import { AccountDirectoryError, type AccountDirectory } from "../../accounts/account_directory.js";
import type { AccountModelPreferences } from "../../accounts/model_preferences.js";
import type { CopilotBackend } from "../../copilot/backend.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import { CapiFetchError } from "../../copilot/models_source.js";
import { GatewayFailureError, type GatewayFailure } from "../../gateway/failures.js";
import type { RouteRegistration } from "../../gateway/hono_app.js";
import { memberValues, type WireJsonObject } from "../../serialization/wire_json.js";
import type { ChatRequest } from "../chat_completions/types.js";
import { resolveModel } from "../model_catalog/resolver.js";
import { convertChatResponse } from "./bridge.js";
import { convertAnthropicRequest } from "./request.js";
import { createAnthropicStreamResponse } from "./stream.js";
import { anthropicErrorBody, type AnthropicErrorType } from "./wire.js";

export interface AnthropicMessagesRouteDependencies {
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly preferences: AccountModelPreferences;
  readonly copilot: CopilotBackend;
  readonly createUuid?: () => string;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createAnthropicMessagesRoute(dependencies: AnthropicMessagesRouteDependencies): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/messages",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: presentAnthropicFailure,
    endpoint: async (request, scope) => {
      if (request.body === undefined) {
        throw new GatewayFailureError({ kind: "invalid_request" });
      }
      assertAnthropicVersion(request.headers);
      const requestedModel = readRequestedModel(request.body);
      const account = await bindAccount(dependencies, scope.signal);
      const catalog = await loadCatalog(dependencies, account.accountId, scope.signal);
      const resolved = resolveModel(catalog, requestedModel.value, dependencies.preferences.get(account.accountId));
      if ("kind" in resolved) {
        throw new GatewayFailureError({ kind: resolved.kind });
      }
      const chatBody = convertAnthropicRequest(request.body, resolved.upstreamModel, requestedModel.value);
      const stream = chatBody.stream === true;
      const copilot = await dependencies.copilot.bind(account, scope.signal);
      const chatRequest: ChatRequest = {
        model: resolved.upstreamModel,
        body: new TextEncoder().encode(JSON.stringify(chatBody)),
        stream,
        hasVisionInput: hasVisionInput(chatBody.messages),
        nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
        connectTimeoutMs: scope.config.timeouts.connectMs,
        firstByteTimeoutMs: scope.config.timeouts.firstByteMs,
        signal: scope.signal,
      };

      if (!stream) {
        const upstream = await copilot.completeChat(chatRequest);
        throwIfUpstreamHttp(upstream);
        if (upstream.body.byteLength > scope.config.limits.nonstreamBodyBytes) {
          throw new GatewayFailureError({ kind: "invalid_upstream_response" });
        }
        const body = convertChatResponse(upstream);
        return new Response(JSON.stringify(body), {
          headers: { ...JSON_HEADERS, "request-id": scope.requestId },
        });
      }

      const upstream = await copilot.openChatStream(chatRequest);
      throwIfUpstreamHttp(upstream);
      return createAnthropicStreamResponse({
        upstream,
        model: resolved.upstreamModel,
        createUuid: dependencies.createUuid ?? crypto.randomUUID.bind(crypto),
        scope,
      });
    },
  };
}

function presentAnthropicFailure(failure: Readonly<GatewayFailure>, requestId: string): Response {
  const mapped = mapAnthropicFailure(failure);
  const headers = new Headers({ ...JSON_HEADERS, "request-id": requestId });
  if (failure.kind === "upstream_http" && failure.retryAfter !== undefined) {
    headers.set("retry-after", failure.retryAfter);
  }
  return new Response(anthropicErrorBody(mapped.type, mapped.message, requestId), {
    status: mapped.status,
    headers,
  });
}

function mapAnthropicFailure(failure: Readonly<GatewayFailure>): {
  readonly status: number;
  readonly type: AnthropicErrorType;
  readonly message: string;
} {
  if (failure.kind === "upstream_http") {
    return {
      status: failure.status,
      type: upstreamAnthropicErrorType(failure.status),
      message: "upstream request failed",
    };
  }
  if (failure.kind === "body_too_large") {
    return { status: 413, type: "request_too_large", message: "request body too large" };
  }
  if (failure.kind === "unsupported_media_type") {
    return { status: 415, type: "invalid_request_error", message: "unsupported media type" };
  }
  if (failure.kind === "unsupported_semantics") {
    return { status: 400, type: "invalid_request_error", message: "unsupported semantics" };
  }
  if (failure.kind === "authentication") {
    return { status: 401, type: "authentication_error", message: "authentication failed" };
  }
  if (failure.kind === "permission") {
    return { status: 403, type: "permission_error", message: "permission denied" };
  }
  if (failure.kind === "model_not_found") {
    return { status: 404, type: "not_found_error", message: "model not found" };
  }
  if (failure.kind === "queue_full" || failure.kind === "queue_timeout") {
    return { status: 529, type: "overloaded_error", message: "server overloaded" };
  }
  if (failure.kind === "upstream_timeout") {
    return { status: 504, type: "timeout_error", message: "upstream timeout" };
  }
  if (failure.kind === "upstream_network") {
    return { status: 502, type: "api_error", message: "upstream request failed" };
  }
  if (failure.kind === "invalid_upstream_response") {
    return { status: 502, type: "api_error", message: "invalid upstream response" };
  }
  if (failure.kind === "internal") {
    return { status: 500, type: "api_error", message: "internal error" };
  }
  return { status: 400, type: "invalid_request_error", message: "invalid request" };
}

function upstreamAnthropicErrorType(status: number): AnthropicErrorType {
  if (status === 400 || status === 415 || status === 422) {
    return "invalid_request_error";
  }
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 402) {
    return "billing_error";
  }
  if (status === 403) {
    return "permission_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 413) {
    return "request_too_large";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status === 504) {
    return "timeout_error";
  }
  if (status === 529) {
    return "overloaded_error";
  }
  return "api_error";
}

function assertAnthropicVersion(headers: Headers): void {
  const value = headers.get("anthropic-version");
  if (value === null || value.includes(",") || value.trim() !== "2023-06-01") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
}

function readRequestedModel(body: WireJsonObject): { readonly value: string | undefined } {
  const values = memberValues(body, "model");
  if (values.length === 0) {
    return { value: undefined };
  }
  const value = values[0];
  if (typeof value !== "string") {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }
  return { value };
}

async function bindAccount(
  dependencies: AnthropicMessagesRouteDependencies,
  signal: AbortSignal,
) {
  try {
    return await dependencies.directory.bindDefault(signal);
  } catch (error: unknown) {
    if (error instanceof AccountDirectoryError && (error.code === "no_default" || error.code === "not_found")) {
      throw new GatewayFailureError({ kind: "authentication" });
    }
    throw error;
  }
}

async function loadCatalog(
  dependencies: AnthropicMessagesRouteDependencies,
  accountId: string,
  signal: AbortSignal,
) {
  try {
    const catalog = await dependencies.catalog.get(accountId, signal);
    dependencies.preferences.markInvalidIfMissing(
      accountId,
      new Set(catalog.models.map((model) => model.id)),
      catalog.generation,
    );
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

function throwIfUpstreamHttp(response: { readonly status: number; readonly headers: Headers }): void {
  if (response.status < 400) {
    return;
  }
  const retryAfter = retryAfterHeader(response.status, response.headers);
  throw new GatewayFailureError({
    kind: "upstream_http",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
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
  if (value.includes(",") && !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    return undefined;
  }
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function hasVisionInput(messages: unknown[]): boolean {
  return JSON.stringify(messages).includes("\"image_url\"");
}