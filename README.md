# GHCP-Ollama

The [Ollama](https://github.com/ollama-dev/ollama) project provides a convenient way to interact with various LLMs (Large Language Models) via a simple API.
This project aims to provide an Ollama-compatible API for interacting with the LLMs of GitHub Copilot.

## Features

- Sign in/sign out with GitHub Copilot
- List available Copilot models
- Set active Copilot model
- Send chat requests and receive streaming responses
- Ollama-compatible API endpoints for integration with existing tools

## Requirements

- Node.js 18.x or newer
- GitHub Copilot subscription
- Installed Copilot LSP server (typically installed with copilot.lua Neovim plugin)

## Installation

```bash
# Clone the repository
git clone https://github.com/ljie-PI/ghcp-ollama.git

# Install dependencies
npm install
```

## Usage

There are two main ways to use this tool:

### 1. Command Line Interface

```bash
# Check your authentication status
node src/ghcp.js status

# Sign in to GitHub Copilot
node src/ghcp.js signin

# Sign out from GitHub Copilot
node src/ghcp.js signout

# List available models
node src/ghcp.js models

# Get the active model
node src/ghcp.js getmodel

# Set the active model
node src/ghcp.js setmodel --model gpt-4o-2024-11-20

# Send a chat message to Copilot
node src/ghcp.js chat --message "Write quick sort algo in python"
```

### 2. Ollama-Compatible Server

Start the server that provides Ollama-compatible API endpoints:

```bash
# Using npm start (recommended)
npm start
```

The server provides the following endpoints:

- `GET /api/tags`: List available models (similar to Ollama).

- `POST /api/chat`: The chat API with request/response in Ollama format.

- `POST /v1/chat/completions`: The chat API with request/response in OpenAI format (also supported in Ollama).

Since the server implements the same API endpoints as Ollama, you can use it with any tool that supports Ollama.

You can run some tests after server started:

-  List available models
```bash
curl http://localhost:11434/api/tags
````

- Chat with text messages
```bash
node tests/ollama_textmsg_test.js [--no-stream]

# or in OpenAI format
node tests/openai_textmsg_test.js [--no-stream]
```

- Chat with tools
```bash
node tests/ollama_tools_test.js [--no-stream]

#or in OpenAI format
node tests/openai_tools_test.js [--no-stream]
```

- Chat with image input
```bash
node tests/ollama_image_test.js [--no-stream]

# or in OpenAI format
node tests/openai_image_test.js [--no-stream]
```
