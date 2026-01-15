import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testToolInvocation(anthropic, stream) {
  try {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "What's time and weather in Beijing now?",
        },
      ],
      tools: [
        {
          name: "get_current_time",
          description: "Get the current time for a specific timezone",
          input_schema: {
            type: "object",
            properties: {
              timezone: {
                type: "string",
                description:
                  "The timezone to get the current time for (e.g., America/New_York)",
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
                description:
                  "The location to get the weather for, e.g. San Francisco, CA",
              },
              format: {
                type: "string",
                description:
                  "The format to return the weather in, e.g. 'celsius' or 'fahrenheit'",
                enum: ["celsius", "fahrenheit"],
              },
            },
            required: ["location", "format"],
          },
        },
      ],
      stream: stream,
    };

    const toolResponses = {};
    let textResponse = "";
    let currentToolUse = null;

    if (stream) {
      const response = await anthropic.messages.create(payload);
      for await (const event of response) {
        console.log("Event received:", JSON.stringify(event));

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          const toolUse = event.content_block;
          toolResponses[toolUse.name] = {
            id: toolUse.id,
            name: toolUse.name,
          };
          currentToolUse = toolResponses[toolUse.name];
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta"
        ) {
          if (currentToolUse && !currentToolUse.input) {
            currentToolUse.input = "";
          }
          if (currentToolUse) {
            currentToolUse.input += event.delta.partial_json;
          }
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text"
        ) {
          textResponse += event.delta.text;
        }
      }
    } else {
      const response = await anthropic.messages.create(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));

      for (const block of response.content) {
        if (block.type === "text") {
          textResponse += block.text;
        } else if (block.type === "tool_use") {
          toolResponses[block.name] = {
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
      }
    }

    for (const toolName in toolResponses) {
      if (
        toolResponses[toolName].input &&
        typeof toolResponses[toolName].input === "string"
      ) {
        try {
          toolResponses[toolName].input = JSON.parse(
            toolResponses[toolName].input,
          );
        } catch (e) {}
      }
    }

    console.log("====================\n");
    console.log("Text Response:\n", textResponse);
    console.log("\n====================\n");
    console.log("Tool Response:\n");
    for (const toolName in toolResponses) {
      console.log(JSON.stringify(toolResponses[toolName], null, 2));
    }
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
testToolInvocation(anthropic, stream);
