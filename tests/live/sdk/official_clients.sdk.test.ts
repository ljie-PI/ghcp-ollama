import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Ollama } from "ollama";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertLiveSdkTestsEnabled,
  consumeAtLeastOne,
  liveBaseUrl,
  loopbackOnlyFetch,
  recordLiveStatus,
} from "./harness.js";

describe("RM-22 guarded live official SDK smoke", () => {
  let openai: OpenAI;
  let anthropic: Anthropic;
  let ollama: Ollama;
  let chatModel: string;
  let responsesModel: string;
  let nativeResponsesModel: string | undefined;

  beforeAll(async () => {
    assertLiveSdkTestsEnabled();
    const baseUrl = liveBaseUrl();
    const guardedFetch = loopbackOnlyFetch(baseUrl);
    openai = new OpenAI({ apiKey: "local-gateway", baseURL: `${baseUrl}/v1`, fetch: guardedFetch, maxRetries: 0 });
    anthropic = new Anthropic({ apiKey: "local-gateway", baseURL: baseUrl, fetch: guardedFetch, maxRetries: 0 });
    ollama = new Ollama({ host: baseUrl, fetch: guardedFetch });

    const [openAiModels, anthropicModels, ollamaModels] = await Promise.all([
      openai.models.list(),
      anthropic.models.list(),
      ollama.list(),
    ]);
    const openAiIds = openAiModels.data.map((model) => model.id);
    const anthropicIds = new Set(anthropicModels.data.map((model) => model.id));
    const ollamaIds = new Set(ollamaModels.models.map((model) => model.model));
    const sharedIds = openAiIds.filter((id) => anthropicIds.has(id) && ollamaIds.has(id));
    const explicitChat = process.env.GHC_GATEWAY_LIVE_CHAT_MODEL;
    chatModel = explicitChat ?? sharedIds.find((id) => modelMode(openAiModels.data.find((model) => model.id === id)) !== "responses") ?? "";
    if (chatModel === "" || !sharedIds.includes(chatModel)) {
      throw new Error("no shared live Chat model is available");
    }
    const explicitResponses = process.env.GHC_GATEWAY_LIVE_RESPONSES_MODEL;
    nativeResponsesModel = explicitResponses
      ?? openAiModels.data.find((model) => modelMode(model) === "responses")?.id;
    if (explicitResponses !== undefined && !openAiIds.includes(explicitResponses)) {
      throw new Error("GHC_GATEWAY_LIVE_RESPONSES_MODEL is not in the current catalog");
    }
    responsesModel = nativeResponsesModel ?? chatModel;
    recordLiveStatus("models", "passing", [chatModel, responsesModel]);
  });

  it("calls OpenAI Chat non-stream, stream, and cancellation", async () => {
    const completion = await openai.chat.completions.create({
      model: chatModel,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    expect(completion.choices.length).toBeGreaterThan(0);
    const stream = await openai.chat.completions.create({
      model: chatModel,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = await openai.chat.completions.create({
      model: chatModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "Count from one to five." }],
      stream: true,
    });
    cancelled.controller.abort();
    expect(cancelled.controller.signal.aborted).toBe(true);
    recordLiveStatus("openai_chat", "passing", [chatModel]);
  });

  it("calls OpenAI Responses non-stream, stream, and cancellation", async () => {
    const response = await openai.responses.create({
      model: responsesModel,
      input: "Reply with OK.",
      max_output_tokens: 8,
    });
    expect(response.id.length).toBeGreaterThan(0);
    const stream = await openai.responses.create({
      model: responsesModel,
      input: "Reply with OK.",
      max_output_tokens: 8,
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = await openai.responses.create({
      model: responsesModel,
      input: "Count from one to five.",
      max_output_tokens: 16,
      stream: true,
    });
    cancelled.controller.abort();
    expect(cancelled.controller.signal.aborted).toBe(true);
    recordLiveStatus("openai_responses", "passing", [responsesModel]);
    recordLiveStatus("native_responses", nativeResponsesModel === undefined ? "not_available" : "passing", nativeResponsesModel === undefined ? [] : [nativeResponsesModel]);
  });

  it("calls Anthropic Messages non-stream, stream, and cancellation", async () => {
    const message = await anthropic.messages.create({
      model: chatModel,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    expect(message.content.length).toBeGreaterThan(0);
    const stream = await anthropic.messages.create({
      model: chatModel,
      max_tokens: 4,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = anthropic.messages.stream({
      model: chatModel,
      max_tokens: 8,
      messages: [{ role: "user", content: "Count from one to five." }],
    });
    cancelled.abort();
    expect(cancelled.aborted).toBe(true);
    recordLiveStatus("anthropic_messages", "passing", [chatModel]);
  });

  it("calls Ollama chat non-stream, stream, and cancellation", async () => {
    const response = await ollama.chat({
      model: chatModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      options: { num_predict: 4 },
      stream: false,
    });
    expect(response.done).toBe(true);
    const stream = await ollama.chat({
      model: chatModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      options: { num_predict: 4 },
      stream: true,
    });
    expect(await consumeAtLeastOne(stream)).toBeGreaterThan(0);
    const cancelled = await ollama.chat({
      model: chatModel,
      messages: [{ role: "user", content: "Count from one to five." }],
      options: { num_predict: 8 },
      stream: true,
    });
    cancelled.abort();
    recordLiveStatus("ollama_chat", "passing", [chatModel]);
  });
});

function modelMode(model: unknown): string | undefined {
  if (model === null || typeof model !== "object" || !("mode" in model)) {
    return undefined;
  }
  return typeof model.mode === "string" ? model.mode : undefined;
}
