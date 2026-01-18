# AGENTS.md - Developer Guide for AI Coding Agents

This guide provides coding standards and workflows for AI agents working in this repository.

## Project Overview

**ghcp-ollama** is a GitHub Copilot proxy providing Ollama, OpenAI, and Anthropic compatible APIs.
- **Language**: JavaScript (ES Modules)
- **Runtime**: Node.js >=18.0.0
- **Package Manager**: npm
- **Module System**: ESM (`"type": "module"` in package.json)

## Build, Lint & Test Commands

### Development
```bash
npm install              # Install dependencies
npm start               # Start server (production)
npm run dev             # Start server with auto-reload (development)
npm run build           # Build the project
```

### Linting
```bash
npm run lint            # Check code style
npm run lint:fix        # Auto-fix code style issues
```

### Testing
```bash
# Run all tests (unit + integration)
npm test

# Run unit tests only (fast, no server required)
npm run test:unit

# Run integration tests (requires running server)
npm run test:integration

# Run a single test file
npx vitest run tests/unit/image_utils.test.js

# Run tests matching a pattern
npx vitest run tests/unit/adapters/

# Watch mode for test-driven development
npm run test:watch

# Interactive UI for tests
npm run test:ui

# Coverage report
npm run test:coverage

# Generate golden outputs for integration tests
npm run test:golden
```

### Server Management
```bash
npm run server:start    # Start server as daemon
npm run server:stop     # Stop server daemon
npm run server:restart  # Restart server daemon
npm run server:status   # Check server status
```

## Code Style Guidelines

### ESLint Configuration
- **Indentation**: 2 spaces
- **Quotes**: Double quotes (`"`)
- **Semicolons**: Required (`;`)
- **Line endings**: Unix (LF)
- **Trailing commas**: Only in multiline
- **Console**: `console.log()` allowed (not an error)
- **Unused vars**: Error (except params prefixed with `_`)

### Import Style
```javascript
// External modules first
import fs from "fs";
import path from "path";
import express from "express";

// Internal modules second
import { CopilotAuth } from "./utils/auth_client.js";
import { detectImageType } from "./utils/image_utils.js";

// Always use .js extension in imports (ESM requirement)
```

### File Organization
```
src/
├── utils/
│   ├── adapters/           # API format converters
│   │   ├── base_adapter.js
│   │   ├── ollama_adapter.js
│   │   ├── openai_adapter.js
│   │   └── anthropic_adapter.js
│   ├── auth_client.js      # GitHub authentication
│   ├── chat_client.js      # Chat API client
│   └── image_utils.js      # Image processing
└── server.js               # Main server
```

### Naming Conventions
- **Files**: `snake_case.js` (e.g., `chat_client.js`, `base_adapter.js`)
- **Classes**: `PascalCase` (e.g., `BaseAdapter`, `OllamaAdapter`)
- **Functions**: `camelCase` (e.g., `convertRequest`, `parseResponse`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `BASE_URL`, `TIMEOUT`)
- **Private params**: Prefix with `_` (e.g., `_payload`, `_response`)

### Documentation (JSDoc)
```javascript
/**
 * Brief description of function/class.
 * Additional details if needed.
 *
 * @param {string} base64String - Parameter description
 * @param {Object} options - Options object
 * @param {boolean} [options.stream=false] - Optional parameter
 * @returns {string} Return value description
 * @throws {Error} When something goes wrong
 */
export function detectImageType(base64String) {
  // Implementation
}
```

### Error Handling
```javascript
// Always validate inputs
if (!payload || typeof payload !== "object") {
  throw new Error("Invalid payload");
}

// Provide descriptive error messages
throw new Error("BaseAdapter is an abstract class and cannot be instantiated directly");

// Use try-catch for async operations
try {
  const result = await apiCall();
  return { success: true, data: result };
} catch (error) {
  return { success: false, error: error.message };
}
```

### Testing Guidelines

**Unit Tests** (`tests/unit/`)
- No external dependencies (server, network)
- Use mocks for external services
- Test file naming: `<module>.test.js`
- Structure: `describe` > `it` pattern
- Use fixtures from `tests/unit/fixtures/`

**Integration Tests** (`tests/integration/`)
- Require running server
- Test real API endpoints
- Use golden outputs for comparison
- Timeout: 30 seconds per test

**Test Structure**
```javascript
import { describe, it, expect } from "vitest";

describe("ModuleName", () => {
  describe("functionName", () => {
    it("should do something specific", () => {
      const result = functionName(input);
      expect(result).toBe(expected);
    });
  });
});
```

## Critical Rules

1. **All comments MUST be in English** (not Chinese)
2. **Never commit secrets** (use .env, don't commit .env files)
3. **Always use ESM imports** (not `require()`)
4. **Test before committing** (`npm run lint && npm run test:unit`)
5. **Deep clone fixtures** in tests to avoid mutation between tests
6. **Coverage target**: 80%+ for adapters, 90%+ for utilities

## Common Tasks

### Adding a new adapter
1. Extend `BaseAdapter` class
2. Implement `convertRequest()`, `parseResponse()`, `parseStreamChunk()`
3. Add unit tests in `tests/unit/adapters/`
4. Add integration tests in `tests/integration/`
5. Update `chat_client.js` to use new adapter

### Fixing a bug
1. Write a failing test that reproduces the bug
2. Fix the bug in source code
3. Verify test passes: `npx vitest run path/to/test.js`
4. Run full suite: `npm run test:unit`

### Adding a new feature
1. Write unit tests first (TDD approach)
2. Implement feature
3. Add integration tests if needed
4. Update README.md if user-facing
5. Ensure coverage remains above threshold
