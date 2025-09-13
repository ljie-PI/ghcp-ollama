import fs from "fs";
import express from "express";
import { CopilotAuth } from "./utils/auth_client.js";
import { CopilotChatClient } from "./utils/chat_client.js";
import { CopilotModels } from "./utils/model_client.js";

let authRefreshInterval = null;
const PORT = process.env.PORT || 11434;
const TOKEN_REFRESH_INTERVAL = 30 * 1000;
const REFRESH_BEFORE_EXPIRY = 5 * 60 * 1000;

function setupLogging() {
  const logFileIndex = process.argv.indexOf("--log-file");
  if (logFileIndex !== -1 && logFileIndex + 1 < process.argv.length) {
    const logFile = process.argv[logFileIndex + 1];
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    process.stdout.write = function (chunk, encoding, callback) {
      return logStream.write(chunk, encoding, callback);
    };

    process.stderr.write = function (chunk, encoding, callback) {
      return logStream.write(chunk, encoding, callback);
    };
  }
}

function setupTokenRefresh() {
  if (authRefreshInterval) {
    clearInterval(authRefreshInterval);
  }
  authRefreshInterval = setInterval(async () => {
    try {
      console.log("Checking GitHub Copilot authentication status...");
      const authClient = new CopilotAuth();
      const status = authClient.checkStatus();

      if (status.authenticated) {
        const tokenInfo = authClient.getGithubToken();
        if (
          tokenInfo.expired ||
          (tokenInfo.expires_at &&
            tokenInfo.expires_at * 1000 - Date.now() < REFRESH_BEFORE_EXPIRY)
        ) {
          await authClient.signIn(true);
          const newStatus = authClient.checkStatus();
          if (!newStatus.authenticated) {
            console.error("Sign in to Github Copilot failed.");
          }
          if (!newStatus.tokenValid) {
            console.error("GitHub token is not valid.");
          }
        }
      } else {
        console.error("Not authenticated with GitHub Copilot.");
      }
    } catch (error) {
      console.error("Error checking auth status:", error);
    }
  }, TOKEN_REFRESH_INTERVAL);
}

async function ensureCopilotSetup(_, res, next) {
  const authClient = new CopilotAuth();
  const status = authClient.checkStatus();
  if (!status.authenticated || !status.tokenValid) {
    return res.status(401).json({
      error: "Authentication required",
      message: "Please sign in to Github Copilot",
    });
  }
  next();
}

async function handleModelFetchRequest(_, res) {
  try {
    const modelClient = new CopilotModels();
    const modelsResult = await modelClient.getAvailableModels();

    if (modelsResult.success) {
      // Format the response to match Ollama's format
      const modelResponse = {
        models: modelsResult.availableModels.map((model) => ({
          name: model.id,
          modified_at: new Date().toISOString(),
          size: 0, // Size is not applicable for Copilot models
          digest: `copilot-${model.id}`,
          details: {
            parameter_size: "unknown",
            family: "GitHub Copilot",
            families: ["GitHub Copilot"],
            format: "Copilot API",
            description: model.description,
          },
        })),
      };
      return res.json(modelResponse);
    } else {
      return res.status(500).json({
        error: "Failed to get models",
        message: modelsResult.error,
      });
    }
  } catch (error) {
    return res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
}

async function handleChatRequest(req, res) {
  const model = req.body.model || "gpt-4o-2024-11-20";
  const messages = req.body.messages || [];
  const stream = req.body.stream !== undefined ? req.body.stream : false;
  const options = req.body.options || {};
  options.model = model;
  const tools = req.body.tools || [];

  const chatClient = new CopilotChatClient();
  try {
    if (stream) {
      // Set headers for response
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write("\n");

      const chatResult = await chatClient.sendStreamingRequest(
        messages,
        (respMessages, event) => {
          for (const respMessage of respMessages) {
            if (respMessage.message) {
              res.write(`${JSON.stringify(respMessage)}\n\n`);
            }
          }
          res.flush && res.flush();
          if (event === "end") {
            res.end();
          }
        },
        options,
        tools,
      );

      if (!chatResult.success) {
        const resp = {
          error: "Failed to generate text",
          message: chatResult.error,
        };
        res.write(`data: ${JSON.stringify(resp)}\n\n`);
        res.end();
      }
    } else {
      const result = await chatClient.sendRequest(messages, options, tools);
      if (result.success) {
        return res.json(result.data);
      } else {
        return res.status(500).json({
          error: "Failed to generate text",
          message: result.error,
        });
      }
    }
  } catch (error) {
    console.error("Error in chat request:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
}

async function handleOpenAIChatRequest(req, res) {
  const chatClient = new CopilotChatClient();
  try {
    const stream = req.body.stream !== undefined ? req.body.stream : false;
    if (stream) {
      // Set headers for response
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write("\n");

      const chatResult = await chatClient.sendStreamingOpenaiRequest(
        req.body,
        (respMessages, event) => {
          for (const respMessage of respMessages) {
            res.write(`data: ${JSON.stringify(respMessage)}\n\n`);
          }
          res.flush && res.flush();
          if (event === "end") {
            res.write("data: [DONE]\n\n");
            res.end();
          }
        },
      );

      if (!chatResult.success) {
        const resp = {
          error: "Failed to generate text",
          message: chatResult.error,
        };
        res.write(`data: ${JSON.stringify(resp)}\n\n`);
        res.end();
      }
    } else {
      const result = await chatClient.sendOpenaiRequest(req.body);
      if (result.success) {
        return res.json(result.data);
      } else {
        return res.status(500).json({
          error: "Failed to generate text",
          message: result.error,
        });
      }
    }
  } catch (error) {
    console.error("Error in chat request:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
}

function shutdown() {
  console.log("Shutting down server...");

  if (authRefreshInterval) {
    clearInterval(authRefreshInterval);
  }

  process.exit(0);
}

// Create Express app
const app = express();
app.use(express.json());

// Ollama API endpoints
app.get("/api/tags", ensureCopilotSetup, async (req, res) => {
  return handleModelFetchRequest(req, res);
});
app.post("/api/chat", ensureCopilotSetup, (req, res) => {
  return handleChatRequest(req, res);
});
app.post("/v1/chat/completions", ensureCopilotSetup, (req, res) => {
  return handleOpenAIChatRequest(req, res);
});

// Add enhanced error handling middleware
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error("Unhandled server error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`GitHub Copilot Ollama server running on port ${PORT}`);
  setupLogging();
  setupTokenRefresh();
});

// Handle shutdown gracefully
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
