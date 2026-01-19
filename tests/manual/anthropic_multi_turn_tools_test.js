import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

const tools = [
  {
    name: "get_current_time",
    description: "Get the current time for a specific timezone",
    input_schema: {
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
  {
    name: "get_current_weather",
    description: "Get the current weather for a location",
    input_schema: {
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
];

function mockToolExecution(name, input) {
  if (name === "get_current_time") {
    return `Current time in ${input.timezone}: 2024-01-15 14:30:00 CST`;
  }
  if (name === "get_current_weather") {
    return `Weather in ${input.location}: Temperature 15°C, Condition: Sunny, Humidity: 45%`;
  }
  return `Unknown tool: ${name}`;
}

async function sendRequest(anthropic, payload, stream) {
  let textResponse = "";
  const toolUses = [];
  let stopReason = null;

  if (stream) {
    const response = await anthropic.messages.create(payload);
    let currentToolUse = null;

    console.log("\n--- Streaming Events ---");
    for await (const event of response) {
      console.log(JSON.stringify(event));
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        currentToolUse = {
          id: event.content_block.id,
          name: event.content_block.name,
          input: "",
        };
        toolUses.push(currentToolUse);
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        textResponse += event.delta.text;
      }
      if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        if (currentToolUse) {
          currentToolUse.input += event.delta.partial_json;
        }
      }
      if (event.type === "content_block_stop") {
        currentToolUse = null;
      }
      if (event.type === "message_delta" && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason;
      }
    }
    console.log("--- End Streaming Events ---\n");

    for (const toolUse of toolUses) {
      if (toolUse.input && typeof toolUse.input === "string") {
        try {
          toolUse.input = JSON.parse(toolUse.input);
        } catch {
          // Keep as string
        }
      }
    }
  } else {
    const response = await anthropic.messages.create(payload);
    stopReason = response.stop_reason;

    for (const block of response.content) {
      if (block.type === "text") {
        textResponse += block.text;
      } else if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  const assistantContent = [];
  if (textResponse) {
    assistantContent.push({ type: "text", text: textResponse });
  }
  for (const toolUse of toolUses) {
    assistantContent.push({
      type: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    });
  }

  return { textResponse, toolUses, assistantContent, stopReason };
}

async function testMultiTurnWithTools(anthropic, stream) {
  console.log("========== TURN 1: Triggering tool_use ==========\n");

  const turn1Payload = {
    model: "claude-sonnet-4.5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "What's the time and weather in Beijing and Shanghai now?" },
    ],
    tools,
    stream,
  };

  const turn1Result = await sendRequest(anthropic, turn1Payload, stream);

  console.log("Turn 1 Text Response:", turn1Result.textResponse);
  console.log("Turn 1 Tool Uses:", JSON.stringify(turn1Result.toolUses, null, 2));
  console.log("Turn 1 Stop Reason:", turn1Result.stopReason);

  if (turn1Result.toolUses.length === 0) {
    throw new Error("FAIL: No tool_use triggered in turn 1. LLM should have called tools.");
  }

  console.log("\n========== TURN 2: Sending tool_result ==========\n");

  const toolResults = turn1Result.toolUses.map((toolUse) => ({
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: mockToolExecution(toolUse.name, toolUse.input),
  }));

  console.log("Tool Results:", JSON.stringify(toolResults, null, 2));

  const turn2Payload = {
    model: "claude-sonnet-4.5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "What's the time and weather in Beijing and Shanghai now?" },
      { role: "assistant", content: turn1Result.assistantContent },
      { role: "user", content: toolResults },
    ],
    tools,
    stream,
  };

  console.log("\n" + "-".repeat(80));
  console.log("Turn 2 Payload (before conversion):");
  console.log(JSON.stringify(turn2Payload, null, 2));
  console.log("-".repeat(80) + "\n");

  const turn2Result = await sendRequest(anthropic, turn2Payload, stream);

  console.log("\nTurn 2 Text Response:", turn2Result.textResponse);
  console.log("Turn 2 Stop Reason:", turn2Result.stopReason);

  console.log("\n========== TEST RESULT ==========\n");

  if (turn2Result.textResponse && turn2Result.stopReason === "end_turn") {
    console.log("SUCCESS: Multi-turn tool call conversation completed.");
  } else {
    console.log("WARNING: Unexpected result in turn 2.");
  }
}

const anthropic = new Anthropic({
  baseURL: "http://localhost:11434",
  apiKey: "sk-ant-test",
  dangerouslyAllowBrowser: true,
});

testMultiTurnWithTools(anthropic, stream).catch((error) => {
  console.error("Test failed:", error.message);
  process.exit(1);
});
