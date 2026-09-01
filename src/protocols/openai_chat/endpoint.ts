import { AccountDirectoryError, type AccountDirectory } from "../../accounts/account_directory.js";
import type { AccountModelPreferences, ModelPreference } from "../../accounts/model_preferences.js";
import type { BoundCopilot, CopilotBackend } from "../../copilot/backend.js";
import { CapiFetchError } from "../../copilot/models_source.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import { parseChatSse } from "../../copilot/chat_sse.js";
import { GatewayFailureError, type GatewayFailure } from "../../gateway/failures.js";
import type { RouteRegistration } from "../../gateway/hono_app.js";
import {
  duplicateMemberNames,
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { resolveModel, type ResolvedModel } from "../model_catalog/resolver.js";
import type { ChatRequest, ChatStreamFrame } from "../chat_completions/types.js";
import type { TelemetryRecorder, UsageUpdate } from "../../telemetry/recorder.js";
import { encodeOpenAiChatDone, encodeOpenAiChatSseChunk, serializeOpenAiErrorBody } from "./wire.js";

export interface OpenAiChatRouteDependencies {
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly preferences?: AccountModelPreferences;
  readonly copilot: CopilotBackend;
  readonly usageRecorder?: Pick<TelemetryRecorder, "recordUsage">;
  readonly nowMs?: () => number;
}

interface DecodedOpenAiChatRequest {
  readonly body: WireJsonObject;
  readonly requestedModel?: string;
  readonly stream: boolean;
}

interface PreparedOpenAiChatRequest {
  readonly body: WireJsonObject;
  readonly bytes: Uint8Array;
  readonly stream: boolean;
  readonly hasVisionInput: boolean;
  readonly resolvedModel: string;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createOpenAiChatRoute(dependencies: OpenAiChatRouteDependencies): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentOpenAiFailure,
    endpoint: async (request, scope) => {
      const startedAtMs = (dependencies.nowMs ?? Date.now)();
      if (request.body === undefined) {
        throw new GatewayFailureError({ kind: "invalid_request" });
      }

      const decoded = decodeOpenAiChatRequest(request.body);
      const account = await bindAccount(dependencies.directory, scope.signal);
      const catalog = await loadCatalog(dependencies.catalog, account.accountId, scope.signal);
      const preference = (dependencies.preferences ?? dependencies.directory.preferences).get(account.accountId);
      const resolved = resolveOpenAiChatModel(decoded, catalog, preference);
      const copilot = await dependencies.copilot.bind(account, scope.signal);
      const prepared = prepareOpenAiChatRequest(decoded, resolved);

      if (!prepared.stream) {
        const upstream = await completeChat(copilot, {
          model: prepared.resolvedModel,
          body: prepared.bytes,
          stream: false,
          hasVisionInput: prepared.hasVisionInput,
          signal: scope.signal,
        });
        assertUpstreamSuccess(upstream.status, upstream.headers);
        if (upstream.body.byteLength > scope.config.limits.nonstreamBodyBytes) {
          throw new GatewayFailureError({ kind: "invalid_upstream_response" });
        }
        const payload = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
        recordUsageSample(dependencies, {
          occurredAtMs: (dependencies.nowMs ?? Date.now)(),
          accountId: account.accountId,
          protocol: "openai_chat",
          resolvedModel: resolved.upstreamModel,
          outcome: "success",
          requestCount: 1,
          errorCount: 0,
          ...usageNumbers(usageObservationFromPayload(payload)),
          latencyMs: (dependencies.nowMs ?? Date.now)() - startedAtMs,
        });
        return new Response(Buffer.from(serializeWireJson(payload)), {
          status: upstream.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "x-request-id": scope.requestId,
          },
        });
      }

      const upstream = await openChatStream(copilot, {
        model: prepared.resolvedModel,
        body: prepared.bytes,
        stream: true,
        hasVisionInput: prepared.hasVisionInput,
        signal: scope.signal,
      });
      assertUpstreamSuccess(upstream.status, upstream.headers);
      if (!isEventStream(upstream.headers)) {
        throw new GatewayFailureError({ kind: "invalid_upstream_response" });
      }

      const frames = parseChatSse(upstream.bytes, scope.config.limits.sseEventBytes);
      const first = await nextFrame(frames);
      if (first.kind === "error") {
        await frames.return(undefined);
        throw new GatewayFailureError({ kind: "invalid_upstream_response" });
      }

      return openAiChatStreamResponse({
        status: upstream.status,
        signal: scope.signal,
        requestId: scope.requestId,
        first,
        frames,
        dependencies,
        accountId: account.accountId,
        resolvedModel: resolved.upstreamModel,
        startedAtMs,
      });
    },
  };
}

export function decodeOpenAiChatRequest(body: WireJsonObject): DecodedOpenAiChatRequest {
  if (duplicateMemberNames(body).length > 0) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }

  const model = memberValues(body, "model")[0];
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }

  const streamValue = memberValues(body, "stream")[0];
  if (streamValue !== undefined && streamValue !== true && streamValue !== false) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (streamValue === true) {
    const streamOptions = memberValues(body, "stream_options")[0];
    if (streamOptions !== undefined) {
      validateStreamOptions(streamOptions);
    }
  }

  return {
    body,
    ...(model === undefined ? {} : { requestedModel: model }),
    stream: streamValue === true,
  };
}

export function prepareOpenAiChatRequest(
  decoded: DecodedOpenAiChatRequest,
  resolved: ResolvedModel,
): PreparedOpenAiChatRequest {
  const members: Array<{ key: string; value: WireJson }> = [];
  let hasModel = false;
  let hasStreamOptions = false;

  for (const member of decoded.body.members) {
    if (member.key === "model") {
      hasModel = true;
      members.push({ key: member.key, value: resolved.upstreamModel });
      continue;
    }
    if (decoded.stream && member.key === "stream_options") {
      hasStreamOptions = true;
      members.push({ key: member.key, value: prepareStreamOptions(member.value) });
      continue;
    }
    members.push(member);
  }

  if (!hasModel) {
    members.push({ key: "model", value: resolved.upstreamModel });
  }
  if (decoded.stream && !hasStreamOptions) {
    members.push({
      key: "stream_options",
      value: { kind: "object", members: [{ key: "include_usage", value: true }] },
    });
  }

  const body: WireJsonObject = { kind: "object", members };
  return {
    body,
    bytes: serializeWireJson(body),
    stream: decoded.stream,
    hasVisionInput: hasVisionInput(decoded.body),
    resolvedModel: resolved.upstreamModel,
  };
}

function resolveOpenAiChatModel(
  decoded: DecodedOpenAiChatRequest,
  catalog: Awaited<ReturnType<CopilotModelCatalog["get"]>>,
  preference: ModelPreference | null,
): ResolvedModel {
  const resolved = resolveModel(catalog, decoded.requestedModel, preference);
  if ("kind" in resolved) {
    throw new GatewayFailureError({ kind: resolved.kind });
  }
  return resolved;
}

async function bindAccount(directory: AccountDirectory, signal: AbortSignal) {
  try {
    return await directory.bindDefault(signal);
  } catch (error: unknown) {
    if (error instanceof AccountDirectoryError && (error.code === "no_default" || error.code === "not_found")) {
      throw new GatewayFailureError({ kind: "authentication" });
    }
    throw error;
  }
}

async function loadCatalog(catalog: CopilotModelCatalog, accountId: string, signal: AbortSignal) {
  try {
    return await catalog.get(accountId, signal);
  } catch (error: unknown) {
    if (error instanceof CapiFetchError) {
      throw new GatewayFailureError({
        kind: "upstream_http",
        status: error.status,
        ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
      });
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

async function completeChat(
  copilot: BoundCopilot,
  request: Readonly<ChatRequest>,
) {
  try {
    return await copilot.completeChat(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error);
  }
}

async function openChatStream(
  copilot: BoundCopilot,
  request: Readonly<ChatRequest>,
) {
  try {
    return await copilot.openChatStream(request);
  } catch (error: unknown) {
    throw upstreamCallFailure(error);
  }
}

function upstreamCallFailure(error: unknown): GatewayFailureError {
  if (error instanceof GatewayFailureError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayFailureError({ kind: "aborted" });
  }
  return new GatewayFailureError({ kind: "upstream_network", cause: error });
}

function parseUpstreamObject(body: Uint8Array, maxBytes: number): WireJsonObject {
  try {
    const payload = parseWireJson(body, {
      maxBytes,
      maxDepth: 64,
    });
    if (!isWireJsonObject(payload)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return payload;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

function prepareStreamOptions(value: WireJson): WireJsonObject {
  validateStreamOptions(value);
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  const includeUsageCount = value.members.filter((member) => member.key === "include_usage").length;
  if (includeUsageCount > 1) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (includeUsageCount === 0) {
    return { kind: "object", members: [...value.members, { key: "include_usage", value: true }] };
  }
  return {
    kind: "object",
    members: value.members.map((member) => member.key === "include_usage"
      ? { key: member.key, value: true }
      : member),
  };
}

function validateStreamOptions(value: WireJson): void {
  if (!isWireJsonObject(value)) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  if (value.members.filter((member) => member.key === "include_usage").length > 1) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
}

function hasVisionInput(body: WireJsonObject): boolean {
  const messages = memberValues(body, "messages")[0];
  if (!isWireJsonArray(messages)) {
    return false;
  }
  return messages.items.some((message) => {
    if (!isWireJsonObject(message)) {
      return false;
    }
    const content = memberValues(message, "content")[0];
    if (!isWireJsonArray(content)) {
      return false;
    }
    return content.items.some((part) => {
      if (!isWireJsonObject(part)) {
        return false;
      }
      return memberValues(part, "type")[0] === "image_url" && memberValues(part, "image_url").length > 0;
    });
  });
}

function assertUpstreamSuccess(status: number, headers: Headers): void {
  if (status >= 200 && status < 300) {
    return;
  }
  const retry = status === 429 ? retryAfter(headers) : undefined;
  throw new GatewayFailureError({
    kind: "upstream_http",
    status,
    ...(retry === undefined ? {} : { retryAfter: retry }),
  });
}

function retryAfter(headers: Headers): string | undefined {
  const value = headers.get("retry-after");
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return value;
  }
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return undefined;
}

function isEventStream(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  if (contentType === null) {
    return false;
  }
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

async function nextFrame(frames: AsyncGenerator<ChatStreamFrame>): Promise<ChatStreamFrame> {
  try {
    const next = await frames.next();
    if (next.done === true) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return next.value;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

function openAiChatStreamResponse(input: {
  readonly status: number;
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly first: ChatStreamFrame;
  readonly frames: AsyncGenerator<ChatStreamFrame>;
  readonly dependencies: OpenAiChatRouteDependencies;
  readonly accountId: string;
  readonly resolvedModel: string;
  readonly startedAtMs: number;
}): Response {
  let pending: ChatStreamFrame | undefined = input.first;
  let closed = false;
  let usage: ChatUsageObservation = {};
  const closeFrames = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await input.frames.return(undefined).catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (input.signal.aborted) {
        await closeFrames();
        controller.close();
        return;
      }
      try {
        const frame = pending ?? await nextFrame(input.frames);
        pending = undefined;
        if (frame.kind === "chunk") {
          usage = mergeUsageObservation(usage, usageObservationFromPayload(frame.chunk.payload));
          controller.enqueue(encodeOpenAiChatSseChunk(frame.chunk.payload));
          return;
        }
        if (frame.kind === "done") {
          controller.enqueue(encodeOpenAiChatDone());
          recordUsageSample(input.dependencies, {
            occurredAtMs: (input.dependencies.nowMs ?? Date.now)(),
            accountId: input.accountId,
            protocol: "openai_chat",
            resolvedModel: input.resolvedModel,
            outcome: "success",
            requestCount: 1,
            errorCount: 0,
            ...usageNumbers(usage),
            latencyMs: (input.dependencies.nowMs ?? Date.now)() - input.startedAtMs,
          });
          await closeFrames();
          controller.close();
          return;
        }
        await closeFrames();
        controller.error(new Error("upstream stream error"));
      } catch (_error) {
        await closeFrames();
        controller.error(new Error("upstream stream error"));
      }
    },
    async cancel(): Promise<void> {
      await closeFrames();
    },
  });
  input.signal.addEventListener("abort", () => {
    void closeFrames();
  }, { once: true });
  return new Response(stream, {
    status: input.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "x-request-id": input.requestId,
    },
  });
}

interface ChatUsageObservation {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
}

function usageObservationFromPayload(value: WireJson): ChatUsageObservation {
  if (!isWireJsonObject(value)) {
    return {};
  }
  const usage = memberValues(value, "usage")[0];
  if (!isWireJsonObject(usage)) {
    return {};
  }
  const promptTokens = nonnegativeInteger(memberValues(usage, "prompt_tokens")[0]);
  const completionTokens = nonnegativeInteger(memberValues(usage, "completion_tokens")[0]);
  const details = memberValues(usage, "prompt_tokens_details")[0];
  const cachedTokens = isWireJsonObject(details)
    ? nonnegativeInteger(memberValues(details, "cached_tokens")[0])
    : undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

function nonnegativeInteger(value: WireJson | undefined): number | undefined {
  if (value === undefined || typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "number") {
    return undefined;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(value.lexeme)) {
    return undefined;
  }
  const parsed = Number.parseInt(value.lexeme, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function mergeUsageObservation(left: ChatUsageObservation, right: ChatUsageObservation): ChatUsageObservation {
  return {
    ...((right.promptTokens ?? left.promptTokens) === undefined ? {} : { promptTokens: right.promptTokens ?? left.promptTokens }),
    ...((right.completionTokens ?? left.completionTokens) === undefined ? {} : { completionTokens: right.completionTokens ?? left.completionTokens }),
    ...((right.cachedTokens ?? left.cachedTokens) === undefined ? {} : { cachedTokens: right.cachedTokens ?? left.cachedTokens }),
  };
}

function usageNumbers(observation: ChatUsageObservation): Pick<UsageUpdate, "inputTokens" | "outputTokens" | "cacheTokens"> {
  return {
    inputTokens: observation.promptTokens ?? 0,
    outputTokens: observation.completionTokens ?? 0,
    cacheTokens: observation.cachedTokens ?? 0,
  };
}

function recordUsageSample(dependencies: OpenAiChatRouteDependencies, update: UsageUpdate): void {
  try {
    dependencies.usageRecorder?.recordUsage(update);
  } catch (_error) {
    // Telemetry is noncritical and must not change protocol bytes.
  }
}

function presentOpenAiFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const status = statusForFailure(failure);
  const headers = new Headers({ ...JSON_HEADERS, "x-request-id": requestId });
  if (failure.kind === "upstream_http" && failure.status === 429 && failure.retryAfter !== undefined) {
    headers.set("retry-after", failure.retryAfter);
  }
  return new Response(serializeOpenAiErrorBody(messageForFailure(failure), errorTypeForStatus(status)), {
    status,
    headers,
  });
}

function statusForFailure(failure: Readonly<GatewayFailure>): number {
  switch (failure.kind) {
  case "invalid_request":
    return 400;
  case "body_too_large":
    return 413;
  case "unsupported_media_type":
    return 415;
  case "unsupported_semantics":
    return 422;
  case "authentication":
    return 401;
  case "permission":
    return 403;
  case "model_not_found":
    return 404;
  case "queue_full":
  case "queue_timeout":
    return 503;
  case "upstream_network":
  case "invalid_upstream_response":
    return 502;
  case "upstream_timeout":
    return 504;
  case "upstream_http":
    return failure.status;
  case "internal":
  case "aborted":
    return 500;
  }
}

function messageForFailure(failure: Readonly<GatewayFailure>): string {
  switch (failure.kind) {
  case "invalid_request":
    return "invalid request";
  case "body_too_large":
    return "request body too large";
  case "unsupported_media_type":
    return "unsupported media type";
  case "unsupported_semantics":
    return "unsupported semantics";
  case "authentication":
    return "authentication failed";
  case "permission":
    return "permission denied";
  case "model_not_found":
    return "model not found";
  case "queue_full":
  case "queue_timeout":
    return "server overloaded";
  case "upstream_timeout":
    return "upstream timeout";
  case "invalid_upstream_response":
    return "invalid upstream response";
  case "upstream_http":
  case "upstream_network":
    return "upstream request failed";
  case "internal":
  case "aborted":
    return "internal error";
  }
}

function errorTypeForStatus(status: number): string {
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 403) {
    return "permission_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status === 400 || status === 409 || status === 413 || status === 415 || status === 422) {
    return "invalid_request_error";
  }
  return "api_error";
}
