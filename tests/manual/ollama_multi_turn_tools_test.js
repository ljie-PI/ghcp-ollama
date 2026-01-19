import { Ollama } from "ollama";

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current time for a specific timezone",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "The timezone to get the current time for (e.g., Asia/Shanghai)",
          },
        },
        required: ["timezone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The location to get the weather for, e.g. Beijing",
          },
          format: {
            type: "string",
            description: "The format to return the weather in",
            enum: ["celsius", "fahrenheit"],
          },
        },
        required: ["location", "format"],
      },
    },
  },
];

function mockToolExecution(name, args) {
  if (name === "get_current_time") {
    return `Current time in ${args.timezone}: 2024-01-15 14:30:00 CST`;
  }
  if (name === "get_current_weather") {
    return `Weather in ${args.location}: Temperature 15°C, Condition: Sunny, Humidity: 45%`;
  }
  return `Unknown tool: ${name}`;
}

async function sendRequest(ollama, payload, stream) {
  let textResponse = "";
  const toolCalls = [];

  if (stream) {
    const response = await ollama.chat(payload);
    console.log("\n--- Streaming Events ---");
    for await (const chunk of response) {
      console.log(JSON.stringify(chunk));
      if (chunk.message?.content) {
        textResponse += chunk.message.content;
      }
      if (chunk.message?.tool_calls) {
        for (const toolCall of chunk.message.tool_calls) {
          const existingTool = toolCalls.find((t) => t.id === toolCall.id);
          if (!existingTool) {
            toolCalls.push(toolCall);
          }
        }
      }
    }
    console.log("--- End Streaming Events ---\n");
  } else {
    const response = await ollama.chat(payload);
    textResponse = response.message?.content || "";
    if (response.message?.tool_calls) {
      toolCalls.push(...response.message.tool_calls);
    }
  }

  return { textResponse, toolCalls };
}

async function testMultiTurnWithTools(ollama, stream) {
  console.log("========== TURN 1: Triggering tool_calls ==========\n");

  const turn1Payload = {
    model: "gpt-5.2",
    messages: [
      { role: "user", content: "What's the time and weather in Beijing and Shanghai now?" },
    ],
    tools,
    stream,
  };

  const turn1Result = await sendRequest(ollama, turn1Payload, stream);

  console.log("Turn 1 Text Response:", turn1Result.textResponse);
  console.log("Turn 1 Tool Calls:", JSON.stringify(turn1Result.toolCalls, null, 2));

  if (turn1Result.toolCalls.length === 0) {
    throw new Error("FAIL: No tool_calls triggered in turn 1. LLM should have called tools.");
  }

  console.log("\n========== TURN 2: Sending tool results ==========\n");

  const toolResultMessages = turn1Result.toolCalls.map((toolCall) => ({
    role: "tool",
    tool_call_id: toolCall.id,
    content: mockToolExecution(toolCall.function.name, toolCall.function.arguments),
  }));

  console.log("Tool Result Messages:", JSON.stringify(toolResultMessages, null, 2));

  const turn2Payload = {
    model: "gpt-5.2",
    messages: [
      { role: "user", content: "What's the time and weather in Beijing and Shanghai now?" },
      {
        role: "assistant",
        content: turn1Result.textResponse || "",
        tool_calls: turn1Result.toolCalls,
      },
      ...toolResultMessages,
    ],
    tools,
    stream,
  };

  console.log("\n" + "-".repeat(80));
  console.log("Turn 2 Payload (before conversion):");
  console.log(JSON.stringify(turn2Payload, null, 2));
  console.log("-".repeat(80) + "\n");

  const turn2Result = await sendRequest(ollama, turn2Payload, stream);

  console.log("\nTurn 2 Text Response:", turn2Result.textResponse);

  console.log("\n========== TEST RESULT ==========\n");

  if (turn2Result.textResponse && turn2Result.toolCalls.length === 0) {
    console.log("SUCCESS: Multi-turn tool call conversation completed.");
  } else {
    console.log("WARNING: Unexpected result in turn 2.");
  }
}

const ollama = new Ollama({ host: "http://localhost:11434" });

testMultiTurnWithTools(ollama, stream).catch((error) => {
  console.error("Test failed:", error.message);
  process.exit(1);
});
