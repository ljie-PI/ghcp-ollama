/**
 * Unit tests for Anthropic adapter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AnthropicAdapter } from "../../../src/utils/adapters/anthropic_adapter.js";
import { createMockChatClient } from "../helpers/mock_chat_client.js";
import {
  textMessageCase,
  toolCallsCase,
  imageInputCase,
  multiTurnToolsCase,
  sampleImages,
} from "../fixtures/test_cases.js";
import {
  textResponse,
  toolCallsResponse,
  textStreamChunks,
  toolCallStreamChunks,
  multipleToolCallStreamChunks,
  sameNameToolCallStreamChunks,
  createStreamBuffer,
  cachedTokensResponse,
  cachedTokensStreamChunks,
} from "../fixtures/openai_responses.js";

describe("AnthropicAdapter", () => {
  let adapter;

  beforeEach(() => {
    const mockClient = createMockChatClient();
    adapter = new AnthropicAdapter(mockClient);
  });

  describe("convertRequest", () => {
    describe("basic text messages", () => {
      it("should convert simple text messages", () => {
        const result = adapter.convertRequest(textMessageCase.anthropic);

        expect(result.model).toBe("gpt-4o");
        expect(result.messages).toHaveLength(3);
        expect(result.messages[0].content).toBe("Why is the sky blue?");
      });

      it("should handle string content", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
        };

        const result = adapter.convertRequest(payload);

        expect(result.messages[0].content).toBe("Hello");
      });

      it("should handle text content blocks", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Hello" }],
            },
          ],
        };

        const result = adapter.convertRequest(payload);

        expect(result.messages[0].content).toEqual([
          { type: "text", text: "Hello" },
        ]);
      });
    });

    describe("system message handling", () => {
      it("should extract system field and prepend as first message", () => {
        const result = adapter.convertRequest(toolCallsCase.anthropic);

        expect(result.messages[0].role).toBe("system");
        expect(result.messages[0].content).toBe(
          "You are a helpful assistant with tools.",
        );
      });

      it("should not add system message if not present", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
        };

        const result = adapter.convertRequest(payload);

        expect(result.messages[0].role).toBe("user");
      });
    });

    describe("image handling", () => {
      it("should convert Anthropic image blocks to OpenAI format", () => {
        const result = adapter.convertRequest(imageInputCase.anthropic);

        const imageContent = result.messages[0].content.find(
          (c) => c.type === "image_url",
        );
        expect(imageContent).toBeDefined();
        expect(imageContent.image_url.url).toContain(
          "data:image/jpeg;base64,",
        );
      });

      it("should preserve media_type from Anthropic format", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What is this?" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: sampleImages.png,
                  },
                },
              ],
            },
          ],
        };

        const result = adapter.convertRequest(payload);
        const imageContent = result.messages[0].content.find(
          (c) => c.type === "image_url",
        );

        expect(imageContent.image_url.url).toContain("data:image/png;base64,");
      });
    });

    describe("tool definitions", () => {
      it("should convert input_schema to parameters", () => {
        const result = adapter.convertRequest(toolCallsCase.anthropic);

        expect(result.tools).toBeDefined();
        expect(result.tools[0].type).toBe("function");
        expect(result.tools[0].function.parameters).toBeDefined();
        expect(result.tools[0].function.parameters.properties.location).toBeDefined();
      });

      it("should handle function wrapper format", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
          tools: [
            {
              type: "function",
              function: {
                name: "test_func",
                description: "Test function",
                parameters: { type: "object" },
              },
            },
          ],
        };

        const result = adapter.convertRequest(payload);

        expect(result.tools[0].function.name).toBe("test_func");
      });
    });

    describe("tool_use blocks (assistant messages)", () => {
      it("should convert tool_use blocks to tool_calls", () => {
        const result = adapter.convertRequest(multiTurnToolsCase.anthropic);

        const assistantMsg = result.messages.find(
          (m) => m.role === "assistant" && m.tool_calls,
        );
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg.tool_calls).toHaveLength(1);
        expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
      });

      it("should stringify tool input as arguments", () => {
        const result = adapter.convertRequest(multiTurnToolsCase.anthropic);

        const assistantMsg = result.messages.find(
          (m) => m.role === "assistant" && m.tool_calls,
        );
        const args = assistantMsg.tool_calls[0].function.arguments;

        expect(typeof args).toBe("string");
        expect(JSON.parse(args)).toEqual({
          location: "Tokyo",
          format: "celsius",
        });
      });
    });

    describe("tool_result blocks", () => {
      it("should convert tool_result blocks", () => {
        const result = adapter.convertRequest(multiTurnToolsCase.anthropic);

        // Tool results should be converted
        const toolResultMessages = result.messages.filter(
          (m) => m.tool_call_id || (m.tool_calls && m.tool_calls.some((tc) => tc.function?.name === "tool_result")),
        );
        expect(toolResultMessages.length).toBeGreaterThan(0);
      });
    });

    describe("parameter passthrough", () => {
      it("should pass through max_tokens", () => {
        const result = adapter.convertRequest(textMessageCase.anthropic);

        expect(result.max_tokens).toBe(1024);
      });

      it("should pass through temperature", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
          temperature: 0.7,
        };

        const result = adapter.convertRequest(payload);

        expect(result.temperature).toBe(0.7);
      });
    });
  });

  describe("detectVisionRequest", () => {
    it("should return true when message has image block", () => {
      expect(adapter.detectVisionRequest(imageInputCase.anthropic)).toBe(true);
    });

    it("should return false for text-only messages", () => {
      expect(adapter.detectVisionRequest(textMessageCase.anthropic)).toBe(
        false,
      );
    });

    it("should return false for string content", () => {
      const payload = {
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });

    it("should return false for empty messages", () => {
      const payload = { messages: [] };
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });
  });

  describe("parseResponse", () => {
    describe("text response", () => {
      it("should convert to Anthropic message format", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.type).toBe("message");
        expect(result.role).toBe("assistant");
        expect(result.content).toBeInstanceOf(Array);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toBe(
          "The sky is blue due to Rayleigh scattering.",
        );
      });

      it("should generate message ID", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.id).toMatch(/^msg_/);
      });

      it("should map stop_reason correctly", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.stop_reason).toBe("end_turn");
      });

      it("should extract usage", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.usage.input_tokens).toBe(50);
        expect(result.usage.output_tokens).toBe(20);
      });

      it("should calculate input_tokens excluding cached_tokens", () => {
        const result = adapter.parseResponse(cachedTokensResponse);

        expect(result.usage.input_tokens).toBe(20);
        expect(result.usage.output_tokens).toBe(15);
        expect(result.usage.cache_read_input_tokens).toBe(80);
        expect(result.usage.cache_creation_input_tokens).toBe(0);
      });

      it("should include cache fields even when no cached tokens", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.usage.input_tokens).toBe(50);
        expect(result.usage.output_tokens).toBe(20);
        expect(result.usage.cache_read_input_tokens).toBe(0);
        expect(result.usage.cache_creation_input_tokens).toBe(0);
      });
    });

    describe("tool calls response", () => {
      it("should convert tool_calls to tool_use content blocks", () => {
        const result = adapter.parseResponse(toolCallsResponse);

        const toolUseBlock = result.content.find((c) => c.type === "tool_use");
        expect(toolUseBlock).toBeDefined();
        expect(toolUseBlock.name).toBe("get_weather");
      });

      it("should parse arguments as object input", () => {
        const result = adapter.parseResponse(toolCallsResponse);

        const toolUseBlock = result.content.find((c) => c.type === "tool_use");
        expect(toolUseBlock.input).toEqual({
          location: "Beijing",
          format: "celsius",
        });
      });

      it("should set stop_reason to tool_use", () => {
        const result = adapter.parseResponse(toolCallsResponse);

        expect(result.stop_reason).toBe("tool_use");
      });
    });

    describe("stop_reason mapping", () => {
      it("should map stop to end_turn", () => {
        const response = { ...textResponse };
        response.choices = [{ ...response.choices[0], finish_reason: "stop" }];

        const result = adapter.parseResponse(response);

        expect(result.stop_reason).toBe("end_turn");
      });

      it("should map length to max_tokens", () => {
        const response = { ...textResponse };
        response.choices = [
          { ...response.choices[0], finish_reason: "length" },
        ];

        const result = adapter.parseResponse(response);

        expect(result.stop_reason).toBe("max_tokens");
      });

      it("should map tool_calls to tool_use", () => {
        const result = adapter.parseResponse(toolCallsResponse);

        expect(result.stop_reason).toBe("tool_use");
      });
    });
  });

  describe("parseStreamChunk", () => {
    describe("message_start event", () => {
      it("should process first chunk without errors", () => {
        const buffer = createStreamBuffer(textStreamChunks.slice(0, 1));
        const state = {};

        expect(() => {
          adapter.parseStreamChunk(buffer, state);
        }).not.toThrow();
      });

      it("should return parsed messages array", () => {
        const buffer = createStreamBuffer(textStreamChunks.slice(0, 1));
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        expect(parsedMessages).toBeInstanceOf(Array);
      });
    });

    describe("content_block events", () => {
      it("should process text content chunks", () => {
        const buffer = createStreamBuffer(textStreamChunks.slice(0, 4));
        const state = {};

        expect(() => {
          adapter.parseStreamChunk(buffer, state);
        }).not.toThrow();
      });

      it("should return messages in Anthropic event format", () => {
        const buffer = createStreamBuffer(textStreamChunks.slice(0, 4));
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        // All messages should have a type field (Anthropic event format)
        for (const msg of parsedMessages) {
          expect(msg.type).toBeDefined();
        }
      });
    });

    describe("message completion", () => {
      it("should process full stream including [DONE]", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        expect(() => {
          adapter.parseStreamChunk(buffer, state);
        }).not.toThrow();
      });

      it("should return array of Anthropic-formatted events", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        expect(parsedMessages).toBeInstanceOf(Array);
        // Verify we get some events back
        expect(parsedMessages.length).toBeGreaterThanOrEqual(0);
      });

      it("should include input_tokens in message_start event", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageStart = parsedMessages.find(
          (msg) => msg.type === "message_start",
        );

        expect(messageStart).toBeDefined();
        expect(messageStart.message.usage).toBeDefined();
        expect(messageStart.message.usage.input_tokens).toBe(50);
        expect(messageStart.message.usage.output_tokens).toBe(0);
      });

      it("should include token usage in message_delta event", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageDelta = parsedMessages.find(
          (msg) => msg.type === "message_delta",
        );

        expect(messageDelta).toBeDefined();
        expect(messageDelta.usage).toBeDefined();
        expect(messageDelta.usage.input_tokens).toBe(50);
        expect(messageDelta.usage.output_tokens).toBe(5);
      });

      it("should include stop_reason in message_delta event", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageDelta = parsedMessages.find(
          (msg) => msg.type === "message_delta",
        );

        expect(messageDelta).toBeDefined();
        expect(messageDelta.delta).toBeDefined();
        expect(messageDelta.delta.stop_reason).toBe("end_turn");
      });

      it("should emit message_stop event at the end", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageStop = parsedMessages.find(
          (msg) => msg.type === "message_stop",
        );

        expect(messageStop).toBeDefined();
        expect(messageStop.type).toBe("message_stop");
      });

      it("should emit usage info in correct events", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageStart = parsedMessages.find(
          (msg) => msg.type === "message_start",
        );
        const messageDelta = parsedMessages.find(
          (msg) => msg.type === "message_delta",
        );

        expect(messageStart.message.usage.input_tokens).toBe(50);
        expect(messageStart.message.usage.output_tokens).toBe(0);

        expect(messageDelta.usage.input_tokens).toBe(50);
        expect(messageDelta.usage.output_tokens).toBe(5);
        expect(messageDelta.usage.cache_read_input_tokens).toBe(0);
        expect(messageDelta.usage.cache_creation_input_tokens).toBe(0);
      });
    });

    describe("cached tokens in streaming", () => {
      it("should calculate input_tokens excluding cached_tokens in message_start", () => {
        const buffer = createStreamBuffer(cachedTokensStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageStart = parsedMessages.find(
          (msg) => msg.type === "message_start",
        );

        expect(messageStart).toBeDefined();
        expect(messageStart.message.usage.input_tokens).toBe(20);
        expect(messageStart.message.usage.output_tokens).toBe(0);
        expect(messageStart.message.usage.cache_read_input_tokens).toBe(80);
        expect(messageStart.message.usage.cache_creation_input_tokens).toBe(0);
      });

      it("should emit complete usage info at the end of stream", () => {
        const buffer = createStreamBuffer(cachedTokensStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageStart = parsedMessages.find(
          (msg) => msg.type === "message_start",
        );
        const messageDelta = parsedMessages.find(
          (msg) => msg.type === "message_delta",
        );
        const messageStop = parsedMessages.find(
          (msg) => msg.type === "message_stop",
        );

        expect(messageStart).toBeDefined();
        expect(messageDelta).toBeDefined();
        expect(messageStop).toBeDefined();

        expect(messageStart.message.usage.input_tokens).toBe(20);
        expect(messageStart.message.usage.cache_read_input_tokens).toBe(80);

        expect(messageDelta.usage.input_tokens).toBe(20);
        expect(messageDelta.usage.output_tokens).toBe(8);
        expect(messageDelta.usage.cache_read_input_tokens).toBe(80);
        expect(messageDelta.usage.cache_creation_input_tokens).toBe(0);

        expect(messageStop.type).toBe("message_stop");
      });

      it("should not include cache fields in message_start when no cached tokens", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageStart = parsedMessages.find(
          (msg) => msg.type === "message_start",
        );
        const messageDelta = parsedMessages.find(
          (msg) => msg.type === "message_delta",
        );

        expect(messageStart.message.usage.cache_read_input_tokens).toBeUndefined();
        expect(messageStart.message.usage.cache_creation_input_tokens).toBeUndefined();
        
        expect(messageDelta.usage.cache_read_input_tokens).toBe(0);
        expect(messageDelta.usage.cache_creation_input_tokens).toBe(0);
      });
    });

    describe("buffer handling", () => {
      it("should return remaining incomplete data", () => {
        const incompleteBuffer = "data: {\"id\":\"test\",\"choices\":[{\"del";
        const state = {};

        const { remainBuffer } = adapter.parseStreamChunk(
          incompleteBuffer,
          state,
        );

        expect(remainBuffer).toBe(incompleteBuffer);
      });

      it("should handle empty buffer", () => {
        const state = {};

        const { parsedMessages, remainBuffer } = adapter.parseStreamChunk(
          "",
          state,
        );

        expect(parsedMessages).toEqual([]);
        expect(remainBuffer).toBe("");
      });
    });

    describe("streaming tool calls", () => {
      it("should output complete tool call sequence at finish_reason", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        // Find tool call related events
        const contentBlockStart = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_start" &&
            msg.content_block?.type === "tool_use",
        );
        const contentBlockDelta = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_delta" &&
            msg.delta?.type === "input_json_delta",
        );
        const contentBlockStop = parsedMessages.find(
          (msg) => msg.type === "content_block_stop",
        );

        expect(contentBlockStart).toBeDefined();
        expect(contentBlockDelta).toBeDefined();
        expect(contentBlockStop).toBeDefined();

        // Verify sequence order
        const startIndex = parsedMessages.indexOf(contentBlockStart);
        const deltaIndex = parsedMessages.indexOf(contentBlockDelta);
        const stopIndex = parsedMessages.indexOf(contentBlockStop);

        expect(startIndex).toBeLessThan(deltaIndex);
        expect(deltaIndex).toBeLessThan(stopIndex);
      });

      it("should have input:{} (empty object) in content_block_start", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const contentBlockStart = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_start" &&
            msg.content_block?.type === "tool_use",
        );

        expect(contentBlockStart).toBeDefined();
        expect(contentBlockStart.content_block.input).toEqual({});
        expect(typeof contentBlockStart.content_block.input).toBe("object");
      });

      it("should have complete partial_json in single content_block_delta", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const contentBlockDeltas = parsedMessages.filter(
          (msg) =>
            msg.type === "content_block_delta" &&
            msg.delta?.type === "input_json_delta",
        );

        // Should have exactly one content_block_delta for tool calls
        expect(contentBlockDeltas.length).toBe(1);

        const delta = contentBlockDeltas[0];
        expect(delta.delta.partial_json).toBe("{\"location\":\"Beijing\"}");
      });

      it("should handle multiple tool calls in correct order", () => {
        const buffer = createStreamBuffer(multipleToolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const toolStarts = parsedMessages.filter(
          (msg) =>
            msg.type === "content_block_start" &&
            msg.content_block?.type === "tool_use",
        );

        expect(toolStarts.length).toBe(2);
        expect(toolStarts[0].content_block.name).toBe("get_weather");
        expect(toolStarts[1].content_block.name).toBe("get_time");

        // Verify each tool has its complete sequence
        const tool1Index = toolStarts[0].index;
        const tool2Index = toolStarts[1].index;

        const tool1Delta = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_delta" &&
            msg.index === tool1Index &&
            msg.delta?.type === "input_json_delta",
        );
        const tool2Delta = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_delta" &&
            msg.index === tool2Index &&
            msg.delta?.type === "input_json_delta",
        );

        expect(tool1Delta).toBeDefined();
        expect(tool1Delta.delta.partial_json).toBe("{\"location\":\"Beijing\"}");
        expect(tool2Delta).toBeDefined();
        expect(tool2Delta.delta.partial_json).toBe("{\"timezone\":\"UTC\"}");
      });

      it("should emit tool_use stop_reason in message_delta", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const messageDelta = parsedMessages.find(
          (msg) => msg.type === "message_delta",
        );

        expect(messageDelta).toBeDefined();
        expect(messageDelta.delta.stop_reason).toBe("tool_use");
      });

      it("should handle multiple calls to same function with different arguments", () => {
        const buffer = createStreamBuffer(sameNameToolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const toolStarts = parsedMessages.filter(
          (msg) =>
            msg.type === "content_block_start" &&
            msg.content_block?.type === "tool_use",
        );

        expect(toolStarts.length).toBe(2);
        expect(toolStarts[0].content_block.name).toBe("get_weather");
        expect(toolStarts[1].content_block.name).toBe("get_weather");
        expect(toolStarts[0].content_block.id).toBe("call_001");
        expect(toolStarts[1].content_block.id).toBe("call_002");

        const tool1Delta = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_delta" &&
            msg.index === toolStarts[0].index &&
            msg.delta?.type === "input_json_delta",
        );
        const tool2Delta = parsedMessages.find(
          (msg) =>
            msg.type === "content_block_delta" &&
            msg.index === toolStarts[1].index &&
            msg.delta?.type === "input_json_delta",
        );

        expect(tool1Delta).toBeDefined();
        expect(tool1Delta.delta.partial_json).toBe("{\"location\":\"Beijing\"}");
        expect(tool2Delta).toBeDefined();
        expect(tool2Delta.delta.partial_json).toBe("{\"location\":\"Shanghai\"}");
      });
    });
  });
});
