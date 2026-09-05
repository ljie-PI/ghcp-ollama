import { Ollama, type ChatRequest, type Message, type Tool } from "ollama";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  decodeCapturedBody,
  getWeather,
  PNG_BASE64,
  REASONING_MODEL,
  type OfflineSdkHarness,
  startOfflineSdkHarness,
  waitFor,
} from "./harness.js";

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
} satisfies Tool;

describe("official Ollama SDK", () => {
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

  it("sends a system message and an ordinary multi-turn conversation", async () => {
    const requestIndex = harness.chatRequests.length;
    const messages = [
      { role: "system", content: "Answer concisely." },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow-up question" },
    ];
    const response = await client.chat({ model: CHAT_MODEL, messages, stream: false });

    expect(response.message.content).toBe("pong");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages,
      stream: false,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
  });

  it("encodes PNG bytes and preserves PNG base64 strings", async () => {
    const requestIndex = harness.chatRequests.length;
    const pngBytes = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));

    const bytesResponse = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "PNG bytes", images: [pngBytes] }],
      stream: false,
    });
    const base64Response = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "PNG base64", images: [PNG_BASE64] }],
      stream: false,
    });

    expect(bytesResponse.message.content).toBe("Image accepted.");
    expect(base64Response.message.content).toBe("Image accepted.");
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "PNG bytes" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ],
      }],
      stream: false,
    });
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "PNG base64" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ],
      }],
      stream: false,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(true);
    expect(harness.chatRequests[requestIndex + 1]!.hasVisionInput).toBe(true);
  });

  it("deserializes an official SDK tool call", async () => {
    const requestIndex = harness.chatRequests.length;
    const response = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
      tools: [WEATHER_TOOL],
      stream: false,
    });
    const toolCall = response.message.tool_calls?.[0];

    expect(toolCall).toMatchObject({
      function: { name: "get_weather", arguments: { city: "Tokyo" } },
    });
    expect(toolCall === undefined ? undefined : Reflect.get(toolCall, "id")).toBe("call_weather");
    expect(toolCall === undefined ? undefined : Reflect.get(toolCall.function, "index")).toBe(0);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
      tools: [WEATHER_TOOL],
      stream: false,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
  });

  it("sends the first tool result in an actual second HTTP request", async () => {
    const requestIndex = harness.chatRequests.length;
    const userMessage: Message = { role: "user", content: "Use the weather tool." };
    const first = await client.chat({
      model: CHAT_MODEL,
      messages: [userMessage],
      tools: [WEATHER_TOOL],
      stream: false,
    });
    const firstToolCall = first.message.tool_calls?.[0];
    if (firstToolCall === undefined) {
      throw new Error("official SDK response omitted the scripted tool call");
    }
    const toolCallId = Reflect.get(firstToolCall, "id");
    if (typeof toolCallId !== "string") {
      throw new Error("official SDK response omitted the scripted tool call ID");
    }
    const city = firstToolCall.function.arguments.city;
    if (typeof city !== "string") {
      throw new Error("expected get_weather city arguments");
    }
    const weather = getWeather(city);
    const toolResult: Message & { readonly tool_call_id: string } = {
      role: "tool",
      content: JSON.stringify(weather),
      tool_name: firstToolCall.function.name,
      tool_call_id: toolCallId,
    };
    const second = await client.chat({
      model: CHAT_MODEL,
      messages: [userMessage, first.message, toolResult],
      tools: [WEATHER_TOOL],
      stream: false,
    });

    expect(second.message.content).toBe("Tool result accepted.");
    expect(harness.chatRequests).toHaveLength(requestIndex + 2);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [userMessage],
      tools: [WEATHER_TOOL],
      stream: false,
    });
    expect(decodeCapturedBody(harness.chatRequests[requestIndex + 1]!)).toEqual({
      model: CHAT_MODEL,
      messages: [
        userMessage,
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_weather",
            index: 0,
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
          }],
        },
        { role: "tool", content: JSON.stringify(weather), name: "get_weather", tool_call_id: "call_weather" },
      ],
      tools: [WEATHER_TOOL],
      stream: false,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
    expect(harness.chatRequests[requestIndex + 1]!.hasVisionInput).toBe(false);
  });

  it("sends image and tool input together", async () => {
    const requestIndex = harness.chatRequests.length;
    const response = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Read the image, then check weather.", images: [PNG_BASE64] }],
      tools: [WEATHER_TOOL],
      stream: false,
    });

    expect(response.message.tool_calls).toHaveLength(1);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Read the image, then check weather." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ],
      }],
      tools: [WEATHER_TOOL],
      stream: false,
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(true);
  });

  it("parses a fragmented streaming tool call through the official iterator", async () => {
    const requestIndex = harness.chatRequests.length;
    const stream = await client.chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Stream a weather tool call." }],
      tools: [WEATHER_TOOL],
      stream: true,
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const terminal = chunks.at(-1);
    const toolCall = terminal?.message.tool_calls?.[0];

    expect(terminal).toMatchObject({ done: true, done_reason: "stop" });
    expect(toolCall).toMatchObject({
      function: { name: "get_weather", arguments: { city: "Tokyo" } },
    });
    expect(toolCall === undefined ? undefined : Reflect.get(toolCall, "id")).toBe("call_stream");
    expect(toolCall === undefined ? undefined : Reflect.get(toolCall.function, "index")).toBe(0);
    expect(decodeCapturedBody(harness.chatRequests[requestIndex]!)).toEqual({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Stream a weather tool call." }],
      tools: [WEATHER_TOOL],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(harness.chatRequests[requestIndex]!.hasVisionInput).toBe(false);
  });

  it("maps all supported think levels to reasoning effort", async () => {
    const requestIndex = harness.chatRequests.length;
    const cases = [
      { think: false, effort: "none" },
      { think: "low", effort: "low" },
      { think: "medium", effort: "medium" },
      { think: "high", effort: "high" },
      { think: "max", effort: "max" },
    ] as const;

    for (const { think, effort } of cases) {
      const request: ChatRequest & { readonly stream: false } = {
        model: REASONING_MODEL,
        messages: [{ role: "user", content: `Reason at ${effort}.` }],
        stream: false,
      };
      Reflect.set(request, "think", think);
      const response = await client.chat(request);
      expect(response.message.content).toBe("Reasoned answer.");
      expect(response.message.thinking).toBe(`reason-${effort}`);
    }

    for (const [offset, { effort }] of cases.entries()) {
      expect(decodeCapturedBody(harness.chatRequests[requestIndex + offset]!)).toEqual({
        model: REASONING_MODEL,
        messages: [{ role: "user", content: `Reason at ${effort}.` }],
        stream: false,
        reasoning_effort: effort,
      });
      expect(harness.chatRequests[requestIndex + offset]!.hasVisionInput).toBe(false);
    }
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
