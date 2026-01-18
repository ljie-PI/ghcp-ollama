/**
 * Adapter for OpenAI format (passthrough adapter).
 * 
 * Since GitHub Copilot API uses OpenAI format natively, this adapter
 * primarily acts as a passthrough with minimal processing.
 * 
 * This adapter is included for consistency and to handle:
 * - Vision request detection
 * - Streaming response formatting
 */

import { BaseAdapter } from "./base_adapter.js";

export class OpenAIAdapter extends BaseAdapter {
  /**
   * Converts OpenAI payload to OpenAI format (passthrough).
   * Since the input is already OpenAI format, return as-is.
   * 
   * @param {Object} payload - OpenAI request payload
   * @returns {Object} Same OpenAI payload (passthrough)
   */
  convertRequest(payload) {
    // OpenAI format is the native format - no conversion needed
    return payload;
  }

  /**
   * Detects if the OpenAI payload contains image input.
   * 
   * @param {Object} payload - OpenAI request payload
   * @returns {boolean} True if any message contains image_url content
   */
  detectVisionRequest(payload) {
    const messages = payload.messages || [];
    return messages.some((message) => {
      const content = message.content;
      if (content && Array.isArray(content)) {
        return content.some((item) => item.type === "image_url");
      }
      return false;
    });
  }

  /**
   * Parses non-streaming OpenAI response (passthrough).
   * 
   * @param {Object} response - OpenAI response object
   * @returns {Object} Same OpenAI response (passthrough)
   */
  parseResponse(response) {
    // Return as-is for OpenAI format
    return response;
  }

  /**
   * Parses streaming OpenAI SSE response chunks.
   * 
   * Extracts SSE chunks in the format:
   * data: {"choices": [...], ...}
   * data: [DONE]
   * 
   * @param {string} buffer - Raw SSE buffer from HTTP stream
   * @param {Object} _state - State object (unused for OpenAI, but kept for interface consistency)
   * @returns {{parsedMessages: Array, remainBuffer: string}} Parsed OpenAI chunks and remaining buffer
   */
  parseStreamChunk(buffer, _state) {
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
            // OpenAI streaming ends with [DONE]
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
}
