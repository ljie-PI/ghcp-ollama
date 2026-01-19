/**
 * Mock OpenAI API responses for unit testing.
 *
 * These responses simulate what the GitHub Copilot API returns
 * and are used to test the parseResponse() and parseStreamChunk() methods.
 */

/**
 * Non-streaming text response
 */
export const textResponse = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "The sky is blue due to Rayleigh scattering.",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 50,
    completion_tokens: 20,
    total_tokens: 70,
  },
};

/**
 * Non-streaming response with tool calls
 */
export const toolCallsResponse = {
  id: "chatcmpl-def456",
  object: "chat.completion",
  created: 1700000001,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: "{\"location\":\"Beijing\",\"format\":\"celsius\"}",
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 30,
    total_tokens: 130,
  },
};

/**
 * Non-streaming response with multiple tool calls
 */
export const multipleToolCallsResponse = {
  id: "chatcmpl-ghi789",
  object: "chat.completion",
  created: 1700000002,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_001",
            type: "function",
            function: {
              name: "get_weather",
              arguments: "{\"location\":\"Beijing\"}",
            },
          },
          {
            id: "call_002",
            type: "function",
            function: {
              name: "get_time",
              arguments: "{\"timezone\":\"Asia/Shanghai\"}",
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 50,
    total_tokens: 170,
  },
};

/**
 * Non-streaming response with cached tokens
 */
export const cachedTokensResponse = {
  id: "chatcmpl-cached123",
  object: "chat.completion",
  created: 1700000003,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "This response uses cached tokens.",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 15,
    total_tokens: 115,
    prompt_tokens_details: {
      cached_tokens: 80,
    },
  },
};

/**
 * Streaming chunks for text response
 * These simulate SSE data lines
 */
export const textStreamChunks = [
  "data: {\"id\":\"chatcmpl-stream1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":50}}",
  "data: {\"id\":\"chatcmpl-stream1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"The \"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"sky \"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"is \"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"blue.\"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":5}}",
  "data: [DONE]",
];

/**
 * Streaming chunks for tool call response
 */
export const toolCallStreamChunks = [
  "data: {\"id\":\"chatcmpl-stream2\",\"object\":\"chat.completion.chunk\",\"created\":1700000001,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream2\",\"object\":\"chat.completion.chunk\",\"created\":1700000001,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_xyz\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream2\",\"object\":\"chat.completion.chunk\",\"created\":1700000001,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"loc\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream2\",\"object\":\"chat.completion.chunk\",\"created\":1700000001,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ation\\\":\\\"\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream2\",\"object\":\"chat.completion.chunk\",\"created\":1700000001,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"Beijing\\\"}\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream2\",\"object\":\"chat.completion.chunk\",\"created\":1700000001,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20}}",
  "data: [DONE]",
];

/**
 * Streaming chunks for multiple tool calls
 */
export const multipleToolCallStreamChunks = [
  "data: {\"id\":\"chatcmpl-stream3\",\"object\":\"chat.completion.chunk\",\"created\":1700000002,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}",
  // First tool call
  "data: {\"id\":\"chatcmpl-stream3\",\"object\":\"chat.completion.chunk\",\"created\":1700000002,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_001\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream3\",\"object\":\"chat.completion.chunk\",\"created\":1700000002,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"location\\\":\\\"Beijing\\\"}\"}}]},\"finish_reason\":null}]}",
  // Second tool call
  "data: {\"id\":\"chatcmpl-stream3\",\"object\":\"chat.completion.chunk\",\"created\":1700000002,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_002\",\"type\":\"function\",\"function\":{\"name\":\"get_time\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream3\",\"object\":\"chat.completion.chunk\",\"created\":1700000002,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"timezone\\\":\\\"UTC\\\"}\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream3\",\"object\":\"chat.completion.chunk\",\"created\":1700000002,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":40}}",
  "data: [DONE]",
];

/**
 * Streaming chunks for multiple calls to same function (e.g., get_weather for Beijing and Shanghai)
 */
export const sameNameToolCallStreamChunks = [
  "data: {\"id\":\"chatcmpl-stream5\",\"object\":\"chat.completion.chunk\",\"created\":1700000004,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream5\",\"object\":\"chat.completion.chunk\",\"created\":1700000004,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_001\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream5\",\"object\":\"chat.completion.chunk\",\"created\":1700000004,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"location\\\":\\\"Beijing\\\"}\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream5\",\"object\":\"chat.completion.chunk\",\"created\":1700000004,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_002\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream5\",\"object\":\"chat.completion.chunk\",\"created\":1700000004,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"location\\\":\\\"Shanghai\\\"}\"}}]},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream5\",\"object\":\"chat.completion.chunk\",\"created\":1700000004,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":60}}",
  "data: [DONE]",
];

/**
 * Streaming chunks with cached tokens
 */
export const cachedTokensStreamChunks = [
  "data: {\"id\":\"chatcmpl-stream4\",\"object\":\"chat.completion.chunk\",\"created\":1700000003,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}],\"usage\":{\"prompt_tokens\":100,\"prompt_tokens_details\":{\"cached_tokens\":80}}}",
  "data: {\"id\":\"chatcmpl-stream4\",\"object\":\"chat.completion.chunk\",\"created\":1700000003,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Cached \"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream4\",\"object\":\"chat.completion.chunk\",\"created\":1700000003,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"response.\"},\"finish_reason\":null}]}",
  "data: {\"id\":\"chatcmpl-stream4\",\"object\":\"chat.completion.chunk\",\"created\":1700000003,\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":8,\"prompt_tokens_details\":{\"cached_tokens\":80}}}",
  "data: [DONE]",
];

/**
 * Helper function to create a buffer from chunks
 * Uses double newline to separate SSE messages (as per SSE spec)
 * @param {string[]} chunks - Array of SSE data lines
 * @returns {string} Concatenated buffer with double newlines
 */
export function createStreamBuffer(chunks) {
  return chunks.join("\n\n") + "\n\n";
}

/**
 * Helper function to create partial buffer (for testing incomplete data)
 * @param {string[]} chunks - Array of SSE data lines
 * @param {number} endIndex - Number of chunks to include
 * @returns {string} Partial buffer
 */
export function createPartialBuffer(chunks, endIndex) {
  return chunks.slice(0, endIndex).join("\n\n") + "\n\n";
}
