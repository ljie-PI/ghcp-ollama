/**
 * OpenAI API Integration Tests
 *
 * Tests the /v1/chat/completions endpoint with OpenAI-format requests.
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
  validateOpenAIResponse,
  extractTextContent,
  extractToolCalls,
  compareSemanticSimilarity,
  TIMEOUT,
  SEMANTIC_TIMEOUT,
} from "./setup.js";

describe("OpenAI API Integration", () => {
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
      it("should return valid OpenAI response structure", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const validation = validateOpenAIResponse(response);

        expect(validation.isValid).toBe(true);
        if (!validation.isValid) {
          console.error("Validation errors:", validation.errors);
        }
      });

      it("should have chat.completion object type or be compatible", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        // GitHub Copilot API may not include 'object' field
        // If present, it should be 'chat.completion'
        if (response.object) {
          expect(response.object).toBe("chat.completion");
        }
        // Must have choices array
        expect(response.choices).toBeDefined();
        expect(Array.isArray(response.choices)).toBe(true);
      });

      it("should include usage statistics", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        expect(response.usage).toBeDefined();
        expect(response.usage.prompt_tokens).toBeGreaterThan(0);
        expect(response.usage.completion_tokens).toBeGreaterThan(0);
        expect(response.usage.total_tokens).toBeGreaterThan(0);
      });

      it("should return text content", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("simpleText", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const content = extractTextContent(response, "openai");

        expect(content).not.toBeNull();
        expect(content.length).toBeGreaterThan(0);
      });

      it(
        "should return semantically similar content to golden",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("simpleText", "openai");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("openai", golden.request);

          const goldenContent = extractTextContent(golden.response, "openai");
          const actualContent = extractTextContent(response, "openai");

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

        const golden = loadGolden("multiTurn", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const validation = validateOpenAIResponse(response);

        expect(validation.isValid).toBe(true);
      });

      it("should maintain conversation context", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("multiTurn", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const content = extractTextContent(response, "openai");

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

          const golden = loadGolden("multiTurn", "openai");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("openai", golden.request);

          const goldenContent = extractTextContent(golden.response, "openai");
          const actualContent = extractTextContent(response, "openai");

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

        const golden = loadGolden("systemMessage", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const validation = validateOpenAIResponse(response);

        expect(validation.isValid).toBe(true);
      });

      it(
        "should return semantically similar content to golden for system message",
        async () => {
          if (!serverAvailable) {
            return;
          }

          const golden = loadGolden("systemMessage", "openai");
          expect(golden).not.toBeNull();
          expect(golden.response).toBeDefined();

          const response = await sendRequest("openai", golden.request);

          const goldenContent = extractTextContent(golden.response, "openai");
          const actualContent = extractTextContent(response, "openai");

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

        const golden = loadGolden("toolCalling", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const validation = validateOpenAIResponse(response);

        expect(validation.isValid).toBe(true);

        // Should have tool calls
        const toolCalls = extractToolCalls(response, "openai");
        expect(toolCalls).not.toBeNull();
        expect(toolCalls.length).toBeGreaterThan(0);
      });

      it("should have tool_calls finish reason", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);

        // Finish reason should indicate tool calls
        const finishReason = response.choices[0].finish_reason;
        expect(finishReason).toBe("tool_calls");
      });

      it("should call get_weather with location", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const toolCalls = extractToolCalls(response, "openai");

        expect(toolCalls).not.toBeNull();
        const weatherTool = toolCalls.find(
          (tc) => tc.function?.name === "get_weather"
        );
        expect(weatherTool).toBeDefined();

        // Arguments should be a JSON string
        const args =
          typeof weatherTool.function.arguments === "string"
            ? JSON.parse(weatherTool.function.arguments)
            : weatherTool.function.arguments;

        expect(args.location?.toLowerCase()).toContain("tokyo");
      });

      it("should include tool call id", async () => {
        if (!serverAvailable) {
          return;
        }

        const golden = loadGolden("toolCalling", "openai");
        expect(golden).not.toBeNull();

        const response = await sendRequest("openai", golden.request);
        const toolCalls = extractToolCalls(response, "openai");

        expect(toolCalls).not.toBeNull();
        expect(toolCalls[0].id).toBeDefined();
        expect(toolCalls[0].id.length).toBeGreaterThan(0);
      });
    },
    TIMEOUT
  );
});
