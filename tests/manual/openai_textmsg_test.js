import OpenAI from "openai";

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testTextMessage(openai, stream) {
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
    throw error;
  }
}

const openai = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "sk-test",
});
testTextMessage(openai, stream);
