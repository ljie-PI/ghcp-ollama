import { describe, expect, it } from "vitest";
import { anthropicGateway, anthropicRequest, decodeChatBody } from "./anthropic_harness.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CapiFetchError } from "../../src/copilot/models_source.js";
import type { ChatRequest } from "../../src/protocols/chat_completions/types.js";

describe("Anthropic request route", () => {
  it("requires the exact Messages version header and never forwards it to Chat", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      for (const [name, headers] of [
        ["missing", { "anthropic-version": undefined }],
        ["empty", { "anthropic-version": "" }],
        ["wrong", { "anthropic-version": "2024-01-01" }],
        ["merged", { "anthropic-version": "2023-06-01, 2023-06-01" }],
      ] as const) {
        const actualHeaders: Record<string, string> = { "content-type": "application/json" };
        if (headers["anthropic-version"] !== undefined) {
          actualHeaders["anthropic-version"] = headers["anthropic-version"];
        }
        const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/messages", {
          method: "POST",
          headers: actualHeaders,
          body: JSON.stringify({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        }));
        expect(response.status, name).toBe(400);
        expect(response.headers.get("request-id")).toBe("req_test_1");
        expect(await response.text()).toBe("{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid request\"},\"request_id\":\"req_test_1\"}");
      }

      const ok = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(ok.status).toBe(200);
      expect(capturedRequests).toHaveLength(1);
      expect(new TextDecoder().decode(capturedRequests[0]?.body)).not.toContain("anthropic-version");
    } finally {
      await close();
    }
  });

  it("resolves missing model only through a valid visible preference and rejects explicit unknown models", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway({ preferredModel: "gpt" });
    try {
      const preferred = await gw.fetch(anthropicRequest({ max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(preferred.status).toBe(200);
      expect(decodeChatBody(capturedRequests[0] as ChatRequest).model).toBe("gpt");

      const unknown = await gw.fetch(anthropicRequest({ model: "no-such-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe("{\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model not found\"},\"request_id\":\"req_test_1\"}");
      expect(capturedRequests).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("preserves model catalog timeout, network, and invalid-response failure categories", async () => {
    for (const [failureKind, expected] of [
      ["upstream_timeout", { status: 504, type: "timeout_error", message: "upstream timeout" }],
      ["upstream_network", { status: 502, type: "api_error", message: "upstream request failed" }],
      ["invalid_upstream_response", { status: 502, type: "api_error", message: "invalid upstream response" }],
    ] as const) {
      const { gw, close } = await anthropicGateway({
        catalogFetch() {
          throw new CapiFetchError(502, undefined, failureKind);
        },
      });
      try {
        const response = await gw.fetch(anthropicRequest({ model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false }));
        expect(response.status).toBe(expected.status);
        expect(await response.text()).toBe(JSON.stringify({
          type: "error",
          error: { type: expected.type, message: expected.message },
          request_id: "req_test_1",
        }));
      } finally {
        await close();
      }
    }
  });

  it("converts system, media, tool history, schema cleanup, tool choice, and reasoning rules", async () => {
    const captured: ChatRequest[] = [];
    const backend = new ScriptedCopilotBackend({
      chatStream(request) {
        captured.push(request);
        return [new TextEncoder().encode("data: [DONE]\n\n")];
      },
    });
    const { gw, close } = await anthropicGateway({ backend });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt-5",
        max_tokens: 64,
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ["END"],
        stream: true,
        system: [
          { type: "text", text: "x-anthropic-billing-header:\n\nbill me elsewhere" },
          { type: "text", text: "second" },
        ],
        metadata: { dropped: true },
        context_management: { dropped: true },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" }, cache_control: { type: "ephemeral" } },
              { type: "document", source: { type: "text", data: "drop" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "tool_use", id: "call_1", name: "lookup", input: { z: 1, a: [true, null] } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: { b: 2, a: 1 }, is_error: true },
              { type: "text", text: "continue" },
            ],
          },
        ],
        tools: [
          { type: "BatchTool", name: "ignored" },
          {
            name: "lookup",
            description: "Lookup",
            input_schema: {
              properties: {
                url: { type: "string", format: "uri" },
                nested: { items: { properties: { link: { type: "string", format: "uri" } } } },
                untouched: { oneOf: [{ type: "string", format: "uri" }] },
              },
            },
            strict: true,
          },
        ],
        tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
        output_config: { effort: "max", format: { type: "json_schema" } },
      }));

      expect(response.status).toBe(200);
      expect(captured).toHaveLength(1);
      const body = decodeChatBody(captured[0] as ChatRequest);
      expect(body).toEqual({
        model: "gpt-5",
        messages: [
          { role: "system", content: "bill me elsewhere\nsecond" },
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{\"a\":[true,null],\"z\":1}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "{\"a\":1,\"b\":2}" },
          { role: "user", content: "continue" },
        ],
        max_tokens: 64,
        temperature: 0.2,
        top_p: 0.9,
        stop: ["END"],
        stream: true,
        stream_options: { include_usage: true },
        tools: [{
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string" },
                nested: { type: "object", properties: {}, items: { type: "object", properties: { link: { type: "string" } } } },
                untouched: { type: "object", properties: {}, oneOf: [{ type: "string", format: "uri" }] },
              },
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "lookup" } },
        reasoning_effort: "xhigh",
      });
    } finally {
      await close();
    }
  });

  it("maps official Anthropic xhigh effort for reasoning-capable models", async () => {
    const { gw, capturedRequests, close } = await anthropicGateway();
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "reason" }],
        output_config: { effort: "xhigh" },
      }));

      expect(response.status).toBe(200);
      expect(decodeChatBody(capturedRequests[0] as ChatRequest)).toMatchObject({
        model: "gpt-5",
        reasoning_effort: "xhigh",
      });
    } finally {
      await close();
    }
  });

  it("keeps parallel tool_result messages adjacent and moves media into the following user message", async () => {
    const captured: ChatRequest[] = [];
    const backend = new ScriptedCopilotBackend({
      chat(request) {
        captured.push(request);
        return {
          status: 200,
          headers: new Headers(),
          body: new TextEncoder().encode(JSON.stringify({
            id: "chatcmpl_1",
            model: "gpt",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          })),
        };
      },
    });
    const { gw, close } = await anthropicGateway({ backend });
    try {
      const response = await gw.fetch(anthropicRequest({
        model: "gpt",
        max_tokens: 1,
        stream: false,
        messages: [{
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "image", source: { media_type: "image/png", data: "abc" } }],
            },
            { type: "tool_result", tool_use_id: "call_2", content: "plain" },
            { type: "text", text: "after tools" },
          ],
        }],
      }));

      expect(response.status).toBe(200);
      expect(decodeChatBody(captured[0] as ChatRequest).messages).toEqual([
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "[\"[cc-switch: tool result media moved to the following user message]\"]",
        },
        { role: "tool", tool_call_id: "call_2", content: "plain" },
        {
          role: "user",
          content: [
            { type: "text", text: "[cc-switch: media output of tool call call_1]" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
        { role: "user", content: "after tools" },
      ]);
    } finally {
      await close();
    }
  });
});
