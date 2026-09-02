import type Database from "better-sqlite3";
import { AccountDirectoryError, type AccountDirectory, type AccountSummary } from "../accounts/account_directory.js";
import { DeviceFlowError, type DeviceFlowService } from "../accounts/device_flow.js";
import { PreferenceRevisionError, type AccountModelPreferences, type ModelPreference } from "../accounts/model_preferences.js";
import type { CatalogSnapshot, CopilotModelCatalog } from "../copilot/model_catalog.js";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import { RuntimeConfigError, type RuntimeConfigStore } from "../config/runtime_config.js";
import type { AdmissionController } from "../gateway/admission.js";
import type { ResponsesHistoryAdmin } from "../protocols/responses/history.js";
import { ResponsesHistoryAdminError } from "../protocols/responses/history.js";
import {
  EVENT_ROW_CAP,
  type TelemetryOutcome,
  type TelemetryProtocol,
  type TelemetryRecorder,
} from "../telemetry/recorder.js";
import type { PerformanceSnapshot } from "../telemetry/performance.js";
import { THRESHOLDS } from "../telemetry/performance.js";
import { VERSION } from "../version.js";
import { iso } from "./auth.js";

export class AdminApiError extends Error {
  readonly code:
    | "validation_failed"
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "revision_conflict"
    | "capacity_exceeded"
    | "internal_error";

  constructor(code: AdminApiError["code"], message: string) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
  }
}

export interface AdminStatus {
  readonly version: string;
  readonly uptimeMs: number;
  readonly health: "ok";
  readonly performance: "healthy" | "degraded";
  readonly degradedSince?: string;
  readonly performanceMetrics: readonly AdminPerformanceMetric[];
  readonly admission: {
    readonly activeRequests: number;
    readonly activeStreams: number;
    readonly queuedRequests: number;
    readonly activeMax: number;
    readonly queueMax: number;
  };
  readonly storage: { readonly historyCount: number; readonly usageBucketCount: number; readonly eventCount: number };
  readonly telemetry: {
    readonly pendingMutations: number;
    readonly droppedUsageUpdates: number;
    readonly droppedOperationalEvents: number;
  };
  readonly daemon: { readonly managed: boolean; readonly pid?: number; readonly startedAt?: string };
}

export interface AdminPerformanceMetric {
  readonly metric: "buffered_p95_ms" | "stream_event_p95_ms" | "checkpoint_p95_ms" | "event_loop_p95_ms";
  readonly state: "healthy" | "degraded" | "insufficient_data";
  readonly actual: number | null;
  readonly threshold: number;
  readonly samples: number;
  readonly startedAt: string | null;
}

export interface AdminAccount {
  readonly accountId: string;
  readonly host: string;
  readonly numericUserId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly state: "active" | "removing" | "removed";
  readonly revision: number;
  readonly authenticatedAt: string | null;
  readonly preferredModel: {
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
  } | null;
}

export interface AdminAccounts {
  readonly defaultRevision: number;
  readonly defaultAccountId: string | null;
  readonly items: readonly AdminAccount[];
}

export interface AdminModels {
  readonly accountId: string;
  readonly catalogGeneration: number;
  readonly fetchedAt: string;
  readonly preferredModel: {
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
  } | null;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly maxInputTokens: number | null;
    readonly maxOutputTokens: number | null;
  }[];
}

export interface AdminUsageBucket {
  readonly utcHour: string;
  readonly accountId: string;
  readonly protocol: TelemetryProtocol;
  readonly resolvedModel: string;
  readonly outcome: TelemetryOutcome;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly latencySumMs: number;
  readonly latencyMaxMs: number;
}

export interface AdminUsageTotals {
  readonly requestCount: number;
  readonly errorCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly latencySumMs: number;
  readonly latencyMaxMs: number;
}

export interface AdminUsagePage {
  readonly items: readonly AdminUsageBucket[];
  readonly nextCursor: string | null;
  readonly totals: AdminUsageTotals;
}

export interface AdminOperationalEvent {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata: Record<string, string | number | boolean | null>;
}

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface AdminRuntimeConfig {
  readonly revision: number;
  readonly config: RuntimeConfigSnapshot;
  readonly ranges: Record<string, { readonly min: number; readonly max: number; readonly unit: string }>;
}

export interface AdminUsageQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
  readonly cursor: string | null;
  readonly accountId?: string | undefined;
  readonly protocol?: TelemetryProtocol | undefined;
  readonly resolvedModel?: string | undefined;
  readonly outcome?: TelemetryOutcome | undefined;
}

export interface AdminEventQuery {
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly limit: number;
  readonly cursor: string | null;
  readonly kind?: string | undefined;
  readonly severity?: "info" | "warning" | "error" | undefined;
}

export interface AdminTelemetryStore {
  usage(query: AdminUsageQuery): AdminUsagePage;
  events(query: AdminEventQuery): AdminPage<AdminOperationalEvent>;
  replayAfter(eventId: string, limit: number): { readonly found: boolean; readonly latestEventId: string | null; readonly items: readonly AdminOperationalEvent[] };
  storageCounts(): { readonly usageBucketCount: number; readonly eventCount: number };
}

export interface AdminDaemonStatus {
  readonly managed: boolean;
  readonly pid?: number;
  readonly startedAtMs?: number;
}

export interface AdminApiDependencies {
  readonly directory: AccountDirectory;
  readonly deviceFlows: DeviceFlowService;
  readonly catalog: CopilotModelCatalog;
  readonly preferences: AccountModelPreferences;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly history: ResponsesHistoryAdmin;
  readonly telemetry: AdminTelemetryStore;
  readonly usageRecorder?: Pick<TelemetryRecorder, "pendingCount" | "droppedCounters">;
  readonly admission?: AdmissionController;
  readonly activeStreams?: () => number;
  readonly performance?: () => PerformanceSnapshot;
  readonly daemon?: () => AdminDaemonStatus;
  readonly nowMs?: () => number;
  readonly version?: string;
}

export class DefaultAdminManagementApi {
  private readonly nowMs: () => number;

  constructor(private readonly dependencies: AdminApiDependencies) {
    this.nowMs = dependencies.nowMs ?? Date.now;
  }

  status(): AdminStatus {
    const performance = this.dependencies.performance?.() ?? healthyPerformance();
    const admission = this.dependencies.admission;
    const storage = this.dependencies.telemetry.storageCounts();
    const history = this.dependencies.history.inspect();
    const dropped = this.dependencies.usageRecorder?.droppedCounters() ?? {
      droppedUsageUpdates: 0,
      droppedOperationalEvents: 0,
    };
    const daemon = this.dependencies.daemon?.() ?? { managed: false };
    return {
      version: this.dependencies.version ?? VERSION,
      uptimeMs: Math.max(0, this.nowMs() - processStartMs),
      health: "ok",
      performance: performance.status,
      ...(performance.startedAtMs === null ? {} : { degradedSince: iso(performance.startedAtMs) ?? "" }),
      performanceMetrics: performanceMetrics(performance),
      admission: {
        activeRequests: admission?.activeCount ?? 0,
        activeStreams: this.dependencies.activeStreams?.() ?? 0,
        queuedRequests: admission?.queuedCount ?? 0,
        activeMax: this.dependencies.runtimeConfig.readSnapshot().admission.activeMax,
        queueMax: this.dependencies.runtimeConfig.readSnapshot().admission.queueMax,
      },
      storage: {
        historyCount: history.count,
        usageBucketCount: storage.usageBucketCount,
        eventCount: storage.eventCount,
      },
      telemetry: {
        pendingMutations: this.dependencies.usageRecorder?.pendingCount() ?? 0,
        droppedUsageUpdates: dropped.droppedUsageUpdates,
        droppedOperationalEvents: dropped.droppedOperationalEvents,
      },
      daemon: {
        managed: daemon.managed,
        ...(daemon.pid === undefined ? {} : { pid: daemon.pid }),
        ...(daemon.startedAtMs === undefined ? {} : { startedAt: iso(daemon.startedAtMs) ?? "" }),
      },
    };
  }

  accounts(): AdminAccounts {
    const defaultState = this.dependencies.directory.defaultState();
    return {
      defaultRevision: defaultState.defaultRevision,
      defaultAccountId: defaultState.defaultAccountId,
      items: this.dependencies.directory.list().map((account) => this.account(account)),
    };
  }

  async startDeviceFlow(host: string): Promise<{
    readonly flowId: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: string;
    readonly pollIntervalSeconds: number;
  }> {
    try {
      const flow = await this.dependencies.deviceFlows.start(host);
      return {
        flowId: flow.flowId,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresAt: iso(flow.expiresAtMs) ?? "",
        pollIntervalSeconds: flow.pollIntervalSeconds,
      };
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  async pollDeviceFlow(flowId: string): Promise<
    | { readonly state: "pending" }
    | { readonly state: "complete"; readonly account: AdminAccount }
    | { readonly state: "expired" }
    | { readonly state: "failed" }
  > {
    try {
      const result = await this.dependencies.deviceFlows.poll(flowId);
      if (result.status === "pending") {
        return { state: "pending" };
      }
      if (result.status === "failed") {
        return { state: "failed" };
      }
      if (result.status === "expired") {
        return { state: "expired" };
      }
      const account = this.requireAccountSummary(result.accountId);
      return { state: "complete", account: this.account(account) };
    } catch (error: unknown) {
      if (error instanceof DeviceFlowError && error.code === "expired") {
        return { state: "expired" };
      }
      throw mapAdminError(error);
    }
  }

  async removeAccount(accountId: string, expectedRevision: number): Promise<AdminAccount> {
    try {
      const removed = await this.dependencies.directory.remove(accountId, expectedRevision);
      return this.account(removed);
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  useDefaultAccount(accountId: string, expectedRevision: number): AdminAccounts {
    try {
      this.dependencies.directory.use(accountId, expectedRevision);
      return this.accounts();
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  async models(accountId: string | null): Promise<AdminModels> {
    const resolvedAccountId = accountId ?? await this.defaultAccountId();
    const account = this.requireAccountSummary(resolvedAccountId);
    if (account.state !== "active") {
      throw new AdminApiError("not_found", "not found");
    }
    const catalog = await this.dependencies.catalog.get(resolvedAccountId, new AbortController().signal);
    this.dependencies.preferences.markInvalidIfMissing(
      resolvedAccountId,
      new Set(catalog.models.map((model) => model.id)),
      catalog.generation,
    );
    return this.modelsDto(catalog);
  }

  async refreshModels(accountId: string): Promise<AdminModels> {
    this.requireAccountSummary(accountId);
    this.dependencies.catalog.invalidate(accountId);
    return await this.models(accountId);
  }

  async setPreferredModel(accountId: string, modelId: string, expectedRevision: number): Promise<{
    readonly accountId: string;
    readonly preferredModel: NonNullable<AdminAccount["preferredModel"]>;
  }> {
    try {
      const catalog = await this.dependencies.catalog.get(accountId, new AbortController().signal);
      if (!catalog.models.some((model) => model.id === modelId)) {
        throw new AdminApiError("not_found", "not found");
      }
      const preference = this.dependencies.preferences.set(accountId, {
        modelId,
        catalogGeneration: catalog.generation,
      }, expectedRevision);
      return {
        accountId,
        preferredModel: preferenceDto(preference),
      };
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  runtimeConfig(): AdminRuntimeConfig {
    return {
      revision: this.dependencies.runtimeConfig.readRevision(),
      config: this.dependencies.runtimeConfig.readSnapshot(),
      ranges: runtimeConfigRanges(),
    };
  }

  updateRuntimeConfig(config: RuntimeConfigSnapshot, expectedRevision: number): AdminRuntimeConfig {
    try {
      this.dependencies.runtimeConfig.update(config, expectedRevision);
      return this.runtimeConfig();
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  history(): {
    readonly revision: number;
    readonly count: number;
    readonly oldestAt: string | null;
    readonly newestAt: string | null;
    readonly ttlDays: number;
    readonly maxResponses: number;
    } {
    const inspection = this.dependencies.history.inspect();
    return {
      revision: inspection.revision,
      count: inspection.count,
      oldestAt: iso(inspection.oldestAt),
      newestAt: iso(inspection.newestAt),
      ttlDays: inspection.ttlDays,
      maxResponses: inspection.maxResponses,
    };
  }

  clearHistory(expectedRevision: number): ReturnType<DefaultAdminManagementApi["history"]> {
    try {
      this.dependencies.history.clear(expectedRevision);
      return this.history();
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  usage(query: AdminUsageQuery): AdminUsagePage {
    return this.dependencies.telemetry.usage(query);
  }

  events(query: AdminEventQuery): AdminPage<AdminOperationalEvent> {
    return this.dependencies.telemetry.events(query);
  }

  replayAfter(eventId: string, limit: number): { readonly found: boolean; readonly latestEventId: string | null; readonly items: readonly AdminOperationalEvent[] } {
    return this.dependencies.telemetry.replayAfter(eventId, limit);
  }

  private account(summary: AccountSummary): AdminAccount {
    const preferred = this.dependencies.preferences.get(summary.accountId);
    return {
      accountId: summary.accountId,
      host: summary.host,
      numericUserId: summary.userId,
      login: summary.login,
      displayName: summary.displayName,
      state: summary.state,
      revision: summary.revision,
      authenticatedAt: iso(summary.authenticatedAtMs),
      preferredModel: preferred === null ? null : preferenceDto(preferred),
    };
  }

  private modelsDto(catalog: CatalogSnapshot): AdminModels {
    const preferred = this.dependencies.preferences.get(catalog.accountId);
    return {
      accountId: catalog.accountId,
      catalogGeneration: catalog.generation,
      fetchedAt: catalog.fetchedAt,
      preferredModel: preferred === null ? null : preferenceDto(preferred),
      items: catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        maxInputTokens: null,
        maxOutputTokens: null,
      })),
    };
  }

  private async defaultAccountId(): Promise<string> {
    try {
      const bound = await this.dependencies.directory.bindDefault();
      return bound.accountId;
    } catch (error: unknown) {
      throw mapAdminError(error);
    }
  }

  private requireAccountSummary(accountId: string): AccountSummary {
    const account = this.dependencies.directory.list().find((item) => item.accountId === accountId);
    if (account === undefined) {
      throw new AdminApiError("not_found", "not found");
    }
    return account;
  }
}

export class SqliteAdminTelemetry implements AdminTelemetryStore {
  constructor(private readonly database: Database.Database) {}

  usage(query: AdminUsageQuery): AdminUsagePage {
    const cursor = query.cursor === null ? null : decodeUsageCursor(query.cursor);
    const where: string[] = ["utc_hour_ms >= ?", "utc_hour_ms < ?"];
    const params: Array<string | number> = [query.fromMs, query.toMs];
    addFilter(where, params, "account_id", query.accountId);
    addFilter(where, params, "protocol", query.protocol);
    addFilter(where, params, "resolved_model", query.resolvedModel);
    addFilter(where, params, "outcome", query.outcome);
    if (cursor !== null) {
      where.push("(utc_hour_ms, account_id, protocol, resolved_model, outcome) > (?, ?, ?, ?, ?)");
      params.push(cursor.utcHourMs, cursor.accountId, cursor.protocol, cursor.resolvedModel, cursor.outcome);
    }
    const rows = this.database.prepare(
      `SELECT utc_hour_ms, account_id, protocol, resolved_model, outcome,
              request_count, error_count, input_tokens, output_tokens, cache_tokens,
              latency_sum_ms, latency_max_ms
       FROM usage_buckets
       WHERE ${where.join(" AND ")}
       ORDER BY utc_hour_ms, account_id, protocol, resolved_model, outcome
       LIMIT ?`,
    ).all(...params, query.limit + 1) as UsageRow[];
    const pageRows = rows.slice(0, query.limit);
    const items = pageRows.map(usageRowDto);
    const next = rows.length > query.limit ? pageRows.at(-1) : undefined;
    const totals = this.database.prepare(
      `SELECT
         COALESCE(SUM(request_count), 0) AS request_count,
         COALESCE(SUM(error_count), 0) AS error_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_tokens), 0) AS cache_tokens,
         COALESCE(SUM(latency_sum_ms), 0) AS latency_sum_ms,
         COALESCE(MAX(latency_max_ms), 0) AS latency_max_ms
       FROM usage_buckets
       WHERE ${whereWithoutCursor(where).join(" AND ")}`,
    ).get(...paramsWithoutCursor(params, cursor)) as UsageTotalsRow;
    return {
      items,
      nextCursor: next === undefined ? null : encodeUsageCursor(next),
      totals: {
        requestCount: totals.request_count,
        errorCount: totals.error_count,
        inputTokens: totals.input_tokens,
        outputTokens: totals.output_tokens,
        cacheTokens: totals.cache_tokens,
        latencySumMs: totals.latency_sum_ms,
        latencyMaxMs: totals.latency_max_ms,
      },
    };
  }

  events(query: AdminEventQuery): AdminPage<AdminOperationalEvent> {
    const cursor = query.cursor === null ? null : decodeEventCursor(query.cursor);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.fromMs !== null) {
      where.push("occurred_at_ms >= ?");
      params.push(query.fromMs);
    }
    if (query.toMs !== null) {
      where.push("occurred_at_ms < ?");
      params.push(query.toMs);
    }
    addFilter(where, params, "kind", query.kind);
    addFilter(where, params, "severity", query.severity);
    if (cursor !== null) {
      where.push("event_id > ?");
      params.push(cursor);
    }
    const clause = where.length === 0 ? "1 = 1" : where.join(" AND ");
    const rows = this.database.prepare(
      `SELECT event_id, occurred_at_ms, kind, severity, metadata_json
       FROM operational_events
       WHERE ${clause}
       ORDER BY event_id
       LIMIT ?`,
    ).all(...params, Math.min(query.limit, EVENT_ROW_CAP) + 1) as EventRow[];
    const pageRows = rows.slice(0, Math.min(query.limit, EVENT_ROW_CAP));
    return {
      items: pageRows.map(eventRowDto),
      nextCursor: rows.length > pageRows.length && pageRows.at(-1) !== undefined
        ? encodeEventCursor(String(pageRows.at(-1)?.event_id))
        : null,
    };
  }

  replayAfter(eventId: string, limit: number): { readonly found: boolean; readonly latestEventId: string | null; readonly items: readonly AdminOperationalEvent[] } {
    const numeric = decimalEventId(eventId);
    const latest = this.latestEventId();
    const found = this.database.prepare("SELECT event_id FROM operational_events WHERE event_id = ?").get(numeric) !== undefined;
    if (!found) {
      return { found: false, latestEventId: latest, items: [] };
    }
    const rows = this.database.prepare(
      `SELECT event_id, occurred_at_ms, kind, severity, metadata_json
       FROM operational_events
       WHERE event_id > ?
       ORDER BY event_id
       LIMIT ?`,
    ).all(numeric, limit) as EventRow[];
    return { found: true, latestEventId: latest, items: rows.map(eventRowDto) };
  }

  storageCounts(): { readonly usageBucketCount: number; readonly eventCount: number } {
    const usage = this.database.prepare("SELECT COUNT(*) AS count FROM usage_buckets").get() as { count: number };
    const events = this.database.prepare("SELECT COUNT(*) AS count FROM operational_events").get() as { count: number };
    return { usageBucketCount: usage.count, eventCount: events.count };
  }

  private latestEventId(): string | null {
    const row = this.database.prepare("SELECT MAX(event_id) AS event_id FROM operational_events").get() as { event_id: number | null };
    return row.event_id === null ? null : String(row.event_id);
  }
}

export function mapAdminError(error: unknown): AdminApiError {
  if (error instanceof AdminApiError) {
    return error;
  }
  if (error instanceof AccountDirectoryError) {
    if (error.code === "revision_conflict") {
      return new AdminApiError("revision_conflict", "revision conflict");
    }
    if (error.code === "capacity") {
      return new AdminApiError("capacity_exceeded", "capacity exceeded");
    }
    if (error.code === "no_default") {
      return new AdminApiError("not_found", "not found");
    }
    return new AdminApiError("not_found", "not found");
  }
  if (error instanceof DeviceFlowError) {
    if (error.code === "capacity") {
      return new AdminApiError("capacity_exceeded", "capacity exceeded");
    }
    if (error.code === "expired") {
      return new AdminApiError("not_found", "not found");
    }
    return new AdminApiError("not_found", "not found");
  }
  if (error instanceof PreferenceRevisionError || error instanceof ResponsesHistoryAdminError) {
    return new AdminApiError("revision_conflict", "revision conflict");
  }
  if (error instanceof RuntimeConfigError) {
    return new AdminApiError(error.code === "revision_conflict" ? "revision_conflict" : "validation_failed", error.code === "revision_conflict" ? "revision conflict" : "validation failed");
  }
  return new AdminApiError("internal_error", "internal error");
}

export function runtimeConfigRanges(): Record<string, { readonly min: number; readonly max: number; readonly unit: string }> {
  return {
    "limits.requestBodyBytes": { min: 1_048_576, max: 67_108_864, unit: "bytes" },
    "limits.sseEventBytes": { min: 65_536, max: 16_777_216, unit: "bytes" },
    "limits.nonstreamBodyBytes": { min: 1_048_576, max: 134_217_728, unit: "bytes" },
    "limits.accumulatorBytes": { min: 1_048_576, max: 134_217_728, unit: "bytes" },
    "admission.activeMax": { min: 1, max: 16, unit: "count" },
    "admission.queueMax": { min: 0, max: 64, unit: "count" },
    "timeouts.queueMs": { min: 1_000, max: 300_000, unit: "ms" },
    "timeouts.connectMs": { min: 1_000, max: 120_000, unit: "ms" },
    "timeouts.firstByteMs": { min: 5_000, max: 600_000, unit: "ms" },
    "timeouts.streamIdleMs": { min: 5_000, max: 600_000, unit: "ms" },
    "timeouts.totalMs": { min: 60_000, max: 7_200_000, unit: "ms" },
    "accounts.maxAuthenticated": { min: 1, max: 32, unit: "count" },
    "history.ttlDays": { min: 1, max: 365, unit: "days" },
    "usage.retentionDays": { min: 1, max: 365, unit: "days" },
    "events.retentionDays": { min: 1, max: 30, unit: "days" },
  };
}

function performanceMetrics(snapshot: PerformanceSnapshot): readonly AdminPerformanceMetric[] {
  const startedAt = iso(snapshot.startedAtMs);
  return [
    metric("buffered_p95_ms", snapshot.metrics.bufferedMs, THRESHOLDS.bufferedMs, startedAt),
    metric("stream_event_p95_ms", snapshot.metrics.eventMs, THRESHOLDS.eventMs, startedAt),
    metric("checkpoint_p95_ms", snapshot.metrics.checkpointMs, THRESHOLDS.checkpointMs, startedAt),
    metric("event_loop_p95_ms", snapshot.metrics.eventLoopMs, THRESHOLDS.eventLoopMs, startedAt),
  ];
}

function metric(
  name: AdminPerformanceMetric["metric"],
  input: { readonly p95: number | null; readonly status: "healthy" | "over" | "insufficient_data" },
  threshold: number,
  startedAt: string | null,
): AdminPerformanceMetric {
  return {
    metric: name,
    state: input.status === "over" ? "degraded" : input.status,
    actual: input.p95,
    threshold,
    samples: input.p95 === null ? 0 : 1,
    startedAt,
  };
}

function healthyPerformance(): PerformanceSnapshot {
  return {
    status: "healthy",
    startedAtMs: null,
    metrics: {
      bufferedMs: { p95: null, status: "insufficient_data" },
      eventMs: { p95: null, status: "insufficient_data" },
      checkpointMs: { p95: null, status: "insufficient_data" },
      eventLoopMs: { p95: null, status: "insufficient_data" },
    },
  };
}

function preferenceDto(preference: ModelPreference): NonNullable<AdminAccount["preferredModel"]> {
  return {
    revision: preference.revision,
    modelId: preference.modelId,
    validity: preference.validity,
  };
}

interface UsageRow {
  readonly utc_hour_ms: number;
  readonly account_id: string;
  readonly protocol: TelemetryProtocol;
  readonly resolved_model: string;
  readonly outcome: TelemetryOutcome;
  readonly request_count: number;
  readonly error_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_tokens: number;
  readonly latency_sum_ms: number;
  readonly latency_max_ms: number;
}

interface UsageTotalsRow {
  readonly request_count: number;
  readonly error_count: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_tokens: number;
  readonly latency_sum_ms: number;
  readonly latency_max_ms: number;
}

interface EventRow {
  readonly event_id: number;
  readonly occurred_at_ms: number;
  readonly kind: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata_json: string;
}

function usageRowDto(row: UsageRow): AdminUsageBucket {
  return {
    utcHour: iso(row.utc_hour_ms) ?? "",
    accountId: row.account_id,
    protocol: row.protocol,
    resolvedModel: row.resolved_model,
    outcome: row.outcome,
    requestCount: row.request_count,
    errorCount: row.error_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    latencySumMs: row.latency_sum_ms,
    latencyMaxMs: row.latency_max_ms,
  };
}

function eventRowDto(row: EventRow): AdminOperationalEvent {
  return {
    eventId: String(row.event_id),
    occurredAt: iso(row.occurred_at_ms) ?? "",
    kind: row.kind,
    severity: row.severity,
    metadata: parseMetadata(row.metadata_json),
  };
}

function parseMetadata(json: string): Record<string, string | number | boolean | null> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function addFilter(where: string[], params: Array<string | number>, column: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  where.push(`${column} = ?`);
  params.push(value);
}

interface UsageCursor {
  readonly utcHourMs: number;
  readonly accountId: string;
  readonly protocol: TelemetryProtocol;
  readonly resolvedModel: string;
  readonly outcome: TelemetryOutcome;
}

function encodeUsageCursor(row: UsageRow): string {
  return Buffer.from(JSON.stringify([
    row.utc_hour_ms,
    row.account_id,
    row.protocol,
    row.resolved_model,
    row.outcome,
  ]), "utf8").toString("base64url");
}

function decodeUsageCursor(cursor: string): UsageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 5) {
      throw new Error("bad cursor");
    }
    const [utcHourMs, accountId, protocol, resolvedModel, outcome] = parsed;
    if (typeof utcHourMs !== "number" || typeof accountId !== "string" || typeof protocol !== "string" || typeof resolvedModel !== "string" || typeof outcome !== "string") {
      throw new Error("bad cursor");
    }
    return { utcHourMs, accountId, protocol: protocol as TelemetryProtocol, resolvedModel, outcome: outcome as TelemetryOutcome };
  } catch {
    throw new AdminApiError("validation_failed", "validation failed");
  }
}

function encodeEventCursor(eventId: string): string {
  return Buffer.from(eventId, "utf8").toString("base64url");
}

function decodeEventCursor(cursor: string): number {
  try {
    return decimalEventId(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new AdminApiError("validation_failed", "validation failed");
  }
}

function decimalEventId(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new AdminApiError("validation_failed", "validation failed");
  }
  return parsed;
}

function whereWithoutCursor(where: readonly string[]): readonly string[] {
  return where.filter((clause) => !clause.startsWith("(utc_hour_ms,"));
}

function paramsWithoutCursor(params: readonly (string | number)[], cursor: UsageCursor | null): readonly (string | number)[] {
  if (cursor === null) {
    return params;
  }
  return params.slice(0, -5);
}

const processStartMs = Date.now();
