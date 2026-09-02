import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

const enabled = process.env.GHC_GATEWAY_SDK_TESTS === "1";

describe.runIf(enabled)("RM-11 Anthropic SDK compatibility", () => {
  it("can list models and call Messages non-stream and stream through the gateway", async () => {
    const client = new Anthropic({
      apiKey: "gateway-local",
      baseURL: process.env.GHC_GATEWAY_BASE_URL ?? "http://127.0.0.1:31400",
    });

    const models = await client.models.list();
    expect(models.data.length).toBeGreaterThanOrEqual(0);

    const message = await client.messages.create({
      model: process.env.GHC_GATEWAY_SDK_MODEL ?? "gpt",
      max_tokens: 8,
      messages: [{ role: "user", content: "Say ok." }],
    });
    expect(message.type).toBe("message");

    const stream = await client.messages.create({
      model: process.env.GHC_GATEWAY_SDK_MODEL ?? "gpt",
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "Say ok." }],
    });
    for await (const event of stream) {
      expect(event.type.length).toBeGreaterThan(0);
      break;
    }
  });
});
