import { describe, expect, it } from "vitest";
import {
  parseWireJson,
  serializeWireJson,
  isWireJsonArray,
  isWireJsonObject,
  type WireJson,
  type WireJsonObject,
} from "../../../src/serialization/wire_json.js";
import {
  decodeResponsesRequest,
  ResponsesRequestDecodeError,
} from "../../../src/protocols/responses/decoder.js";

const LIMITS = { maxBytes: 4096, maxDepth: 16 } as const;

function objectFromJson(json: string): WireJsonObject {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect((value as { kind?: string }).kind).toBe("object");
  return value as WireJsonObject;
}

function numberLexeme(value: WireJson | undefined): string | undefined {
  return typeof value === "object" && value !== null && value.kind === "number"
    ? value.lexeme
    : undefined;
}

function expectDecodeError(json: string): ResponsesRequestDecodeError {
  try {
    decodeResponsesRequest(objectFromJson(json));
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResponsesRequestDecodeError);
    return error as ResponsesRequestDecodeError;
  }
  throw new Error("expected decode error");
}

describe("RM-12 Responses request decoder", () => {
  it("requires a non-empty string model and rejects duplicate control fields", () => {
    expect(expectDecodeError("{}").field).toBe("model");
    expect(expectDecodeError("{\"model\":null}").field).toBe("model");
    expect(expectDecodeError("{\"model\":4}").field).toBe("model");
    expect(expectDecodeError("{\"model\":\"\",\"input\":\"hi\"}").field).toBe("model");
    expect(expectDecodeError("{\"model\":\"gpt\",\"model\":\"other\"}").field).toBe("model");
    expect(expectDecodeError("{\"model\":\"gpt\",\"stream\":false,\"stream\":true}").field).toBe("stream");
  });

  it("applies null/missing defaults only to control fields without coercion", () => {
    const decoded = decodeResponsesRequest(objectFromJson([
      "{\"metadata\":{\"temperature\":0.7},",
      "\"model\":\"gpt-4.1\",",
      "\"input\":{\"type\":\"message\",\"content\":\"hi\"},",
      "\"previous_response_id\":null,",
      "\"store\":null}",
    ].join("")));

    expect(decoded.model).toBe("gpt-4.1");
    expect(decoded.stream).toBe(false);
    expect(decoded.store).toBe(true);
    expect(decoded.previousResponseId).toBeUndefined();
    expect(isWireJsonObject(decoded.input)).toBe(true);
    expect(decoded.body.members.map((member) => member.key)).toEqual([
      "metadata",
      "model",
      "input",
      "previous_response_id",
      "store",
    ]);
  });

  it("validates stream, store, and previous_response_id types", () => {
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"stream\":true}")).stream).toBe(true);
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"store\":false}")).store).toBe(false);
    expect(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\",\"previous_response_id\":\"resp_1\"}"))
      .previousResponseId).toBe("resp_1");
    expect(expectDecodeError("{\"model\":\"gpt\",\"stream\":\"true\"}").field).toBe("stream");
    expect(expectDecodeError("{\"model\":\"gpt\",\"store\":\"false\"}").field).toBe("store");
    expect(expectDecodeError("{\"model\":\"gpt\",\"previous_response_id\":8}").field)
      .toBe("previous_response_id");
  });

  it("preserves member order, duplicate non-control fields, number lexemes, and nested values", () => {
    const decoded = decodeResponsesRequest(objectFromJson([
      "{\"metadata\":{\"a\":-0,\"nested\":[9007199254740993]},",
      "\"model\":\"gpt\",",
      "\"metadata\":{\"b\":1e+6},",
      "\"temperature\":0.70}",
    ].join("")));

    expect(decoded.body.members.map((member) => member.key)).toEqual([
      "metadata",
      "model",
      "metadata",
      "temperature",
    ]);
    const firstMetadata = decoded.body.members[0]?.value as WireJsonObject;
    const nested = firstMetadata.members[1]?.value;
    expect(numberLexeme(firstMetadata.members[0]?.value)).toBe("-0");
    expect(isWireJsonArray(nested)).toBe(true);
    if (isWireJsonArray(nested)) {
      expect(numberLexeme(nested.items[0])).toBe("9007199254740993");
    }
    expect(numberLexeme(decoded.body.members[3]?.value)).toBe("0.70");
    expect(new TextDecoder().decode(serializeWireJson(decoded.body))).toBe([
      "{\"metadata\":{\"a\":-0,\"nested\":[9007199254740993]},",
      "\"model\":\"gpt\",",
      "\"metadata\":{\"b\":1e+6},",
      "\"temperature\":0.70}",
    ].join(""));
  });
});
