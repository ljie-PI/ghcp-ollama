# GHCP-Ollama

The [Ollama](https://github.com/ollama-dev/ollama) project provides a convenient way to interact with various LLMs (Large Language Models) via a simple API.
This project aims to provide an Ollama-compatible API for interacting with the LLMs of GitHub Copilot.

## Features

- Sign in/sign out with GitHub Copilot
- List available Copilot models
- Set active Copilot model
- Send chat requests and receive streaming responses
- Ollama-compatible API endpoints for integration with existing tools
- Anthropic Messages API endpoints for Anthropic SDK compatibility

## Requirements

- Node.js 18.x or newer
- GitHub Copilot subscription

## Installation

You can install this package directly from npm:

```bash
npm install -g @ljie-pi/ghcp-ollama
```

Alternatively, you can clone the repository and install locally:

```bash
# Clone the repository
git clone https://github.com/ljie-PI/ghcp-ollama.git

# Install dependencies
npm install

# Link the package globally (optional)
npm link
```

## Usage

There are two main ways to use this tool:

### 1. Command Line Interface

After installing via npm, you can use the `ghcpo` command directly:

```bash
# Check your authentication status
ghcpo status

# Sign in to GitHub Copilot
ghcpo signin

# Sign out from GitHub Copilot
ghcpo signout

# List available models
ghcpo models

# Get the active model
ghcpo getmodel

# Set the active model
ghcpo setmodel --model gpt-4o-2024-11-20

# Send a chat message to Copilot
ghcpo chat --message "Write quick sort algo in python"
```

If you cloned the repository instead, you can use:

```bash
# Check your authentication status
node src/ghcpo.js status

# Sign in to GitHub Copilot
node src/ghcpo.js signin

# Sign out from GitHub Copilot
node src/ghcpo.js signout

# List available models
node src/ghcpo.js models

# Get the active model
node src/ghcpo.js getmodel

# Set the active model
node src/ghcpo.js setmodel --model gpt-4o-2024-11-20

# Send a chat message to Copilot
node src/ghcpo.js chat --message "Write quick sort algo in python"
```

### 2. Ollama-Compatible Server

Start the server that provides Ollama-compatible API endpoints:

If installed via npm, you can use the `ghcpo-server` command:

```bash
# Start the server
ghcpo-server start

# Check server status
ghcpo-server status

# Stop the server
ghcpo-server stop

# Restart the server
ghcpo-server restart
```

Alternatively, you can start the server directly with Node.js:

```bash
# Using npm start (recommended)
npm start

# Or directly with Node.js
node src/server.js
```

The server provides the following endpoints:

- `GET /api/version`: Get Ollama version information.

- `GET /api/tags`: List available models (similar to Ollama).

- `POST /api/chat`: The chat API with request/response in Ollama format.

- `POST /v1/chat/completions`: The chat API with request/response in OpenAI format (also supported in Ollama).

- `POST /v1/messages`: The chat API with request/response in Anthropic format.

Since the server implements the same API endpoints as Ollama, you can use it with any tool that supports Ollama.

You can run some tests after server started:

-  List available models
```bash
curl http://localhost:11434/api/tags
```

- Chat with text messages
```bash
node tests/manual/ollama_textmsg_test.js [--no-stream]

# or in OpenAI format
node tests/manual/openai_textmsg_test.js [--no-stream]

# or in Anthropic format
node tests/manual/anthropic_textmsg_test.js [--no-stream]
```

- Chat with tools
```bash
node tests/manual/ollama_tools_test.js [--no-stream]

#or in OpenAI format
node tests/manual/openai_tools_test.js [--no-stream]

# or in Anthropic format
node tests/manual/anthropic_tools_test.js [--no-stream]
```

- Chat with image input
```bash
node tests/manual/ollama_image_test.js [--no-stream]

# or in OpenAI format
node tests/manual/openai_image_test.js [--no-stream]

# or in Anthropic format
node tests/manual/anthropic_image_test.js [--no-stream]
```

## Testing

This project has a comprehensive test suite including unit tests and integration tests.

### Test Structure

```
tests/
├── unit/                    # Unit tests (no server required)
│   ├── adapters/           # Adapter unit tests
│   ├── fixtures/           # Shared test fixtures
│   └── helpers/            # Test utilities
├── integration/            # Integration tests (requires running server)
│   ├── golden/             # Golden output files for comparison
│   └── utils/              # Integration test utilities
└── manual/                 # Manual test scripts
```

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests only (fast, no server required)
npm run test:unit

# Run integration tests (requires server running)
npm run test:integration

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

### Integration Tests

Integration tests require the server to be running and authenticated:

```bash
# 1. Sign in to GitHub Copilot
node src/ghcpo.js signin

# 2. Start the server
npm run dev

# 3. Generate golden outputs (one-time, or when test cases change)
npm run test:golden

# 4. Run integration tests
npm run test:integration
```
