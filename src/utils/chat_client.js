/**
 * Client for handling chat interactions with GitHub Copilot.
 * Manages authentication, model selection, and streaming chat requests.
 */

import { CopilotAuth } from "./auth_client.js";
import { CopilotModels } from "./model_client.js";
import { sendHttpRequest, sendHttpStreamingRequest } from "./http_utils.js";
import { editorConfig } from "../config.js";

export class CopilotChatClient {
  constructor() {
    this.auth = new CopilotAuth();
    this.models = new CopilotModels();
  }

  /**
   * Sends a streaming chat request to the Copilot API.
   *
   * @param {Array} messages - Array of chat messages to send
   * @param {Function} onResponse - Callback function to handle streaming responses
   * @param {Object} [options={}] - Additional options for the request
   * @param {Array|null} [tools=null] - Array of tools available to the model
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {Promise<{success: boolean, error?: string}>} Result of the streaming request
   */
  async sendStreamingRequest(
    messages,
    onResponse,
    options = {},
    tools = null,
    refreshToken = true,
  ) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      return await this.#doSendRequest(messages, onResponse, options, tools);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a non-streaming chat request to the Copilot API.
   *
   * @param {Array} messages - Array of chat messages to send
   * @param {Object} [options={}] - Additional options for the request
   * @param {Array|null} [tools=null] - Array of tools available to the model
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {object} Response of the non-streaming call
   */
  async sendRequest(messages, options = {}, tools = null, refreshToken = true) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      return await this.#doSendRequest(messages, null, options, tools, false);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a streaming OpenAI chat request to the Copilot API.
   *
   * @param {Array} payload - The request of OpanAI request
   * @param {Function} onResponse - Callback function to handle streaming responses
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {Promise<{success: boolean, error?: string}>} Result of the streaming request
   */
  async sendStreamingOpenaiRequest(payload, onResponse, refreshToken = true) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      return await this.#doSendOpenaiRequest(payload, onResponse);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a non-streaming OpenAI chat request to the Copilot API.
   *
   * @param {Array} payload - The request of OpanAI request
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {object} Response of the non-streaming call
   */
  async sendOpenaiRequest(payload, refreshToken = true) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      return await this.#doSendOpenaiRequest(payload);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a streaming Anthropic message request to the Copilot API.
   *
   * @param {Array} payload - The request of Anthropic message request
   * @param {Function} onResponse - Callback function to handle streaming responses
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {Promise<{success: boolean, error?: string}>} Result of the streaming request
   */
  async sendStreamingAnthropicRequest(
    payload,
    onResponse,
    refreshToken = true,
  ) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      return await this.#doSendAnthropicRequest(payload, onResponse);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a non-streaming Anthropic message request to the Copilot API.
   *
   * @param {Array} payload - The request of Anthropic message request
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {object} Response of the non-streaming call
   */
  async sendAnthropicRequest(payload, refreshToken = true) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      return await this.#doSendAnthropicRequest(payload);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async #checkGithubToken(refreshToken) {
    // Quick check if the token is valid
    const { token, expired } = this.auth.getGithubToken();
    if (!token || expired) {
      if (refreshToken) {
        await this.auth.signIn(true);
        const newStatus = this.auth.checkStatus();
        if (!newStatus.authenticated || !newStatus.tokenValid) {
          return {
            success: false,
            error: "Failed to sign in and refresh GitHub token",
          };
        }
      } else {
        return {
          success: false,
          error: "GitHub token not valid",
        };
      }
    }
    return { success: true };
  }

  async #doSendRequest(
    messages,
    onResponse,
    options = {},
    tools,
    stream = true,
  ) {
    const { token, endpoint } = this.auth.getGithubToken();
    if (!token) {
      return {
        success: false,
        error: "Could not determine GitHub token",
      };
    }
    if (!endpoint) {
      return {
        success: false,
        error: "Could not determine API endpoint",
      };
    }

    try {
      const url = new URL(`${endpoint}/chat/completions`);
      const defaultModel = await this.#getDefaultModel();
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": editorConfig.copilotIntegrationId,
        "Editor-Version": `${editorConfig.editorInfo.name}/${editorConfig.editorInfo.version}`,
        "Editor-Plugin-Version": `${editorConfig.editorPluginInfo.name}/${editorConfig.editorPluginInfo.version}`,
      };
      if (messages.some((message) => message.images)) {
        headers["Copilot-Vision-Request"] = "true";
      }
      const payload = this.#convertToOpenaiReq(
        messages,
        tools,
        options,
        options.model || defaultModel.modelConfig.modelId,
        stream,
      );

      if (stream) {
        return await sendHttpStreamingRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          payload,
          {
            onResponse,
            parseResp: this.#parseToOllamaResp,
          },
        );
      } else {
        const response = await sendHttpRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          payload,
        );
        return {
          success: true,
          data: this.#parseToNonStreamingOllamaResp(response.data),
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async #doSendOpenaiRequest(payload, onResponse = null) {
    const { token, endpoint } = this.auth.getGithubToken();
    if (!token) {
      return {
        success: false,
        error: "Could not determine GitHub token",
      };
    }
    if (!endpoint) {
      return {
        success: false,
        error: "Could not determine API endpoint",
      };
    }

    try {
      const stream = payload.stream !== undefined ? payload.stream : false;
      const url = new URL(`${endpoint}/chat/completions`);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": editorConfig.copilotIntegrationId,
        "Editor-Version": `${editorConfig.editorInfo.name}/${editorConfig.editorInfo.version}`,
      };
      const containsImageInput = payload.messages.some((message) => {
        const content = message.content;
        if (content && Array.isArray(content)) {
          return content.some((item) => item.type === "image_url");
        }
        return false;
      });
      if (containsImageInput) {
        headers["Copilot-Vision-Request"] = "true";
      }
      const defaultModel = await this.#getDefaultModel();
      if (!payload.model) {
        payload.model = defaultModel.modelConfig.modelId;
      }

      if (stream) {
        return await sendHttpStreamingRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          payload,
          {
            onResponse,
            parseResp: this.#forwardOpenaiResp,
          },
        );
      } else {
        return await sendHttpRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          payload,
        );
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async #doSendAnthropicRequest(payload, onResponse = null) {
    const { token, endpoint } = this.auth.getGithubToken();
    if (!token) {
      return {
        success: false,
        error: "Could not determine GitHub token",
      };
    }
    if (!endpoint) {
      return {
        success: false,
        error: "Could not determine API endpoint",
      };
    }

    try {
      const stream = payload.stream !== undefined ? payload.stream : false;
      const url = new URL(`${endpoint}/chat/completions`);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": editorConfig.copilotIntegrationId,
        "Editor-Version": `${editorConfig.editorInfo.name}/${editorConfig.editorInfo.version}`,
        "Editor-Plugin-Version": `${editorConfig.editorPluginInfo.name}/${editorConfig.editorPluginInfo.version}`,
      };

      const containsImageInput = payload.messages.some((message) => {
        const content = message.content;
        if (content && Array.isArray(content)) {
          return content.some((item) => item.type === "image");
        }
        return false;
      });
      if (containsImageInput) {
        headers["Copilot-Vision-Request"] = "true";
      }

      const openaiPayload = this.#convertAnthropicToOpenaiReq(payload);

      if (stream) {
        return await sendHttpStreamingRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          openaiPayload,
          {
            onResponse,
            parseResp: this.#parseToAnthropicResp,
          },
        );
      } else {
        const response = await sendHttpRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          openaiPayload,
        );
        return {
          success: true,
          data: this.#parseToNonStreamingAnthropicResp(response.data),
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async #getDefaultModel() {
    const currentModel = await this.models.getCurrentModel();
    if (currentModel.success) {
      return currentModel;
    } else {
      return {
        success: true,
        modelConfig: {
          modelId: "gpt-4o-2024-11-20",
          modelName: "GPT-4o",
          lastUpdated: "2025-04-04T04:35:49.004Z",
        },
      };
    }
  }

  #convertToOpenaiReq(messages, tools, options, model, stream) {
    const openaiReq = {
      ...options,
      model: model,
      tools: tools,
      stream: stream,
    };
    if (messages.some((message) => message.images)) {
      openaiReq.messages = messages.map((message) => {
        if (!message.images) {
          return message;
        }
        const content = [
          {
            type: "text",
            text: message.content,
          },
        ];
        const images = message.images.map((base64Image) => {
          return {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          };
        });
        content.push(...images);
        return {
          role: message.role,
          content: content,
        };
      });
    } else {
      openaiReq.messages = messages;
    }
    return openaiReq;
  }

  #convertAnthropicToOpenaiReq(payload) {
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

    if (payload.system) {
      openaiReq.messages.push({
        role: "system",
        content: payload.system,
      });
    }

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

  #parseToOllamaResp(buffer, incompleteResult) {
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

  #parseToNonStreamingOllamaResp(openaiResp) {
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

  #parseToNonStreamingAnthropicResp(openaiResp) {
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
            } catch (e) {
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

  #forwardOpenaiResp(buffer) {
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
            break;
          }
          parsedMessages.push(JSON.parse(data));
        }
      }
    }

    return {
      parsedMessages,
      remainBuffer,
    };
  }

  #parseToAnthropicResp(buffer, incompleteResult) {
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
