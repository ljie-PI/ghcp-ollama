import OpenAI from "openai";

// Usage: node openai_tools_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testToolInvocation(openai, stream) {
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
      const response = await openai.chat.completions.create(payload);
      for await (const chunk of response) {
        console.log("Chunk received:", JSON.stringify(chunk));

        if (chunk.choices[0]?.delta?.tool_calls) {
          for (const toolCall of chunk.choices[0].delta.tool_calls) {
            if (toolCall.function.name) {
              toolResponses[toolCall.function.name] = {
                name: toolCall.function.name,
              };
              currentToolCall = toolResponses[toolCall.function.name];
            }
            if (currentToolCall && toolCall.function.arguments) {
              currentToolCall.arguments += toolCall.function.arguments;
            }
          }
        }
        if (chunk.choices[0]?.delta?.content) {
          textResponse += chunk.choices[0].delta.content;
        }
      }
    } else {
      const response = await openai.chat.completions.create(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));
      textResponse = response.choices[0].message.content;
      if (response.choices[0].message.tool_calls) {
        for (const toolCall of response.choices[0].message.tool_calls) {
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

const openai = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "sk-test",
});
testToolInvocation(openai, stream);
