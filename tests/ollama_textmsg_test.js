// Usage: node ollama_textmsg_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)

// Parse command line arguments with a default value of true for stream
const args = process.argv.slice(2);
const stream = args.includes("--no-stream") ? false : true;

const payload = {
  model: "claude-3.5-sonnet",
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

async function chat() {
  try {
    const response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    let fullResponse = "";

    // Create a stream reader
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Decode the stream chunk and split by lines
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        const data = JSON.parse(line);
        console.log("Chunk received:", JSON.stringify(data));

        if (data.message) {
          fullResponse += data.message.content;
        }

        if (data.done) {
          console.log("Stream finished.\n");
          break;
        }
      }
    }

    console.log("====================\n");
    console.log("Full Response:\n", fullResponse);
  } catch (error) {
    console.error("Error:", error);
  }
}

chat();
