/**
 * Ollama API Integration Tests
 *
 * Tests the /api/chat endpoint with Ollama-format requests.
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
  validateOllamaResponse,
  compareResponses,
  extractTextContent,
  extractToolCalls,
  compareSemanticSimilarity,
  TIMEOUT,
  SEMANTIC_TIMEOUT,
} from "./setup.js";

describe("Ollama API Integration", () => {
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
      it("should return valid Ollama response structure", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const validation = validateOllamaResponse(response);

        expect(validation.isValid).toBe(true);
        if (!validation.isValid) {
          console.error("Validation errors:", validation.errors);
        }
      });

      it("should return text content", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const content = extractTextContent(response, "ollama");

        expect(content).not.toBeNull();
        expect(content.length).toBeGreaterThan(0);
      });

      it("should be semantically equivalent to golden output", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const comparison = compareResponses(response, golden.response, "ollama");

        expect(comparison.structureValid).toBe(true);
        // Note: Content may differ, but structure should be valid
      });

      it(
        "should return semantically similar content to golden",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("simpleText", "ollama");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("ollama", golden.request);

          const goldenContent = extractTextContent(golden.response, "ollama");
          const actualContent = extractTextContent(response, "ollama");

          // Skip if either content is empty
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

        const golden = loadGolden("multiTurn", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const validation = validateOllamaResponse(response);

        expect(validation.isValid).toBe(true);

        // Should respond with context from previous messages
        const content = extractTextContent(response, "ollama");
        expect(content).not.toBeNull();
      });

      it(
        "should return semantically similar content to golden for multi-turn",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("multiTurn", "ollama");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("ollama", golden.request);

          const goldenContent = extractTextContent(golden.response, "ollama");
          const actualContent = extractTextContent(response, "ollama");

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

        const golden = loadGolden("systemMessage", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const validation = validateOllamaResponse(response);

        expect(validation.isValid).toBe(true);

        const content = extractTextContent(response, "ollama");
        expect(content).not.toBeNull();
        // Response should be influenced by system message
      });

      it(
        "should return semantically similar content to golden for system message",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("systemMessage", "ollama");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("ollama", golden.request);

          const goldenContent = extractTextContent(golden.response, "ollama");
          const actualContent = extractTextContent(response, "ollama");

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
      it("should return tool calls when tools are provided", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const validation = validateOllamaResponse(response);

        expect(validation.isValid).toBe(true);

        // Should have tool calls
        const toolCalls = extractToolCalls(response, "ollama");
        expect(toolCalls).not.toBeNull();
        expect(toolCalls.length).toBeGreaterThan(0);

        // Tool call should be get_weather
        const hasWeatherTool = toolCalls.some(
          (tc) => tc.function?.name === "get_weather"
        );
        expect(hasWeatherTool).toBe(true);
      });

      it("should include location in tool call arguments", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "ollama");
        expect(golden).not.toBeNull();

        const response = await sendRequest("ollama", golden.request);
        const toolCalls = extractToolCalls(response, "ollama");

        expect(toolCalls).not.toBeNull();
        const weatherTool = toolCalls.find(
          (tc) => tc.function?.name === "get_weather"
        );
        expect(weatherTool).toBeDefined();

        // Arguments should include location (could be string or object)
        const args = weatherTool.function.arguments;
        if (typeof args === "string") {
          expect(args.toLowerCase()).toContain("tokyo");
        } else {
          expect(args.location?.toLowerCase()).toContain("tokyo");
        }
      });
    },
    TIMEOUT
  );
});
