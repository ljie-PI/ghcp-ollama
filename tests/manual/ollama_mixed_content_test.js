import { Ollama } from "ollama";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function encodeImageToBase64(imagePath) {
  const image = fs.readFileSync(imagePath);
  return image.toString("base64");
}

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testMixedContent(ollama, stream) {
  try {
    const imagePath = path.join(__dirname, "images", "vergil.jpg");
    const base64Image = encodeImageToBase64(imagePath);

    const payload = {
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: "Who is in this image?",
          images: [base64Image],
        },
        {
          role: "assistant",
          content: "This is Vergil from Devil May Cry.",
        },
        {
          role: "user",
          content: "What games has he appeared in?",
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_456",
              type: "function",
              function: {
                name: "search_games",
                arguments: { character: "Vergil", franchise: "Devil May Cry" },
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_456",
          content:
            "Vergil appears in Devil May Cry 3, Devil May Cry 4, and Devil May Cry 5",
        },
        {
          role: "user",
          content: "Thanks! Tell me more about the character.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "search_games",
            description: "Search for games featuring a character",
            parameters: {
              type: "object",
              properties: {
                character: {
                  type: "string",
                  description: "Character name",
                },
                franchise: {
                  type: "string",
                  description: "Game franchise name",
                },
              },
              required: ["character"],
            },
          },
        },
      ],
      stream: stream,
    };

    let fullResponse = "";
    let toolCalls = [];

    if (stream) {
      const response = await ollama.chat(payload);
      for await (const chunk of response) {
        console.log("Chunk received:", JSON.stringify(chunk));
        if (chunk.message?.content) {
          fullResponse += chunk.message.content;
        }
        if (chunk.message?.tool_calls) {
          toolCalls = chunk.message.tool_calls;
        }
        if (chunk.done) {
          console.log("Stream finished.\n");
        }
      }
    } else {
      const response = await ollama.chat(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));
      fullResponse = response.message.content;
      toolCalls = response.message.tool_calls || [];
    }

    console.log("====================\n");
    console.log("Full Response:\n", fullResponse);
    if (toolCalls.length > 0) {
      console.log("\n====================\n");
      console.log("Tool Calls:\n", JSON.stringify(toolCalls, null, 2));
    }
  } catch (error) {
    console.error("Error:", error);
    if (error.message.includes("ENOENT")) {
      console.error(
        "Image file not found. Please make sure to place an image named 'vergil.jpg' in the tests/images directory.",
      );
    }
    throw error;
  }
}

const ollama = new Ollama({ host: "http://localhost:11434" });
testMixedContent(ollama, stream);
