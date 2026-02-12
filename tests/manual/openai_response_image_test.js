import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");
const compact = args.includes("--compact");
const baseUrl = process.env.GHCPO_BASE_URL || "http://localhost:11434";
const apiKey = process.env.GHCPO_API_KEY || "sk-test";

function encodeImageToBase64(imagePath) {
  const image = fs.readFileSync(imagePath);
  return image.toString("base64");
}

function resolveEndpoint(useCompact) {
  return `${baseUrl}/v1/response${useCompact ? "/compact" : ""}`;
}

async function sendResponseRequest(payload, useCompact) {
  const response = await fetch(resolveEndpoint(useCompact), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  if (!payload.stream) {
    return await response.json();
  }

  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    const messages = buffer.split("\n\n");
    buffer = messages.pop() || "";

    for (const message of messages) {
      for (const line of message.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const data = line.slice(6);
        if (data === "[DONE]") {
          events.push({ type: "done" });
          continue;
        }

        try {
          events.push(JSON.parse(data));
        } catch {
          events.push({ type: "parse_error", raw: data });
        }
      }
    }
  }

  return events;
}

async function testResponseImageInput(streamMode, useCompact) {
  try {
    const imagePath = path.join(__dirname, "..", "images", "vergil.jpg");

    const payload = {
      model: "gpt-5.2",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Who is the man in this image?",
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${encodeImageToBase64(imagePath)}`,
            },
          ],
        },
      ],
      stream: streamMode,
    };

    console.log("Endpoint:", resolveEndpoint(useCompact));

    let fullResponse = "";
    if (streamMode) {
      const events = await sendResponseRequest(payload, useCompact);
      for (const event of events) {
        console.log("Event received:", JSON.stringify(event));
        if (event.type === "response.output_text.delta") {
          fullResponse += event.delta || "";
        }
      }
    } else {
      const response = await sendResponseRequest(payload, useCompact);
      console.log("Response received:", JSON.stringify(response, null, 2));
      fullResponse = response.output_text || "";
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

testResponseImageInput(stream, compact);
