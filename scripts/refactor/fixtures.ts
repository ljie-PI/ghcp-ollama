import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccountDirectory, type BoundAccount } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { assertNode24 } from "./node_version.js";
import { outboundHeaders, type BoundCopilot, type CopilotBackend, type CopilotTarget } from "../../src/copilot/backend.js";
import { parseChatSse } from "../../src/copilot/chat_sse.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { decodeOpenAiChatRequest, prepareOpenAiChatRequest } from "../../src/protocols/openai_chat/endpoint.js";
import { createOllamaChatRoutes } from "../../src/protocols/ollama_chat/endpoint.js";
import { encodeOpenAiChatDone, encodeOpenAiChatSseChunk, serializeOpenAiErrorBody } from "../../src/protocols/openai_chat/wire.js";
import { isWireJsonObject, memberValues, parseWireJson, serializeWireJson, type WireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";
import type { ChatRequest, ChatResponse, NativeResponsesUpstreamRequest, UpstreamByteResponse, UpstreamByteStream } from "../../src/protocols/chat_completions/types.js";
import type { ResolvedModel } from "../../src/protocols/model_catalog/resolver.js";

export interface FixtureManifestEntry {
  readonly caseId: string;
  readonly owner: string;
  readonly source: string;
  readonly input: string;
  readonly expected: string;
  readonly encoder: string;
}

const FIXTURE_ROOT = path.resolve("tests/refactor/fixtures");

type GoReferenceJson =
  | null
  | boolean
  | number
  | string
  | GoReferenceJson[]
  | GoReferenceObject;

interface GoReferenceObject {
  readonly kind: "go-reference-object";
  readonly members: readonly GoReferenceMember[];
}

interface GoReferenceMember {
  readonly key: string;
  readonly value: GoReferenceJson | undefined;
  readonly omitEmpty?: boolean;
}

async function findManifests(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return findManifests(fullPath);
    }
    return entry.name === "manifest.json" ? [fullPath] : [];
  }));

  return nested.flat().sort();
}

function assertManifestEntry(value: unknown, manifestPath: string, index: number): FixtureManifestEntry {
  if (value === null || typeof value !== "object") {
    throw new Error(`${manifestPath} entry ${index} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const fields = ["caseId", "owner", "source", "input", "expected", "encoder"] as const;

  for (const field of fields) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      throw new Error(`${manifestPath} entry ${index} field ${field} must be a non-empty string`);
    }
  }

  return candidate as unknown as FixtureManifestEntry;
}

export async function verifyFixtureManifests(root = FIXTURE_ROOT, verifyExpectedBytes = true): Promise<readonly FixtureManifestEntry[]> {
  const manifests = await findManifests(root);
  const seen = new Set<string>();
  const entries: FixtureManifestEntry[] = [];

  for (const manifest of manifests) {
    const raw = await readFile(manifest, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];

    for (const [index, value] of list.entries()) {
      const entry = assertManifestEntry(value, manifest, index);
      if (seen.has(entry.caseId)) {
        throw new Error(`duplicate fixture caseId: ${entry.caseId}`);
      }
      seen.add(entry.caseId);
      entries.push(entry);
    }
  }

  if (verifyExpectedBytes) {
    await verifyOpenAiChatFixtures(entries);
    await verifyOllamaFixtures(entries);
  }
  return entries;
}

export async function writeFixtureReport(entries: readonly FixtureManifestEntry[]): Promise<string> {
  const reportPath = path.resolve("dist-refactor", "fixtures-report.json");
  const payload = {
    generatedAt: new Date(0).toISOString(),
    count: entries.length,
    checksum: createHash("sha256")
      .update(entries.map((entry) => entry.caseId).join("\n"))
      .digest("hex"),
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reportPath;
}

export function assertFixtureGeneratorAvailable(caseId: string, entries: readonly FixtureManifestEntry[]): never {
  const known = entries.some((entry) => entry.caseId === caseId);
  const reason = known ? "does not have an RM-01 generator" : "is not registered in a manifest";
  throw new Error(`fixture case ${caseId} ${reason}; golden generation is implemented by the owning protocol slice`);
}

async function main(): Promise<void> {
  assertNode24();
  const [command, ...args] = process.argv.slice(2);

  if (command === "verify") {
    const entries = await verifyFixtureManifests();
    console.log(`Verified ${entries.length} refactor fixture manifest entries.`);
    return;
  }

  if (command === "generate") {
    if (!args.includes("--accept")) {
      throw new Error("fixture generation is explicit-only; pass --accept and --case <caseId>");
    }
    const caseIndex = args.indexOf("--case");
    const caseId = args[caseIndex + 1];
    if (caseIndex === -1 || caseId === undefined) {
      throw new Error("fixture generation requires --case <caseId>");
    }

    const entries = await verifyFixtureManifests(FIXTURE_ROOT, false);
    const entry = entries.find((candidate) => candidate.caseId === caseId);
    if (entry?.owner === "RM-09") {
      await generateOpenAiChatFixture(entry);
      return;
    }
    if (entry?.owner === "RM-10") {
      await generateOllamaFixture(entry);
      return;
    }
    assertFixtureGeneratorAvailable(caseId, entries);
  }

  throw new Error("usage: fixtures.ts verify | generate --case <caseId> --accept");
}

async function generateOpenAiChatFixture(entry: FixtureManifestEntry): Promise<void> {
  const expectedPath = path.join(FIXTURE_ROOT, "openai-chat", entry.expected);
  const expected = await expectedOpenAiChatFixture(entry);
  if (expected !== undefined) {
    await writeFile(expectedPath, expected, "utf8");
    return;
  }
  assertFixtureGeneratorAvailable(entry.caseId, [entry]);
}

async function verifyOpenAiChatFixtures(entries: readonly FixtureManifestEntry[]): Promise<void> {
  for (const entry of entries.filter((candidate) => candidate.owner === "RM-09")) {
    const expected = await expectedOpenAiChatFixture(entry);
    if (expected === undefined) {
      throw new Error(`fixture case ${entry.caseId} does not have an RM-09 generator`);
    }

    const actual = await readFile(path.join(FIXTURE_ROOT, "openai-chat", entry.expected), "utf8");
    if (actual !== expected) {
      throw new Error(`fixture case ${entry.caseId} expected bytes are stale; run fixtures:generate -- --case ${entry.caseId} --accept`);
    }
  }
}

async function generateOllamaFixture(entry: FixtureManifestEntry): Promise<void> {
  const expected = await expectedOllamaFixture(entry);
  if (expected === undefined) {
    assertFixtureGeneratorAvailable(entry.caseId, [entry]);
  }
  await writeFile(path.join(FIXTURE_ROOT, "ollama", entry.expected), expected, "utf8");
}

async function verifyOllamaFixtures(entries: readonly FixtureManifestEntry[]): Promise<void> {
  for (const entry of entries.filter((candidate) => candidate.owner === "RM-10")) {
    const expected = await expectedOllamaFixture(entry);
    if (expected === undefined) {
      throw new Error(`fixture case ${entry.caseId} does not have an Ollama generator`);
    }
    const actual = await readFile(path.join(FIXTURE_ROOT, "ollama", entry.expected), "utf8");
    if (actual !== expected) {
      throw new Error(`fixture case ${entry.caseId} expected bytes are stale; run fixtures:generate -- --case ${entry.caseId} --accept`);
    }
  }
}

async function expectedOllamaFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "ollama.request.capture" && entry.caseId !== "ollama.nonstream.success" && entry.caseId !== "ollama.stream.success") {
    return undefined;
  }
  const input = await readFile(path.join(FIXTURE_ROOT, "ollama", entry.input), "utf8");
  if (entry.caseId === "ollama.nonstream.success") {
    return ollamaNonstreamSuccessReference();
  }
  if (entry.caseId === "ollama.stream.success") {
    return ollamaStreamSuccessReference();
  }
  const backend = new FixtureOllamaBackend();
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-ollama-fixture-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    nowMs: () => 0,
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => 0);
  await accounts.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "fixture" },
  });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, createOllamaChatRoutes({
    directory: accounts,
    copilot: backend,
    now: () => new Date(0),
    tokenCounter: (input) => input.text === undefined ? 1 : 0,
  }), {
    createRequestId: () => "req_fixture",
  });
  try {
    const response = await gateway.fetch(new Request("http://127.0.0.1:31400/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input,
    }));
    await response.arrayBuffer();
  } finally {
    await gateway.close();
    closeDatabase(database);
  }

  function ollamaStreamSuccessReference(): string {
    return `${stringifyGoReference(goObject([
      { key: "model", value: "gpt" },
      { key: "remote_model", value: undefined, omitEmpty: true },
      { key: "remote_host", value: undefined, omitEmpty: true },
      { key: "created_at", value: "2026-01-02T03:04:05.12Z" },
      { key: "message", value: goObject([
        { key: "role", value: "assistant" },
        { key: "content", value: "hello" },
        { key: "thinking", value: undefined, omitEmpty: true },
        { key: "images", value: undefined, omitEmpty: true },
        { key: "tool_calls", value: undefined, omitEmpty: true },
        { key: "tool_name", value: undefined, omitEmpty: true },
        { key: "tool_call_id", value: undefined, omitEmpty: true },
      ]) },
      { key: "done", value: false },
      { key: "done_reason", value: undefined, omitEmpty: true },
    ]))}\n${stringifyGoReference(goObject([
      { key: "model", value: "gpt" },
      { key: "remote_model", value: undefined, omitEmpty: true },
      { key: "remote_host", value: undefined, omitEmpty: true },
      { key: "created_at", value: "2026-01-02T03:04:05.12Z" },
      { key: "message", value: goObject([
        { key: "role", value: "assistant" },
        { key: "content", value: "" },
        { key: "thinking", value: undefined, omitEmpty: true },
        { key: "images", value: undefined, omitEmpty: true },
        { key: "tool_calls", value: undefined, omitEmpty: true },
        { key: "tool_name", value: undefined, omitEmpty: true },
        { key: "tool_call_id", value: undefined, omitEmpty: true },
      ]) },
      { key: "done", value: true },
      { key: "done_reason", value: "stop", omitEmpty: true },
    ]))}\n`;
  }

  function ollamaNonstreamSuccessReference(): string {
    return stringifyGoReference(goObject([
      { key: "model", value: "gpt" },
      { key: "remote_model", value: undefined, omitEmpty: true },
      { key: "remote_host", value: undefined, omitEmpty: true },
      { key: "created_at", value: "2023-11-14T22:13:20Z" },
      {
        key: "message",
        value: goObject([
          { key: "role", value: "assistant" },
          { key: "content", value: "visible" },
          { key: "thinking", value: "hidden", omitEmpty: true },
          { key: "images", value: undefined, omitEmpty: true },
          {
            key: "tool_calls",
            value: [
              goObject([
                { key: "id", value: "call_1", omitEmpty: true },
                {
                  key: "function",
                  value: goObject([
                    { key: "index", value: 2 },
                    { key: "name", value: "weather" },
                    { key: "arguments", value: goObject([
                      { key: "city", value: "Tokyo" },
                      { key: "unit", value: "c" },
                    ]) },
                  ]),
                },
              ]),
            ],
            omitEmpty: true,
          },
          { key: "tool_name", value: undefined, omitEmpty: true },
          { key: "tool_call_id", value: undefined, omitEmpty: true },
        ]),
      },
      { key: "done", value: true },
      { key: "done_reason", value: "stop", omitEmpty: true },
      { key: "_debug_info", value: undefined, omitEmpty: true },
      {
        key: "logprobs",
        value: [
          goObject([
            { key: "token", value: "visible" },
            { key: "logprob", value: -0.5 },
            { key: "bytes", value: [118, 105], omitEmpty: true },
            {
              key: "top_logprobs",
              value: [goObject([
                { key: "token", value: "visible" },
                { key: "logprob", value: -0.5 },
                { key: "bytes", value: [118], omitEmpty: true },
              ])],
              omitEmpty: true,
            },
          ]),
        ],
        omitEmpty: true,
      },
      { key: "total_duration", value: undefined, omitEmpty: true },
      { key: "load_duration", value: undefined, omitEmpty: true },
      { key: "prompt_eval_count", value: 12, omitEmpty: true },
      { key: "prompt_eval_duration", value: undefined, omitEmpty: true },
      { key: "eval_count", value: 6, omitEmpty: true },
      { key: "eval_duration", value: undefined, omitEmpty: true },
    ]));
  }

  function goObject(members: readonly GoReferenceMember[]): GoReferenceObject {
    return { kind: "go-reference-object", members };
  }

  function stringifyGoReference(value: GoReferenceJson): string {
    return goEscapeJson(writeGoReference(value));
  }

  function writeGoReference(value: GoReferenceJson): string {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(writeGoReference).join(",")}]`;
    }
    const members = value.members.filter((member) => !member.omitEmpty || !isGoEmpty(member.value));
    return `{${members.map((member) => `${JSON.stringify(member.key)}:${writeGoReference(member.value as GoReferenceJson)}`).join(",")}}`;
  }

  function isGoEmpty(value: GoReferenceJson | undefined): boolean {
    return value === undefined
      || value === null
      || value === false
      || value === 0
      || value === ""
      || (Array.isArray(value) && value.length === 0);
  }

  function goEscapeJson(json: string): string {
    return json
      .replace(/</gu, "\\u003c")
      .replace(/>/gu, "\\u003e")
      .replace(/&/gu, "\\u0026")
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029");
  }

  const request = backend.requests[0];
  if (request === undefined) {
    throw new Error("ollama.request.capture did not call Chat upstream");
  }
  const headers = outboundHeaders("fixture-token", new Headers({ "content-type": "application/json" }));
  return JSON.stringify({
    upstreamUrl: "https://api.githubcopilot.com/chat/completions",
    headers: {
      "content-type": headers.get("content-type"),
      "copilot-integration-id": headers.get("copilot-integration-id"),
      "editor-version": headers.get("editor-version"),
      "editor-plugin-version": headers.get("editor-plugin-version"),
      "user-agent": headers.get("user-agent"),
      "x-github-api-version": headers.get("x-github-api-version"),
    },
    hasVisionInput: request.hasVisionInput,
    chatCallCount: 1,
    body: decodeBytes(request.body),
  });
}

class FixtureOllamaBackend implements CopilotBackend {
  readonly requests: ChatRequest[] = [];

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const target: CopilotTarget = { endpoint: "https://api.githubcopilot.com", token: "fixture-token" };
    return {
      accountId: account.accountId,
      target,
      completeChat: async (request): Promise<ChatResponse> => {
        this.requests.push(request);
        return {
          status: 200,
          headers: new Headers(),
          body: new TextEncoder().encode(JSON.stringify({
            created: 1_700_000_000,
            choices: [{
              index: 0,
              message: {
                content: "<think>hidden</thinking>visible",
                tool_calls: [{
                  id: "call_1",
                  index: 2,
                  type: "function",
                  function: { name: "weather", arguments: "{\"city\":\"Tokyo\",\"unit\":\"c\"}" },
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
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          })),
        };
      },
      openChatStream: async (request): Promise<UpstreamByteStream> => {
        this.requests.push(request);
        return {
          status: 200,
          headers: new Headers({ "content-type": "text/event-stream" }),
          bytes: streamFixtureBytes("data: [DONE]\n\n"),
          cancel: async () => undefined,
        };
      },
      completeResponses: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteResponse> => {
        throw new Error("Responses must not be called by Ollama fixture");
      },
      openResponsesStream: async (_request: Readonly<NativeResponsesUpstreamRequest>): Promise<UpstreamByteStream> => {
        throw new Error("Responses stream must not be called by Ollama fixture");
      },
    };
  }
}

async function* streamFixtureBytes(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

async function expectedOpenAiChatFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  const inputPath = path.join(FIXTURE_ROOT, "openai-chat", entry.input);
  switch (entry.caseId) {
  case "openai-chat.request.model-rewrite": {
    return prepareRequestFixture(await readWireObject(inputPath), "resolved");
  }
  case "openai-chat.request.capture":
    return requestCaptureFixture(await readWireObject(inputPath));
  case "openai-chat.stream.done": {
    return await streamFixture(await readFile(inputPath, "utf8"));
  }
  case "openai-chat.presenter.model-not-found":
    await readFile(inputPath, "utf8");
    return serializeOpenAiErrorBody("model not found", "not_found_error");
  case "openai-chat.buffered.success": {
    return decodeBytes(serializeWireJson(await readWireObject(inputPath)));
  }
  case "openai-chat.buffered.limit-boundary":
    await readFile(inputPath, "utf8");
    return "{\"inclusiveStatus\":200,\"overLimitStatus\":502,\"defaultLimitBytes\":33554432}";
  case "openai-chat.usage.observation": {
    return JSON.stringify(usageFixture(await readWireObject(inputPath)));
  }
  case "openai-chat.model.preferred": {
    return prepareRequestFixture(await readWireObject(inputPath), "preferred");
  }
  case "openai-chat.stream.truncated":
    await readFile(inputPath, "utf8");
    return "{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}";
  case "openai-chat.stream.limit-boundary":
    await readFile(inputPath, "utf8");
    return "{\"inclusiveStatus\":200,\"overLimitStatus\":502,\"defaultLimitBytes\":4194304}";
  case "openai-chat.abort.zero-bytes":
    await readFile(inputPath, "utf8");
    return "";
  default:
    return undefined;
  }
}

async function readWireObject(inputPath: string): Promise<WireJsonObject> {
  const bytes = new TextEncoder().encode(await readFile(inputPath, "utf8"));
  const parsed = parseWireJson(bytes, { maxBytes: bytes.byteLength, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) {
    throw new Error(`${inputPath} must contain a JSON object`);
  }
  return parsed;
}

function prepareRequestFixture(body: WireJsonObject, upstreamModel: string): string {
  const prepared = prepareOpenAiChatRequest(decodeOpenAiChatRequest(body), resolvedModel(upstreamModel));
  return decodeBytes(prepared.bytes);
}

function requestCaptureFixture(body: WireJsonObject): string {
  const prepared = prepareOpenAiChatRequest(decodeOpenAiChatRequest(body), resolvedModel("gpt"));
  const extra = new Headers({ "content-type": "application/json" });
  if (prepared.hasVisionInput) {
    extra.set("copilot-vision-request", "true");
  }
  const headers = outboundHeaders("fixture-token", extra);
  return JSON.stringify({
    upstreamUrl: "https://api.githubcopilot.com/chat/completions",
    headers: {
      "content-type": headers.get("content-type"),
      "copilot-integration-id": headers.get("copilot-integration-id"),
      "editor-version": headers.get("editor-version"),
      "editor-plugin-version": headers.get("editor-plugin-version"),
      "user-agent": headers.get("user-agent"),
      "x-github-api-version": headers.get("x-github-api-version"),
      "copilot-vision-request": headers.get("copilot-vision-request"),
    },
    body: decodeBytes(prepared.bytes),
    chatCallCount: 1,
  });
}

async function streamFixture(input: string): Promise<string> {
  let output = "";
  for await (const frame of parseChatSse(asBytes(input))) {
    if (frame.kind === "chunk") {
      output += decodeBytes(encodeOpenAiChatSseChunk(frame.chunk.payload));
    } else if (frame.kind === "done") {
      output += decodeBytes(encodeOpenAiChatDone());
    } else {
      throw new Error("openai-chat stream fixture produced an error frame");
    }
  }
  return output;
}

function usageFixture(root: WireJsonObject): { inputTokens: number; outputTokens: number; cacheTokens: number } {
  const usage = onlyObject(root, "usage");
  return {
    inputTokens: numberMember(usage, "prompt_tokens"),
    outputTokens: numberMember(usage, "completion_tokens"),
    cacheTokens: numberMember(onlyObject(usage, "prompt_tokens_details"), "cached_tokens"),
  };
}

function onlyObject(root: WireJsonObject, key: string): WireJsonObject {
  const value = memberValues(root, key)[0];
  if (!isWireJsonObject(value)) {
    throw new Error(`expected object member ${key}`);
  }
  return value;
}

function numberMember(root: WireJsonObject, key: string): number {
  const value: WireJson | undefined = memberValues(root, key)[0];
  if (value === undefined || typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "number") {
    throw new Error(`expected number member ${key}`);
  }
  return Number.parseInt(value.lexeme, 10);
}

function resolvedModel(upstreamModel: string): ResolvedModel {
  return {
    upstreamModel,
    source: "explicit",
    routing: {},
  };
}

async function* asBytes(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
