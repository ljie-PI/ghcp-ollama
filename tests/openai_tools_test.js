// Usage: node openai_tools_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)

// Parse command line arguments with a default value of true for stream
const args = process.argv.slice(2);
const stream = args.includes("--no-stream") ? false : true;

const payload = {
  model: "claude-3.5-sonnet",
  messages: [
    {
      role: "system",
      content: "You should use tools to get information. You can use multple tools for one query.",
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

async function chat() {
  try {
    const response = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const toolResponses = {};
    let textResponse = "";
    let currentToolCall = null;

    if (stream) {
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
          console.log("Chunk received:", line);
          if (line.includes("[DONE]")) {
            break;
          }
          const data = JSON.parse(line.slice(6));

          if (data.choices.length > 0) {
            for (const choice of data.choices) {
              if (choice.delta?.tool_calls) {
                for (const toolCall of choice.delta.tool_calls) {
                  if (toolCall.function.name) {
                    toolResponses[toolCall.function.name] = {
                      name: toolCall.function.name,
                      arguments: "",
                    };
                    currentToolCall = toolResponses[toolCall.function.name];
                  }
                  if (currentToolCall && toolCall.function.arguments) {
                    currentToolCall.arguments += toolCall.function.arguments;
                  }
                }
              }

              if (choice.delta?.content) {
                textResponse += choice.delta.content;
              }
            }
          }
        }
      }
    } else {
      const data = await response.json();
      console.log("Response received:", JSON.stringify(data, null, 2));
      if (data.choices.length > 0) {
        for (const choice of data.choices) {
          if (choice.message.tool_calls) {
            for (const toolCall of choice.message.tool_calls) {
              if (toolCall.function.name) {
                toolResponses[toolCall.function.name] = {
                  name: toolCall.function.name,
                };
                if (toolCall.function.arguments) {
                  toolResponses[toolCall.function.name].arguments =
                    toolCall.function.arguments;
                }
              }
            }
          }

          if (choice.message.content) {
            textResponse += choice.message.content;
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
  }
}

chat();
