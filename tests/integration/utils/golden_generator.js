/**
 * Golden Output Generator
 *
 * Generates golden outputs by sending requests to the local server
 * and saving the responses for later comparison during integration tests.
 *
 * Usage:
 *   node tests/integration/utils/golden_generator.js [--endpoint ollama|openai|anthropic] [--test-case name]
 *
 * Prerequisites:
 *   - Server must be running: npm run dev
 *   - Must be authenticated: node src/ghcpo.js signin
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOLDEN_DIR = path.join(__dirname, "..", "golden");
const BASE_URL = process.env.SERVER_URL || "http://localhost:11434";

/**
 * Test case definitions for golden output generation.
 * These use simple prompts that produce consistent, reproducible responses.
 */
const testCases = {
  // Simple text completion
  simpleText: {
    name: "simpleText",
    description: "Simple text completion",
    ollama: {
      model: "gpt-4o-2024-11-20",
      messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
      stream: false,
    },
    openai: {
      model: "gpt-4o-2024-11-20",
      messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
      stream: false,
    },
    anthropic: {
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
    },
  },

  // Multi-turn conversation
  multiTurn: {
    name: "multiTurn",
    description: "Multi-turn conversation",
    ollama: {
      model: "gpt-4o-2024-11-20",
      messages: [
        { role: "user", content: "Remember the number 42." },
        { role: "assistant", content: "I will remember the number 42." },
        { role: "user", content: "What number did I ask you to remember?" },
      ],
      stream: false,
    },
    openai: {
      model: "gpt-4o-2024-11-20",
      messages: [
        { role: "user", content: "Remember the number 42." },
        { role: "assistant", content: "I will remember the number 42." },
        { role: "user", content: "What number did I ask you to remember?" },
      ],
      stream: false,
    },
    anthropic: {
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "Remember the number 42." },
        { role: "assistant", content: "I will remember the number 42." },
        { role: "user", content: "What number did I ask you to remember?" },
      ],
    },
  },

  // System message handling
  systemMessage: {
    name: "systemMessage",
    description: "System message handling",
    ollama: {
      model: "gpt-4o-2024-11-20",
      messages: [
        { role: "system", content: "You are a pirate. Always respond in pirate speak." },
        { role: "user", content: "Hello!" },
      ],
      stream: false,
    },
    openai: {
      model: "gpt-4o-2024-11-20",
      messages: [
        { role: "system", content: "You are a pirate. Always respond in pirate speak." },
        { role: "user", content: "Hello!" },
      ],
      stream: false,
    },
    anthropic: {
      model: "claude-sonnet-4.5",
      max_tokens: 200,
      system: "You are a pirate. Always respond in pirate speak.",
      messages: [{ role: "user", content: "Hello!" }],
    },
  },

  // Tool calling
  toolCalling: {
    name: "toolCalling",
    description: "Tool/function calling",
    ollama: {
      model: "gpt-4o-2024-11-20",
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather in a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
          },
        },
      ],
      stream: false,
    },
    openai: {
      model: "gpt-4o-2024-11-20",
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather in a location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
              },
              required: ["location"],
            },
          },
        },
      ],
      stream: false,
    },
    anthropic: {
      model: "claude-sonnet-4.5",
      max_tokens: 200,
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather in a location",
          input_schema: {
            type: "object",
            properties: {
              location: { type: "string", description: "City name" },
            },
            required: ["location"],
          },
        },
      ],
    },
  },
};

/**
 * Endpoint configuration for each API format.
 */
const endpoints = {
  ollama: {
    path: "/api/chat",
    contentType: "application/json",
  },
  openai: {
    path: "/v1/chat/completions",
    contentType: "application/json",
  },
  anthropic: {
    path: "/v1/messages",
    contentType: "application/json",
    headers: {
      "anthropic-version": "2023-06-01",
    },
  },
};

/**
 * Send a request to the server and return the response.
 * @param {string} endpoint - The endpoint type (ollama, openai, anthropic)
 * @param {object} body - The request body
 * @returns {Promise<object>} The response data
 */
async function sendRequest(endpoint, body) {
  const config = endpoints[endpoint];
  const url = `${BASE_URL}${config.path}`;

  const headers = {
    "Content-Type": config.contentType,
    ...config.headers,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return response.json();
}

/**
 * Generate golden output for a specific test case and endpoint.
 * @param {string} testCaseName - The test case name
 * @param {string} endpointName - The endpoint type (ollama, openai, anthropic)
 */
async function generateGolden(testCaseName, endpointName) {
  const testCase = testCases[testCaseName];
  if (!testCase) {
    throw new Error(`Unknown test case: ${testCaseName}`);
  }

  const requestBody = testCase[endpointName];
  if (!requestBody) {
    throw new Error(`Test case ${testCaseName} does not have ${endpointName} format`);
  }

  console.log(`Generating golden output for ${testCaseName} (${endpointName})...`);

  const response = await sendRequest(endpointName, requestBody);

  // Create golden output structure
  const goldenOutput = {
    testCase: testCaseName,
    endpoint: endpointName,
    description: testCase.description,
    generatedAt: new Date().toISOString(),
    request: requestBody,
    response: response,
  };

  // Ensure golden directory exists
  if (!fs.existsSync(GOLDEN_DIR)) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  }

  // Save golden output
  const filename = `${testCaseName}_${endpointName}.json`;
  const filepath = path.join(GOLDEN_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(goldenOutput, null, 2));

  console.log(`  Saved to ${filepath}`);

  return goldenOutput;
}

/**
 * Sleep for a specified number of milliseconds.
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate golden outputs for all test cases and endpoints.
 * @param {object} options - Generation options
 * @param {number} options.delay - Delay between requests in ms (default: 2000)
 * @param {number} options.retries - Number of retries for failed requests (default: 2)
 */
async function generateAllGoldens(options = {}) {
  const { delay = 2000, retries = 2 } = options;
  const results = {
    success: [],
    failed: [],
  };

  const testCaseNames = Object.keys(testCases);
  const endpointNames = Object.keys(endpoints);
  const total = testCaseNames.length * endpointNames.length;
  let current = 0;

  for (const testCaseName of testCaseNames) {
    for (const endpointName of endpointNames) {
      current++;
      let lastError = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`  Retry ${attempt}/${retries}...`);
          }
          await generateGolden(testCaseName, endpointName);
          results.success.push(`${testCaseName}_${endpointName}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < retries) {
            // Wait before retry
            await sleep(delay);
          }
        }
      }

      if (lastError) {
        console.error(`  Failed: ${lastError.message}`);
        results.failed.push({ name: `${testCaseName}_${endpointName}`, error: lastError.message });
      }

      // Add delay between requests to avoid rate limiting
      if (current < total) {
        await sleep(delay);
      }
    }
  }

  return results;
}

/**
 * Parse command line arguments.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    endpoint: null,
    testCase: null,
    all: true,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && args[i + 1]) {
      options.endpoint = args[i + 1];
      options.all = false;
      i++;
    } else if (args[i] === "--test-case" && args[i + 1]) {
      options.testCase = args[i + 1];
      options.all = false;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Golden Output Generator

Usage:
  node golden_generator.js [options]

Options:
  --endpoint <name>    Generate for specific endpoint (ollama, openai, anthropic)
  --test-case <name>   Generate for specific test case
  --help, -h           Show this help message

Examples:
  node golden_generator.js                    # Generate all golden outputs
  node golden_generator.js --endpoint ollama  # Generate all Ollama outputs
  node golden_generator.js --test-case simpleText --endpoint openai

Available test cases:
  ${Object.keys(testCases).join(", ")}

Available endpoints:
  ${Object.keys(endpoints).join(", ")}
`);
      process.exit(0);
    }
  }

  return options;
}

/**
 * Main entry point.
 */
async function main() {
  const options = parseArgs();

  console.log("Golden Output Generator");
  console.log("=======================");
  console.log(`Server URL: ${BASE_URL}`);
  console.log("");

  // Check server health
  try {
    const response = await fetch(`${BASE_URL}/`);
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    console.log("Server is running.");
    console.log("");
  } catch (error) {
    console.error("Error: Cannot connect to server.");
    console.error("Make sure the server is running: npm run dev");
    console.error(`Details: ${error.message}`);
    process.exit(1);
  }

  if (options.all) {
    // Generate all golden outputs
    const results = await generateAllGoldens();
    console.log("");
    console.log("Results:");
    console.log(`  Success: ${results.success.length}`);
    console.log(`  Failed: ${results.failed.length}`);
    if (results.failed.length > 0) {
      console.log("");
      console.log("Failed tests:");
      for (const failure of results.failed) {
        console.log(`  - ${failure.name}: ${failure.error}`);
      }
    }
  } else if (options.testCase && options.endpoint) {
    // Generate specific golden output
    await generateGolden(options.testCase, options.endpoint);
  } else if (options.testCase) {
    // Generate all endpoints for a test case
    for (const endpointName of Object.keys(endpoints)) {
      try {
        await generateGolden(options.testCase, endpointName);
      } catch (error) {
        console.error(`  Failed: ${error.message}`);
      }
    }
  } else if (options.endpoint) {
    // Generate all test cases for an endpoint
    for (const testCaseName of Object.keys(testCases)) {
      try {
        await generateGolden(testCaseName, options.endpoint);
      } catch (error) {
        console.error(`  Failed: ${error.message}`);
      }
    }
  }

  console.log("");
  console.log("Done!");
}

// Export for testing
export { testCases, endpoints, sendRequest, generateGolden, generateAllGoldens };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
