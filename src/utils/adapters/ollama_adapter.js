/**
 * Adapter for converting between Ollama format and OpenAI format.
 * 
 * Ollama Format:
 * - Uses `images` field for base64 image data
 * - Uses `options` object for temperature, num_predict, etc.
 * - Supports tool_calls and tool results in messages
 * 
 * This adapter handles:
 * 1. Converting Ollama requests to OpenAI format
 * 2. Parsing OpenAI responses back to Ollama format
 * 3. Handling streaming responses with tool calls
 */

import { BaseAdapter } from "./base_adapter.js";
import { detectImageType } from "../image_utils.js";

export class OllamaAdapter extends BaseAdapter {
  /**
   * Converts Ollama payload to OpenAI format.
   * 
   * @param {Object} payload - Ollama request payload
   * @param {string} payload.model - Model ID
   * @param {Array} payload.messages - Array of messages with Ollama format
   * @param {Object} [payload.options] - Ollama-specific options (temperature, num_predict, etc.)
   * @param {Array} [payload.tools] - Tool definitions
   * @param {boolean} [payload.stream] - Whether to stream responses
   * @returns {Object} OpenAI-formatted request
   */
  convertRequest(payload) {
    const messages = payload.messages || [];
    const tools = payload.tools || null;
    const options = payload.options || {};
    const model = payload.model;
    const stream = payload.stream !== undefined ? payload.stream : false;

    const openaiReq = {
      ...options,
      model: model,
      tools: tools,
      stream: stream,
      messages: [],
    };

    // Convert each message to OpenAI format
    // Support: text content (string/array), images, tool_calls, tool results
    for (const message of messages) {
      const openaiMessage = {
        role: message.role,
      };

      // Handle content: prioritize images > existing content format
      if (message.images && message.images.length > 0) {
        // Ollama images format → OpenAI image_url format
        const content = [];

        // Add text content if present
        if (message.content) {
          content.push({
            type: "text",
            text: message.content,
          });
        }

        // Add images as image_url blocks with auto-detected media type
        message.images.forEach((base64Image) => {
          const mediaType = detectImageType(base64Image);
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${mediaType};base64,${base64Image}`,
            },
          });
        });

        openaiMessage.content = content;
      } else if (message.content !== undefined) {
        // Preserve original content format (string or array)
        openaiMessage.content = message.content;
      }

      // Handle tool_calls (for assistant messages)
      if (message.tool_calls && message.tool_calls.length > 0) {
        openaiMessage.tool_calls = message.tool_calls.map((tc) => {
          const toolCall = {
            type: tc.type || "function",
            function: {
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === "string"
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
            },
          };

          if (tc.id) {
            toolCall.id = tc.id;
          }

          return toolCall;
        });
      }

      // Handle tool result messages (role="tool")
      if (message.tool_call_id) {
        openaiMessage.tool_call_id = message.tool_call_id;
      }

      // Handle function messages (role="function")
      if (
        message.name &&
        (message.role === "function" || message.role === "tool")
      ) {
        openaiMessage.name = message.name;
      }

      openaiReq.messages.push(openaiMessage);
    }

    return openaiReq;
  }

  /**
   * Detects if the Ollama payload contains image input.
   * 
   * @param {Object} payload - Ollama request payload
   * @returns {boolean} True if any message contains images
   */
  detectVisionRequest(payload) {
    const messages = payload.messages || [];
    return messages.some((message) => message.images && message.images.length > 0);
  }

  /**
   * Parses non-streaming OpenAI response to Ollama format.
   * 
   * @param {Object} openaiResp - OpenAI response object
   * @returns {Object} Ollama-formatted response
   */
  parseResponse(openaiResp) {
    const model = openaiResp.model;
    const createTimeString = openaiResp.created
      ? new Date(openaiResp.created * 1000).toISOString()
      : new Date().toISOString();
    const prompt_eval_count = openaiResp.usage?.prompt_tokens || 0;
    const eval_count = openaiResp.usage?.completion_tokens || 0;
    const parsedMessage = {
      role: "assistant",
      content: "",
    };
    for (const choice of openaiResp.choices) {
      if (choice.message?.content) {
        parsedMessage.content += choice.message.content;
      }
      if (choice.message?.tool_calls) {
        if (!parsedMessage.tool_calls) {
          parsedMessage.tool_calls = [];
        }
        parsedMessage.tool_calls.push(...choice.message.tool_calls);
      }
    }
    if (parsedMessage.tool_calls) {
      for (const toolCall of parsedMessage.tool_calls) {
        if (!toolCall.function?.arguments) continue;
        toolCall.function.arguments = JSON.parse(toolCall.function.arguments);
      }
    }
    return {
      model: model,
      created_at: createTimeString,
      message: parsedMessage,
      done: true,
      prompt_eval_count: prompt_eval_count,
      eval_count: eval_count,
    };
  }

  /**
   * Parses streaming OpenAI SSE response chunks to Ollama format.
   * 
   * This method handles:
   * - Text content streaming
   * - Tool calls accumulation (functions are built incrementally)
   * - [DONE] event handling
   * - Usage statistics
   * 
   * @param {string} buffer - Raw SSE buffer from HTTP stream
   * @param {Object} incompleteResult - State object for tracking incomplete data across chunks
   * @returns {{parsedMessages: Array, remainBuffer: string}} Parsed Ollama messages and remaining buffer
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
            if (
              incompleteResult.functions &&
              Object.keys(incompleteResult.functions).length > 0
            ) {
              const toolCalls = Object.values(incompleteResult.functions).map(
                (func) => ({
                  function: { ...func },
                }),
              );

              const toolCallMessage = {
                done: false,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: toolCalls,
                },
                model: incompleteResult.model || "",
                created_at:
                  incompleteResult.created_at || new Date().toISOString(),
              };
              parsedMessages.push(toolCallMessage);
              incompleteResult.currentToolFunc = null;
              delete incompleteResult.functions;
            }
            const parsedMessage = {
              ...incompleteResult,
              done: true,
              message: {
                role: "assistant",
                content: "",
              },
            };
            parsedMessages.push(parsedMessage);
            incompleteResult = {};
            break;
          }
          const parsed = JSON.parse(data);
          const createTimeString = parsed.created
            ? new Date(parsed.created * 1000).toISOString()
            : new Date().toISOString();
          if (parsed.choices && parsed.choices[0]) {
            const choice = parsed.choices[0];
            if (choice.finish_reason) {
              if (
                choice.finish_reason === "tool_calls" &&
                incompleteResult.functions
              ) {
                Object.values(incompleteResult.functions).forEach((func) => {
                  if (func.arguments) {
                    func.arguments = JSON.parse(func.arguments);
                  }
                });
              }
              const usage = parsed.usage;
              if (usage) {
                incompleteResult = {
                  ...incompleteResult,
                  done_reason: "stop",
                  model: parsed.model,
                  created_at: createTimeString,
                  prompt_eval_count: usage.prompt_tokens || 0,
                  eval_count: usage.completion_tokens || 0,
                };
              }
            }
            if (choice.delta) {
              if (choice.delta.content) {
                const parsedMessage = {
                  done: false,
                  message: {
                    role: "assistant",
                    content: choice.delta.content ?? "",
                  },
                  model: parsed.model,
                  created_at: createTimeString,
                };
                parsedMessages.push(parsedMessage);
              }
              if (
                choice.delta.tool_calls &&
                choice.delta.tool_calls.length > 0
              ) {
                if (!incompleteResult.functions) {
                  incompleteResult.functions = {};
                  incompleteResult.currentToolFunc = null;
                }
                if (!incompleteResult.model)
                  incompleteResult.model = parsed.model;
                if (!incompleteResult.created_at)
                  incompleteResult.created_at = createTimeString;

                choice.delta.tool_calls.forEach((toolCallDelta) => {
                  const toolFunc = toolCallDelta.function;
                  if (toolFunc.name) {
                    incompleteResult.functions[toolFunc.name] = {
                      name: toolFunc.name,
                      arguments: "",
                    };
                    incompleteResult.currentToolFunc =
                      incompleteResult.functions[toolFunc.name];
                  }
                  if (toolFunc.arguments) {
                    incompleteResult.currentToolFunc.arguments +=
                      toolFunc.arguments;
                  }
                });
              }
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
