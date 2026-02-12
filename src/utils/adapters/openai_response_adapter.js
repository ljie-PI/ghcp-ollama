/**
 * Adapter for converting between OpenAI Responses API format and OpenAI Chat Completions format.
 *
 * OpenAI Responses API Format:
 * - Uses `input` instead of `messages`
 * - Uses `max_output_tokens` instead of `max_tokens`
 * - Uses output items (message, function_call) in `output` array
 * - Streaming responses are event-based with response.* event types
 *
 * This adapter handles:
 * 1. Converting Responses API requests to Chat Completions requests
 * 2. Parsing Chat Completions responses back to Responses API format
 * 3. Translating Chat Completions SSE chunks to Responses API streaming events
 */

import { BaseAdapter } from "./base_adapter.js";

export class OpenAIResponseAdapter extends BaseAdapter {
  /**
   * Converts Responses API payload to OpenAI Chat Completions format.
   *
   * @param {Object} payload - Responses API request payload
   * @param {string} [payload.model] - Model ID
   * @param {string|Array} [payload.input] - Input content (string or structured input array)
   * @param {string} [payload.instructions] - System instruction text
   * @param {Array} [payload.tools] - Tool definitions in Responses API format
   * @param {number} [payload.temperature] - Temperature
   * @param {number} [payload.top_p] - Top-p sampling
   * @param {number} [payload.max_output_tokens] - Maximum output tokens
   * @param {boolean} [payload.stream] - Whether to stream responses
   * @param {string|Object} [payload.tool_choice] - Tool choice strategy
   * @param {boolean} [payload.parallel_tool_calls] - Whether parallel tool calls are enabled
   * @param {string} [payload.user] - End-user identifier
   * @param {Object} [payload.metadata] - Additional metadata
   * @returns {Object} OpenAI Chat Completions-formatted request
   */
  convertRequest(payload) {
    const messages = parseResponseInput(payload.input);

    if (payload.instructions) {
      messages.unshift({
        role: "system",
        content: payload.instructions,
      });
    }

    return {
      model: payload.model,
      messages,
      tools: parseTools(payload.tools),
      temperature: payload.temperature,
      top_p: payload.top_p,
      max_tokens: payload.max_output_tokens,
      stream: payload.stream !== undefined ? payload.stream : false,
      tool_choice: payload.tool_choice,
      parallel_tool_calls: payload.parallel_tool_calls,
      user: payload.user,
      metadata: payload.metadata,
    };
  }

  /**
   * Detects if the Responses API payload contains image input.
   *
   * @param {Object} payload - Responses API request payload
   * @returns {boolean} True if any input item contains image input
   */
  detectVisionRequest(payload) {
    const input = payload.input;
    if (!Array.isArray(input)) {
      return false;
    }

    for (const item of input) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const content = item.content;
      if (!Array.isArray(content)) {
        continue;
      }

      if (
        content.some(
          (part) => part?.type === "input_image" || part?.type === "image_url",
        )
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Parses non-streaming Chat Completions response to Responses API format.
   *
   * @param {Object} response - Chat Completions response object
   * @returns {Object} Responses API response object
   */
  parseResponse(response) {
    const responseId = createResponseId();
    const createdAt = response.created || Math.floor(Date.now() / 1000);
    const output = [];
    const outputTextParts = [];

    for (const choice of response.choices || []) {
      const message = choice.message || {};

      if (message.content) {
        outputTextParts.push(message.content);
      }

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          output.push({
            id: toolCall.id || createFunctionCallId(),
            type: "function_call",
            status: "completed",
            name: toolCall.function?.name || "unknown",
            arguments: toolCall.function?.arguments || "{}",
            call_id: toolCall.id || createFunctionCallId(),
          });
        }
      }
    }

    const outputText = outputTextParts.join("");
    if (outputText) {
      output.unshift({
        id: createMessageId(),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      });
    }

    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status: "completed",
      model: response.model,
      output,
      output_text: outputText,
      usage: buildUsage(response.usage),
      parallel_tool_calls: true,
    };
  }

  /**
   * Parses streaming Chat Completions SSE chunks to Responses API events.
   *
   * @param {string} buffer - Raw SSE buffer from HTTP stream
   * @param {Object} state - State object for tracking incomplete data across chunks
   * @returns {{parsedMessages: Array, remainBuffer: string}} Parsed events and remaining buffer
   */
  parseStreamChunk(buffer, state) {
    const respMessages = buffer.split("\n\n");
    const remainBuffer = respMessages.pop();
    const parsedMessages = [];

    if (!state.initialized) {
      state.initialized = true;
      state.responseId = createResponseId();
      state.createdAt = Math.floor(Date.now() / 1000);
      state.model = "";
      state.outputText = "";
      state.usage = {};
      state.toolCalls = {};
      state.started = false;
    }

    for (const respMessage of respMessages) {
      if (!respMessage || respMessage.trim() === "") {
        continue;
      }

      const lines = respMessage.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const data = line.slice(6);
        if (data === "[DONE]") {
          if (state.outputText) {
            parsedMessages.push({
              type: "response.output_text.done",
              response_id: state.responseId,
              output_index: 0,
              content_index: 0,
              text: state.outputText,
            });
          }

          for (const toolCall of Object.values(state.toolCalls)) {
            parsedMessages.push({
              type: "response.function_call_arguments.done",
              response_id: state.responseId,
              output_index: toolCall.outputIndex,
              item_id: toolCall.itemId,
              arguments: toolCall.arguments,
            });
          }

          parsedMessages.push({
            type: "response.completed",
            response: {
              id: state.responseId,
              object: "response",
              created_at: state.createdAt,
              status: "completed",
              model: state.model,
              output_text: state.outputText,
              usage: buildUsage(state.usage),
            },
          });
          continue;
        }

        const parsed = JSON.parse(data);
        state.model = parsed.model || state.model;
        state.createdAt = parsed.created || state.createdAt;

        if (!state.started) {
          parsedMessages.push({
            type: "response.created",
            response: {
              id: state.responseId,
              object: "response",
              created_at: state.createdAt,
              status: "in_progress",
              model: state.model,
            },
          });
          parsedMessages.push({
            type: "response.in_progress",
            response: {
              id: state.responseId,
              object: "response",
              created_at: state.createdAt,
              status: "in_progress",
              model: state.model,
            },
          });
          state.started = true;
        }

        if (parsed.usage) {
          state.usage = {
            ...state.usage,
            ...parsed.usage,
          };
        }

        const choice = parsed.choices?.[0];
        if (!choice || !choice.delta) {
          continue;
        }

        if (choice.delta.content) {
          state.outputText += choice.delta.content;
          parsedMessages.push({
            type: "response.output_text.delta",
            response_id: state.responseId,
            output_index: 0,
            content_index: 0,
            delta: choice.delta.content,
          });
        }

        if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
          for (const toolDelta of choice.delta.tool_calls) {
            const key = toolDelta.index;

            if (!state.toolCalls[key]) {
              state.toolCalls[key] = {
                outputIndex: Number(key) + (state.outputText ? 1 : 0),
                itemId: toolDelta.id || createFunctionCallId(),
                arguments: "",
              };
            }

            if (toolDelta.id) {
              state.toolCalls[key].itemId = toolDelta.id;
            }

            if (toolDelta.function?.arguments) {
              state.toolCalls[key].arguments += toolDelta.function.arguments;
              parsedMessages.push({
                type: "response.function_call_arguments.delta",
                response_id: state.responseId,
                output_index: state.toolCalls[key].outputIndex,
                item_id: state.toolCalls[key].itemId,
                delta: toolDelta.function.arguments,
              });
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

function createResponseId() {
  return `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function createMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function createFunctionCallId() {
  return `fc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function normalizeRequestContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  const normalizedContent = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "input_text") {
      normalizedContent.push({
        type: "text",
        text: item.text || "",
      });
      continue;
    }

    if (item.type === "input_image") {
      if (item.image_url) {
        normalizedContent.push({
          type: "image_url",
          image_url: {
            url: item.image_url,
          },
        });
      }
      continue;
    }

    normalizedContent.push(item);
  }

  if (normalizedContent.length === 1 && normalizedContent[0].type === "text") {
    return normalizedContent[0].text;
  }

  return normalizedContent;
}

function parseResponseInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  const messages = [];

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "message") {
      messages.push({
        role: item.role || "user",
        content: normalizeRequestContent(item.content),
      });
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output || {}),
      });
      continue;
    }

    if (item.role) {
      messages.push({
        role: item.role,
        content: normalizeRequestContent(item.content),
      });
    }
  }

  return messages;
}

function parseTools(tools) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const openaiTools = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }

    if (tool.type !== "function") {
      continue;
    }

    if (tool.function) {
      openaiTools.push(tool);
      continue;
    }

    openaiTools.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    });
  }

  return openaiTools.length > 0 ? openaiTools : undefined;
}

function buildUsage(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens:
      usage.total_tokens ||
      (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
    },
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
    },
  };
}
