import { Ollama } from "ollama";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Usage: node ollama_image_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function encodeImageToBase64(imagePath) {
  const image = fs.readFileSync(imagePath);
  return image.toString("base64");
}

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testImageInput(ollama, stream) {
  try {
    const imagePath = path.join(__dirname, "images", "vergil.jpg");

    const payload = {
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: "Who is the man in this image?",
          images: [encodeImageToBase64(imagePath)],
        },
      ],
      stream: stream,
    };

    let fullResponse = "";

    if (stream) {
      const response = await ollama.chat(payload);
      for await (const chunk of response) {
        console.log("Chunk received:", JSON.stringify(chunk));
        if (chunk.message?.content) {
          fullResponse += chunk.message.content;
        }
        if (chunk.done) {
          console.log("Stream finished.\n");
        }
      }
    } else {
      const response = await ollama.chat(payload);
      console.log("Response received:", JSON.stringify(response));
      fullResponse = response.message.content;
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

const ollama = new Ollama({ host: "http://localhost:11434" });
testImageInput(ollama, stream);
