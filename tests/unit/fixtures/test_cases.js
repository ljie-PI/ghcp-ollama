/**
 * Shared test cases for adapter unit tests.
 *
 * Each test case contains input data in all three formats (Ollama, OpenAI, Anthropic)
 * and the expected OpenAI format output after conversion.
 *
 * Test Cases:
 * 1. textMessage - Basic multi-turn conversation
 * 2. toolCalls - Function/tool calling
 * 3. imageInput - Image with text
 * 4. multiTurnTools - Conversation with tool results in history
 * 5. mixedContent - Image + text + tools combined
 */

// Sample base64 image prefixes for different formats (first few chars)
// These are used to test image type detection
export const sampleImages = {
  // JPEG: /9j/ prefix
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof",
  // PNG: iVBOR prefix
  png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  // GIF: R0lGO prefix
  gif: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  // WebP: UklGR prefix
  webp: "UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoBAAEAAQAcJYgCdAEO/hOMAAD++O9u/7MT/rt/LEQAAAAA",
};

/**
 * Test Case 1: Basic text message (multi-turn conversation)
 */
export const textMessageCase = {
  name: "textMessage",
  description: "Basic multi-turn text conversation",

  // Ollama format input
  ollama: {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "Why is the sky blue?" },
      { role: "assistant", content: "Due to Rayleigh scattering." },
      { role: "user", content: "How is that different from Mie scattering?" },
    ],
    stream: false,
  },

  // OpenAI format input (same as expected output for passthrough)
  openai: {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "Why is the sky blue?" },
      { role: "assistant", content: "Due to Rayleigh scattering." },
      { role: "user", content: "How is that different from Mie scattering?" },
    ],
    stream: false,
  },

  // Anthropic format input
  anthropic: {
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Why is the sky blue?" },
      { role: "assistant", content: "Due to Rayleigh scattering." },
      { role: "user", content: "How is that different from Mie scattering?" },
    ],
  },

  // Expected OpenAI format after conversion
  expectedOpenai: {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "Why is the sky blue?" },
      { role: "assistant", content: "Due to Rayleigh scattering." },
      { role: "user", content: "How is that different from Mie scattering?" },
    ],
    stream: false,
    tools: null,
  },
};

/**
 * Test Case 2: Tool/function calling
 */
export const toolCallsCase = {
  name: "toolCalls",
  description: "Function/tool calling with multiple tools",

  // Tool definitions (shared)
  tools: {
    ollama: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string", description: "City name" },
              format: { type: "string", enum: ["celsius", "fahrenheit"] },
            },
            required: ["location"],
          },
        },
      },
    ],
    anthropic: [
      {
        name: "get_weather",
        description: "Get the current weather",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
            format: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
        },
      },
    ],
  },

  // Ollama format input
  ollama: {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant with tools." },
      { role: "user", content: "What is the weather in Beijing?" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string", description: "City name" },
              format: { type: "string", enum: ["celsius", "fahrenheit"] },
            },
            required: ["location"],
          },
        },
      },
    ],
    stream: false,
  },

  // OpenAI format input
  openai: {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant with tools." },
      { role: "user", content: "What is the weather in Beijing?" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string", description: "City name" },
              format: { type: "string", enum: ["celsius", "fahrenheit"] },
            },
            required: ["location"],
          },
        },
      },
    ],
    stream: false,
  },

  // Anthropic format input
  anthropic: {
    model: "gpt-4o",
    max_tokens: 1024,
    system: "You are a helpful assistant with tools.",
    messages: [{ role: "user", content: "What is the weather in Beijing?" }],
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
            format: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
        },
      },
    ],
  },
};

/**
 * Test Case 3: Image input
 */
export const imageInputCase = {
  name: "imageInput",
  description: "Image with text prompt",

  // Ollama format input (uses images array with base64)
  ollama: {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: "What is in this image?",
        images: [sampleImages.jpeg],
      },
    ],
    stream: false,
  },

  // OpenAI format input (uses content array with image_url)
  openai: {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${sampleImages.jpeg}` },
          },
        ],
      },
    ],
    stream: false,
  },

  // Anthropic format input (uses content array with image type)
  anthropic: {
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: sampleImages.jpeg,
            },
          },
        ],
      },
    ],
  },

  // Expected OpenAI format after conversion
  expectedOpenai: {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${sampleImages.jpeg}` },
          },
        ],
      },
    ],
    stream: false,
    tools: null,
  },
};

/**
 * Test Case 4: Multi-turn conversation with tool results
 */
export const multiTurnToolsCase = {
  name: "multiTurnTools",
  description: "Conversation with tool call and result in history",

  // Ollama format input
  ollama: {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: { location: "Tokyo", format: "celsius" },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "{\"temperature\": 22, \"condition\": \"sunny\"}",
      },
      { role: "user", content: "Is that warm?" },
    ],
    stream: false,
  },

  // OpenAI format input
  openai: {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: "{\"location\":\"Tokyo\",\"format\":\"celsius\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "{\"temperature\": 22, \"condition\": \"sunny\"}",
      },
      { role: "user", content: "Is that warm?" },
    ],
    stream: false,
  },

  // Anthropic format input
  anthropic: {
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "get_weather",
            input: { location: "Tokyo", format: "celsius" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: "{\"temperature\": 22, \"condition\": \"sunny\"}",
          },
        ],
      },
      { role: "user", content: "Is that warm?" },
    ],
  },
};

/**
 * Test Case 5: Mixed content (image + text + tools)
 */
export const mixedContentCase = {
  name: "mixedContent",
  description: "Complex conversation with image, text, and tool calls",

  // Ollama format input
  ollama: {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: "What character is this?",
        images: [sampleImages.jpeg],
      },
      {
        role: "assistant",
        content: "This appears to be Vergil from Devil May Cry.",
      },
      { role: "user", content: "What games has he appeared in?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_456",
            type: "function",
            function: {
              name: "search_games",
              arguments: { character: "Vergil", franchise: "Devil May Cry" },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_456",
        content: "[\"DMC3\", \"DMC4\", \"DMC5\"]",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "search_games",
          description: "Search for games featuring a character",
          parameters: {
            type: "object",
            properties: {
              character: { type: "string" },
              franchise: { type: "string" },
            },
            required: ["character"],
          },
        },
      },
    ],
    stream: false,
  },

  // Anthropic format input
  anthropic: {
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What character is this?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: sampleImages.jpeg,
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "This appears to be Vergil from Devil May Cry.",
      },
      { role: "user", content: "What games has he appeared in?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_456",
            name: "search_games",
            input: { character: "Vergil", franchise: "Devil May Cry" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_456",
            content: "[\"DMC3\", \"DMC4\", \"DMC5\"]",
          },
        ],
      },
    ],
    tools: [
      {
        name: "search_games",
        description: "Search for games featuring a character",
        input_schema: {
          type: "object",
          properties: {
            character: { type: "string" },
            franchise: { type: "string" },
          },
          required: ["character"],
        },
      },
    ],
  },
};

/**
 * All test cases exported as an array
 */
export const allTestCases = [
  textMessageCase,
  toolCallsCase,
  imageInputCase,
  multiTurnToolsCase,
  mixedContentCase,
];
