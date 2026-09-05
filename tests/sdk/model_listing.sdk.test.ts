import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Ollama } from "ollama";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_MODEL, type OfflineSdkHarness, startOfflineSdkHarness } from "./harness.js";

describe("official SDK model listing", () => {
  let harness: OfflineSdkHarness;

  beforeAll(async () => {
    harness = await startOfflineSdkHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("deserializes the shared catalog with OpenAI, Anthropic, and Ollama clients", async () => {
    const openai = new OpenAI({ apiKey: "local", baseURL: harness.openAiBaseUrl, fetch: harness.fetch, maxRetries: 0 });
    const anthropic = new Anthropic({ apiKey: "local", baseURL: harness.baseUrl, fetch: harness.fetch, maxRetries: 0 });
    const ollama = new Ollama({ host: harness.baseUrl, fetch: harness.fetch });

    const [openAiModels, anthropicModels, ollamaModels] = await Promise.all([
      openai.models.list(),
      anthropic.models.list(),
      ollama.list(),
    ]);

    expect(openAiModels.data.map((model) => model.id)).toContain(CHAT_MODEL);
    expect(anthropicModels.data.map((model) => model.id)).toContain(CHAT_MODEL);
    expect(ollamaModels.models.map((model) => model.model)).toContain(CHAT_MODEL);
    expect(harness.backendKinds).toEqual([]);
  });
});
