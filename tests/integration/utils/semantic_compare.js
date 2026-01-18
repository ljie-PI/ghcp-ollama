/**
 * Semantic Comparison Utility
 *
 * Compares API responses semantically rather than exactly,
 * since LLM outputs can vary between runs while being semantically equivalent.
 *
 * Comparison strategies:
 * 1. Structure validation - Ensures response has correct format
 * 2. Field presence - Checks required fields exist
 * 3. Type checking - Validates field types match expected
 * 4. Content similarity - For text content, checks semantic similarity
 * 5. Tool call validation - For tool calls, validates structure and parameters
 */

/**
 * Validates the structure of an Ollama API response.
 * @param {object} response - The response to validate
 * @returns {object} Validation result with isValid and errors
 */
export function validateOllamaResponse(response) {
  const errors = [];

  // Required fields
  if (!response.model) {
    errors.push("Missing required field: model");
  }

  if (!response.message) {
    errors.push("Missing required field: message");
  } else {
    if (!response.message.role) {
      errors.push("Missing required field: message.role");
    }
    if (response.message.content === undefined && !response.message.tool_calls) {
      errors.push("Missing required field: message.content or message.tool_calls");
    }
  }

  if (!response.created_at) {
    errors.push("Missing required field: created_at");
  }

  // Optional fields validation
  if (response.done !== undefined && typeof response.done !== "boolean") {
    errors.push("Field 'done' should be a boolean");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates the structure of an OpenAI API response.
 * Note: GitHub Copilot API returns responses without some fields that
 * the standard OpenAI API includes (e.g., 'object', 'created').
 * @param {object} response - The response to validate
 * @returns {object} Validation result with isValid and errors
 */
export function validateOpenAIResponse(response) {
  const errors = [];

  // Required fields
  if (!response.id) {
    errors.push("Missing required field: id");
  }

  // 'object' field is optional for GitHub Copilot API compatibility
  if (response.object && response.object !== "chat.completion") {
    errors.push(`Invalid object type: ${response.object}, expected 'chat.completion'`);
  }

  // 'created' is optional for GitHub Copilot API compatibility

  if (!response.model) {
    errors.push("Missing required field: model");
  }

  if (!response.choices || !Array.isArray(response.choices)) {
    errors.push("Missing or invalid field: choices");
  } else if (response.choices.length === 0) {
    errors.push("choices array is empty");
  } else {
    const choice = response.choices[0];
    if (!choice.message) {
      errors.push("Missing required field: choices[0].message");
    } else {
      if (!choice.message.role) {
        errors.push("Missing required field: choices[0].message.role");
      }
    }
    if (choice.finish_reason === undefined) {
      errors.push("Missing required field: choices[0].finish_reason");
    }
  }

  // Usage is optional but should be valid if present
  if (response.usage) {
    if (typeof response.usage.prompt_tokens !== "number") {
      errors.push("Invalid usage.prompt_tokens");
    }
    if (typeof response.usage.completion_tokens !== "number") {
      errors.push("Invalid usage.completion_tokens");
    }
    if (typeof response.usage.total_tokens !== "number") {
      errors.push("Invalid usage.total_tokens");
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validates the structure of an Anthropic API response.
 * @param {object} response - The response to validate
 * @returns {object} Validation result with isValid and errors
 */
export function validateAnthropicResponse(response) {
  const errors = [];

  // Required fields
  if (!response.id) {
    errors.push("Missing required field: id");
  }

  if (!response.type) {
    errors.push("Missing required field: type");
  } else if (response.type !== "message") {
    errors.push(`Invalid type: ${response.type}, expected 'message'`);
  }

  if (!response.role) {
    errors.push("Missing required field: role");
  } else if (response.role !== "assistant") {
    errors.push(`Invalid role: ${response.role}, expected 'assistant'`);
  }

  if (!response.content || !Array.isArray(response.content)) {
    errors.push("Missing or invalid field: content");
  }

  if (!response.model) {
    errors.push("Missing required field: model");
  }

  if (!response.stop_reason) {
    errors.push("Missing required field: stop_reason");
  }

  // Usage is required for Anthropic
  if (!response.usage) {
    errors.push("Missing required field: usage");
  } else {
    if (typeof response.usage.input_tokens !== "number") {
      errors.push("Invalid usage.input_tokens");
    }
    if (typeof response.usage.output_tokens !== "number") {
      errors.push("Invalid usage.output_tokens");
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Extracts text content from a response based on endpoint type.
 * @param {object} response - The API response
 * @param {string} endpoint - The endpoint type (ollama, openai, anthropic)
 * @returns {string|null} The extracted text content
 */
export function extractTextContent(response, endpoint) {
  switch (endpoint) {
  case "ollama":
    return response.message?.content || null;

  case "openai":
    return response.choices?.[0]?.message?.content || null;

  case "anthropic": {
    if (!response.content || !Array.isArray(response.content)) {
      return null;
    }
    const textBlocks = response.content.filter((block) => block.type === "text");
    return textBlocks.map((block) => block.text).join("\n") || null;
  }

  default:
    return null;
  }
}

/**
 * Extracts tool calls from a response based on endpoint type.
 * @param {object} response - The API response
 * @param {string} endpoint - The endpoint type (ollama, openai, anthropic)
 * @returns {Array|null} The extracted tool calls
 */
export function extractToolCalls(response, endpoint) {
  switch (endpoint) {
  case "ollama":
    return response.message?.tool_calls || null;

  case "openai":
    return response.choices?.[0]?.message?.tool_calls || null;

  case "anthropic": {
    if (!response.content || !Array.isArray(response.content)) {
      return null;
    }
    const toolUseBlocks = response.content.filter((block) => block.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      return null;
    }
    // Convert to common format
    return toolUseBlocks.map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: block.input,
      },
    }));
  }

  default:
    return null;
  }
}

/**
 * Compares two responses semantically.
 * @param {object} actual - The actual response
 * @param {object} expected - The expected (golden) response
 * @param {string} endpoint - The endpoint type (ollama, openai, anthropic)
 * @param {object} options - Comparison options
 * @returns {object} Comparison result
 */
export function compareResponses(actual, expected, endpoint, _options = {}) {
  const result = {
    isEquivalent: true,
    structureValid: true,
    differences: [],
    warnings: [],
  };

  // Validate response structure
  let validation;
  switch (endpoint) {
  case "ollama":
    validation = validateOllamaResponse(actual);
    break;
  case "openai":
    validation = validateOpenAIResponse(actual);
    break;
  case "anthropic":
    validation = validateAnthropicResponse(actual);
    break;
  default:
    result.isEquivalent = false;
    result.differences.push(`Unknown endpoint: ${endpoint}`);
    return result;
  }

  if (!validation.isValid) {
    result.structureValid = false;
    result.isEquivalent = false;
    result.differences.push(...validation.errors.map((e) => `Structure: ${e}`));
    return result;
  }

  // Compare model (should match)
  const actualModel = actual.model;
  const expectedModel = expected.model;
  if (actualModel !== expectedModel) {
    result.warnings.push(`Model differs: ${actualModel} vs ${expectedModel}`);
  }

  // Extract and compare content
  const actualContent = extractTextContent(actual, endpoint);
  const expectedContent = extractTextContent(expected, endpoint);

  if (actualContent !== null && expectedContent !== null) {
    // Both have text content - check if non-empty
    if (actualContent.length === 0 && expectedContent.length > 0) {
      result.differences.push("Actual response has empty content, expected non-empty");
      result.isEquivalent = false;
    }
  }

  // Extract and compare tool calls
  const actualToolCalls = extractToolCalls(actual, endpoint);
  const expectedToolCalls = extractToolCalls(expected, endpoint);

  if (actualToolCalls !== null && expectedToolCalls !== null) {
    // Both have tool calls
    if (actualToolCalls.length !== expectedToolCalls.length) {
      result.differences.push(
        `Tool call count differs: ${actualToolCalls.length} vs ${expectedToolCalls.length}`
      );
      result.isEquivalent = false;
    } else {
      // Compare tool call names
      for (let i = 0; i < actualToolCalls.length; i++) {
        const actualName = actualToolCalls[i].function?.name;
        const expectedName = expectedToolCalls[i].function?.name;
        if (actualName !== expectedName) {
          result.differences.push(
            `Tool call ${i} name differs: ${actualName} vs ${expectedName}`
          );
          result.isEquivalent = false;
        }
      }
    }
  } else if (
    (actualToolCalls !== null && expectedToolCalls === null) ||
    (actualToolCalls === null && expectedToolCalls !== null)
  ) {
    result.differences.push("Tool call presence differs between actual and expected");
    result.isEquivalent = false;
  }

  // Compare finish reason
  const actualFinishReason = getFinishReason(actual, endpoint);
  const expectedFinishReason = getFinishReason(expected, endpoint);
  if (actualFinishReason !== expectedFinishReason) {
    // This is a warning, not a failure, as finish reason can vary
    result.warnings.push(
      `Finish reason differs: ${actualFinishReason} vs ${expectedFinishReason}`
    );
  }

  return result;
}

/**
 * Gets the finish reason from a response.
 * @param {object} response - The API response
 * @param {string} endpoint - The endpoint type
 * @returns {string|null} The finish reason
 */
function getFinishReason(response, endpoint) {
  switch (endpoint) {
  case "ollama":
    return response.done_reason || (response.done ? "stop" : null);
  case "openai":
    return response.choices?.[0]?.finish_reason || null;
  case "anthropic":
    return response.stop_reason || null;
  default:
    return null;
  }
}

/**
 * Creates a comparison report from multiple test results.
 * @param {Array} results - Array of comparison results
 * @returns {object} Summary report
 */
export function createComparisonReport(results) {
  const report = {
    total: results.length,
    passed: 0,
    failed: 0,
    warnings: 0,
    failures: [],
    allWarnings: [],
  };

  for (const result of results) {
    if (result.isEquivalent) {
      report.passed++;
    } else {
      report.failed++;
      report.failures.push({
        testCase: result.testCase,
        endpoint: result.endpoint,
        differences: result.differences,
      });
    }
    if (result.warnings.length > 0) {
      report.warnings += result.warnings.length;
      report.allWarnings.push({
        testCase: result.testCase,
        endpoint: result.endpoint,
        warnings: result.warnings,
      });
    }
  }

  return report;
}

/**
 * Uses LLM to compare semantic similarity between two text contents.
 * This function sends both texts to the LLM API and asks it to evaluate
 * if they are semantically similar (convey the same meaning/information).
 *
 * @param {string} expected - The expected (golden) text content
 * @param {string} actual - The actual text content
 * @param {object} options - Options
 * @param {number} options.threshold - Similarity threshold (default: 0.8)
 * @param {string} options.baseUrl - API base URL (default: http://localhost:11434)
 * @param {string} options.model - Model to use (default: gpt-4o-2024-11-20)
 * @param {number} options.maxRetries - Max retries for JSON parse errors (default: 1)
 * @returns {Promise<object>} Similarity result with { isSimilar, score, explanation, threshold, error }
 */
export async function compareSemanticSimilarity(expected, actual, options = {}) {
  const {
    threshold = 0.8,
    baseUrl = "http://localhost:11434",
    model = "gpt-4o-2024-11-20",
    maxRetries = 1,
    verbose = true, // Enable verbose logging by default
  } = options;

  // Log the content being compared
  if (verbose) {
    console.log("\n" + "=".repeat(80));
    console.log("SEMANTIC SIMILARITY COMPARISON");
    console.log("=".repeat(80));
    console.log("\n📄 Expected Content:");
    console.log("-".repeat(80));
    console.log(expected);
    console.log("-".repeat(80));
    console.log("\n📄 Actual Content:");
    console.log("-".repeat(80));
    console.log(actual);
    console.log("-".repeat(80));
  }

  const prompt = `Compare these two AI responses and determine if they are semantically similar.

Expected response:
"""
${expected}
"""

Actual response:
"""
${actual}
"""

Evaluate based on:
1. Do they convey the same core meaning/information?
2. Are the key facts/points consistent?
3. Is the intent/purpose the same?

You MUST respond with valid JSON only, no other text:
{"similar": true, "score": 0.85, "explanation": "Both responses explain..."}

The score should be between 0.0 and 1.0, where:
- 1.0 = semantically identical
- 0.8+ = very similar, minor differences in wording
- 0.6-0.8 = similar core meaning, some differences
- 0.4-0.6 = partially similar
- 0.0-0.4 = different meanings`;

  if (verbose) {
    console.log("\n🤖 Prompt sent to LLM:");
    console.log("-".repeat(80));
    console.log(prompt);
    console.log("-".repeat(80));
    console.log(`\n⚙️  Model: ${model}`);
    console.log(`⚙️  Threshold: ${threshold}`);
    console.log(`⚙️  Base URL: ${baseUrl}`);
    console.log("");
  }

  let lastError = null;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} - ${errorText}`);
      }

      const apiResponse = await response.json();
      const content = apiResponse.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("No content in API response");
      }

      // Try to parse JSON from the response
      let parsed;
      try {
        // Remove markdown code blocks if present
        const cleanedContent = content.replace(/```json\n?|\n?```/g, "").trim();
        parsed = JSON.parse(cleanedContent);
      } catch (parseError) {
        lastError = new Error(`JSON parse error: ${parseError.message}\nContent: ${content}`);
        
        if (verbose) {
          console.log("\n⚠️  JSON Parse Error (will retry):");
          console.log("-".repeat(80));
          console.log(`Error: ${parseError.message}`);
          console.log(`Content received: ${content}`);
          console.log("-".repeat(80));
        }
        
        retryCount++;
        if (retryCount <= maxRetries) {
          continue; // Retry
        }
        // Max retries reached, return failure
        if (verbose) {
          console.log("\n❌ Max retries reached. Returning failure.");
          console.log("=".repeat(80) + "\n");
        }
        return {
          isSimilar: false,
          score: 0,
          explanation: "Failed to parse LLM response as JSON",
          threshold,
          error: lastError.message,
        };
      }

      // Validate parsed structure
      if (typeof parsed.score !== "number" || typeof parsed.explanation !== "string") {
        lastError = new Error(`Invalid JSON structure: ${JSON.stringify(parsed)}`);
        
        if (verbose) {
          console.log("\n⚠️  Invalid JSON Structure (will retry):");
          console.log("-".repeat(80));
          console.log(`Parsed: ${JSON.stringify(parsed, null, 2)}`);
          console.log("-".repeat(80));
        }
        
        retryCount++;
        if (retryCount <= maxRetries) {
          continue; // Retry
        }
        
        if (verbose) {
          console.log("\n❌ Max retries reached. Returning failure.");
          console.log("=".repeat(80) + "\n");
        }
        
        return {
          isSimilar: false,
          score: 0,
          explanation: "Invalid JSON structure from LLM",
          threshold,
          error: lastError.message,
        };
      }

      // Success - return result
      const result = {
        isSimilar: parsed.score >= threshold,
        score: parsed.score,
        explanation: parsed.explanation,
        threshold,
      };

      if (verbose) {
        console.log("\n✅ LLM Response:");
        console.log("-".repeat(80));
        console.log(`Score: ${result.score}`);
        console.log(`Threshold: ${result.threshold}`);
        console.log(`Similar: ${result.isSimilar ? "✅ YES" : "❌ NO"}`);
        console.log(`Explanation: ${result.explanation}`);
        console.log("-".repeat(80));
        console.log("=".repeat(80) + "\n");
      }

      return result;
    } catch (error) {
      lastError = error;
      
      if (verbose) {
        console.log("\n⚠️  API Error (will retry):");
        console.log("-".repeat(80));
        console.log(`Error: ${error.message}`);
        console.log("-".repeat(80));
      }
      
      retryCount++;
      if (retryCount <= maxRetries) {
        continue; // Retry
      }
      // Max retries reached, return failure
      if (verbose) {
        console.log("\n❌ Max retries reached. Returning failure.");
        console.log("=".repeat(80) + "\n");
      }
      return {
        isSimilar: false,
        score: 0,
        explanation: "API request failed",
        threshold,
        error: error.message,
      };
    }
  }

  // Should not reach here, but just in case
  return {
    isSimilar: false,
    score: 0,
    explanation: "Unknown error",
    threshold,
    error: lastError?.message || "Unknown error",
  };
}

// Export all validation functions
export const validators = {
  ollama: validateOllamaResponse,
  openai: validateOpenAIResponse,
  anthropic: validateAnthropicResponse,
};
