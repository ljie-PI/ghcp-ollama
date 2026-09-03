import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeCapturedBody,
  NATIVE_RESPONSES_MODEL,
  type OfflineSdkHarness,
  startOfflineSdkHarness,
  waitFor,
} from "./harness.js";

describe("RM-17 official OpenAI Responses SDK", () => {
  let harness: OfflineSdkHarness;
  let client: OpenAI;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
    client = new OpenAI({ apiKey: "local", baseURL: harness.openAiBaseUrl, fetch: harness.fetch, maxRetries: 0 });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes non-stream and iterates a terminal native Responses stream", async () => {
    const nonstream = await client.responses.create({ model: NATIVE_RESPONSES_MODEL, input: "sdk-responses-nonstream" });
    expect(nonstream.id).toBe("resp_sdk");
    expect(nonstream.output_text).toBe("pong");

    const stream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-stream",
      stream: true,
    });
    const eventTypes = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    expect(eventTypes).toEqual(["response.completed"]);
    expect(decodeCapturedBody(harness.responsesRequests[0]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-nonstream",
    });
    expect(decodeCapturedBody(harness.responsesRequests[1]!)).toEqual({
      model: NATIVE_RESPONSES_MODEL,
      input: "sdk-responses-stream",
      stream: true,
    });
  });

  it("surfaces the official API error class and gateway request ID", async () => {
    const error = await client.responses.create({
      model: "missing-sdk-model",
      input: "sdk-error",
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error).toMatchObject({ status: 404, requestID: "req_sdk_loopback" });
  });

  it("cancels an in-flight official Responses stream", async () => {
    const stream = await client.responses.create({
      model: NATIVE_RESPONSES_MODEL,
      input: "cancel-sdk-request",
      stream: true,
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    stream.controller.abort();
    await waitFor(() => harness.cancelled.responses > 0);
    expect(harness.backendKinds).toContain("responses-stream");
  });
});
