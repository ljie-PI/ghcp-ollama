/**
 * Integration test setup and utilities.
 *
 * These tests require:
 * 1. Server running: npm run dev
 * 2. Authentication: node src/ghcpo.js signin
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  validateOllamaResponse,
  validateOpenAIResponse,
  validateAnthropicResponse,
  compareResponses,
  extractTextContent,
  extractToolCalls,
  compareSemanticSimilarity,
} from "./utils/semantic_compare.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOLDEN_DIR = path.join(__dirname, "golden");
const BASE_URL = process.env.SERVER_URL || "http://localhost:11434";
const TIMEOUT = 30000; // 30 seconds timeout for LLM requests
const SEMANTIC_TIMEOUT = 90000; // 90 seconds for semantic comparison (includes retry)

/**
 * Check if server is available.
 */
async function isServerAvailable() {
  try {
    const response = await fetch(`${BASE_URL}/`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Load golden output for a test case and endpoint.
 */
function loadGolden(testCase, endpoint) {
  const filename = `${testCase}_${endpoint}.json`;
  const filepath = path.join(GOLDEN_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return null;
  }
  const content = fs.readFileSync(filepath, "utf8");
  return JSON.parse(content);
}

/**
 * Send request to endpoint.
 */
async function sendRequest(endpoint, body) {
  const paths = {
    ollama: "/api/chat",
    openai: "/v1/chat/completions",
    anthropic: "/v1/messages",
  };

  const headers = {
    "Content-Type": "application/json",
  };

  if (endpoint === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
  }

  const response = await fetch(`${BASE_URL}${paths[endpoint]}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// Export utilities for test files
export {
  isServerAvailable,
  loadGolden,
  sendRequest,
  validateOllamaResponse,
  validateOpenAIResponse,
  validateAnthropicResponse,
  compareResponses,
  extractTextContent,
  extractToolCalls,
  compareSemanticSimilarity,
  BASE_URL,
  GOLDEN_DIR,
  TIMEOUT,
  SEMANTIC_TIMEOUT,
};
