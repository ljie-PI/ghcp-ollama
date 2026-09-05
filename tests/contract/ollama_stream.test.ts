import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory, type BoundAccount } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import type { BoundCopilot, CopilotBackend, CopilotTarget } from "../../src/copilot/backend.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import type { RuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createOllamaChatRoutes } from "../../src/protocols/ollama_chat/endpoint.js";
import type { ChatRequest, ChatResponse, NativeResponsesUpstreamRequest, UpstreamByteResponse, UpstreamByteStream } from "../../src/protocols/chat_completions/types.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

const nowMs = (): number => 1_700_000_000_000;

class StreamBackend implements CopilotBackend {
  status = 200;
  chunks: Uint8Array[] | AsyncIterable<Uint8Array> = [];
  canceled = 0;

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const target: CopilotTarget = { endpoint: "https://api.githubcopilot.com", token: "t" };
    return {
      accountId: account.accountId,
      target,
      completeChat: async (_request: Readonly<ChatRequest>): Promise<ChatResponse> => {
        throw new Error("non-stream must not be called");
      },
      openChatStream: async (_request: Readonly<ChatRequest>): Promise<UpstreamByteStream> => ({
        status: this.status,
        headers: new Headers({ "content-type": "text/event-stream" }),
        bytes: Array.isArray(this.chunks) ? streamBytes(...this.chunks) : this.chunks,
        cancel: async () => { this.canceled += 1; },
      }),
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
  configureRuntime: (runtime: RuntimeConfigSnapshot) => void = () => undefined,
  usageUpdates?: UsageUpdate[],
) {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-ollama-stream-"));
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
  const runtime = defaultRuntimeConfigSnapshot();
  configureRuntime(runtime);
  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime,
  }, createOllamaChatRoutes({
    directory: accounts,
    copilot: backend,
    now: () => new Date("2026-01-02T03:04:05.120Z"),
    tokenCounter: () => 0,
    ...(usageUpdates === undefined
      ? {}
      : { usageRecorder: { recordUsage: (update: UsageUpdate) => usageUpdates.push(update) } }),
  }));
  return { gw, close: async () => { await gw.close(); closeDatabase(database); } };
}

describe("Ollama stream", () => {
  it("reduces sparse Chat chunks to exact Ollama NDJSON", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const backend = new StreamBackend();
    backend.chunks = [
      sse({ choices: [{ index: 0, delta: { content: "<think>hidden" }, logprobs: { content: [{ token: "hidden", logprob: -0.25, bytes: [104] }] } }] }),
      sse({ choices: [{ index: 0, delta: { content: "visible < &" } }] }),
      sse({ choices: [{ index: 0, delta: { reasoning_content: "explicit" } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_1", function: { name: "weather", arguments: "{\"2\":\"two\"," } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "\"1\":\"one\"}" } }] } }], usage: { prompt_tokens: 12 } }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { completion_tokens: 6 } }),
      done(),
    ];
    const { gw, close } = await ollamaGateway(backend, undefined, usageUpdates);
    try {
      const response = await gw.fetch(request({ model: "gpt", stream: true, messages: [{ role: "user", content: "hi" }] }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\"hidden\"},\"done\":false,\"logprobs\":[{\"token\":\"hidden\",\"logprob\":-0.25,\"bytes\":[104]}]}\n"
        + "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"visible \\u003c \\u0026\"},\"done\":false}\n"
        + "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\"explicit\"},\"done\":false}\n"
        + "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"index\":1,\"name\":\"weather\",\"arguments\":{\"2\":\"two\",\"1\":\"one\"}}}]},\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":12,\"eval_count\":6}\n",
      );
      expect(usageUpdates).toMatchObject([{
        protocol: "ollama",
        outcome: "success",
        inputTokens: 12,
        outputTokens: 6,
      }]);
    } finally {
      await close();
    }
  });

  it("keeps same-chunk explicit reasoning and visible content together", async () => {
    const backend = new StreamBackend();
    backend.chunks = [
      sse({ choices: [{ index: 0, delta: { content: "visible", reasoning_content: "think" } }] }),
      done(),
    ];
    const { gw, close } = await ollamaGateway(backend);
    try {
      const response = await gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"visible\",\"thinking\":\"think\"},\"done\":false}\n"
        + "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"done_reason\":\"stop\"}\n",
      );
    } finally {
      await close();
    }
  });

  it("maps stream finish reason terminal transitions", async () => {
    const cases = [
      { finish: "length", expected: "length" },
      { finish: "content_filter", expected: "stop" },
      { expected: "stop" },
    ];
    for (const item of cases) {
      const backend = new StreamBackend();
      const choice = item.finish === undefined
        ? { index: 0, delta: {} }
        : { index: 0, delta: {}, finish_reason: item.finish };
      backend.chunks = [sse({ choices: [choice] }), done()];
      const { gw, close } = await ollamaGateway(backend);
      try {
        const response = await gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(
          `{"model":"gpt","created_at":"2026-01-02T03:04:05.12Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"${item.expected}"}\n`,
        );
      } finally {
        await close();
      }
    }

    const backend = new StreamBackend();
    backend.chunks = [sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }), done()];
    const { gw, close } = await ollamaGateway(backend);
    try {
      const response = await gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("{\"error\":\"invalid upstream response\"}");
    } finally {
      await close();
    }
  });

  it("returns pre-commit safe errors for upstream status, error frames, and truncation", async () => {
    for (const item of [
      { status: 503, chunks: [done()], expectedStatus: 503, expectedBody: "{\"error\":\"upstream request failed\"}" },
      { chunks: [sse({ error: "boom" })], expectedStatus: 502, expectedBody: "{\"error\":\"upstream stream error\"}" },
      { chunks: [], expectedStatus: 502, expectedBody: "{\"error\":\"upstream stream truncated\"}" },
    ]) {
      const backend = new StreamBackend();
      backend.status = item.status ?? 200;
      backend.chunks = item.chunks;
      const { gw, close } = await ollamaGateway(backend);
      try {
        const response = await gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
        expect(response.status).toBe(item.expectedStatus);
        expect(await response.text()).toBe(item.expectedBody);
      } finally {
        await close();
      }
    }
  });

  it("writes one post-commit error and no synthetic terminal on truncation", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const backend = new StreamBackend();
    backend.chunks = [sse({ choices: [{ index: 0, delta: { content: "hello" } }] })];
    const { gw, close } = await ollamaGateway(backend, undefined, usageUpdates);
    try {
      const response = await gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"done\":false}\n"
        + "{\"error\":\"upstream stream truncated\"}\n",
      );
      expect(usageUpdates).toMatchObject([{ protocol: "ollama", outcome: "upstream_error", errorCount: 1 }]);
    } finally {
      await close();
    }
  });

  it("uses documented post-commit error text for invalid terminal state and idle timeout", async () => {
    const invalidFinish = new StreamBackend();
    invalidFinish.chunks = [
      sse({ choices: [{ index: 0, delta: { content: "hello" } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "weird" }] }),
      done(),
    ];
    const invalid = await ollamaGateway(invalidFinish);
    try {
      const response = await invalid.gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"done\":false}\n"
        + "{\"error\":\"invalid upstream response\"}\n",
      );
    } finally {
      await invalid.close();
    }

    const timeout = new StreamBackend();
    timeout.chunks = delayedStream(sse({ choices: [{ index: 0, delta: { content: "hello" } }] }), new Promise(() => undefined));
    const timed = await ollamaGateway(timeout, (runtime) => {
      runtime.timeouts.streamIdleMs = 1;
    });
    try {
      const response = await timed.gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"done\":false}\n"
        + "{\"error\":\"upstream timeout\"}\n",
      );
      expect(timeout.canceled).toBeGreaterThan(0);
    } finally {
      await timed.close();
    }
  });

  it("aborts without writing error or done after commit and cancels upstream", async () => {
    const usageUpdates: UsageUpdate[] = [];
    const backend = new StreamBackend();
    let resume = (): void => undefined;
    backend.chunks = delayedStream(sse({ choices: [{ index: 0, delta: { content: "hello" } }] }), new Promise<void>((resolve) => {
      resume = resolve;
    }));
    const { gw, close } = await ollamaGateway(backend, undefined, usageUpdates);
    try {
      const controller = new AbortController();
      const response = await gw.fetch(request({ model: "gpt", messages: [{ role: "user", content: "hi" }] }, controller.signal));
      const reader = response.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toBe(
        "{\"model\":\"gpt\",\"created_at\":\"2026-01-02T03:04:05.12Z\",\"message\":{\"role\":\"assistant\",\"content\":\"hello\"},\"done\":false}\n",
      );
      controller.abort();
      resume();
      const next = await reader?.read().catch(() => ({ done: true, value: undefined }));
      expect(next?.value === undefined ? "" : new TextDecoder().decode(next.value)).toBe("");
      expect(backend.canceled).toBeGreaterThan(0);
      expect(usageUpdates).toMatchObject([{ protocol: "ollama", outcome: "aborted", errorCount: 1 }]);
    } finally {
      await close();
    }
  });
});

function request(body: unknown, signal?: AbortSignal): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal !== undefined) {
    init.signal = signal;
  }
  return new Request("http://127.0.0.1:31400/api/chat", init);
}

function sse(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

function done(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

async function* streamBytes(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

async function* delayedStream(first: Uint8Array, wait: Promise<void>): AsyncIterable<Uint8Array> {
  yield first;
  await wait;
}
