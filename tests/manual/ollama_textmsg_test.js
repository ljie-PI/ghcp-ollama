import { Ollama } from "ollama";

// Usage: node ollama_textmsg_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testTextMessage(ollama, stream) {
  try {
    const payload = {
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: "why is the sky blue?",
        },
        {
          role: "assistant",
          content: "due to rayleigh scattering.",
        },
        {
          role: "user",
          content: "how is that different than mie scattering?",
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
    throw error;
  }
}

const ollama = new Ollama({ host: "http://localhost:11434" });
testTextMessage(ollama, stream);
