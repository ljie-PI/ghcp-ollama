#!/usr/bin/env node

import minimist from "minimist";
import { CopilotAuth } from "./utils/auth_client.js";
import { CopilotModels } from "./utils/model_client.js";
import { CopilotChatClient } from "./utils/chat_client.js";

const args = process.argv.slice(2);
const command = args[0] || "status";
const argv = minimist(args.slice(1), {
  string: ["message", "model"],
  boolean: ["help"],
  alias: {
    h: "help",
    m: "message",
  },
});
argv.command = command;

if (argv.help) {
  console.log(`
GitHub Copilot CLI Tool

Usage: node ghcpo.js <command> [options]

Commands:
  status                Check authentication status
  signin                Sign in to GitHub Copilot
  signout               Sign out from GitHub Copilot
  models                List available models
  getmodel              Get the active model
  setmodel              Set the active model (requires --model)
  chat                  Send a chat message to Copilot (requires --message)

Options:
  --message, -m         Message for chat command
  --model               Model ID for setmodel command
  --help, -h            Show this help message

Examples:
  node ghcpo.js status
  node ghcpo.js signin
  node ghcpo.js setmodel --model gpt-4
  node ghcpo.js chat --message "How do I read a file in Node.js?"
  `);
  process.exit(0);
}


async function main() {
  try {
    const auth = new CopilotAuth();
    const models = new CopilotModels();
    const chatClient = new CopilotChatClient();

    switch (argv.command) {
    case "status": {
      const status = auth.checkStatus();
      if (status.user && status.authenticated) {
        console.log(`Signed in as GitHub user: ${status.user}`);
      } else {
        console.log("Not signed in");
      }
      if (status.tokenValid) {
        console.log("GitHub token is valid");
      } else if (status.tokenExpired) {
        console.log("GitHub token is expired");
      } else {
        console.log("GitHub token is not valid");
      }
      break;
    }

    case "signin": {
      await auth.signIn();
      break;
    }

    case "signout": {
      await auth.signOut();
      break;
    }

    case "models": {
      const modelsInfo = await models.getAvailableModels();
      if (modelsInfo.success) {
        console.log("Available models:");
        console.log(JSON.stringify(modelsInfo.availableModels, null, 2));
      } else {
        console.error("Failed to get models:", modelsInfo.error);
      }
      break;
    }

    case "getmodel": {
      const currentModel = await models.getCurrentModel();
      if (currentModel.success) {
        console.log("Current active model:");
        console.log(JSON.stringify(currentModel.modelConfig, null, 2));
      } else {
        console.error("Failed to get current model:", currentModel.error);
      }
      break;
    }

    case "setmodel": {
      const modelId = argv.model;
      if (!modelId) {
        console.error("Model ID is required. Use --model <modelId>");
        break;
      }

      const result = await models.setModel(modelId);
      if (result.success) {
        console.log("Set active model to:");
        console.log(JSON.stringify(result.modelConfig, null, 2));
      } else {
        console.error("Failed to set model:", result.error);
      }
      break;
    }

    case "chat": {
      const message = argv.message;
      if (!message) {
        console.error("Message is required. Use --message <message>");
        break;
      }
      console.log("Sending message to Copilot...\n");
      const messages = [
        {
          role: "system",
          content: "You are GitHub Copilot, an AI coding assistant.",
        },
        { role: "user", content: message },
      ];
      await chatClient.sendStreamingRequest(
        messages,
        (respMessages) => {
          for (const respMessage of respMessages) {
            if (respMessage.message?.content) {
              process.stdout.write(respMessage.message.content);
            }
            if (respMessage.done) {
              console.log("\n\n[Response complete]");
              cleanup();
            }
          }
        },
        { temperature: 0.5 },
      );
      process.stdin.resume();
      break;
    }

    default:
      console.error(`Unknown command: ${argv.command}`);
      break;
    }
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    // Don't stop if we're streaming a chat message
    if (argv.command !== "chat") {
      cleanup();
    }
  }
}

function cleanup() {
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("\nReceived SIGINT. Shutting down...");
  cleanup();
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM. Shutting down...");
  cleanup();
});

main().catch((error) => {
  console.error("Fatal error:", error);
  cleanup();
});
