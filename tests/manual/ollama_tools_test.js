import { Ollama } from "ollama";

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testToolInvocation(ollama, stream) {
  try {
    const payload = {
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content:
            "You should use tools to get information. You can use multiple tools for one query.",
        },
        {
          role: "user",
          content: "What's the time and weather in Beijing now?",
        },
      ],
      tools: [
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
                  description:
                    "The timezone to get the current time for (e.g., America/New_York)",
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
        },
      ],
      tool_choice: "auto",
      stream: stream,
    };

    const toolResponses = {};
    let textResponse = "";
    let currentToolCall = null;

    if (stream) {
      const response = await ollama.chat(payload);
      for await (const chunk of response) {
        console.log("Chunk received:", JSON.stringify(chunk));

        if (chunk.message?.tool_calls) {
          for (const toolCall of chunk.message.tool_calls) {
            if (toolCall.function.name) {
              toolResponses[toolCall.function.name] = {
                name: toolCall.function.name,
              };
              currentToolCall = toolResponses[toolCall.function.name];
            }
            if (currentToolCall && toolCall.function.arguments) {
              currentToolCall.arguments = toolCall.function.arguments;
            }
          }
        }
        if (chunk.message?.content) {
          textResponse += chunk.message.content;
        }
      }
    } else {
      const response = await ollama.chat(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));
      textResponse = response.message.content;
      if (response.message.tool_calls) {
        for (const toolCall of response.message.tool_calls) {
          if (toolCall.function.name) {
            toolResponses[toolCall.function.name] = {
              name: toolCall.function.name,
            };
          }
          if (toolCall.function.arguments) {
            toolResponses[toolCall.function.name].arguments =
              toolCall.function.arguments;
          }
        }
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

const ollama = new Ollama({ host: "http://localhost:11434" });
testToolInvocation(ollama, stream);
