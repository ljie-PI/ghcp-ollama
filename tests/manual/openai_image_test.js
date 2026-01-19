import OpenAI from "openai";
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

async function testImageInput(openai, stream) {
  try {
    const imagePath = path.join(__dirname, "images", "vergil.jpg");

    const payload = {
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Who is the man in this image?",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${encodeImageToBase64(imagePath)}`,
              },
            },
          ],
        },
      ],
      stream: stream,
    };

    let fullResponse = "";

    if (stream) {
      const response = await openai.chat.completions.create(payload);
      for await (const chunk of response) {
        console.log("Chunk received:", JSON.stringify(chunk));
        if (chunk.choices[0]?.delta?.content) {
          fullResponse += chunk.choices[0].delta.content;
        }
      }
    } else {
      const response = await openai.chat.completions.create(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));
      fullResponse = response.choices[0].message.content;
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

const openai = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "sk-test",
});
testImageInput(openai, stream);
