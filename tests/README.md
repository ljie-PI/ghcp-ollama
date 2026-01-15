# Test Files

This directory contains test files for testing the ghcp-ollama server.

## Usage

All test files use official SDKs (Ollama and OpenAI) for cleaner API interactions.

### Ollama Tests

- `ollama_textmsg_test.js` - Test text message with Ollama API
- `ollama_image_test.js` - Test image input with Ollama API
- `ollama_tools_test.js` - Test tool invocation with Ollama API

### OpenAI Tests

- `openai_textmsg_test.js` - Test text message with OpenAI API
- `openai_image_test.js` - Test image input with OpenAI API
- `openai_tools_test.js` - Test tool invocation with OpenAI API

## Running Tests

Each test can be run with or without streaming:

```bash
# Run with streaming (default)
node tests/ollama_textmsg_test.js

# Run without streaming
node tests/ollama_textmsg_test.js --no-stream
```

## Test Types

1. **Text Message**: Simple text conversation
2. **Image Input**: Text conversation with image input
3. **Tool Invocation**: Conversation with function calling

## Setup

Make sure the ghcp-ollama server is running before running tests:

```bash
npm start
```

Or start it in the background:

```bash
npm run server:start
```

## Prerequisites

- Node.js >= 18.0.0
- Image file at `tests/images/vergil.jpg` for image input tests
