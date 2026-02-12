import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIResponseAdapter } from "../../../src/utils/adapters/openai_response_adapter.js";
import { createMockChatClient } from "../helpers/mock_chat_client.js";
import {
  textResponse,
  toolCallsResponse,
  textStreamChunks,
  toolCallStreamChunks,
  createStreamBuffer,
  reasoningResponse,
  lengthFinishResponse,
  annotationsResponse,
  newEventTypesStreamChunks,
  costResponse,
  cachedTokensResponse,
} from "../fixtures/openai_responses.js";

describe("OpenAIResponseAdapter", () => {
  let adapter;

  beforeEach(() => {
    adapter = new OpenAIResponseAdapter(createMockChatClient());
  });

  describe("convertRequest", () => {
    it("should convert response input to chat.completions messages", () => {
      const payload = {
        model: "gpt-4o",
        instructions: "You are a helpful assistant.",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Hello" },
            ],
          },
        ],
        temperature: 0.5,
      };

      const result = adapter.convertRequest(payload);

      expect(result.model).toBe("gpt-4o");
      expect(result.messages[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant.",
      });
      expect(result.messages[1]).toEqual({
        role: "user",
        content: "Hello",
      });
      expect(result.temperature).toBe(0.5);
    });

    it("should convert function tools into chat completion format", () => {
      const payload = {
        model: "gpt-4o",
        input: "call tool",
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ]);
    });

    it("should convert reasoning.effort to reasoning_effort", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        reasoning: { effort: "high" },
      };

      const result = adapter.convertRequest(payload);

      expect(result.reasoning_effort).toBe("high");
    });

    it("should convert text.format json_schema to response_format", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        text: {
          format: {
            type: "json_schema",
            name: "weather",
            schema: {
              type: "object",
              properties: {
                temperature: { type: "number" },
              },
            },
            strict: true,
          },
        },
      };

      const result = adapter.convertRequest(payload);

      expect(result.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "weather",
          schema: {
            type: "object",
            properties: {
              temperature: { type: "number" },
            },
          },
          strict: true,
        },
      });
    });

    it("should convert text.format json_object to response_format", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        text: {
          format: { type: "json_object" },
        },
      };

      const result = adapter.convertRequest(payload);

      expect(result.response_format).toEqual({ type: "json_object" });
    });

    it("should pass through truncation parameter", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        truncation: "auto",
      };

      const result = adapter.convertRequest(payload);

      expect(result.truncation).toBe("auto");
    });

    it("should handle stream_options.include_usage", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        stream_options: { include_usage: true },
      };

      const result = adapter.convertRequest(payload);

      expect(result.stream_options).toEqual({ include_usage: true });
    });

    it("should transform tool_choice from dict format", () => {
      const testCases = [
        { input: { type: "auto" }, expected: "auto" },
        { input: { type: "none" }, expected: "none" },
        { input: { type: "required" }, expected: "required" },
        { input: { type: "tool" }, expected: "required" },
      ];

      for (const { input, expected } of testCases) {
        const payload = {
          model: "gpt-4o",
          input: "test",
          tool_choice: input,
        };

        const result = adapter.convertRequest(payload);

        expect(result.tool_choice).toBe(expected);
      }
    });

    it("should handle MCP tools", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        tools: [
          {
            type: "mcp",
            name: "my_mcp_tool",
            description: "MCP tool",
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.tools).toContainEqual({
        type: "mcp",
        name: "my_mcp_tool",
        description: "MCP tool",
      });
    });

    it("should handle Web Search tools", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        tools: [
          {
            type: "web_search",
            search_context_size: "low",
            user_location: { type: "approximate", country: "US" },
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.web_search_options).toEqual({
        search_context_size: "low",
        user_location: { type: "approximate", country: "US" },
      });
    });

    it("should handle web_search_preview type", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        tools: [
          {
            type: "web_search_preview",
            search_context_size: "medium",
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.web_search_options).toEqual({
        search_context_size: "medium",
        user_location: null,
      });
    });

    it("should handle new tool properties", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        tools: [
          {
            type: "function",
            function: {
              name: "test_tool",
              description: "Test",
              parameters: { type: "object", properties: {} },
            },
            cache_control: { type: "ephemeral" },
            defer_loading: true,
            allowed_callers: ["assistant"],
            input_examples: [{ example: "data" }],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.tools?.[0]).toMatchObject({
        type: "function",
        function: {
          name: "test_tool",
          description: "Test",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
        cache_control: { type: "ephemeral" },
        defer_loading: true,
        allowed_callers: ["assistant"],
        input_examples: [{ example: "data" }],
      });
    });

    it("should ensure parameters has type object", () => {
      const payload = {
        model: "gpt-4o",
        input: "test",
        tools: [
          {
            type: "function",
            name: "test_tool",
            parameters: { properties: {} },
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.tools?.[0].function.parameters.type).toBe("object");
    });
  });

  describe("normalizeRequestContent", () => {
    it("should handle input_file type", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                file_id: "file-abc123",
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "file", file: { file_id: "file-abc123" } },
      ]);
    });

    it("should handle input_file with file_data", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                file_data: {
                  filename: "test.txt",
                  content: "base64content",
                },
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        {
          type: "file",
          file: { filename: "test.txt", content: "base64content" },
        },
      ]);
    });

    it("should handle input_audio type", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                audio: { url: "https://example.com/audio.mp3" },
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "input_audio", input_audio: { url: "https://example.com/audio.mp3" } },
      ]);
    });

    it("should handle input_audio with url property", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                url: "https://example.com/audio.wav",
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "input_audio", input_audio: { url: "https://example.com/audio.wav" } },
      ]);
    });

    it("should handle output_text type (in response context)", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Previous response",
              },
              {
                type: "output_text",
                text: "Another response",
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "text", text: "Previous response" },
        { type: "text", text: "Another response" },
      ]);
    });

    it("should handle output_text type - single element simplified to string", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Previous response",
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toBe("Previous response");
    });

    it("should handle tool_result type", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                text: "Tool executed successfully",
              },
              {
                type: "tool_result",
                text: "Another result",
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "text", text: "Tool executed successfully" },
        { type: "text", text: "Another result" },
      ]);
    });

    it("should handle input_ prefix types", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Text" },
              { type: "input_image", image_url: "data:image/png;base64,abc" },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "text", text: "Text" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ]);
    });

    it("should handle input_ prefix with url fallback", () => {
      const payload = {
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                url: "https://example.com/image.png",
              },
            ],
          },
        ],
      };

      const result = adapter.convertRequest(payload);

      expect(result.messages[0].content).toEqual([
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      ]);
    });
  });

  describe("detectVisionRequest", () => {
    it("should detect image content in responses input", () => {
      const payload = {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "describe" },
              { type: "input_image", image_url: "data:image/png;base64,abc" },
            ],
          },
        ],
      };

      expect(adapter.detectVisionRequest(payload)).toBe(true);
    });
  });

  describe("parseResponse", () => {
    it("should convert text completion response to responses format", () => {
      const result = adapter.parseResponse(textResponse);

      expect(result.object).toBe("response");
      expect(result.status).toBe("completed");
      expect(result.output_text).toContain("The sky is blue");
      expect(result.output[0].type).toBe("message");
    });

    it("should include function_call output for tool call responses", () => {
      const result = adapter.parseResponse(toolCallsResponse);

      expect(result.output.some((item) => item.type === "function_call")).toBe(
        true,
      );
    });

    it("should handle reasoning content", () => {
      const result = adapter.parseResponse(reasoningResponse);

      expect(result.output).toHaveLength(2);
      expect(result.output[0].type).toBe("reasoning");
      expect(result.output[0].content[0].text).toBe("Let me think about this step by step.");
      expect(result.output[1].type).toBe("message");
      expect(result.output_text).toBe("The answer is 42.");
    });

    it("should map finish_reason length to incomplete status", () => {
      const result = adapter.parseResponse(lengthFinishResponse);

      expect(result.status).toBe("incomplete");
      expect(result.incomplete_details).toEqual({ reason: "max_tokens" });
    });

    it("should map finish_reason stop to completed status", () => {
      const result = adapter.parseResponse(textResponse);

      expect(result.status).toBe("completed");
      expect(result.incomplete_details).toBeNull();
    });

    it("should handle annotations", () => {
      const result = adapter.parseResponse(annotationsResponse);

      const message = result.output.find((item) => item.type === "message");
      expect(message?.content[0].annotations).toEqual([
        {
          type: "url_citation",
          start_index: 5,
          end_index: 21,
          url: "https://example.com",
          title: "Example Source",
        },
      ]);
    });

    it("should preserve cost in usage", () => {
      const result = adapter.parseResponse(costResponse);

      expect(result.usage.cost).toBe(0.001);
    });

    it("should build input_tokens_details", () => {
      const result = adapter.parseResponse(cachedTokensResponse);

      expect(result.usage.input_tokens_details).toEqual({
        cached_tokens: 80,
        text_tokens: 0,
        audio_tokens: 0,
      });
    });

    it("should build output_tokens_details", () => {
      const result = adapter.parseResponse(reasoningResponse);

      expect(result.usage.output_tokens_details).toEqual({
        reasoning_tokens: 15,
        text_tokens: 15,
      });
    });

    it("should have default values for missing usage details", () => {
      const result = adapter.parseResponse(textResponse);

      expect(result.usage.input_tokens_details).toEqual({
        cached_tokens: 0,
      });
      expect(result.usage.output_tokens_details).toEqual({
        reasoning_tokens: 0,
      });
    });
  });

  describe("parseStreamChunk", () => {
    it("should emit response.output_text.delta events from chat completion chunks", () => {
      const state = {};
      const buffer = createStreamBuffer(textStreamChunks.slice(0, 4));

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      const deltaEvents = parsedMessages.filter(
        (message) => message.type === "response.output_text.delta",
      );
      expect(deltaEvents.length).toBeGreaterThan(0);
      expect(deltaEvents[0].delta).toBe("The ");
    });

    it("should emit function_call_arguments delta events", () => {
      const state = {};
      const buffer = createStreamBuffer(toolCallStreamChunks.slice(0, 5));

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      const deltaEvents = parsedMessages.filter(
        (message) => message.type === "response.function_call_arguments.delta",
      );
      expect(deltaEvents.length).toBeGreaterThan(0);
    });

    it("should emit response.completed on done", () => {
      const state = {};
      const buffer = createStreamBuffer(textStreamChunks);

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      expect(
        parsedMessages.some((message) => message.type === "response.completed"),
      ).toBe(true);
    });

    it("should emit output_item_added event", () => {
      const state = {};
      const buffer = createStreamBuffer(newEventTypesStreamChunks.slice(0, 2));

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      expect(
        parsedMessages.some((message) => message.type === "response.output_item.added"),
      ).toBe(true);
    });

    it("should emit content_part_added event", () => {
      const state = {};
      const buffer = createStreamBuffer(newEventTypesStreamChunks.slice(1, 3));

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      expect(
        parsedMessages.some((message) => message.type === "response.content_part.added"),
      ).toBe(true);
    });

    it("should emit content_part.done event before completion", () => {
      const state = {};
      const buffer = createStreamBuffer(newEventTypesStreamChunks);

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      const contentPartDoneEvents = parsedMessages.filter(
        (message) => message.type === "response.content_part.done",
      );
      expect(contentPartDoneEvents.length).toBeGreaterThan(0);

      const doneEvent = contentPartDoneEvents[0];
      expect(doneEvent.part.type).toBe("output_text");
      expect(doneEvent.part.text).toContain("Hello world!");
    });

    it("should emit output_item.done event before completion", () => {
      const state = {};
      const buffer = createStreamBuffer(newEventTypesStreamChunks);

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      expect(
        parsedMessages.some((message) => message.type === "response.output_item.done"),
      ).toBe(true);

      const outputItemDone = parsedMessages.find(
        (message) => message.type === "response.output_item.done",
      );
      expect(outputItemDone.item.status).toBe("completed");
      expect(outputItemDone.item.type).toBe("message");
    });
  });
});
