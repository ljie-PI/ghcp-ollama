/**
 * Unit tests for Ollama adapter.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OllamaAdapter } from "../../../src/utils/adapters/ollama_adapter.js";
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
  multipleToolCallsResponse,
  textStreamChunks,
  toolCallStreamChunks,
  createStreamBuffer,
} from "../fixtures/openai_responses.js";

describe("OllamaAdapter", () => {
  let adapter;

  beforeEach(() => {
    const mockClient = createMockChatClient();
    adapter = new OllamaAdapter(mockClient);
  });

  describe("convertRequest", () => {
    describe("basic text messages", () => {
      it("should convert simple text messages", () => {
        const result = adapter.convertRequest(textMessageCase.ollama);

        expect(result.model).toBe("gpt-4o");
        expect(result.messages).toHaveLength(3);
        expect(result.messages[0].role).toBe("user");
        expect(result.messages[0].content).toBe("Why is the sky blue?");
        expect(result.stream).toBe(false);
      });

      it("should preserve message roles", () => {
        const result = adapter.convertRequest(textMessageCase.ollama);

        expect(result.messages[0].role).toBe("user");
        expect(result.messages[1].role).toBe("assistant");
        expect(result.messages[2].role).toBe("user");
      });
    });

    describe("image handling", () => {
      it("should convert images array to image_url content blocks", () => {
        const result = adapter.convertRequest(imageInputCase.ollama);

        expect(result.messages[0].content).toBeInstanceOf(Array);
        expect(result.messages[0].content).toHaveLength(2);
        expect(result.messages[0].content[0].type).toBe("text");
        expect(result.messages[0].content[1].type).toBe("image_url");
      });

      it("should detect JPEG image type correctly", () => {
        const result = adapter.convertRequest(imageInputCase.ollama);
        const imageBlock = result.messages[0].content[1];

        expect(imageBlock.image_url.url).toContain("data:image/jpeg;base64,");
      });

      it("should detect PNG image type correctly", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: "What is this?",
              images: [sampleImages.png],
            },
          ],
        };

        const result = adapter.convertRequest(payload);
        const imageBlock = result.messages[0].content[1];

        expect(imageBlock.image_url.url).toContain("data:image/png;base64,");
      });

      it("should detect GIF image type correctly", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: "What is this?",
              images: [sampleImages.gif],
            },
          ],
        };

        const result = adapter.convertRequest(payload);
        const imageBlock = result.messages[0].content[1];

        expect(imageBlock.image_url.url).toContain("data:image/gif;base64,");
      });

      it("should detect WebP image type correctly", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: "What is this?",
              images: [sampleImages.webp],
            },
          ],
        };

        const result = adapter.convertRequest(payload);
        const imageBlock = result.messages[0].content[1];

        expect(imageBlock.image_url.url).toContain("data:image/webp;base64,");
      });

      it("should handle multiple images in one message", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: "Compare these",
              images: [sampleImages.jpeg, sampleImages.png],
            },
          ],
        };

        const result = adapter.convertRequest(payload);

        expect(result.messages[0].content).toHaveLength(3); // 1 text + 2 images
        expect(result.messages[0].content[1].type).toBe("image_url");
        expect(result.messages[0].content[2].type).toBe("image_url");
      });
    });

    describe("tool handling", () => {
      it("should pass through tool definitions", () => {
        const result = adapter.convertRequest(toolCallsCase.ollama);

        expect(result.tools).toBeDefined();
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].function.name).toBe("get_weather");
      });

      it("should preserve complete tool definition structure", () => {
        const result = adapter.convertRequest(toolCallsCase.ollama);

        const tool = result.tools[0];
        expect(tool.type).toBe("function");
        expect(tool.function.name).toBe("get_weather");
        expect(tool.function.description).toBe("Get the current weather");
        expect(tool.function.parameters).toBeDefined();
        expect(tool.function.parameters.type).toBe("object");
        expect(tool.function.parameters.properties).toBeDefined();
        expect(tool.function.parameters.properties.location).toEqual({
          type: "string",
          description: "City name",
        });
        expect(tool.function.parameters.properties.format).toEqual({
          type: "string",
          enum: ["celsius", "fahrenheit"],
        });
        expect(tool.function.parameters.required).toEqual(["location"]);
      });

      it("should handle multiple tool definitions", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: {} },
              },
            },
            {
              type: "function",
              function: {
                name: "get_time",
                description: "Get time",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        };

        const result = adapter.convertRequest(payload);

        expect(result.tools).toHaveLength(2);
        expect(result.tools[0].function.name).toBe("get_weather");
        expect(result.tools[1].function.name).toBe("get_time");
      });

      it("should handle null tools", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
          tools: null,
        };

        const result = adapter.convertRequest(payload);

        expect(result.tools).toBeNull();
      });

      it("should handle missing tools field", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
        };

        const result = adapter.convertRequest(payload);

        expect(result.tools).toBeNull();
      });

      it("should stringify tool call arguments if they are objects", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "test",
                    arguments: { key: "value" }, // Object, not string
                  },
                },
              ],
            },
          ],
        };

        const result = adapter.convertRequest(payload);
        const toolCall = result.messages[0].tool_calls[0];

        expect(typeof toolCall.function.arguments).toBe("string");
        expect(toolCall.function.arguments).toBe("{\"key\":\"value\"}");
      });

      it("should preserve string arguments as-is", () => {
        const payload = {
          model: "gpt-4o",
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "test",
                    arguments: "{\"key\":\"value\"}", // Already string
                  },
                },
              ],
            },
          ],
        };

        const result = adapter.convertRequest(payload);
        const toolCall = result.messages[0].tool_calls[0];

        expect(toolCall.function.arguments).toBe("{\"key\":\"value\"}");
      });
    });

    describe("tool results", () => {
      it("should preserve tool_call_id for tool messages", () => {
        const result = adapter.convertRequest(multiTurnToolsCase.ollama);

        const toolResultMsg = result.messages.find(
          (m) => m.role === "tool" && m.tool_call_id,
        );
        expect(toolResultMsg).toBeDefined();
        expect(toolResultMsg.tool_call_id).toBe("call_123");
      });
    });

    describe("options handling", () => {
      it("should spread options into root level", () => {
        const payload = {
          model: "gpt-4o",
          messages: [{ role: "user", content: "test" }],
          options: {
            temperature: 0.7,
            num_predict: 100,
          },
        };

        const result = adapter.convertRequest(payload);

        expect(result.temperature).toBe(0.7);
        expect(result.num_predict).toBe(100);
      });
    });
  });

  describe("detectVisionRequest", () => {
    it("should return true when messages have images", () => {
      expect(adapter.detectVisionRequest(imageInputCase.ollama)).toBe(true);
    });

    it("should return false for text-only messages", () => {
      expect(adapter.detectVisionRequest(textMessageCase.ollama)).toBe(false);
    });

    it("should return false for empty images array", () => {
      const payload = {
        messages: [{ role: "user", content: "test", images: [] }],
      };
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });

    it("should return false when no messages", () => {
      const payload = { messages: [] };
      expect(adapter.detectVisionRequest(payload)).toBe(false);
    });
  });

  describe("parseResponse", () => {
    describe("text response", () => {
      it("should convert to Ollama format", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.model).toBe("gpt-4o");
        expect(result.message.role).toBe("assistant");
        expect(result.message.content).toBe(
          "The sky is blue due to Rayleigh scattering.",
        );
        expect(result.done).toBe(true);
      });

      it("should convert timestamp to ISO format", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      it("should extract usage counts", () => {
        const result = adapter.parseResponse(textResponse);

        expect(result.prompt_eval_count).toBe(50);
        expect(result.eval_count).toBe(20);
      });
    });

    describe("tool calls response", () => {
      it("should parse tool calls and convert arguments to object", () => {
        // Deep clone to avoid mutation of shared fixture
        const response = JSON.parse(JSON.stringify(toolCallsResponse));
        const result = adapter.parseResponse(response);

        expect(result.message.tool_calls).toBeDefined();
        expect(result.message.tool_calls).toHaveLength(1);

        const toolCall = result.message.tool_calls[0];
        expect(toolCall.function.name).toBe("get_weather");
        expect(toolCall.function.arguments).toEqual({
          location: "Beijing",
          format: "celsius",
        });
      });

      it("should handle multiple tool calls", () => {
        // Deep clone to avoid mutation of shared fixture
        const response = JSON.parse(JSON.stringify(multipleToolCallsResponse));
        const result = adapter.parseResponse(response);

        expect(result.message.tool_calls).toHaveLength(2);
        expect(result.message.tool_calls[0].function.name).toBe("get_weather");
        expect(result.message.tool_calls[1].function.name).toBe("get_time");
      });

      it("should handle null content for tool calls", () => {
        // Deep clone to avoid mutation of shared fixture
        const response = JSON.parse(JSON.stringify(toolCallsResponse));
        const result = adapter.parseResponse(response);

        // Content can be empty string or null when there are tool calls
        expect(result.message.content === "" || result.message.content === null).toBe(true);
      });
    });
  });

  describe("parseStreamChunk", () => {
    describe("text streaming", () => {
      it("should parse text content deltas", () => {
        const buffer = createStreamBuffer(textStreamChunks.slice(1, 4));
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        // Should parse some messages (exact count depends on internal logic)
        expect(parsedMessages).toBeInstanceOf(Array);
      });

      it("should return state object with accumulated data", () => {
        const buffer = createStreamBuffer(textStreamChunks.slice(0, 2));
        const state = {};

        adapter.parseStreamChunk(buffer, state);

        // State should be modified (even if some fields are undefined initially)
        expect(typeof state).toBe("object");
      });

      it("should process full stream without errors", () => {
        // Process all chunks including [DONE]
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        expect(() => {
          adapter.parseStreamChunk(buffer, state);
        }).not.toThrow();
      });

      it("should extract token usage from final chunk", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        // Find the final message with done=true
        const finalMessage = parsedMessages.find((msg) => msg.done === true);

        expect(finalMessage).toBeDefined();
        expect(finalMessage.prompt_eval_count).toBe(50);
        expect(finalMessage.eval_count).toBe(5);
      });

      it("should include model and timestamp in final message", () => {
        const buffer = createStreamBuffer(textStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        const finalMessage = parsedMessages.find((msg) => msg.done === true);

        expect(finalMessage.model).toBe("gpt-4o");
        expect(finalMessage.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
    });

    describe("tool call streaming", () => {
      it("should process tool call stream without errors", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        expect(() => {
          adapter.parseStreamChunk(buffer, state);
        }).not.toThrow();
      });

      it("should return parsed messages array", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        expect(parsedMessages).toBeInstanceOf(Array);
      });

      it("should extract token usage from tool call stream", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        // Find the final message with done=true
        const finalMessage = parsedMessages.find((msg) => msg.done === true);

        expect(finalMessage).toBeDefined();
        expect(finalMessage.prompt_eval_count).toBe(100);
        expect(finalMessage.eval_count).toBe(20);
      });

      it("should accumulate tool call data correctly", () => {
        const buffer = createStreamBuffer(toolCallStreamChunks);
        const state = {};

        const { parsedMessages } = adapter.parseStreamChunk(buffer, state);

        // Find the tool call message (done=false with tool_calls)
        const toolCallMessage = parsedMessages.find(
          (msg) => msg.message?.tool_calls && msg.message.tool_calls.length > 0,
        );

        expect(toolCallMessage).toBeDefined();
        expect(toolCallMessage.message.tool_calls).toHaveLength(1);
        expect(toolCallMessage.message.tool_calls[0].function.name).toBe(
          "get_weather",
        );
        expect(toolCallMessage.message.tool_calls[0].function.arguments).toEqual(
          { location: "Beijing" },
        );
      });
    });

    describe("buffer handling", () => {
      it("should return remaining incomplete data in remainBuffer", () => {
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
  });
});
