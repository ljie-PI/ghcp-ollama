import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  decodeCapturedBody,
  type OfflineSdkHarness,
  startOfflineSdkHarness,
  waitFor,
} from "./harness.js";

describe("RM-11 official Anthropic SDK", () => {
  let harness: OfflineSdkHarness;
  let client: Anthropic;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new Anthropic({ apiKey: "local", baseURL: harness.baseUrl, fetch: harness.fetch, maxRetries: 0 });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes Messages non-stream and iterates the complete event stream", async () => {
    const message = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "sdk-anthropic-nonstream" }],
    });
    expect(message.type).toBe("message");
    expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "pong" }));

    const stream = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "sdk-anthropic-stream" }],
      stream: true,
    });
    const eventTypes = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    expect(eventTypes[0]).toBe("message_start");
    expect(eventTypes.at(-1)).toBe("message_stop");
    expect(decodeCapturedBody(harness.chatRequests[0]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-anthropic-nonstream" }],
      max_tokens: 8,
    });
    expect(decodeCapturedBody(harness.chatRequests[1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "sdk-anthropic-stream" }],
      max_tokens: 8,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("surfaces the official API error class and gateway request ID", async () => {
    const error = await client.messages.create({
      model: "missing-sdk-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "sdk-error" }],
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Anthropic.APIError);
    expect(error).toMatchObject({ status: 404, requestID: "req_sdk_loopback" });
  });

  it("cancels an in-flight official MessageStream", async () => {
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: 8,
      messages: [{ role: "user", content: "cancel-sdk-request" }],
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    stream.abort();
    await waitFor(() => harness.cancelled.chat > 0);
    expect(harness.backendKinds).toContain("chat-stream");
  });
});
