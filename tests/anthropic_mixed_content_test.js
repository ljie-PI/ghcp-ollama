import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Usage: node anthropic_mixed_content_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)
//
// This test verifies that mixed content types are correctly handled:
// 1. User message with image
// 2. Assistant response (text)
// 3. User message with text
// 4. Assistant message with tool_use
// 5. User message with tool_result
// 6. Assistant final response

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function encodeImageToBase64(imagePath) {
  const image = fs.readFileSync(imagePath);
  return image.toString("base64");
}

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testMixedContent(anthropic, stream) {
  try {
    const imagePath = path.join(__dirname, "images", "vergil.jpg");
    const base64Image = encodeImageToBase64(imagePath);

    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Who is in this image?",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: base64Image,
              },
            },
          ],
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
          content: [
            {
              type: "tool_use",
              id: "toolu_456",
              name: "search_games",
              input: {
                character: "Vergil",
                franchise: "Devil May Cry",
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_456",
              content:
                "Vergil appears in Devil May Cry 3, Devil May Cry 4, and Devil May Cry 5",
            },
          ],
        },
        {
          role: "user",
          content: "Thanks! Tell me more about the character.",
        },
      ],
      tools: [
        {
          name: "search_games",
          description: "Search for games featuring a character",
          input_schema: {
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
      ],
      stream: stream,
    };

    let fullResponse = "";
    const toolUses = [];

    if (stream) {
      const response = await anthropic.messages.create(payload);
      for await (const event of response) {
        console.log("Event received:", JSON.stringify(event));

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          const toolUse = event.content_block;
          toolUses.push({
            id: toolUse.id,
            name: toolUse.name,
            input: "",
          });
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta"
        ) {
          if (toolUses.length > 0) {
            toolUses[toolUses.length - 1].input += event.delta.partial_json;
          }
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text"
        ) {
          fullResponse += event.delta.text;
        }
      }

      // Parse accumulated JSON inputs
      for (const toolUse of toolUses) {
        if (toolUse.input && typeof toolUse.input === "string") {
          try {
            toolUse.input = JSON.parse(toolUse.input);
          } catch (e) {
            // Keep as string if parsing fails
          }
        }
      }
    } else {
      const response = await anthropic.messages.create(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));

      for (const block of response.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        } else if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
    }

    console.log("====================\n");
    console.log("Full Response:\n", fullResponse);
    if (toolUses.length > 0) {
      console.log("\n====================\n");
      console.log("Tool Uses:\n", JSON.stringify(toolUses, null, 2));
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

const anthropic = new Anthropic({
  baseURL: "http://localhost:11434",
  apiKey: "sk-ant-test",
  dangerouslyAllowBrowser: true,
});
testMixedContent(anthropic, stream);
