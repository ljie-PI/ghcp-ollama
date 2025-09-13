# GHCP-Ollama Project Context

## Project Overview

GHCP-Ollama is a Node.js project that provides an Ollama-compatible API for interacting with GitHub Copilot's Large Language Models (LLMs). It allows users to access GitHub Copilot's capabilities through familiar Ollama API endpoints.

## Project Structure

```
.
├── src/
│   ├── config.js              # Configuration settings
│   ├── ghcpo.js               # CLI tool implementation
│   ├── server.js              # Main server implementation
│   ├── serverctl.js           # Server control utilities
│   └── utils/                 # Utility modules
│       ├── auth_client.js     # GitHub authentication handling
│       ├── chat_client.js     # Chat functionality with Copilot
│       ├── http_utils.js      # HTTP request utilities
│       └── model_client.js    # Model management utilities
├── tests/                     # Test scripts
├── package.json               # Project dependencies and scripts
├── README.md                  # Project documentation
└── eslint.config.js           # ESLint configuration
```

## Local Development Setup

### Prerequisites
- Node.js 18.x or newer
- GitHub Copilot subscription

### Quick Start for Development
```bash
# Install dependencies
npm install

# Run in development mode with auto-restart on file changes
npm run dev

# Or start the server normally
npm start
```

## Development Commands

```bash
# Development server with auto-restart
npm run dev

# Start server normally
npm start

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Build distribution package
npm run build

# Server control commands
npm run server:start    # Start server with logging
npm run server:stop     # Stop server
npm run server:restart  # Restart server
npm run server:status   # Check server status
```

## Debugging Guide

### Server Logging
- Server logs are written to `~/.ghcpo-server/log/` directory
- Each server session creates a timestamped log file
- Authentication messages are displayed in console but not written to log files

### Common Debugging Scenarios

1. **Authentication Issues**
   - Check `~/.config/github-copilot/` directory for auth tokens
   - Run `node src/ghcpo.js status` to check auth status
   - Run `node src/ghcpo.js signin` to re-authenticate

2. **Server Not Starting**
   - Check if port 11434 is already in use
   - Verify GitHub Copilot authentication status
   - Check log files in `~/.ghcpo-server/log/`

3. **API Response Issues**
   - Test with curl commands:
     ```bash
     curl http://localhost:11434/api/tags
     ```
   - Use test scripts in the `tests/` directory

### Process Management
- Server runs as a detached process when started with `serverctl.js`
- PID file is stored at `~/.ghcpo-server/pidfile`
- Use `npm run server:stop` to properly stop the server

## Development Conventions

### Code Style
The project follows these ESLint rules:
- Indentation: 2 spaces
- Line endings: Unix style
- Quotes: Double quotes
- Semicolons: Always required
- Variables: Prefer const, no var
- Unused variables: Not allowed

### Architecture
The project is organized into these main components:
1. **Authentication** (`auth_client.js`) - Handles GitHub OAuth flow and token management
2. **Model Management** (`model_client.js`) - Manages available models and active model selection
3. **Chat Functionality** (`chat_client.js`) - Handles sending chat requests to Copilot API
4. **HTTP Utilities** (`http_utils.js`) - Provides HTTP request functionality
5. **Configuration** (`config.js`) - Stores configuration settings
6. **CLI Tool** (`ghcpo.js`) - Provides command-line interface
7. **Server Control** (`serverctl.js`) - Manages server lifecycle and logging
8. **Server** (`server.js`) - Implements Ollama-compatible API endpoints

## Key Implementation Details

### Authentication Flow
- Uses GitHub's device authorization flow
- Tokens stored in `~/.config/github-copilot/`
- Automatic token refresh every 25 minutes

### API Endpoints
- `GET /api/tags` - List available models (Ollama format)
- `POST /api/chat` - Chat API (Ollama format)
- `POST /v1/chat/completions` - Chat API (OpenAI format)