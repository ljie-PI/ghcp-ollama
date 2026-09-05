import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import type { BoundAccount } from "../../src/accounts/account_directory.js";
import type { BoundCopilot, CopilotBackend, CopilotTarget } from "../../src/copilot/backend.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createOllamaChatRoutes } from "../../src/protocols/ollama_chat/endpoint.js";
import type { ChatRequest, ChatResponse, NativeResponsesUpstreamRequest, UpstreamByteResponse, UpstreamByteStream } from "../../src/protocols/chat_completions/types.js";

const nowMs = (): number => 1_700_000_000_000;

class CapturingBackend implements CopilotBackend {
  readonly requests: ChatRequest[] = [];
  responseStatus = 200;
  responseBody = new TextEncoder().encode("{\"created\":1700000000,\"choices\":[{\"index\":0,\"message\":{\"content\":\"\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":0}}");

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const target: CopilotTarget = { endpoint: "https://api.githubcopilot.com", token: "t" };
    return {
      accountId: account.accountId,
      target,
      completeChat: async (request): Promise<ChatResponse> => {
        this.requests.push(request);
        return { status: this.responseStatus, headers: new Headers(), body: this.responseBody };
      },
      openChatStream: async (request): Promise<UpstreamByteStream> => {
        this.requests.push(request);
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          bytes: streamBytes("data: [DONE]\n\n"),
          cancel: async () => undefined,
        };
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
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    tokenCounter,
  }));
  return { gw, close: async () => { await gw.close(); closeDatabase(database); } };
}

describe("Ollama request", () => {
  it("requires model and messages and defaults stream to true", async () => {
    const backend = new CapturingBackend();
    const { gw, close } = await ollamaGateway(backend);
    try {
      const missing = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }));
      expect(missing.status).toBe(400);
      expect(await missing.text()).toBe("{\"error\":\"invalid request\"}");

      const ok = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(ok.headers.get("content-type")).toBe("application/x-ndjson");
      const text = await ok.text();
      expect(text.endsWith("\n")).toBe(true);
      expect(text).toContain("\"done\":true");
    } finally {
      await close();
    }
  });

  it("maps messages, images, tools, options, format, thinking, and logprobs to Chat request bytes", async () => {
    const backend = new CapturingBackend();
    const { gw, close } = await ollamaGateway(backend);
    try {
      const png = "iVBORw0KGgo=";
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt",
          messages: [
            {
              role: "Assistant",
              content: "",
              thinking: "checking",
              tool_calls: [{
                id: "call_1",
                function: { index: 0, name: "weather", arguments: { city: "Tokyo" } },
              }],
            },
            { role: "tool", content: "sunny", tool_name: "weather", tool_call_id: "call_1" },
            { role: "user", content: "see", images: [png] },
          ],
          tools: [{
            type: "function",
            items: { note: "kept" },
            function: {
              name: "weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string", items: "scalar", strict: true } }, required: ["city"], strict: true },
              strict: true,
            },
            strict: true,
          }],
          format: "json",
          stream: false,
          think: "medium",
          options: {
            num_predict: 256,
            temperature: 0.7,
            top_p: 0.9,
            seed: 42,
            stop: ["END"],
            frequency_penalty: 1,
            presence_penalty: 2,
          },
          logprobs: true,
          top_logprobs: 3,
          _debug_render_only: false,
        }),
      }));
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(backend.requests[0]?.body)).toBe(
        "{\"model\":\"gpt\",\"messages\":[{\"role\":\"assistant\",\"content\":\"\",\"reasoning\":\"checking\",\"tool_calls\":[{\"id\":\"call_1\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"weather\",\"arguments\":\"{\\\"city\\\":\\\"Tokyo\\\"}\"}}]},{\"role\":\"tool\",\"content\":\"sunny\",\"name\":\"weather\",\"tool_call_id\":\"call_1\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"see\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,iVBORw0KGgo=\"}}]}],\"tools\":[{\"type\":\"function\",\"items\":{\"note\":\"kept\"},\"function\":{\"name\":\"weather\",\"description\":\"Get weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\",\"items\":\"scalar\"}},\"required\":[\"city\"]}}}],\"response_format\":{\"type\":\"json_object\"},\"stream\":false,\"reasoning_effort\":\"medium\",\"max_tokens\":256,\"temperature\":0.7,\"top_p\":0.9,\"seed\":42,\"frequency_penalty\":1,\"presence_penalty\":2,\"stop\":[\"END\"],\"_debug_render_only\":false,\"logprobs\":true,\"top_logprobs\":3}",
      );
      expect(backend.requests[0]?.hasVisionInput).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects unsupported source-valid semantics before upstream", async () => {
    for (const body of [
      { model: "gpt", messages: [{ role: "user", content: "hi" }], keep_alive: 0 },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], truncate: false },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], shift: true },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], think: true },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], options: { top_k: 40 } },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], options: { num_predict: -1 } },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], options: { stop: "END" } },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], format: 1 },
      { model: "gpt", messages: [] },
    ]) {
      const backend = new CapturingBackend();
      const { gw, close } = await ollamaGateway(backend);
      try {
        const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }));
        expect(response.status).toBe(422);
        expect(await response.text()).toBe("{\"error\":\"unsupported semantics\"}");
        expect(backend.requests).toHaveLength(0);
      } finally {
        await close();
      }
    }
  });

  it("rejects invalid images, top_logprobs, and tool call arguments before upstream", async () => {
    for (const body of [
      { model: "gpt", messages: [{ role: "user", content: "hi", images: ["not-base64"] }] },
      { model: "gpt", messages: [{ role: "user", content: "hi", images: ["MTIzNA=="] }] },
      { model: "gpt", messages: [{ role: "user", content: "hi", images: ["iVBORw=="] }] },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], top_logprobs: 21 },
      { model: "gpt", messages: [{ role: "", content: "hi" }], top_logprobs: 21 },
      { model: "gpt", messages: [{ role: "user", content: "hi" }], options: { num_predict: "256" } },
      {
        model: "gpt",
        messages: [{
          role: "assistant",
          content: "",
          tool_calls: [{ function: { index: 0.5, name: "x", arguments: {} } }],
        }],
      },
      {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "bad", parameters: { type: "object" } } }],
      },
      {
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
        tools: [{
          type: "function",
          function: { name: "bad", parameters: { type: "object", properties: { x: { description: 1 } } } },
        }],
      },
    ]) {
      const backend = new CapturingBackend();
      const { gw, close } = await ollamaGateway(backend);
      try {
        const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }));
        expect(response.status).toBe(400);
        expect(backend.requests).toHaveLength(0);
      } finally {
        await close();
      }
    }
  });

  it("maps schema format, think false, and JPEG/WebP image magic", async () => {
    const backend = new CapturingBackend();
    const { gw, close } = await ollamaGateway(backend);
    try {
      const jpeg = "/9j/4AAQSkZJRg==";
      const webp = "UklGRiQAAABXRUJQ";
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt",
          stream: false,
          think: false,
          format: { type: "object", properties: {} },
          messages: [{ role: "", content: "", images: [jpeg, webp] }],
        }),
      }));
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(backend.requests[0]?.body)).toBe(
        "{\"model\":\"gpt\",\"messages\":[{\"role\":\"\",\"content\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/jpeg;base64,/9j/4AAQSkZJRg==\"}},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/webp;base64,UklGRiQAAABXRUJQ\"}}]}],\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"schema\":{\"type\":\"object\",\"properties\":{}}}},\"stream\":false,\"reasoning_effort\":\"none\"}",
      );
      expect(backend.requests[0]?.hasVisionInput).toBe(true);
    } finally {
      await close();
    }
  });
});

async function* streamBytes(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}
