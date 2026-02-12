const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");
const compact = args.includes("--compact");
const baseUrl = process.env.GHCPO_BASE_URL || "http://localhost:11434";
const apiKey = process.env.GHCPO_API_KEY || "sk-test";

const tools = [
  {
    type: "function",
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
  {
    type: "function",
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
];

function resolveEndpoint(useCompact) {
  return `${baseUrl}/v1/response${useCompact ? "/compact" : ""}`;
}

function mockToolExecution(name, input) {
  if (name === "get_current_time") {
    return `Current time in ${input.timezone}: 2024-01-15 14:30:00 CST`;
  }
  if (name === "get_current_weather") {
    return `Weather in ${input.location}: Temperature 15°C, Condition: Sunny, Humidity: 45%`;
  }
  return `Unknown tool: ${name}`;
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

async function sendTurn(payload, streamMode, useCompact) {
  let textResponse = "";
  const toolCalls = [];

  if (streamMode) {
    const events = await sendResponseRequest(payload, useCompact);
    const callMap = {};

    console.log("\n--- Streaming Events ---");
    for (const event of events) {
      console.log(JSON.stringify(event));

      if (event.type === "response.output_text.delta") {
        textResponse += event.delta || "";
      }

      if (event.type === "response.function_call_arguments.delta") {
        if (!callMap[event.item_id]) {
          callMap[event.item_id] = {
            id: event.item_id,
            name: "unknown",
            arguments: "",
          };
        }
        callMap[event.item_id].arguments += event.delta || "";
      }

      if (event.type === "response.completed") {
        const outputItems = event.response?.output || [];
        for (const item of outputItems) {
          if (item.type === "function_call") {
            if (!callMap[item.id]) {
              callMap[item.id] = {
                id: item.id,
                name: item.name,
                arguments: item.arguments || "",
              };
            } else {
              callMap[item.id].name = item.name || callMap[item.id].name;
            }
          }
        }
      }
    }
    console.log("--- End Streaming Events ---\n");

    for (const callId in callMap) {
      const toolCall = callMap[callId];
      if (toolCall.arguments && typeof toolCall.arguments === "string") {
        try {
          toolCall.arguments = JSON.parse(toolCall.arguments);
        } catch {
          // Keep as string
        }
      }
      toolCalls.push(toolCall);
    }
  } else {
    const response = await sendResponseRequest(payload, useCompact);
    textResponse = response.output_text || "";

    for (const item of response.output || []) {
      if (item.type === "function_call") {
        toolCalls.push({
          id: item.id,
          name: item.name,
          arguments: item.arguments,
        });
      }
    }

    for (const toolCall of toolCalls) {
      if (toolCall.arguments && typeof toolCall.arguments === "string") {
        try {
          toolCall.arguments = JSON.parse(toolCall.arguments);
        } catch {
          // Keep as string
        }
      }
    }
  }

  return { textResponse, toolCalls };
}

async function testMultiTurnWithTools(streamMode, useCompact) {
  console.log("Endpoint:", resolveEndpoint(useCompact));
  console.log("========== TURN 1: Triggering function_call ==========" + "\n");

  const turn1Payload = {
    model: "gpt-5.2",
    input: [
      {
        role: "user",
        content: "What's the time and weather in Beijing and Shanghai now?",
      },
    ],
    tools,
    stream: streamMode,
  };

  const turn1Result = await sendTurn(turn1Payload, streamMode, useCompact);

  console.log("Turn 1 Text Response:", turn1Result.textResponse);
  console.log("Turn 1 Tool Calls:", JSON.stringify(turn1Result.toolCalls, null, 2));

  if (turn1Result.toolCalls.length === 0) {
    throw new Error("FAIL: No function_call triggered in turn 1. LLM should have called tools.");
  }

  console.log("\n========== TURN 2: Sending function_call_output ==========\n");

  const turn2Input = [
    {
      role: "user",
      content: "What's the time and weather in Beijing and Shanghai now?",
    },
  ];

  for (const toolCall of turn1Result.toolCalls) {
    turn2Input.push({
      type: "function_call_output",
      call_id: toolCall.id,
      output: mockToolExecution(toolCall.name, toolCall.arguments || {}),
    });
  }

  const turn2Payload = {
    model: "gpt-5.2",
    input: turn2Input,
    tools,
    stream: streamMode,
  };

  console.log("\n" + "-".repeat(80));
  console.log("Turn 2 Payload (before conversion):");
  console.log(JSON.stringify(turn2Payload, null, 2));
  console.log("-".repeat(80) + "\n");

  const turn2Result = await sendTurn(turn2Payload, streamMode, useCompact);

  console.log("Turn 2 Text Response:", turn2Result.textResponse);
  console.log("Turn 2 Tool Calls:", JSON.stringify(turn2Result.toolCalls, null, 2));

  console.log("\n========== TEST RESULT ==========\n");

  if (turn2Result.textResponse) {
    console.log("SUCCESS: Multi-turn tool call conversation completed.");
  } else {
    console.log("WARNING: Empty turn 2 text response.");
  }
}

testMultiTurnWithTools(stream, compact).catch((error) => {
  console.error("Test failed:", error.message);
  process.exit(1);
});
