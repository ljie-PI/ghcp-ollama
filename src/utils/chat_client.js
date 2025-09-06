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
      console.error("Error sending chat messages:", error);
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
      console.error("Error sending chat messages:", error);
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
      console.error("Error sending chat messages:", error);
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
      console.error("Error sending chat messages:", error);
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
        console.log("GitHub token not valid, attempting to refresh...");
        await this.auth.signIn(true);
        const newStatus = this.auth.checkStatus();
        if (!newStatus.authenticated || !newStatus.tokenValid) {
          return {
            success: false,
            error: "Failed to sign in and refresh GitHub token",
          };
        }
        console.log("GitHub token refreshed successfully");
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
      console.error("Error sending chat messages:", error);
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
      console.error("Error sending chat messages:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async #getDefaultModel() {
    try {
      return this.models.getCurrentModel();
    } catch (error) {
      console.error("Error getting default model:", error);
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
          try {
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
                      try {
                        func.arguments = JSON.parse(func.arguments);
                      } catch (e) {
                        console.warn(
                          `Failed to parse arguments for tool ${func.name}(${func.arguments}) : ${e.message}`,
                        );
                      }
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
          } catch (error) {
            console.error("Error parsing data:", error, data);
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
    const prompt_eval_count = openaiResp.usage.prompt_tokens || 0;
    const eval_count = openaiResp.usage.completion_tokens || 0;
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
    for (const toolCall of parsedMessage.tool_calls) {
      if (!toolCall.function.arguments) continue;
      toolCall.function.arguments = JSON.parse(toolCall.function.arguments);
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
          try {
            parsedMessages.push(JSON.parse(data));
          } catch (error) {
            console.error("Error parsing data:", error, data);
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
