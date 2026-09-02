import { AccountDirectoryError, type AccountDirectory } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import { iterateChatFrames, type BoundCopilot, type CopilotBackend } from "../../copilot/backend.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import { CapiFetchError } from "../../copilot/models_source.js";
import { GatewayFailureError, type GatewayFailure } from "../../gateway/failures.js";
import type { RouteRegistration } from "../../gateway/hono_app.js";
import type { RequestScope } from "../../gateway/request_scope.js";
import { createStreamResponseWriter } from "../../gateway/stream_response.js";
import { isWireJsonObject, parseWireJson, serializeWireJson, type WireJsonObject } from "../../serialization/wire_json.js";
import type { ChatRequest, UpstreamByteResponse, UpstreamByteStream } from "../chat_completions/types.js";
import { resolveModel } from "../model_catalog/resolver.js";
import { convertChatResponseToResponses } from "./bridge_nonstream.js";
import { prepareChatBridgeRequest } from "./bridge_request.js";
import { convertChatStream, type ResponsesStreamEmission } from "./bridge_stream.js";
import { decodeResponsesRequest, ResponsesRequestDecodeError } from "./decoder.js";
import type { ResponsesHistory } from "./history.js";
import { completeNativeResponses, normalizeNativeResponsesStream, openNativeResponsesStream } from "./native.js";
import { planResponsesExecution, type ChatBridgePlan } from "./planner.js";
import {
  encodeResponsesSseEvent,
  RESPONSES_JSON_HEADERS,
  RESPONSES_STREAM_HEADERS,
  serializeResponsesErrorBody,
} from "./wire.js";

export interface ResponsesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly preferences: AccountModelPreferences;
  readonly copilot: CopilotBackend;
  readonly history: ResponsesHistory;
  readonly nowUnixSeconds?: () => number;
  readonly createUuid?: () => string;
}

export function createResponsesRoute(dependencies: ResponsesRouteDependencies): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/responses",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentResponsesFailure,
    endpoint: async (request, scope) => {
      if (request.body === undefined) {
        throw new GatewayFailureError({ kind: "invalid_request" });
      }
      const decoded = decodeRequest(request.body);
      const account = await bindAccount(dependencies.directory, scope.signal);
      const catalog = await loadCatalog(dependencies, account.accountId, scope.signal);
      const resolved = resolveModel(catalog, decoded.model, dependencies.preferences.get(account.accountId));
      if ("kind" in resolved) {
        throw new GatewayFailureError({ kind: resolved.kind });
      }
      const bound = await dependencies.copilot.bind(account, scope.signal);
      const plan = planResponsesExecution(decoded, resolved, bound.target);
      if (plan.kind === "native_responses") {
        return decoded.stream
          ? await nativeStreamResponse(bound, plan, scope)
          : await nativeNonstreamResponse(bound, plan, scope);
      }
      return decoded.stream
        ? await bridgeStreamResponse(dependencies, bound, plan, scope)
        : await bridgeNonstreamResponse(dependencies, bound, plan, scope);
    },
  };
}

function decodeRequest(body: WireJsonObject) {
  try {
    return decodeResponsesRequest(body);
  } catch (error: unknown) {
    if (error instanceof ResponsesRequestDecodeError) {
      throw new GatewayFailureError({ kind: "invalid_request", cause: error });
    }
    throw error;
  }
}

async function nativeNonstreamResponse(
  bound: BoundCopilot,
  plan: Parameters<typeof completeNativeResponses>[1],
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const upstream = await completeNativeResponses(bound, plan, nativeOptions(scope));
  assertUpstreamSuccess(upstream);
  return new Response(Buffer.from(upstream.body), {
    status: upstream.status,
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

async function nativeStreamResponse(
  bound: BoundCopilot,
  plan: Parameters<typeof openNativeResponsesStream>[1],
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const upstream = await openNativeResponsesStream(bound, plan, nativeOptions(scope));
  if (upstream.status < 200 || upstream.status >= 300) {
    await upstream.cancel();
  }
  assertUpstreamSuccess(upstream);
  const bytes = withStreamTimeouts(upstream.bytes, upstream, scope);
  return await streamBytesResponse(normalizeNativeResponsesStream(bytes, scope.config.limits.sseEventBytes), upstream, scope);
}

async function bridgeNonstreamResponse(
  dependencies: ResponsesRouteDependencies,
  bound: BoundCopilot,
  plan: ChatBridgePlan,
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const prepared = await prepareChatBridgeRequest(plan, dependencies.history, {
    reasoningConfig: null,
    ...promptCacheContext(bound.target.endpoint),
  }, scope.signal);
  const upstream = await bound.completeChat(chatRequest(prepared.body, plan.resolvedModel.upstreamModel, false, scope));
  assertUpstreamSuccess(upstream);
  const chat = parseUpstreamObject(upstream.body, scope.config.limits.nonstreamBodyBytes);
  const converted = convertChatResponseToResponses(chat, {
    originalRequest: plan.originalRequest,
    toolContext: prepared.toolContext,
    customLlmProvider: "github_copilot",
    modelId: plan.resolvedModel.upstreamModel,
    createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
  });
  await dependencies.history.record(converted.historyRecord, scope.signal);
  return new Response(Buffer.from(serializeWireJson(converted.response)), {
    headers: { ...RESPONSES_JSON_HEADERS, "x-request-id": scope.requestId },
  });
}

async function bridgeStreamResponse(
  dependencies: ResponsesRouteDependencies,
  bound: BoundCopilot,
  plan: ChatBridgePlan,
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const prepared = await prepareChatBridgeRequest(plan, dependencies.history, {
    reasoningConfig: null,
    ...promptCacheContext(bound.target.endpoint),
  }, scope.signal);
  const upstream = await bound.openChatStream(chatRequest(prepared.body, plan.resolvedModel.upstreamModel, true, scope));
  if (upstream.status < 200 || upstream.status >= 300) {
    await upstream.cancel();
  }
  assertUpstreamSuccess(upstream);
  const timedUpstream = { ...upstream, bytes: withStreamTimeouts(upstream.bytes, upstream, scope) };
  const emissions = convertChatStream(iterateChatFrames(timedUpstream), {
    originalRequest: plan.originalRequest,
    toolContext: prepared.toolContext,
    model: plan.resolvedModel.upstreamModel,
    nowUnixSeconds: dependencies.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000)),
    uuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
    customLlmProvider: "github_copilot",
    modelId: plan.resolvedModel.upstreamModel,
  });
  return await streamEmissionsResponse(emissions, dependencies.history, upstream, scope);
}

async function* withStreamTimeouts(
  source: AsyncIterable<Uint8Array>,
  upstream: UpstreamByteStream,
  scope: Readonly<RequestScope>,
): AsyncIterable<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let seenBytes = false;
  try {
    for (;;) {
      const timeoutMs = seenBytes ? scope.config.timeouts.streamIdleMs : scope.config.timeouts.firstByteMs;
      const next = await nextWithTimeout(iterator, timeoutMs, scope.signal, upstream);
      if (next.done === true) {
        return;
      }
      seenBytes = true;
      yield next.value;
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

async function nextWithTimeout(
  iterator: AsyncIterator<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
  upstream: UpstreamByteStream,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new GatewayFailureError({ kind: "upstream_timeout" }));
    }, timeoutMs);
  });
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), timeout, abort]);
  } catch (error: unknown) {
    if (timedOut) {
      await upstream.cancel();
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function streamEmissionsResponse(
  emissions: AsyncIterable<ResponsesStreamEmission>,
  history: ResponsesHistory,
  upstream: UpstreamByteStream,
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const bytes = (async function* (): AsyncIterable<Uint8Array> {
    try {
      for await (const emission of emissions) {
        if (scope.signal.aborted) {
          await upstream.cancel();
          return;
        }
        if (emission.kind === "checkpoint") {
          await history.record(emission.historyRecord, scope.signal);
        }
        yield encodeResponsesSseEvent(emission.event);
      }
    } finally {
      await upstream.cancel();
    }
  })();
  return await streamBytesResponse(bytes, upstream, scope);
}

async function streamBytesResponse(
  bytes: AsyncIterable<Uint8Array>,
  upstream: UpstreamByteStream,
  scope: Readonly<RequestScope>,
): Promise<Response> {
  const iterator = bytes[Symbol.asyncIterator]();
  let first: IteratorResult<Uint8Array>;
  try {
    first = await iterator.next();
  } catch (error: unknown) {
    await upstream.cancel();
    throw error;
  }
  const writer = createStreamResponseWriter({
    signal: scope.signal,
    headers: { ...RESPONSES_STREAM_HEADERS, "x-request-id": scope.requestId },
  });
  void (async () => {
    try {
      if (first.done !== true && !await writer.enqueue(first.value)) {
        await upstream.cancel();
        return;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        if (!await writer.enqueue(next.value)) {
          await upstream.cancel();
          return;
        }
      }
      writer.close();
    } catch (_error: unknown) {
      writer.abort();
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
  })();
  return writer.response;
}

function chatRequest(
  body: WireJsonObject,
  model: string,
  stream: boolean,
  scope: Readonly<RequestScope>,
): ChatRequest {
  const bytes = serializeWireJson(body);
  return {
    model,
    body: bytes,
    stream,
    hasVisionInput: new TextDecoder().decode(bytes).includes("\"image_url\""),
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  };
}

function nativeOptions(scope: Readonly<RequestScope>) {
  return {
    requestId: scope.requestId,
    nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    connectTimeoutMs: scope.config.timeouts.connectMs,
    firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
    signal: scope.signal,
  };
}

function assertUpstreamSuccess(response: Pick<UpstreamByteResponse, "status" | "headers">): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  const retryAfter = retryAfterHeader(response.status, response.headers);
  throw new GatewayFailureError({
    kind: "upstream_http",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

function parseUpstreamObject(body: Uint8Array, maxBytes: number): WireJsonObject {
  try {
    const parsed = parseWireJson(body, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

async function bindAccount(directory: AccountDirectory, signal: AbortSignal) {
  try {
    return await directory.bindDefault(signal);
  } catch (error: unknown) {
    if (error instanceof AccountDirectoryError && (error.code === "no_default" || error.code === "not_found")) {
      throw new GatewayFailureError({ kind: "authentication", cause: error });
    }
    throw error;
  }
}

async function loadCatalog(
  dependencies: ResponsesRouteDependencies,
  accountId: string,
  signal: AbortSignal,
) {
  try {
    const catalog = await dependencies.catalog.get(accountId, signal);
    dependencies.preferences.markInvalidIfMissing(accountId, new Set(catalog.models.map((model) => model.id)), catalog.generation);
    return catalog;
  } catch (error: unknown) {
    if (error instanceof CapiFetchError) {
      if (error.failureKind === "upstream_timeout") {
        throw new GatewayFailureError({ kind: "upstream_timeout", cause: error });
      }
      if (error.failureKind === "upstream_network") {
        throw new GatewayFailureError({ kind: "upstream_network", cause: error });
      }
      if (error.failureKind === "invalid_upstream_response") {
        throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
      }
      throw new GatewayFailureError({
        kind: "upstream_http",
        status: error.status,
        ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
      });
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

function promptCacheContext(endpoint: string): { readonly upstreamHost?: string; readonly upstreamPath?: string; readonly promptCacheRouting: "auto" } {
  try {
    const url = new URL(endpoint);
    return { upstreamHost: url.hostname, upstreamPath: url.pathname, promptCacheRouting: "auto" };
  } catch (_error: unknown) {
    return { promptCacheRouting: "auto" };
  }
}

function presentResponsesFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const status = statusForFailure(failure);
  const headers = new Headers({ ...RESPONSES_JSON_HEADERS, "x-request-id": requestId });
  if (failure.kind === "upstream_http" && failure.status === 429 && failure.retryAfter !== undefined) {
    headers.set("retry-after", failure.retryAfter);
  }
  return new Response(serializeResponsesErrorBody(messageForFailure(failure), errorTypeForStatus(status)), { status, headers });
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
  case "upstream_timeout":
    return 504;
  case "upstream_http":
    return failure.status;
  case "upstream_network":
  case "upstream_stream_error":
  case "upstream_stream_truncated":
  case "invalid_upstream_response":
  case "invalid_tool_arguments":
  case "invalid_logprobs":
    return 502;
  case "internal":
  case "aborted":
    return 500;
  }
}

function messageForFailure(failure: Readonly<GatewayFailure>): string {
  if (failure.kind === "upstream_http") {
    return "upstream request failed";
  }
  if (failure.kind === "body_too_large") {
    return "request body too large";
  }
  if (failure.kind === "unsupported_media_type") {
    return "unsupported media type";
  }
  if (failure.kind === "unsupported_semantics") {
    return "unsupported semantics";
  }
  if (failure.kind === "authentication") {
    return "authentication failed";
  }
  if (failure.kind === "permission") {
    return "permission denied";
  }
  if (failure.kind === "model_not_found") {
    return "model not found";
  }
  if (failure.kind === "queue_full" || failure.kind === "queue_timeout") {
    return "server overloaded";
  }
  if (failure.kind === "upstream_timeout") {
    return "upstream timeout";
  }
  if (failure.kind === "invalid_upstream_response" || failure.kind === "invalid_tool_arguments" || failure.kind === "invalid_logprobs") {
    return "invalid upstream response";
  }
  if (failure.kind === "upstream_network" || failure.kind === "upstream_stream_error" || failure.kind === "upstream_stream_truncated") {
    return "upstream request failed";
  }
  return failure.kind === "invalid_request" ? "invalid request" : "internal error";
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
  return status === 400 || status === 409 || status === 413 || status === 415 || status === 422
    ? "invalid_request_error"
    : "api_error";
}

function retryAfterHeader(status: number, headers: Headers): string | undefined {
  if (status !== 429) {
    return undefined;
  }
  const value = headers.get("retry-after");
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return value;
  }
  if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return undefined;
}
