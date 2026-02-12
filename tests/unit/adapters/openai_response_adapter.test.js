import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIResponseAdapter } from "../../../src/utils/adapters/openai_response_adapter.js";
import { createMockChatClient } from "../helpers/mock_chat_client.js";
import {
  textResponse,
  toolCallsResponse,
  textStreamChunks,
  toolCallStreamChunks,
  createStreamBuffer,
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
  });
});
