/**
 * Base adapter class for converting between different API formats and OpenAI format.
 * All specific adapters (Ollama, OpenAI, Anthropic) should extend this class.
 * 
 * The adapter pattern allows for:
 * - Clean separation of concerns (each API format has its own adapter)
 * - Easy testing (adapters can be tested independently)
 * - Simple extensibility (new API formats = new adapters)
 */
export class BaseAdapter {
  /**
   * Creates a new adapter instance.
   * @param {import('../chat_client.js').CopilotChatClient} chatClient - Reference to the parent chat client
   */
  constructor(chatClient) {
    if (new.target === BaseAdapter) {
      throw new Error("BaseAdapter is an abstract class and cannot be instantiated directly");
    }
    this.chatClient = chatClient;
  }

  /**
   * Converts the API-specific request payload to OpenAI format.
   * This is used before sending to GitHub Copilot API (which expects OpenAI format).
   * 
   * @param {Object} _payload - The API-specific request payload
   * @returns {Object} OpenAI-formatted request payload
   * @abstract
   */
  convertRequest(_payload) {
    throw new Error("convertRequest() must be implemented by subclass");
  }

  /**
   * Parses a non-streaming OpenAI response and converts it to the API-specific format.
   * 
   * @param {Object} _response - The OpenAI response object
   * @returns {Object} API-specific response format
   * @abstract
   */
  parseResponse(_response) {
    throw new Error("parseResponse() must be implemented by subclass");
  }

  /**
   * Parses streaming response chunks and converts them to the API-specific format.
   * 
   * @param {string} _buffer - The raw SSE (Server-Sent Events) buffer
   * @param {Object} _state - State object for tracking incomplete results across chunks
   * @returns {{parsedMessages: Array, remainBuffer: string}} Parsed messages and remaining buffer
   * @abstract
   */
  parseStreamChunk(_buffer, _state) {
    throw new Error("parseStreamChunk() must be implemented by subclass");
  }

  /**
   * Detects if the payload contains image/vision input.
   * Used to set the "Copilot-Vision-Request" header.
   * 
   * @param {Object} _payload - The API-specific request payload
   * @returns {boolean} True if the payload contains image input
   * @abstract
   */
  detectVisionRequest(_payload) {
    throw new Error("detectVisionRequest() must be implemented by subclass");
  }

  /**
   * Gets the default model from the model client.
   * This is a shared utility method available to all adapters.
   * 
   * @returns {Promise<Object>} Model configuration object
   */
  async getDefaultModel() {
    const currentModel = await this.chatClient.models.getCurrentModel();
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
