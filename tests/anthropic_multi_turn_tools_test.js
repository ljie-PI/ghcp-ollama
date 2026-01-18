import Anthropic from "@anthropic-ai/sdk";

// Usage: node anthropic_multi_turn_tools_test.js [--no-stream]
// --no-stream: Use non-streaming mode (default: streaming enabled)
//
// This test verifies that multi-turn conversations with tool calls are correctly
// converted to OpenAI format and then back to Anthropic format. It tests:
// 1. User message
// 2. Assistant message with tool_use
// 3. User message with tool_result
// 4. Assistant response
// 5. Follow-up user message

const args = process.argv.slice(2);
const stream = !args.includes("--no-stream");

async function testMultiTurnWithTools(anthropic, stream) {
  try {
    const payload = {
      model: "claude-sonnet-4.5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: "What's the weather in Beijing?",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "get_weather",
              input: {
                location: "Beijing",
                format: "celsius",
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "Temperature: 15°C, Condition: Sunny",
            },
          ],
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
          name: "get_weather",
          description: "Get weather information for a location",
          input_schema: {
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
        {
          name: "get_time",
          description: "Get current time for a timezone",
          input_schema: {
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
      ],
      stream: stream,
    };

    let fullResponse = "";
    const toolUses = [];

    if (stream) {
      const response = await anthropic.messages.create(payload);
      for await (const event of response) {
        console.log("Event received:", JSON.stringify(event));

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          const toolUse = event.content_block;
          toolUses.push({
            id: toolUse.id,
            name: toolUse.name,
            input: "",
          });
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta"
        ) {
          if (toolUses.length > 0) {
            toolUses[toolUses.length - 1].input += event.delta.partial_json;
          }
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text"
        ) {
          fullResponse += event.delta.text;
        }
      }

      // Parse accumulated JSON inputs
      for (const toolUse of toolUses) {
        if (toolUse.input && typeof toolUse.input === "string") {
          try {
            toolUse.input = JSON.parse(toolUse.input);
          } catch (e) {
            // Keep as string if parsing fails
          }
        }
      }
    } else {
      const response = await anthropic.messages.create(payload);
      console.log("Response received:", JSON.stringify(response, null, 2));

      for (const block of response.content) {
        if (block.type === "text") {
          fullResponse += block.text;
        } else if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
    }

    console.log("====================\n");
    console.log("Full Response:\n", fullResponse);
    if (toolUses.length > 0) {
      console.log("\n====================\n");
      console.log("Tool Uses:\n", JSON.stringify(toolUses, null, 2));
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
testMultiTurnWithTools(anthropic, stream);
