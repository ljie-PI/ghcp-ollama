import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
} from "../../serialization/wire_json.js";

export function ollamaErrorBody(text: string): string {
  return ollamaJsonStringify({ error: text });
}

export function ollamaCreatedAt(now: Date): string {
  return now.toISOString()
    .replace(/\.000Z$/u, "Z")
    .replace(/(\.\d*?[1-9])0+Z$/u, "$1Z");
}

export function encodeNdjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${ollamaJsonStringify(value)}\n`);
}

export function ollamaJsonStringify(value: unknown): string {
  return goEscapeJson(serializeOllamaJson(value));
}

function serializeOllamaJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Ollama JSON cannot encode non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (isWireJsonNumber(value)) {
    return value.lexeme;
  }
  if (isWireJsonArray(value)) {
    return `[${value.items.map(serializeOllamaJson).join(",")}]`;
  }
  if (isWireJsonObject(value)) {
    return `{${value.members.map((member) => `${JSON.stringify(member.key)}:${serializeOllamaJson(member.value)}`).join(",")}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : serializeOllamaJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, Exclude<unknown, undefined>] => entry[1] !== undefined);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${serializeOllamaJson(item)}`).join(",")}}`;
  }
  return "null";
}

function goEscapeJson(json: string): string {
  return json
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
