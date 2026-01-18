/**
 * Adapter for converting between Anthropic format and OpenAI format.
 * 
 * Anthropic Format:
 * - Uses `system` field for system messages (not in messages array)
 * - Uses content blocks: {type: "text", text: "..."}, {type: "image", source: {...}}
 * - Uses `tool_use` and `tool_result` blocks instead of tool_calls
 * - Uses `input_schema` for tool parameters (OpenAI uses `parameters`)
 * 
 * This adapter handles:
 * 1. Converting Anthropic requests to OpenAI format
 * 2. Parsing OpenAI responses back to Anthropic streaming event format
 * 3. Complex streaming with content blocks and tool use
 */

import { BaseAdapter } from "./base_adapter.js";

export class AnthropicAdapter extends BaseAdapter {
  /**
   * Converts Anthropic payload to OpenAI format.
   * 
   * @param {Object} payload - Anthropic request payload
   * @param {string} payload.model - Model ID
   * @param {Array} payload.messages - Array of messages with Anthropic format
   * @param {string} [payload.system] - System message (separate from messages)
   * @param {number} [payload.max_tokens] - Maximum tokens to generate
   * @param {number} [payload.temperature] - Temperature
   * @param {number} [payload.top_p] - Top-p sampling
   * @param {number} [payload.top_k] - Top-k sampling
   * @param {Array} [payload.tools] - Tool definitions (Anthropic format)
   * @param {boolean} [payload.stream] - Whether to stream responses
   * @returns {Object} OpenAI-formatted request
   */
  convertRequest(payload) {
    const openaiReq = {
      model: payload.model || "gpt-4o-2024-11-20",
      messages: [],
      stream: payload.stream !== undefined ? payload.stream : false,
    };

    if (payload.max_tokens !== undefined) {
      openaiReq.max_tokens = payload.max_tokens;
    }
    if (payload.temperature !== undefined) {
      openaiReq.temperature = payload.temperature;
    }
    if (payload.top_p !== undefined) {
      openaiReq.top_p = payload.top_p;
    }
    if (payload.top_k !== undefined) {
      openaiReq.top_k = payload.top_k;
    }

    // System message handling (Anthropic has separate system field)
    if (payload.system) {
      openaiReq.messages.push({
        role: "system",
        content: payload.system,
      });
    }

    // Convert Anthropic tools to OpenAI tools
    const convertedTools = [];
    if (payload.tools && payload.tools.length > 0) {
      for (const tool of payload.tools) {
        if (tool.type === "function" && tool.function) {
          convertedTools.push({
            type: "function",
            function: {
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.input_schema,
            },
          });
        } else if (tool.name && tool.input_schema) {
          convertedTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          });
        }
      }
      openaiReq.tools = convertedTools;
    }

    // Convert messages
    for (const message of payload.messages) {
      const openaiMessage = {
        role: message.role === "assistant" ? "assistant" : "user",
      };

      if (Array.isArray(message.content)) {
        const content = [];
        for (const block of message.content) {
          if (block.type === "text") {
            content.push({
              type: "text",
              text: block.text,
            });
          } else if (block.type === "image") {
            const mediaType = block.source.media_type || "image/jpeg";
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${mediaType};base64,${block.source.data}`,
              },
            });
          } else if (
            block.type === "tool_use" &&
            message.role === "assistant"
          ) {
            if (!openaiMessage.tool_calls) {
              openaiMessage.tool_calls = [];
            }
            openaiMessage.tool_calls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input),
              },
            });
          } else if (block.type === "tool_result") {
            if (!openaiMessage.tool_calls) {
              openaiMessage.tool_calls = [];
            }
            openaiMessage.tool_calls.push({
              id: block.tool_use_id,
              type: "function",
              function: {
                name: "tool_result",
                arguments: JSON.stringify({ result: block.content }),
              },
            });
          }
        }
        if (content.length > 0) {
          openaiMessage.content = content;
        }
      } else {
        openaiMessage.content = message.content;
      }

      openaiReq.messages.push(openaiMessage);
    }

    return openaiReq;
  }

  /**
   * Detects if the Anthropic payload contains image input.
   * 
   * @param {Object} payload - Anthropic request payload
   * @returns {boolean} True if any message contains image blocks
   */
  detectVisionRequest(payload) {
    const messages = payload.messages || [];
    return messages.some((message) => {
      const content = message.content;
      if (content && Array.isArray(content)) {
        return content.some((item) => item.type === "image");
      }
      return false;
    });
  }

  /**
   * Parses non-streaming OpenAI response to Anthropic format.
   * 
   * @param {Object} openaiResp - OpenAI response object
   * @returns {Object} Anthropic-formatted response
   */
  parseResponse(openaiResp) {
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const contentBlocks = [];

    for (const choice of openaiResp.choices) {
      const message = choice.message;

      if (message?.content && message.content !== "") {
        contentBlocks.push({
          type: "text",
          text: message.content,
        });
      }

      if (message?.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          let input = {};
          if (toolCall.function?.arguments) {
            try {
              input = JSON.parse(toolCall.function.arguments);
            } catch {
              input = { arguments: toolCall.function.arguments };
            }
          }

          contentBlocks.push({
            type: "tool_use",
            id:
              toolCall.id ||
              `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: toolCall.function?.name || "unknown",
            input: input,
          });
        }
      }
    }

    const finishReason = openaiResp.choices[0]?.finish_reason || "stop";
    const stopReasonMap = {
      stop: "end_turn",
      length: "max_tokens",
      tool_calls: "tool_use",
      content_filter: "stop_sequence",
    };

    return {
      id: messageId,
      type: "message",
      role: "assistant",
      content: contentBlocks,
      model: openaiResp.model,
      stop_reason: stopReasonMap[finishReason] || "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: openaiResp.usage?.prompt_tokens || 0,
        output_tokens: openaiResp.usage?.completion_tokens || 0,
      },
    };
  }

  /**
   * Parses streaming OpenAI SSE response chunks to Anthropic streaming event format.
   * 
   * Anthropic uses a complex streaming protocol with events:
   * - message_start: Initial message metadata
   * - content_block_start: Start of a new content block (text or tool_use)
   * - content_block_delta: Incremental content within a block
   * - content_block_stop: End of a content block
   * - message_delta: Final message metadata (stop_reason, usage)
   * - message_stop: End of stream
   * 
   * @param {string} buffer - Raw SSE buffer from HTTP stream
   * @param {Object} incompleteResult - State object for tracking incomplete data across chunks
   * @returns {{parsedMessages: Array, remainBuffer: string}} Parsed Anthropic events and remaining buffer
   */
  parseStreamChunk(buffer, incompleteResult) {
    const respMessages = buffer.split("\n\n");
    const remainBuffer = respMessages.pop();
    const parsedMessages = [];

    for (const respMessage of respMessages) {
      if (!respMessage || respMessage.trim() === "") continue;

      const lines = respMessage.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            if (incompleteResult.hasStartedCurrentBlock) {
              parsedMessages.push({
                type: "content_block_stop",
                index: incompleteResult.currentIndex,
              });
            }
            if (incompleteResult.outputTokens > 0) {
              parsedMessages.push({
                type: "message_delta",
                delta: {
                  stop_reason: incompleteResult.stopReason || "end_turn",
                  stop_sequence: null,
                },
                usage: {
                  input_tokens: incompleteResult.inputTokens,
                  output_tokens: incompleteResult.outputTokens,
                },
              });
            }
            parsedMessages.push({ type: "message_stop" });
            incompleteResult = {};
            break;
          }

          const parsed = JSON.parse(data);

          if (!incompleteResult.hasStarted) {
            incompleteResult.messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            incompleteResult.model = parsed.model;
            incompleteResult.currentIndex = -1;
            incompleteResult.contentBlocks = [];
            incompleteResult.textAccumulator = "";
            incompleteResult.hasStarted = true;
            incompleteResult.hasStartedCurrentBlock = false;
            incompleteResult.stopReason = null;
            incompleteResult.outputTokens = 0;
            incompleteResult.inputTokens = 0;

            parsedMessages.push({
              type: "message_start",
              message: {
                id: incompleteResult.messageId,
                type: "message",
                role: "assistant",
                content: [],
                model: incompleteResult.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: parsed.usage?.prompt_tokens || 0,
                  output_tokens: 0,
                },
              },
            });

            if (parsed.usage?.prompt_tokens) {
              incompleteResult.inputTokens = parsed.usage.prompt_tokens;
            }
          } else if (parsed.usage?.prompt_tokens) {
            incompleteResult.inputTokens = parsed.usage.prompt_tokens;
          }

          if (parsed.choices && parsed.choices[0]) {
            const choice = parsed.choices[0];

            if (choice.delta?.content) {
              if (!incompleteResult.hasStartedCurrentBlock) {
                incompleteResult.currentIndex++;
                incompleteResult.hasStartedCurrentBlock = true;
                incompleteResult.textAccumulator = "";
                incompleteResult.currentType = "text";
                parsedMessages.push({
                  type: "content_block_start",
                  index: incompleteResult.currentIndex,
                  content_block: { type: "text", text: "" },
                });
              }
              parsedMessages.push({
                type: "content_block_delta",
                index: incompleteResult.currentIndex,
                delta: { type: "text", text: choice.delta.content },
              });
              incompleteResult.textAccumulator += choice.delta.content;
            }

            if (
              choice.delta?.tool_calls &&
              choice.delta.tool_calls.length > 0
            ) {
              if (!incompleteResult.functions) {
                incompleteResult.functions = {};
              }
              if (!incompleteResult.currentToolFunc) {
                incompleteResult.currentToolFunc = null;
              }

              choice.delta.tool_calls.forEach((toolCallDelta) => {
                const toolFunc = toolCallDelta.function;
                if (toolFunc.name) {
                  const toolId =
                    toolCallDelta.id ||
                    `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                  if (!incompleteResult.functions[toolFunc.name]) {
                    incompleteResult.functions[toolFunc.name] = {
                      id: toolId,
                      name: toolFunc.name,
                      input: "",
                    };
                    incompleteResult.currentToolFunc =
                      incompleteResult.functions[toolFunc.name];

                    if (
                      incompleteResult.hasStartedCurrentBlock &&
                      incompleteResult.currentType === "text"
                    ) {
                      parsedMessages.push({
                        type: "content_block_stop",
                        index: incompleteResult.currentIndex,
                      });
                    }

                    incompleteResult.currentIndex++;
                    incompleteResult.hasStartedCurrentBlock = true;
                    incompleteResult.currentType = "tool_use";
                    parsedMessages.push({
                      type: "content_block_start",
                      index: incompleteResult.currentIndex,
                      content_block: {
                        type: "tool_use",
                        id: toolId,
                        name: toolFunc.name,
                        input: "",
                      },
                    });
                  }
                }
                if (toolFunc.arguments && incompleteResult.currentToolFunc) {
                  incompleteResult.currentToolFunc.input += toolFunc.arguments;
                  parsedMessages.push({
                    type: "content_block_delta",
                    index: incompleteResult.currentIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: toolFunc.arguments,
                    },
                  });
                }
              });
            }

            if (choice.finish_reason) {
              if (incompleteResult.functions) {
                Object.values(incompleteResult.functions).forEach((func) => {
                  if (func.input && typeof func.input === "string") {
                    try {
                      func.input = JSON.parse(func.input);
                    } catch {
                      // Keep input as string if not valid JSON
                    }
                  }
                });
              }

              const stopReasonMap = {
                stop: "end_turn",
                length: "max_tokens",
                tool_calls: "tool_use",
                content_filter: "refusal",
              };
              incompleteResult.stopReason =
                stopReasonMap[choice.finish_reason] || "end_turn";
              incompleteResult.outputTokens =
                parsed.usage?.completion_tokens || 0;
            }
          }
        }
      }
    }

    return {
      parsedMessages,
      remainBuffer,
    };
  }
}
