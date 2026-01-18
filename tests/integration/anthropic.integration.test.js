/**
 * Anthropic API Integration Tests
 *
 * Tests the /v1/messages endpoint with Anthropic-format requests.
 *
 * Prerequisites:
 * - Server running: npm run dev
 * - Authentication: node src/ghcpo.js signin
 * - Golden outputs generated: npm run test:golden
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  isServerAvailable,
  loadGolden,
  sendRequest,
  validateAnthropicResponse,
  extractTextContent,
  compareSemanticSimilarity,
  TIMEOUT,
  SEMANTIC_TIMEOUT,
} from "./setup.js";

describe("Anthropic API Integration", () => {
  let serverAvailable = false;

  beforeAll(async () => {
    serverAvailable = await isServerAvailable();
  });

  describe("health check", () => {
    it("should connect to server", () => {
      expect(serverAvailable).toBe(true);
    });
  });

  describe(
    "simpleText",
    () => {
      it("should return valid Anthropic response structure", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const validation = validateAnthropicResponse(response);

        expect(validation.isValid).toBe(true);
        if (!validation.isValid) {
          console.error("Validation errors:", validation.errors);
        }
      });

      it("should have message type", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        expect(response.type).toBe("message");
        expect(response.role).toBe("assistant");
      });

      it("should include usage statistics", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        expect(response.usage).toBeDefined();
        expect(response.usage.input_tokens).toBeGreaterThan(0);
        expect(response.usage.output_tokens).toBeGreaterThan(0);
      });

      it("should return text content in content blocks", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);

        expect(response.content).toBeDefined();
        expect(Array.isArray(response.content)).toBe(true);
        expect(response.content.length).toBeGreaterThan(0);

        const textBlock = response.content.find((b) => b.type === "text");
        expect(textBlock).toBeDefined();
        expect(textBlock.text.length).toBeGreaterThan(0);
      });

      it(
        "should return semantically similar content to golden",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("simpleText", "anthropic");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("anthropic", golden.request);

          const goldenContent = extractTextContent(golden.response, "anthropic");
          const actualContent = extractTextContent(response, "anthropic");

          if (!goldenContent || !actualContent) {
            console.log("Skipping semantic comparison: no text content");
            return;
          }

          const similarity = await compareSemanticSimilarity(
            goldenContent,
            actualContent
          );

          expect(similarity.isSimilar).toBe(true);
          if (!similarity.isSimilar) {
            console.log(
              `Similarity score: ${similarity.score} (threshold: ${similarity.threshold})`
            );
            console.log(`Explanation: ${similarity.explanation}`);
            if (similarity.error) {
              console.error(`Error: ${similarity.error}`);
            }
          }
        },
        SEMANTIC_TIMEOUT
      );
    },
    TIMEOUT
  );

  describe(
    "multiTurn",
    () => {
      it("should handle multi-turn conversation", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("multiTurn", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const validation = validateAnthropicResponse(response);

        expect(validation.isValid).toBe(true);
      });

      it("should maintain conversation context", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("multiTurn", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const content = extractTextContent(response, "anthropic");

        expect(content).not.toBeNull();
        // Response should reference the number 42
        expect(content.toLowerCase()).toMatch(/42|forty[- ]?two/);
      });

      it(
        "should return semantically similar content to golden for multi-turn",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("multiTurn", "anthropic");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("anthropic", golden.request);

          const goldenContent = extractTextContent(golden.response, "anthropic");
          const actualContent = extractTextContent(response, "anthropic");

          if (!goldenContent || !actualContent) {
            console.log("Skipping semantic comparison: no text content");
            return;
          }

          const similarity = await compareSemanticSimilarity(
            goldenContent,
            actualContent
          );

          expect(similarity.isSimilar).toBe(true);
          if (!similarity.isSimilar) {
            console.log(
              `Similarity score: ${similarity.score} (threshold: ${similarity.threshold})`
            );
            console.log(`Explanation: ${similarity.explanation}`);
            if (similarity.error) {
              console.error(`Error: ${similarity.error}`);
            }
          }
        },
        SEMANTIC_TIMEOUT
      );
    },
    TIMEOUT
  );

  describe(
    "systemMessage",
    () => {
      it("should respect system message", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("systemMessage", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const validation = validateAnthropicResponse(response);

        expect(validation.isValid).toBe(true);
      });

      it(
        "should return semantically similar content to golden for system message",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("systemMessage", "anthropic");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("anthropic", golden.request);

          const goldenContent = extractTextContent(golden.response, "anthropic");
          const actualContent = extractTextContent(response, "anthropic");

          if (!goldenContent || !actualContent) {
            console.log("Skipping semantic comparison: no text content");
            return;
          }

          const similarity = await compareSemanticSimilarity(
            goldenContent,
            actualContent
          );

          expect(similarity.isSimilar).toBe(true);
          if (!similarity.isSimilar) {
            console.log(
              `Similarity score: ${similarity.score} (threshold: ${similarity.threshold})`
            );
            console.log(`Explanation: ${similarity.explanation}`);
            if (similarity.error) {
              console.error(`Error: ${similarity.error}`);
            }
          }
        },
        SEMANTIC_TIMEOUT
      );
    },
    TIMEOUT
  );

  describe(
    "toolCalling",
    () => {
      it("should return tool use blocks when tools are provided", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const validation = validateAnthropicResponse(response);

        expect(validation.isValid).toBe(true);

        // Should have tool_use content blocks
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
        expect(toolUseBlocks.length).toBeGreaterThan(0);
      });

      it("should have tool_use stop reason", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);

        // Stop reason should indicate tool use
        expect(response.stop_reason).toBe("tool_use");
      });

      it("should call get_weather with location", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

        expect(toolUseBlocks.length).toBeGreaterThan(0);
        const weatherTool = toolUseBlocks.find((b) => b.name === "get_weather");
        expect(weatherTool).toBeDefined();

        // Input should contain location
        expect(weatherTool.input.location?.toLowerCase()).toContain("tokyo");
      });

      it("should include tool use id", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "anthropic");
        expect(golden).not.toBeNull();

        const response = await sendRequest("anthropic", golden.request);
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

        expect(toolUseBlocks.length).toBeGreaterThan(0);
        expect(toolUseBlocks[0].id).toBeDefined();
        expect(toolUseBlocks[0].id.length).toBeGreaterThan(0);
      });
    },
    TIMEOUT
  );
});
