import { Ollama } from "ollama";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  decodeCapturedBody,
  type OfflineSdkHarness,
  startOfflineSdkHarness,
  waitFor,
} from "./harness.js";

describe("RM-10 official Ollama SDK", () => {
  let harness: OfflineSdkHarness;
  let client: Ollama;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new Ollama({ host: harness.baseUrl, fetch: harness.fetch });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream chat and iterates NDJSON through the official client", async () => {
    const nonstream = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-ollama-nonstream" }],
      stream: false,
    });
    expect(nonstream.done).toBe(true);
    expect(nonstream.message.content).toBe("pong");

    const stream = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-ollama-stream" }],
      stream: true,
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)).toMatchObject({ done: true, done_reason: "stop" });
    expect(decodeCapturedBody(harness.chatRequests[0]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-ollama-nonstream" }],
      stream: false,
    });
    expect(decodeCapturedBody(harness.chatRequests[1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-ollama-stream" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("cancels an in-flight official Ollama iterator", async () => {
    const stream = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "cancel-sdk-request" }],
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    stream.abort();
    await waitFor(() => harness.cancelled.chat > 0);
    expect(harness.backendKinds).toContain("chat-stream");
  });
});
