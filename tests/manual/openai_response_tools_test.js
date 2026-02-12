const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");
const compact = args.includes("--compact");
const baseUrl = process.env.GHCPO_BASE_URL || "http://localhost:11434";
const apiKey = process.env.GHCPO_API_KEY || "sk-test";

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

async function testResponseToolInvocation(streamMode, useCompact) {
  try {
    const payload = {
      model: "gpt-5.2",
      input: [
        {
          role: "user",
          content: "What's the time and weather in Beijing now?",
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_current_time",
          description: "Get the current time for a specific timezone",
          parameters: {
            type: "object",
            properties: {
              timezone: {
                type: "string",
                description:
                  "The timezone to get the current time for (e.g., Asia/Shanghai)",
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
                description: "The location to get weather for",
              },
              format: {
                type: "string",
                enum: ["celsius", "fahrenheit"],
              },
            },
            required: ["location", "format"],
          },
        },
      ],
      tool_choice: "auto",
      stream: streamMode,
    };

    console.log("Endpoint:", resolveEndpoint(useCompact));

    const toolResponses = {};
    let textResponse = "";

    if (streamMode) {
      const events = await sendResponseRequest(payload, useCompact);
      for (const event of events) {
        console.log("Event received:", JSON.stringify(event));

        if (event.type === "response.output_text.delta") {
          textResponse += event.delta || "";
        }

        if (event.type === "response.function_call_arguments.delta") {
          if (!toolResponses[event.item_id]) {
            toolResponses[event.item_id] = {
              id: event.item_id,
              arguments: "",
            };
          }
          toolResponses[event.item_id].arguments += event.delta || "";
        }
      }
    } else {
      const response = await sendResponseRequest(payload, useCompact);
      console.log("Response received:", JSON.stringify(response, null, 2));
      textResponse = response.output_text || "";

      for (const item of response.output || []) {
        if (item.type === "function_call") {
          toolResponses[item.id] = {
            id: item.id,
            name: item.name,
            arguments: item.arguments,
          };
        }
      }
    }

    console.log("====================\n");
    console.log("Text Response:\n", textResponse);
    console.log("\n====================\n");
    console.log("Tool Response:\n");
    for (const toolId in toolResponses) {
      const toolResponse = toolResponses[toolId];
      if (toolResponse.arguments && typeof toolResponse.arguments === "string") {
        try {
          toolResponse.arguments = JSON.parse(toolResponse.arguments);
        } catch {
          // Keep as string if parsing fails.
        }
      }
      console.log(JSON.stringify(toolResponse, null, 2));
    }
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

testResponseToolInvocation(stream, compact);
