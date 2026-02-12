/**
 * Client for handling chat interactions with GitHub Copilot.
 * Manages authentication, model selection, and streaming chat requests.
 * 
 * This client uses an adapter pattern to support multiple API formats:
 * - Ollama format
 * - OpenAI format
 * - Anthropic format
 * 
 * All formats are converted to OpenAI format before sending to GitHub Copilot API,
 * then responses are converted back to the original format.
 */

import { CopilotAuth } from "./auth_client.js";
import { CopilotModels } from "./model_client.js";
import { sendHttpRequest, sendHttpStreamingRequest } from "./http_utils.js";
import { editorConfig } from "../config.js";
import { OllamaAdapter } from "./adapters/ollama_adapter.js";
import { OpenAIAdapter } from "./adapters/openai_adapter.js";
import { AnthropicAdapter } from "./adapters/anthropic_adapter.js";
import { OpenAIResponseAdapter } from "./adapters/openai_response_adapter.js";

export class CopilotChatClient {
  constructor() {
    this.auth = new CopilotAuth();
    this.models = new CopilotModels();
    
    // Initialize adapters for each API format
    this.#adapters = {
      ollama: new OllamaAdapter(this),
      openai: new OpenAIAdapter(this),
      anthropic: new AnthropicAdapter(this),
      response: new OpenAIResponseAdapter(this),
    };
  }

  #adapters;

  /**
   * Sends a streaming chat request (OLD Ollama API - for backward compatibility).
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
    // Convert old Ollama API to new unified format
    const defaultModel = await this.#getDefaultModel();
    const payload = {
      model: options.model || defaultModel.modelConfig.modelId,
      messages: messages,
      options: options,
      tools: tools,
      stream: true,
    };
    
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      const adapter = this.#adapters.ollama;
      return await this.#doSendUnified(adapter, payload, onResponse, true);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a non-streaming chat request (OLD Ollama API - for backward compatibility).
   *
   * @param {Array} messages - Array of chat messages to send
   * @param {Object} [options={}] - Additional options for the request
   * @param {Array|null} [tools=null] - Array of tools available to the model
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {object} Response of the non-streaming call
   */
  async sendRequest(messages, options = {}, tools = null, refreshToken = true) {
    // Convert old Ollama API to new unified format
    const defaultModel = await this.#getDefaultModel();
    const payload = {
      model: options.model || defaultModel.modelConfig.modelId,
      messages: messages,
      options: options,
      tools: tools,
      stream: false,
    };
    
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      const adapter = this.#adapters.ollama;
      return await this.#doSendUnified(adapter, payload, null, false);
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
   * @param {Object} payload - The OpenAI request payload
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

      const adapter = this.#adapters.openai;
      return await this.#doSendUnified(adapter, payload, onResponse, true);
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
   * @param {Object} payload - The OpenAI request payload
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

      const adapter = this.#adapters.openai;
      return await this.#doSendUnified(adapter, payload, null, false);
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
   * @param {Object} payload - The Anthropic request payload
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

      const adapter = this.#adapters.anthropic;
      return await this.#doSendUnified(adapter, payload, onResponse, true);
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
   * @param {Object} payload - The Anthropic request payload
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

      const adapter = this.#adapters.anthropic;
      return await this.#doSendUnified(adapter, payload, null, false);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }


  /**
   * Sends a streaming OpenAI Responses API request.
   *
   * @param {Object} payload - The OpenAI responses request payload
   * @param {Function} onResponse - Callback function to handle streaming responses
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {Promise<{success: boolean, error?: string}>} Result of the streaming request
   */
  async sendStreamingResponseRequest(payload, onResponse, refreshToken = true) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      const adapter = this.#adapters.response;
      return await this.#doSendUnified(adapter, payload, onResponse, true);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Sends a non-streaming OpenAI Responses API request.
   *
   * @param {Object} payload - The OpenAI responses request payload
   * @param {boolean} [refreshToken=true] - Whether to attempt token refresh if invalid
   *
   * @returns {object} Response of the non-streaming call
   */
  async sendResponseRequest(payload, refreshToken = true) {
    try {
      const tokenStatus = await this.#checkGithubToken(refreshToken);
      if (!tokenStatus.success) {
        return tokenStatus;
      }

      const adapter = this.#adapters.response;
      return await this.#doSendUnified(adapter, payload, null, false);
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Checks if the GitHub token is valid and refreshes if needed.
   * @private
   */
  async #checkGithubToken(refreshToken) {
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

  /**
   * Unified request handler for all API types.
   * Uses adapters to convert between API formats and OpenAI format.
   * @private
   */
  async #doSendUnified(adapter, payload, onResponse, stream) {
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
      
      // Build headers
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": editorConfig.copilotIntegrationId,
        "Editor-Version": `${editorConfig.editorInfo.name}/${editorConfig.editorInfo.version}`,
        "Editor-Plugin-Version": `${editorConfig.editorPluginInfo.name}/${editorConfig.editorPluginInfo.version}`,
      };

      // Detect vision request using adapter
      if (adapter.detectVisionRequest(payload)) {
        headers["Copilot-Vision-Request"] = "true";
      }

      // Convert payload to OpenAI format using adapter
      const openaiPayload = adapter.convertRequest(payload);
      
      // Set default model if not specified
      if (!openaiPayload.model) {
        const defaultModel = await this.#getDefaultModel();
        openaiPayload.model = defaultModel.modelConfig.modelId;
      }

      // Handle streaming vs non-streaming
      if (stream) {
        return await sendHttpStreamingRequest(
          url.hostname,
          url.pathname,
          "POST",
          headers,
          openaiPayload,
          {
            onResponse,
            parseResp: (buffer, state) => adapter.parseStreamChunk(buffer, state || {}),
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
          data: adapter.parseResponse(response.data),
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Gets the default model configuration.
   * @private
   */
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
}
