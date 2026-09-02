import { describe, expect, it } from "vitest";
import { GatewayFailureError } from "../../../src/gateway/failures.js";
import { normalizeNativeResponsesStream } from "../../../src/protocols/responses/native.js";

describe("RM-13 native Responses stream", () => {
  it("normalizes only item IDs by output index and preserves compact Responses SSE bytes", async () => {
    const output = await collect(normalizeNativeResponsesStream(streamBytes([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item_stable\",\"type\":\"message\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"item_drift\",\"delta\":\"hi\"}\n\n",
      "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"item_done\",\"type\":\"message\"}}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":1}}}\n\n",
    ]), 4096));
    expect(output).toBe([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item_stable\",\"type\":\"message\"}}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"item_stable\",\"delta\":\"hi\"}\n\n",
      "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"item_stable\",\"type\":\"message\"}}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":1}}}\n\n",
    ].join(""));
  });

  it("rejects DONE markers, event type mismatches, and EOF before terminal", async () => {
    await expect(collect(normalizeNativeResponsesStream(streamBytes(["data: [DONE]\n\n"]), 4096)))
      .rejects.toBeInstanceOf(GatewayFailureError);
    await expect(collect(normalizeNativeResponsesStream(streamBytes([
      "event: wrong\ndata: {\"type\":\"response.completed\"}\n\n",
    ]), 4096))).rejects.toBeInstanceOf(GatewayFailureError);
    await expect(collect(normalizeNativeResponsesStream(streamBytes([
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item_stable\"}}\n\n",
    ]), 4096))).rejects.toBeInstanceOf(GatewayFailureError);
  });

  it("applies the SSE byte limit per event rather than per network chunk", async () => {
    const combined = [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
    ].join("");
    await expect(collect(normalizeNativeResponsesStream(streamBytes([combined]), 80))).resolves.toBe(combined);
  });

  async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
    let output = "";
    for await (const chunk of source) {
      output += new TextDecoder().decode(chunk);
    }
    return output;
  }

  async function* streamBytes(parts: readonly string[]): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    for (const part of parts) {
      yield encoder.encode(part);
    }
  }
});
