import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../../src/copilot/model_catalog.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../../src/persistence/migrations/030_responses_history.js";
import type { ChatRequest, NativeResponsesUpstreamRequest } from "../../../src/protocols/chat_completions/types.js";
import { SqliteResponsesHistory } from "../../../src/protocols/responses/history.js";
import { bootstrapGateway } from "../../../src/main.js";

export const SDK_TEST_GUARD = "GHC_GATEWAY_SDK_TESTS";
export const CHAT_MODEL = "chat-sdk";
export const NATIVE_RESPONSES_MODEL = "responses-sdk";

const encoder = new TextEncoder();
const nativeFetch = globalThis.fetch;
const nowMs = (): number => 1_700_000_000_000;

export interface OfflineSdkHarness {
  readonly baseUrl: string;
  readonly openAiBaseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly chatRequests: ChatRequest[];
  readonly responsesRequests: NativeResponsesUpstreamRequest[];
  readonly backendKinds: readonly string[];
  readonly cancelled: Readonly<{ chat: number; responses: number }>;
  close(): Promise<void>;
}

export function assertOfflineSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[SDK_TEST_GUARD] !== "1") {
    throw new Error(`${SDK_TEST_GUARD}=1 is required for manual offline SDK tests`);
  }
}

export async function startOfflineSdkHarness(): Promise<OfflineSdkHarness> {
  assertOfflineSdkTestsEnabled();
  const dataDir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-sdk-"));
  const port = await reserveLoopbackPort();
  const database = openDatabase({
    path: path.join(dataDir, "state.db"),
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(responsesHistoryMigration),
    ],
    nowMs,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
  await directory.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "sdk-scripted-token" },
  });
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return {
        data: [
          { id: CHAT_MODEL, name: "SDK Chat", vendor: "github", model_picker_enabled: true, model_info: { mode: "chat" } },
          { id: NATIVE_RESPONSES_MODEL, name: "SDK Responses", vendor: "github", model_picker_enabled: true, model_info: { mode: "responses", supported_endpoints: ["/v1/responses"] } },
        ],
      };
    },
  }, () => new Date(nowMs()));
  const history = new SqliteResponsesHistory(database, { nowMs });
  const chatRequests: ChatRequest[] = [];
  const responsesRequests: NativeResponsesUpstreamRequest[] = [];
  const cancellation = { chat: 0, responses: 0 };
  const backend = new ScriptedCopilotBackend({
    chat(request) {
      chatRequests.push(request);
      return {
        status: 200,
        headers: new Headers({ "x-scripted-remote": "chat" }),
        body: jsonBytes(chatCompletion()),
      };
    },
    chatStream(request) {
      chatRequests.push(request);
      return isCancellationRequest(request.body)
        ? cancellableChatStream(request.signal, cancellation)
        : [chatSse(chatCompletionChunk(modelFromBody(request.body))), encoder.encode("data: [DONE]\n\n")];
    },
    responses(request) {
      responsesRequests.push(request);
      return {
        status: 200,
        headers: new Headers({ "x-scripted-remote": "responses" }),
        body: jsonBytes(responsesObject("completed")),
      };
    },
    responsesStream(request) {
      responsesRequests.push(request);
      return isCancellationRequest(request.body)
        ? cancellableResponsesStream(request.signal, cancellation)
        : [responsesSse("response.completed", { type: "response.completed", response: responsesObject("completed") })];
    },
  });
  let databaseClosed = false;
  const closeState = (): void => {
    if (!databaseClosed) {
      databaseClosed = true;
      closeDatabase(database);
    }
  };
  const gateway = await bootstrapGateway({
    startup: { host: "127.0.0.1", port, dataDir, logLevel: "error" },
    application: {
      database,
      credentials: new MemoryCredentialStore(),
      directory,
      catalog,
      copilot: backend,
      history,
      tokenCounter: () => 0,
      modelMetadata: new Map([
        [CHAT_MODEL, { mode: "chat", maxInputTokens: 128_000, maxOutputTokens: 16_384 }],
        [NATIVE_RESPONSES_MODEL, { mode: "responses", maxInputTokens: 128_000, maxOutputTokens: 16_384 }],
      ]),
      async close() {
        await catalog.close();
        closeState();
      },
      forceClose: closeState,
    },
    dependencies: { createRequestId: () => "req_sdk_loopback" },
  });
  try {
    await gateway.listen();
  } catch (error: unknown) {
    await gateway.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    openAiBaseUrl: `${baseUrl}/v1`,
    fetch: loopbackOnlyFetch(baseUrl),
    chatRequests,
    responsesRequests,
    get backendKinds() {
      return backend.captured.map((entry) => entry.kind);
    },
    cancelled: cancellation,
    async close() {
      await gateway.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function decodeCapturedBody(request: ChatRequest | NativeResponsesUpstreamRequest): unknown {
  return JSON.parse(new TextDecoder().decode(request.body)) as unknown;
}

export async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for SDK cancellation");
}

function loopbackOnlyFetch(origin: string): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin || url.hostname !== "127.0.0.1") {
      throw new Error("offline SDK tests blocked a non-loopback request");
    }
    return await nativeFetch(input, init);
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve SDK loopback port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

function chatCompletion(): Record<string, unknown> {
  return {
    id: "chatcmpl_sdk",
    object: "chat.completion",
    created: 1_700_000_000,
    model: CHAT_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function chatCompletionChunk(model = CHAT_MODEL): Record<string, unknown> {
  return {
    id: "chatcmpl_sdk_stream",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  };
}

function responsesObject(status: "in_progress" | "completed"): Record<string, unknown> {
  const completed = status === "completed";
  return {
    id: "resp_sdk",
    object: "response",
    created_at: 1_700_000_000,
    status,
    completed_at: completed ? 1_700_000_001 : null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 8,
    metadata: null,
    model: NATIVE_RESPONSES_MODEL,
    output: completed ? [{
      id: "msg_sdk",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    }] : [],
    output_text: completed ? "pong" : "",
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: completed
      ? { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
      : null,
  };
}

async function* cancellableChatStream(
  signal: AbortSignal,
  cancellation: { chat: number },
): AsyncIterable<Uint8Array> {
  try {
    yield chatSse({
      ...chatCompletionChunk(),
      choices: [{ index: 0, delta: { role: "assistant", content: "waiting" }, finish_reason: null }],
    });
    await untilAborted(signal);
  } finally {
    cancellation.chat += 1;
  }
}

async function* cancellableResponsesStream(
  signal: AbortSignal,
  cancellation: { responses: number },
): AsyncIterable<Uint8Array> {
  try {
    yield responsesSse("response.created", { type: "response.created", response: responsesObject("in_progress") });
    await untilAborted(signal);
  } finally {
    cancellation.responses += 1;
  }
}

async function untilAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw signal.reason;
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function isCancellationRequest(body: Uint8Array): boolean {
  return new TextDecoder().decode(body).includes("cancel-sdk-request");
}

function modelFromBody(body: Uint8Array): string {
  const decoded = JSON.parse(new TextDecoder().decode(body)) as { readonly model?: unknown };
  return typeof decoded.model === "string" ? decoded.model : CHAT_MODEL;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function chatSse(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function responsesSse(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}
