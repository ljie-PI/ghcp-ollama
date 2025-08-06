import express from "express";
import { CopilotAuth } from "./utils/auth_client.js";
import { CopilotChatClient } from "./utils/chat_client.js";
import { CopilotLSPClient } from "./utils/lsp_client.js";
import { CopilotModels } from "./utils/model_client.js";

// Global variables
let lspClient = null;
let authClient = null;
let modelClient = null;
let chatClient = null;
let authRefreshInterval = null;
let copilotStatus = null;
const PORT = process.env.PORT || 11434; // Same port as Ollama

async function setupCopilotChat() {
  try {
    console.log("Initializing GitHub Copilot LSP client...");
    if (!lspClient) {
      lspClient = new CopilotLSPClient();
    }
    if (!lspClient.initialized) {
      await lspClient.start();
    }

    console.log("Initializing GitHub Copilot chat client...");
    authClient = new CopilotAuth(lspClient);
    modelClient = new CopilotModels(lspClient);
    chatClient = new CopilotChatClient(lspClient);

    await authClient.signIn(true);
    const status = await authClient.checkStatus();
    if (!status.authenticated) {
      copilotStatus = { ready: false, error: "auth" };
      return { success: false, error: "Sing in to Github Copilot failed." };
    }
    if (!status.tokenValid) {
      copilotStatus = { ready: false, error: "auth" };
      return { success: false, error: "GitHub token is not valid." };
    }

    // Set up auto token refresh - check every hour if token is still valid
    startAuthRefresh();
    copilotStatus = { ready: true };
    return { success: true };
  } catch (error) {
    copilotStatus = { ready: false, error: "unknown" };
    return {
      success: false,
      error: `Failed to initialize Copilot client: ${error.message}.`,
    };
  }
}

function startAuthRefresh() {
  if (authRefreshInterval) {
    clearInterval(authRefreshInterval);
  }
  // Token expires in 30 minutes, refresh every 29 minutes
  authRefreshInterval = setInterval(
    async () => {
      try {
        console.log("Refreshing GitHub Copilot authentication...");
        await authClient.signIn(true);
        const status = await authClient.checkStatus();
        if (!status.authenticated) {
          console.error("Sign in to Github Copilot failed.");
        }
        if (!status.tokenValid) {
          console.error("GitHub token is not valid.");
        }
      } catch (error) {
        console.error("Error checking auth status:", error);
      }
    },
    29 * 60 * 1000,
  );
}

async function ensureCopilotSetup(req, res, next) {
  if (!copilotStatus.ready) {
    // If it needs authentication specifically, return 401
    if (copilotStatus.error === "auth") {
      return res.status(401).json({
        error: "Authentication required",
        message: "Please sign in to Github Copilot",
      });
    }

    // Otherwise return a 500 error
    return res.status(500).json({
      error: "Failed to setup GitHub Copilot client",
      message: "Please check your GitHub Copilot setup",
    });
  }
  next();
}

async function handleModelFetchRequest(req, res) {
  try {
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
  if (lspClient && lspClient.initialized) {
    lspClient.stop();
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
app.use((err, req, res, next) => {
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
  // Initialize client on startup
  setupCopilotChat()
    .then((result) => {
      if (result.success) {
        console.log("Github Copilot client setup successfully");
      } else {
        console.error("Github Copilot client setup failed:", result.error);
      }
    })
    .catch((error) => {
      console.error("Error during Github Copilot setup:", error);
    });
});

// Handle shutdown gracefully
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
