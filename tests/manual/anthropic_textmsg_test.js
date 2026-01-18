import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testTextMessage(anthropic, stream) {
  try {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 1024,
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
      const response = await anthropic.messages.create(payload);
      for await (const event of response) {
        console.log("Event received:", JSON.stringify(event));
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
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
    throw error;
  }
}

const anthropic = new Anthropic({
  baseURL: "http://localhost:11434",
  apiKey: "sk-ant-test",
  dangerouslyAllowBrowser: true,
});
testTextMessage(anthropic, stream);
