/**
 * Unit tests for OpenAI adapter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OpenAIAdapter } from "../../../src/utils/adapters/openai_adapter.js";
import { createMockChatClient } from "../helpers/mock_chat_client.js";
import {
  textMessageCase,
  toolCallsCase,
  imageInputCase,
} from "../fixtures/test_cases.js";
import {
  textResponse,
  toolCallsResponse,
  textStreamChunks,
  createStreamBuffer,
} from "../fixtures/openai_responses.js";

describe("OpenAIAdapter", () => {
  let adapter;

  beforeEach(() => {
    const mockClient = createMockChatClient();
    adapter = new OpenAIAdapter(mockClient);
  });

  describe("convertRequest", () => {
    it("should pass through request unchanged (text message)", () => {
      const input = textMessageCase.openai;
      const result = adapter.convertRequest(input);

      expect(result).toEqual(input);
    });

    it("should pass through request unchanged (tool calls)", () => {
      const input = toolCallsCase.openai;
      const result = adapter.convertRequest(input);

      expect(result).toEqual(input);
    });

    it("should pass through request unchanged (image input)", () => {
      const input = imageInputCase.openai;
      const result = adapter.convertRequest(input);

      expect(result).toEqual(input);
    });

    it("should preserve all fields without modification", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "test" }],
        temperature: 0.7,
        max_tokens: 100,
        stream: true,
        tools: [{ type: "function", function: { name: "test" } }],
      };

      const result = adapter.convertRequest(input);

      expect(result).toEqual(input);
      // Verify it's the same reference (true passthrough)
      expect(result).toBe(input);
    });
  });

  describe("detectVisionRequest", () => {
    it("should return true when message has image_url content", () => {
      const payload = imageInputCase.openai;
      expect(adapter.detectVisionRequest(payload)).toBe(true);
    });

    it("should return false for text-only messages", () => {
      const payload = textMessageCase.openai;
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });

    it("should return false for string content", () => {
      const payload = {
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });

    it("should return false for empty messages array", () => {
      const payload = { messages: [] };
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });

    it("should handle mixed content array correctly", () => {
      const payload = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "test" },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
            ],
          },
        ],
      };
      expect(adapter.detectVisionRequest(payload)).toBe(true);
    });
  });

  describe("parseResponse", () => {
    it("should pass through response unchanged (text)", () => {
      const result = adapter.parseResponse(textResponse);

      expect(result).toEqual(textResponse);
      expect(result).toBe(textResponse);
    });

    it("should pass through response unchanged (tool calls)", () => {
      const result = adapter.parseResponse(toolCallsResponse);

      expect(result).toEqual(toolCallsResponse);
      expect(result).toBe(toolCallsResponse);
    });
  });

  describe("parseStreamChunk", () => {
    it("should parse SSE buffer into chunks", () => {
      const buffer = createStreamBuffer(textStreamChunks.slice(0, 3));
      const state = {};

      const { parsedMessages, remainBuffer } = adapter.parseStreamChunk(
        buffer,
        state,
      );

      expect(parsedMessages.length).toBe(3);
      expect(parsedMessages[0].choices[0].delta.role).toBe("assistant");
      expect(parsedMessages[1].choices[0].delta.content).toBe("The ");
      expect(parsedMessages[2].choices[0].delta.content).toBe("sky ");
      expect(remainBuffer).toBe("");
    });

    it("should handle [DONE] marker", () => {
      // [DONE] must be followed by double newline to be processed
      const buffer = "data: [DONE]\n\n";
      const state = {};

      const { parsedMessages, remainBuffer } = adapter.parseStreamChunk(
        buffer,
        state,
      );

      expect(parsedMessages.length).toBe(0);
      expect(remainBuffer).toBe("");
    });

    it("should handle incomplete buffer", () => {
      const buffer = "data: {\"id\":\"test\",\"choices\":[{\"del";
      const state = {};

      const { parsedMessages, remainBuffer } = adapter.parseStreamChunk(
        buffer,
        state,
      );

      expect(parsedMessages.length).toBe(0);
      expect(remainBuffer).toBe("data: {\"id\":\"test\",\"choices\":[{\"del");
    });

    it("should skip empty lines", () => {
      const buffer = "\n\ndata: " + JSON.stringify(textResponse) + "\n\n";
      const state = {};

      const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

      expect(parsedMessages.length).toBe(1);
    });
  });
});
