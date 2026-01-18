import { Ollama } from "ollama";

// Usage: node ollama_multi_turn_tools_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)
//
// This test verifies that multi-turn conversations with tool calls are correctly
// converted to OpenAI format. It tests:
// 1. User message
// 2. Assistant message with tool_calls
// 3. Tool result message (role="tool")
// 4. Follow-up user message

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testMultiTurnWithTools(ollama, stream) {
  try {
    const payload = {
      model: "gpt-5.2",
      messages: [
        {
          role: "user",
          content: "What's the weather in Beijing?",
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_weather",
                arguments: { location: "Beijing", format: "celsius" },
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: "Temperature: 15°C, Condition: Sunny",
        },
        {
          role: "assistant",
          content:
            "The weather in Beijing is currently 15°C and sunny. Would you like to know anything else?",
        },
        {
          role: "user",
          content: "Thanks! And what's the time there?",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather information for a location",
            parameters: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: "The location to get weather for",
                },
                format: {
                  type: "string",
                  enum: ["celsius", "fahrenheit"],
                  description: "Temperature format",
                },
              },
              required: ["location", "format"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "get_time",
            description: "Get current time for a timezone",
            parameters: {
              type: "object",
              properties: {
                timezone: {
                  type: "string",
                  description: "Timezone (e.g., Asia/Shanghai)",
                },
              },
              required: ["timezone"],
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
    throw error;
  }
}

const ollama = new Ollama({ host: "http://localhost:11434" });
testMultiTurnWithTools(ollama, stream);
