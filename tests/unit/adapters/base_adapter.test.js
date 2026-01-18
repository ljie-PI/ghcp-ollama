/**
 * Unit tests for BaseAdapter abstract class.
 */

import { describe, it, expect } from "vitest";
import { BaseAdapter } from "../../../src/utils/adapters/base_adapter.js";
import { createMockChatClient } from "../helpers/mock_chat_client.js";

describe("BaseAdapter", () => {
  describe("constructor", () => {
    it("should throw error when instantiated directly", () => {
      const mockClient = createMockChatClient();
      expect(() => new BaseAdapter(mockClient)).toThrow(
        "BaseAdapter is an abstract class and cannot be instantiated directly",
      );
    });
  });

  describe("abstract methods", () => {
    // Create a concrete subclass to test abstract method defaults
    class TestAdapter extends BaseAdapter {
      constructor(chatClient) {
        super(chatClient);
      }
    }

    it("convertRequest should throw not implemented error", () => {
      const mockClient = createMockChatClient();
      const adapter = new TestAdapter(mockClient);
      expect(() => adapter.convertRequest({})).toThrow(
        "convertRequest() must be implemented by subclass",
      );
    });

    it("parseResponse should throw not implemented error", () => {
      const mockClient = createMockChatClient();
      const adapter = new TestAdapter(mockClient);
      expect(() => adapter.parseResponse({})).toThrow(
        "parseResponse() must be implemented by subclass",
      );
    });

    it("parseStreamChunk should throw not implemented error", () => {
      const mockClient = createMockChatClient();
      const adapter = new TestAdapter(mockClient);
      expect(() => adapter.parseStreamChunk("", {})).toThrow(
        "parseStreamChunk() must be implemented by subclass",
      );
    });

    it("detectVisionRequest should throw not implemented error", () => {
      const mockClient = createMockChatClient();
      const adapter = new TestAdapter(mockClient);
      expect(() => adapter.detectVisionRequest({})).toThrow(
        "detectVisionRequest() must be implemented by subclass",
      );
    });
  });

  describe("getDefaultModel", () => {
    class TestAdapter extends BaseAdapter {
      constructor(chatClient) {
        super(chatClient);
      }
    }

    it("should return model from chat client when successful", async () => {
      const mockClient = createMockChatClient();
      const adapter = new TestAdapter(mockClient);

      const result = await adapter.getDefaultModel();

      expect(result.success).toBe(true);
      expect(result.modelConfig).toBeDefined();
      expect(result.modelConfig.modelId).toBe("gpt-4o-mock");
    });

    it("should return fallback model when chat client fails", async () => {
      const mockClient = createMockChatClient();
      // Override to simulate failure
      mockClient.models.getCurrentModel = async () => ({ success: false });

      const adapter = new TestAdapter(mockClient);
      const result = await adapter.getDefaultModel();

      expect(result.success).toBe(true);
      expect(result.modelConfig.modelId).toBe("gpt-4o-2024-11-20");
    });
  });
});
