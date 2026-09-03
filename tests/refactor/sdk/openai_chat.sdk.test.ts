import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  decodeCapturedBody,
  type OfflineSdkHarness,
  startOfflineSdkHarness,
  waitFor,
} from "./harness.js";

describe("RM-09 official OpenAI Chat SDK", () => {
  let harness: OfflineSdkHarness;
  let client: OpenAI;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new OpenAI({ apiKey: "local", baseURL: harness.openAiBaseUrl, fetch: harness.fetch, maxRetries: 0 });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream and iterates stream responses while capturing exact Chat requests", async () => {
    const nonstream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-nonstream" }],
    });
    expect(nonstream.choices[0]?.message.content).toBe("pong");

    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-stream" }],
      stream: true,
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.choices[0]?.delta.content).filter(Boolean)).toEqual(["pong"]);
    expect(decodeCapturedBody(harness.chatRequests[0]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-nonstream" }],
    });
    expect(decodeCapturedBody(harness.chatRequests[1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-chat-stream" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("surfaces the official API error class and gateway request ID", async () => {
    const error = await client.chat.completions.create({
      model: "missing-sdk-model",
      messages: [{ role: "user", content: "sdk-error" }],
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error).toMatchObject({ status: 404, requestID: "req_sdk_loopback" });
  });

  it("cancels an in-flight official SDK stream", async () => {
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "cancel-sdk-request" }],
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    stream.controller.abort();
    await waitFor(() => harness.cancelled.chat > 0);
    expect(harness.backendKinds).toContain("chat-stream");
  });
});
