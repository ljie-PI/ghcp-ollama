import { describe, it } from "vitest";
import OpenAI from "openai";
import { assertOfflineSdkTestsEnabled } from "./harness.js";

const sdkIt = process.env.GHC_GATEWAY_SDK_TESTS === "1" ? it : it.skip;

describe("RM-09 official OpenAI Chat SDK", () => {
  sdkIt("manual-only: Chat Completions non-stream, stream, error class/request ID, and cancellation", async () => {
    assertOfflineSdkTestsEnabled();
    const client = new OpenAI({
      apiKey: "unused-by-ghc-gateway",
      baseURL: process.env.GHC_GATEWAY_SDK_BASE_URL ?? "http://127.0.0.1:31400/v1",
    });

    await client.chat.completions.create({
      model: process.env.GHC_GATEWAY_SDK_MODEL ?? "gpt-4.1",
      messages: [{ role: "user", content: "Say pong." }],
    });

    const stream = await client.chat.completions.create({
      model: process.env.GHC_GATEWAY_SDK_MODEL ?? "gpt-4.1",
      messages: [{ role: "user", content: "Say pong." }],
      stream: true,
    });
    for await (const chunk of stream) {
      if (chunk !== undefined) {
        break;
      }
    }

    await client.chat.completions.create({
      model: "__ghc_gateway_missing_model__",
      messages: [{ role: "user", content: "This should fail." }],
    }).catch((error: unknown) => {
      if (!(error instanceof OpenAI.APIError) || error.status !== 404 || error.requestID === undefined) {
        throw error;
      }
    });

    const controller = new AbortController();
    controller.abort();
    await client.chat.completions.create({
      model: process.env.GHC_GATEWAY_SDK_MODEL ?? "gpt-4.1",
      messages: [{ role: "user", content: "This should cancel." }],
    }, { signal: controller.signal }).catch((error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
    });
  });
});
