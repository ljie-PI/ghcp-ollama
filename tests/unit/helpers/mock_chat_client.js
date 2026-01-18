/**
 * Mock CopilotChatClient for unit testing adapters.
 *
 * This mock provides the minimal interface needed by adapters
 * without requiring actual authentication or network calls.
 */

export class MockChatClient {
  constructor() {
    this.models = new MockModelClient();
  }
}

/**
 * Mock model client that returns a default model
 */
class MockModelClient {
  async getCurrentModel() {
    return {
      success: true,
      modelConfig: {
        modelId: "gpt-4o-mock",
        modelName: "GPT-4o Mock",
        lastUpdated: "2025-01-01T00:00:00.000Z",
      },
    };
  }
}

/**
 * Creates a fresh mock chat client instance
 * @returns {MockChatClient}
 */
export function createMockChatClient() {
  return new MockChatClient();
}
