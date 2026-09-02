import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RuntimeConfigSchema } from "../config/schema.js";
import type { DecodedHttpRequest, RouteRegistration } from "../gateway/hono_app.js";
import type { GatewayFailure } from "../gateway/failures.js";
import type { RequestScope } from "../gateway/request_scope.js";
import type {
  DefaultAdminManagementApi} from "./api.js";
import {
  AdminApiError,
  mapAdminError,
  type AdminEventQuery,
  type AdminUsageQuery,
} from "./api.js";
import type {
  AdminAuth} from "./auth.js";
import {
  AdminAuthError,
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "./auth.js";
import { AdminEventStreamHub } from "./events.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

const BootstrapSchema = Type.Object({ token: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const DeviceFlowStartSchema = Type.Object({ host: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ExpectedRevisionSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const DefaultAccountSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const PreferredModelSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const RefreshModelsSchema = Type.Object({ accountId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const RuntimeConfigUpdateSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  config: RuntimeConfigSchema,
}, { additionalProperties: false });

const USAGE_PROTOCOLS = new Set(["openai_chat", "openai_responses_native", "openai_responses_bridge", "anthropic", "ollama"]);
const USAGE_OUTCOMES = new Set(["success", "client_error", "authentication_error", "overloaded", "upstream_error", "timeout", "aborted", "internal_error"]);
const EVENT_SEVERITIES = new Set(["info", "warning", "error"]);
const EVENT_KINDS = new Set([
  "gateway_started",
  "gateway_stopped",
  "request_failed",
  "account_authenticated",
  "account_removed",
  "default_account_changed",
  "preferred_model_changed",
  "runtime_config_changed",
  "catalog_refreshed",
  "performance_degraded",
  "performance_recovered",
  "telemetry_dropped",
  "metadata_rejected",
  "daemon_start_failed",
  "config_updated",
]);

export interface AdminRouteDependencies {
  readonly auth: AdminAuth;
  readonly api: DefaultAdminManagementApi;
  readonly origin?: string;
  readonly eventHub?: AdminEventStreamHub;
  readonly nowMs?: () => number;
}

export function createAdminRoutes(dependencies: AdminRouteDependencies): readonly RouteRegistration[] {
  const origin = dependencies.origin ?? "http://127.0.0.1:31400";
  const eventHub = dependencies.eventHub ?? new AdminEventStreamHub(dependencies.api);
  const nowMs = dependencies.nowMs ?? Date.now;

  return [
    adminRoute("POST", "/admin/api/v1/auth/bootstrap", "admin-json-object", async (request, scope) => {
      requireExactOrigin(request.headers, origin);
      const body = checked(BootstrapSchema, request.adminBody);
      const session = dependencies.auth.exchangeBootstrapToken(body.token);
      const headers = successHeaders(scope.requestId);
      headers.set("Set-Cookie", serializeSessionCookie(session.sessionId, session.absoluteExpiresAtMs));
      return json(200, { data: dependencies.auth.metadata(session) }, headers);
    }),
    adminRoute("GET", "/admin/api/v1/auth/session", "none", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.auth.metadata(session) }, successHeaders(scope.requestId));
    }),
    adminRoute("POST", "/admin/api/v1/auth/logout", "none", async (request, scope) => {
      const sessionId = readSessionCookie(request.headers);
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      dependencies.auth.logout(sessionId);
      const headers = successHeaders(scope.requestId);
      headers.set("Set-Cookie", serializeExpiredSessionCookie());
      return new Response(null, { status: 204, headers });
    }),
    adminRoute("GET", "/admin/api/v1/status", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.api.status() }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/usage", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.api.usage(parseUsageQuery(request.url, nowMs())) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/accounts", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.api.accounts() }, successHeaders(scope.requestId));
    }),
    adminRoute("POST", "/admin/api/v1/device-flows", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(DeviceFlowStartSchema, request.adminBody);
      return json(201, { data: await dependencies.api.startDeviceFlow(body.host) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/device-flows/:flowId", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      const flowId = pathTail(request.url.pathname);
      return json(200, { data: await dependencies.api.pollDeviceFlow(flowId) }, successHeaders(scope.requestId));
    }),
    adminRoute("DELETE", "/admin/api/v1/accounts/:accountId", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(ExpectedRevisionSchema, request.adminBody);
      return json(200, { data: await dependencies.api.removeAccount(pathTail(request.url.pathname), body.expectedRevision) }, successHeaders(scope.requestId));
    }),
    adminRoute("PUT", "/admin/api/v1/accounts/default", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(DefaultAccountSchema, request.adminBody);
      return json(200, { data: dependencies.api.useDefaultAccount(body.accountId, body.expectedRevision) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/models", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      const accountId = singleOptionalQuery(request.url, new Set(["accountId"]), "accountId");
      return json(200, { data: await dependencies.api.models(accountId) }, successHeaders(scope.requestId));
    }),
    adminRoute("POST", "/admin/api/v1/models/refresh", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(RefreshModelsSchema, request.adminBody);
      return json(200, { data: await dependencies.api.refreshModels(body.accountId) }, successHeaders(scope.requestId));
    }),
    adminRoute("PUT", "/admin/api/v1/models/preferred", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(PreferredModelSchema, request.adminBody);
      return json(200, { data: await dependencies.api.setPreferredModel(body.accountId, body.modelId, body.expectedRevision) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/config", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.api.runtimeConfig() }, successHeaders(scope.requestId));
    }),
    adminRoute("PUT", "/admin/api/v1/config", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(RuntimeConfigUpdateSchema, request.adminBody);
      return json(200, { data: dependencies.api.updateRuntimeConfig(body.config, body.expectedRevision) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/history", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.api.history() }, successHeaders(scope.requestId));
    }),
    adminRoute("DELETE", "/admin/api/v1/history", "admin-json-object", async (request, scope) => {
      const session = requireSession(dependencies.auth, request.headers);
      requireMutationSecurity(request, dependencies.auth, session, origin);
      const body = checked(ExpectedRevisionSchema, request.adminBody);
      return json(200, { data: dependencies.api.clearHistory(body.expectedRevision) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/events", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      return json(200, { data: dependencies.api.events(parseEventQuery(request.url)) }, successHeaders(scope.requestId));
    }),
    adminRoute("GET", "/admin/api/v1/events/stream", "none", async (request, scope) => {
      requireSession(dependencies.auth, request.headers);
      const response = eventHub.open(request.headers.get("last-event-id"));
      response.headers.set("x-request-id", scope.requestId);
      return response;
    }),
  ];
}

type AdminEndpoint = (request: Readonly<DecodedHttpRequest>, scope: Readonly<RequestScope>) => Promise<Response> | Response;

function adminRoute(
  method: RouteRegistration["method"],
  path: string,
  body: RouteRegistration["body"],
  endpoint: AdminEndpoint,
): RouteRegistration {
  return {
    method,
    path,
    admission: "none",
    body,
    presentFailure: adminFailureFromGateway,
    endpoint: async (request, scope) => {
      try {
        return await endpoint(request, scope);
      } catch (error: unknown) {
        return adminFailure(mapRouteError(error), scope.requestId);
      }
    },
  };
}

function adminFailureFromGateway(failure: Readonly<GatewayFailure>, requestId: string): Response {
  if (
    failure.kind === "invalid_request"
    || failure.kind === "body_too_large"
    || failure.kind === "unsupported_media_type"
  ) {
    return adminFailure(new AdminApiError("validation_failed", "validation failed"), requestId);
  }
  return adminFailure(new AdminApiError("internal_error", "internal error"), requestId);
}

function mapRouteError(error: unknown): AdminApiError {
  if (error instanceof AdminAuthError) {
    return new AdminApiError(error.code === "capacity" ? "capacity_exceeded" : error.code === "unauthenticated" ? "unauthenticated" : "forbidden", error.code === "capacity" ? "capacity exceeded" : error.code === "unauthenticated" ? "unauthenticated" : "forbidden");
  }
  return mapAdminError(error);
}

function adminFailure(error: AdminApiError, requestId: string): Response {
  const status = statusFor(error.code);
  return json(status, {
    error: {
      code: error.code,
      message: messageFor(error.code),
      requestId,
    },
  }, successHeaders(requestId));
}

function statusFor(code: AdminApiError["code"]): number {
  if (code === "validation_failed") {
    return 400;
  }
  if (code === "unauthenticated") {
    return 401;
  }
  if (code === "forbidden") {
    return 403;
  }
  if (code === "not_found") {
    return 404;
  }
  if (code === "revision_conflict") {
    return 409;
  }
  if (code === "capacity_exceeded") {
    return 503;
  }
  return 500;
}

function messageFor(code: AdminApiError["code"]): string {
  return code.replaceAll("_", " ");
}

function successHeaders(requestId: string): Headers {
  return new Headers({ ...JSON_HEADERS, "x-request-id": requestId });
}

function json(status: number, body: unknown, headers: Headers): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function checked<TSchemaValue extends TSchema>(schema: TSchemaValue, value: unknown): Static<TSchemaValue> {
  if (!Value.Check(schema, value)) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return structuredClone(value) as Static<TSchemaValue>;
}

function requireSession(auth: AdminAuth, headers: Headers) {
  return auth.requireSession(readSessionCookie(headers));
}

function requireMutationSecurity(
  request: Readonly<DecodedHttpRequest>,
  auth: AdminAuth,
  session: ReturnType<AdminAuth["requireSession"]>,
  origin: string,
): void {
  requireExactOrigin(request.headers, origin);
  const csrf = request.headers.get("x-ghcg-csrf");
  if (csrf === null) {
    throw new AdminApiError("forbidden", "forbidden");
  }
  try {
    auth.requireCsrf(session, csrf);
  } catch {
    throw new AdminApiError("forbidden", "forbidden");
  }
}

function requireExactOrigin(headers: Headers, expected: string): void {
  if (headers.get("origin") !== expected) {
    throw new AdminApiError("forbidden", "forbidden");
  }
}

function pathTail(pathname: string): string {
  const tail = pathname.split("/").at(-1);
  if (tail === undefined || tail.length === 0) {
    throw new AdminApiError("not_found", "not found");
  }
  try {
    return decodeURIComponent(tail);
  } catch {
    throw new AdminApiError("validation_failed", "validation failed");
  }
}

function singleOptionalQuery(url: URL, allowed: ReadonlySet<string>, key: string): string | null {
  rejectUnknownQuery(url, allowed);
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return values[0] ?? null;
}

function parseUsageQuery(url: URL, nowMs: number): AdminUsageQuery {
  rejectUnknownQuery(url, new Set(["from", "to", "limit", "cursor", "accountId", "protocol", "resolvedModel", "outcome"]));
  const fromMs = parseOptionalUtc(url, "from") ?? nowMs - 24 * 60 * 60_000;
  const toMs = parseOptionalUtc(url, "to") ?? nowMs;
  if (fromMs >= toMs || fromMs < nowMs - 90 * 24 * 60 * 60_000 || toMs > nowMs + 60_000) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  const protocol = parseSet(url, "protocol", USAGE_PROTOCOLS);
  const outcome = parseSet(url, "outcome", USAGE_OUTCOMES);
  const accountId = nonempty(url, "accountId");
  const resolvedModel = nonempty(url, "resolvedModel");
  let result: AdminUsageQuery = {
    fromMs,
    toMs,
    limit: parseLimit(url),
    cursor: parseCursor(url),
  };
  if (accountId !== null) {
    result = { ...result, accountId };
  }
  if (protocol !== null) {
    result = { ...result, protocol: protocol as AdminUsageQuery["protocol"] };
  }
  if (resolvedModel !== null) {
    result = { ...result, resolvedModel };
  }
  if (outcome !== null) {
    result = { ...result, outcome: outcome as AdminUsageQuery["outcome"] };
  }
  return result;
}

function parseEventQuery(url: URL): AdminEventQuery {
  rejectUnknownQuery(url, new Set(["from", "to", "limit", "cursor", "kind", "severity"]));
  const kind = parseSet(url, "kind", EVENT_KINDS);
  const severity = parseSet(url, "severity", EVENT_SEVERITIES);
  return {
    fromMs: parseOptionalUtc(url, "from"),
    toMs: parseOptionalUtc(url, "to"),
    limit: parseLimit(url),
    cursor: parseCursor(url),
    ...(kind === null ? {} : { kind }),
    ...(severity === null ? {} : { severity: severity as "info" | "warning" | "error" }),
  };
}

function rejectUnknownQuery(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new AdminApiError("validation_failed", "validation failed");
    }
  }
}

function parseOptionalUtc(url: URL, key: string): number | null {
  const value = singleQueryValue(url, key);
  if (value === null) {
    return null;
  }
  if (!value.endsWith("Z")) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return parsed;
}

function parseLimit(url: URL): number {
  const value = singleQueryValue(url, "limit");
  if (value === null) {
    return 100;
  }
  if (!/^[0-9]+$/u.test(value)) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > 500) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return parsed;
}

function parseCursor(url: URL): string | null {
  const value = singleQueryValue(url, "cursor");
  if (value === null) {
    return null;
  }
  if (value.length === 0 || value.length > 1024) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return value;
}

function parseSet(url: URL, key: string, allowed: ReadonlySet<string>): string | null {
  const value = singleQueryValue(url, key);
  if (value === null) {
    return null;
  }
  if (!allowed.has(value)) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return value;
}

function nonempty(url: URL, key: string): string | null {
  const value = singleQueryValue(url, key);
  if (value === null) {
    return null;
  }
  if (value.length === 0) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return value;
}

function singleQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return values[0] ?? null;
}
