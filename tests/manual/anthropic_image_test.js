import Anthropic from "@anthropic-ai/sdk";
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

async function testImageInput(anthropic, stream) {
  try {
    const imagePath = path.join(__dirname, "images", "vergil.jpg");

    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Who is the man in this image?",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: encodeImageToBase64(imagePath),
              },
            },
          ],
        },
      ],
      stream: stream,
    };

    let fullResponse = "";

    if (stream) {
      const response = await anthropic.messages.create(payload);
      for await (const event of response) {
        console.log("Event received:", JSON.stringify(event));
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text"
        ) {
          fullResponse += event.delta.text;
        }
      }
    } else {
      const response = await anthropic.messages.create(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));
      for (const block of response.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        }
      }
    }

    console.log("====================\n");
    console.log("Full Response:\n", fullResponse);
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
testImageInput(anthropic, stream);
