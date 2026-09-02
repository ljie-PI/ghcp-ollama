import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import type { BoundAccount } from "../../../src/accounts/account_directory.js";
import type { BoundCopilot, CopilotBackend, CopilotTarget } from "../../../src/copilot/backend.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { createGateway } from "../../../src/gateway/create_gateway.js";
import { UpstreamBodyLimitError } from "../../../src/copilot/transport.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { createOllamaChatRoutes } from "../../../src/protocols/ollama_chat/endpoint.js";
import type { ChatRequest, ChatResponse, NativeResponsesUpstreamRequest, UpstreamByteResponse, UpstreamByteStream } from "../../../src/protocols/chat_completions/types.js";

const nowMs = (): number => 1_700_000_000_000;

class NonstreamBackend implements CopilotBackend {
  responseStatus = 200;
  responseBody = new TextEncoder().encode(JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
  }));
  responseError: unknown;

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const target: CopilotTarget = { endpoint: "https://api.githubcopilot.com", token: "t" };
    return {
      accountId: account.accountId,
      target,
      completeChat: async (_request: Readonly<ChatRequest>): Promise<ChatResponse> => {
        if (this.responseError !== undefined) {
          throw this.responseError;
        }
        return {
          status: this.responseStatus,
          headers: new Headers(),
          body: this.responseBody,
        };
      },
      openChatStream: async (_request: Readonly<ChatRequest>): Promise<UpstreamByteStream> => {
        throw new Error("stream must not be called");
      },
      completeResponses: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse> => {
        throw new Error("responses must not be called");
      },
      openResponsesStream: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream> => {
        throw new Error("responses stream must not be called");
      },
    };
  }
}

async function ollamaGateway(
  backend: CopilotBackend,
  tokenCounter: (input: { readonly model: ""; readonly messages?: unknown; readonly text?: string }) => number = () => 0,
  now: () => Date = () => new Date("2026-01-02T03:04:05.000Z"),
) {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-ollama-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    nowMs,
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
  await accounts.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "t" },
  });
  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, createOllamaChatRoutes({
    directory: accounts,
    copilot: backend,
    now,
    tokenCounter,
  }));
  return { gw, close: async () => { await gw.close(); closeDatabase(database); } };
}

describe("RM-10 Ollama non-stream", () => {
  it("maps chat JSON to an Ollama object with done true", async () => {
    const backend = new NonstreamBackend();
    const { gw, close } = await ollamaGateway(backend);
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      }));
      expect(response.status).toBe(200);
      const body = JSON.parse(await response.text()) as {
        done: boolean;
        done_reason: string;
        message: { content: string };
        created_at: string;
      };
      expect(body.done).toBe(true);
      expect(body.done_reason).toBe("stop");
      expect(body.message.content).toBe("hello");
      expect(body.created_at).toBe("2026-01-02T03:04:05Z");
    } finally {
      await close();
    }
  });

  it("maps content, reasoning, tool calls, finish reason, usage, and logprobs", async () => {
    const backend = new NonstreamBackend();
    backend.responseBody = new TextEncoder().encode(JSON.stringify({
      id: "ignored",
      remote_model: "ignored",
      remote_host: "ignored",
      _debug_info: { ignored: true },
      total_duration: 1,
      load_duration: 2,
      prompt_eval_duration: 3,
      eval_duration: 4,
      created: 1_700_000_000,
      choices: [{
        index: 0,
        message: {
          content: "<think>hidden</thinking>visible",
          tool_calls: [{
            id: "call_1",
            index: 2,
            type: "function",
            function: { name: "weather", arguments: "{\"10\":\"ten\",\"2\":\"two\",\"city\":\"Tōkyō\"}" },
          }],
        },
        finish_reason: "tool_calls",
        logprobs: {
          content: [{
            token: "visible",
            logprob: -0.5,
            bytes: [118, 105],
            top_logprobs: [{ token: "visible", logprob: -0.5, bytes: [118] }],
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 999 },
    }));
    const { gw, close } = await ollamaGateway(backend, undefined, () => {
      throw new Error("created upstream responses must not read the injected clock");
    });
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2023-11-14T22:13:20Z\",\"message\":{\"role\":\"assistant\",\"content\":\"visible\",\"thinking\":\"hidden\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"index\":2,\"name\":\"weather\",\"arguments\":{\"10\":\"ten\",\"2\":\"two\",\"city\":\"Tōkyō\"}}}]},\"done\":true,\"done_reason\":\"stop\",\"logprobs\":[{\"token\":\"visible\",\"logprob\":-0.5,\"bytes\":[118,105],\"top_logprobs\":[{\"token\":\"visible\",\"logprob\":-0.5,\"bytes\":[118]}]}],\"prompt_eval_count\":12,\"eval_count\":6}",
      );
    } finally {
      await close();
    }
  });

  it("uses explicit reasoning, clock fallback, token counter fallback, and Go HTML escaping", async () => {
    const backend = new NonstreamBackend();
    backend.responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{
        index: 0,
        message: { content: "<final>&", reasoning_content: "think" },
        finish_reason: "length",
      }],
      usage: { total_tokens: 999 },
    }));
    const calls: Array<{ readonly model: ""; readonly messages?: unknown; readonly text?: string }> = [];
    let clockCalls = 0;
    const { gw, close } = await ollamaGateway(backend, (input) => {
      calls.push(input);
      return input.text === undefined ? 7 : 3;
    }, () => {
      clockCalls += 1;
      return new Date("2026-01-02T03:04:05.123Z");
    });
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.123Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\\u003cfinal\\u003e\\u0026\",\"thinking\":\"think\"},\"done\":true,\"done_reason\":\"length\",\"prompt_eval_count\":7,\"eval_count\":3}",
      );
      expect(calls).toHaveLength(2);
      expect(clockCalls).toBe(1);
      expect(calls[0]?.model).toBe("");
      expect(calls[0]?.messages).toEqual({
        kind: "array",
        items: [{ kind: "object", members: [{ key: "role", value: "user" }, { key: "content", value: "hi" }] }],
      });
      expect(calls[1]).toEqual({ model: "", text: "<final>&" });
    } finally {
      await close();
    }
  });

  it("omits zero usage counts and preserves nonzero partial usage", async () => {
    const backend = new NonstreamBackend();
    backend.responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{ index: 0, message: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0 },
    }));
    const { gw, close } = await ollamaGateway(backend, (input) => input.text === undefined ? 99 : 5);
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\",\"eval_count\":5}",
      );
    } finally {
      await close();
    }
  });

  it("applies Go omitempty to empty optional thinking and logprob slices", async () => {
    const backend = new NonstreamBackend();
    backend.responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{
        index: 0,
        message: { content: "visible", reasoning_content: "" },
        finish_reason: "stop",
        logprobs: {
          content: [{
            token: "visible",
            logprob: -0.5,
            bytes: [],
            top_logprobs: [],
          }],
        },
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }));
    const { gw, close } = await ollamaGateway(backend);
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"visible\"},\"done\":true,\"done_reason\":\"stop\",\"logprobs\":[{\"token\":\"visible\",\"logprob\":-0.5}]}",
      );
    } finally {
      await close();
    }
  });

  it("maps finish reason matrix", async () => {
    const cases = [
      { finish: "stop", expected: "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}" },
      { finish: null, expected: "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}" },
      { expected: "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}" },
      { finish: "content_filter", expected: "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}" },
      { finish: "length", expected: "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"length\"}" },
    ];
    for (const item of cases) {
      const backend = new NonstreamBackend();
      const choice = item.finish === undefined
        ? { index: 0, message: { content: "" } }
        : { index: 0, message: { content: "" }, finish_reason: item.finish };
      backend.responseBody = new TextEncoder().encode(JSON.stringify({
        choices: [choice],
      }));
      const { gw, close } = await ollamaGateway(backend);
      try {
        const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
        }));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(item.expected);
      } finally {
        await close();
      }
    }
  });

  it("rejects malformed upstream response, tool arguments, logprobs, and upstream http statuses", async () => {
    const cases = [
      { body: "{", status: 502, text: "{\"error\":\"invalid upstream response\"}" },
      { body: "[]", status: 502, text: "{\"error\":\"invalid upstream response\"}" },
      { body: "{}", status: 502, text: "{\"error\":\"invalid upstream response\"}" },
      {
        body: JSON.stringify({ created: "bad", choices: [{ index: 0, message: { content: "" }, finish_reason: "stop" }] }),
        status: 502,
        text: "{\"error\":\"invalid upstream response\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0 }, { index: 0 }] }),
        status: 502,
        text: "{\"error\":\"invalid upstream response\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "", tool_calls: [{ function: { name: "x", arguments: "[]" } }] }, finish_reason: "tool_calls" }] }),
        status: 502,
        text: "{\"error\":\"invalid tool arguments\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "stop", logprobs: { content: [{ token: "x", logprob: "bad" }] } }] }),
        status: 502,
        text: "{\"error\":\"invalid logprobs\"}",
      },
      {
        body: JSON.stringify({
          choices: [{
            index: 0,
            message: { content: "" },
            finish_reason: "stop",
            logprobs: { content: [{ token: "x", logprob: -1, top_logprobs: [{ token: "x", logprob: -1, top_logprobs: null }] }] },
          }],
        }),
        status: 502,
        text: "{\"error\":\"invalid logprobs\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "stop", logprobs: {} }] }),
        status: 502,
        text: "{\"error\":\"invalid logprobs\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "stop", logprobs: { content: null } }] }),
        status: 502,
        text: "{\"error\":\"invalid logprobs\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: "bad" } }),
        status: 502,
        text: "{\"error\":\"invalid upstream response\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "stop" }], usage: { completion_tokens: -1 } }),
        status: 502,
        text: "{\"error\":\"invalid upstream response\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "surprise" }] }),
        status: 502,
        text: "{\"error\":\"invalid upstream response\"}",
      },
      {
        body: JSON.stringify({ choices: [{ index: 0, message: { content: "" }, finish_reason: "tool_calls" }] }),
        status: 502,
        text: "{\"error\":\"invalid upstream response\"}",
      },
    ];
    for (const item of cases) {
      const backend = new NonstreamBackend();
      backend.responseBody = new TextEncoder().encode(item.body);
      const { gw, close } = await ollamaGateway(backend);
      try {
        const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
        }));
        expect(response.status).toBe(item.status);
        expect(await response.text()).toBe(item.text);
      } finally {
        await close();
      }
    }

    const backend = new NonstreamBackend();
    backend.responseStatus = 503;
    const { gw, close } = await ollamaGateway(backend);
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("{\"error\":\"upstream request failed\"}");
    } finally {
      await close();
    }

    const oversizedBackend = new NonstreamBackend();
    oversizedBackend.responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{ index: 0, message: { content: "x".repeat(defaultRuntimeConfigSnapshot().limits.nonstreamBodyBytes) } }],
    }));
    const oversized = await ollamaGateway(oversizedBackend);
    try {
      const response = await oversized.gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("{\"error\":\"invalid upstream response\"}");
    } finally {
      await oversized.close();
    }

    const overLimitBackend = new NonstreamBackend();
    overLimitBackend.responseError = new UpstreamBodyLimitError();
    const limited = await ollamaGateway(overLimitBackend);
    try {
      const response = await limited.gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("{\"error\":\"invalid upstream response\"}");
    } finally {
      await limited.close();
    }
  });
});
