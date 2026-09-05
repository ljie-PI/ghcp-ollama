import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import {
  AdminTelemetryError,
  SqliteAdminTelemetry,
  type AdminMonitorEvent,
} from "../../src/telemetry/admin.js";
import { MIN_OBSERVATIONS, PerformanceWindows } from "../../src/telemetry/performance.js";
import { TelemetryRecorder, type UsageUpdate } from "../../src/telemetry/recorder.js";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    closeDatabase(database);
  }
});

async function database(): Promise<ReturnType<typeof openDatabase>> {
  const directory = await mkdtemp(path.join(tmpdir(), "ghc-gateway-admin-telemetry-"));
  const result = openDatabase({
    path: path.join(directory, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(telemetryMigration)],
    nowMs: () => NOW,
  });
  databases.push(result);
  return result;
}

function usage(overrides: Partial<UsageUpdate> = {}): UsageUpdate {
  return {
    occurredAtMs: NOW,
    accountId: "github.com/1",
    protocol: "openai_chat",
    resolvedModel: "gpt-4.1",
    outcome: "success",
    requestCount: 1,
    errorCount: 0,
    inputTokens: 10,
    outputTokens: 5,
    cacheTokens: 2,
    latencyMs: 4,
    ...overrides,
  };
}

describe("AdminTelemetry", () => {
  it("queries usage through strict opaque cursors and totals the complete filtered range", async () => {
    const db = await database();
    const recorder = new TelemetryRecorder(db, () => NOW);
    recorder.recordUsage(usage({ occurredAtMs: NOW - 2 * HOUR, requestCount: 2, inputTokens: 20 }));
    recorder.recordUsage(usage({ occurredAtMs: NOW - HOUR, requestCount: 3, inputTokens: 30 }));
    recorder.recordUsage(usage({ accountId: "github.com/2", requestCount: 50, inputTokens: 500 }));
    await recorder.flush();
    const telemetry = new SqliteAdminTelemetry(db, { recorder });
    const signal = new AbortController().signal;
    const query = {
      fromMs: NOW - 3 * HOUR,
      toMs: NOW + HOUR,
      accountId: "github.com/1",
      limit: 1,
      cursor: null,
    } as const;

    const first = await telemetry.queryUsage(query, signal);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.totals).toEqual({
      requestCount: 5,
      errorCount: 0,
      inputTokens: 50,
      outputTokens: 10,
      cacheTokens: 4,
      latencySumMs: 8,
      latencyMaxMs: 4,
    });

    const second = await telemetry.queryUsage({ ...query, cursor: first.nextCursor }, signal);
    expect(second.items.map((item) => item.requestCount)).toEqual([3]);
    expect(second.nextCursor).toBeNull();
    await expect(telemetry.queryUsage({ ...query, cursor: `${first.nextCursor}=` }, signal))
      .rejects.toBeInstanceOf(AdminTelemetryError);
  });

  it("sanitizes persisted metadata per event kind and replays retained decimal event IDs", async () => {
    const db = await database();
    db.prepare(
      "INSERT INTO operational_events (occurred_at_ms, kind, severity, metadata_json) VALUES (?, ?, ?, ?)",
    ).run(NOW - 2, "request_failed", "warning", JSON.stringify({
      requestId: "req_1",
      protocol: "openai_chat",
      category: "upstream_error",
      accountId: "wrong-kind-field",
      token: "gho_secret",
      nested: { prompt: "CANARY" },
    }));
    db.prepare(
      "INSERT INTO operational_events (occurred_at_ms, kind, severity, metadata_json) VALUES (?, ?, ?, ?)",
    ).run(NOW - 1, "account_removed", "info", JSON.stringify({
      accountId: "github.com/1",
      requestId: "wrong-kind-field",
      login: "private-login",
    }));
    const telemetry = new SqliteAdminTelemetry(db);
    const signal = new AbortController().signal;

    const page = await telemetry.queryEvents({
      fromMs: null,
      toMs: null,
      limit: 1,
      cursor: null,
    }, signal);
    expect(page.items[0]?.metadata).toEqual({
      requestId: "req_1",
      protocol: "openai_chat",
      category: "upstream_error",
    });
    expect(JSON.stringify(page)).not.toContain("gho_secret");
    expect(JSON.stringify(page)).not.toContain("CANARY");

    const replay = await telemetry.replayEvents("1", signal);
    expect(replay.found).toBe(true);
    expect(replay.latestEventId).toBe("2");
    expect(replay.items).toHaveLength(1);
    expect(replay.items[0]?.metadata).toEqual({ accountId: "github.com/1" });
    await expect(telemetry.replayEvents("01", signal)).rejects.toBeInstanceOf(AdminTelemetryError);

    db.prepare(
      "INSERT INTO operational_events (occurred_at_ms, kind, severity, metadata_json) VALUES (?, ?, ?, ?)",
    ).run(NOW, "request_failed", "error", JSON.stringify({ protocol: "gho_secret", status: 999, category: "private" }));
    const unsafe = await telemetry.queryEvents({ fromMs: NOW, toMs: NOW + 1, limit: 1, cursor: null }, signal);
    expect(unsafe.items[0]?.metadata).toEqual({});
  });

  it("replays persisted events in bounded ascending batches", async () => {
    const db = await database();
    const insert = db.prepare(
      "INSERT INTO operational_events (occurred_at_ms, kind, severity, metadata_json) VALUES (?, ?, ?, ?)",
    );
    for (let index = 0; index < 130; index += 1) {
      insert.run(NOW + index, "gateway_started", "info", "{}");
    }
    const telemetry = new SqliteAdminTelemetry(db);
    const signal = new AbortController().signal;

    const first = await telemetry.replayEvents("1", signal);
    expect(first.latestEventId).toBe("130");
    expect(first.items).toHaveLength(32);
    expect(first.items[0]?.eventId).toBe("2");
    expect(first.items.at(-1)?.eventId).toBe("33");

    const second = await telemetry.replayEvents("129", signal);
    expect(second.items.map((event) => event.eventId)).toEqual(["130"]);
  });

  it("reports storage, drops, pending work, performance, and sanitized live transitions", async () => {
    const db = await database();
    const recorder = new TelemetryRecorder(db, () => NOW, 100, 512, 1, (event) => {
      telemetry.observeOperationalEvent(event);
    });
    const windows = new PerformanceWindows(() => NOW, (evaluation) => {
      telemetry.observePerformance(evaluation);
    });
    const telemetry = new SqliteAdminTelemetry(db, { recorder });
    const observed: AdminMonitorEvent[] = [];
    const unsubscribe = telemetry.subscribe((event) => observed.push(event));

    recorder.recordEvent({
      occurredAtMs: NOW,
      kind: "request_failed",
      severity: "warning",
      metadata: { requestId: "req_live", protocol: "openai_chat", category: "upstream_error", token: "gho_secret" },
    });
    recorder.recordUsage(usage({ requestCount: 7 }));
    expect(telemetry.snapshot().pendingMutations).toBe(1);
    expect(telemetry.snapshot().droppedUsageUpdates).toBe(7);
    await recorder.flush();

    for (let window = 0; window < 3; window += 1) {
      for (let sample = 0; sample < MIN_OBSERVATIONS; sample += 1) {
        windows.observeBuffered(20);
      }
      windows.evaluateWindow();
    }

    const snapshot = telemetry.snapshot();
    expect(snapshot.storage).toEqual({ usageBucketCount: 0, eventCount: 1 });
    expect(snapshot.pendingMutations).toBe(0);
    expect(snapshot.droppedUsageUpdates).toBe(7);
    expect(snapshot.droppedOperationalEvents).toBe(0);
    expect(snapshot.performance.status).toBe("degraded");
    expect(observed.map((event) => event.kind)).toEqual(["operational", "performance"]);
    expect(observed[0]).toMatchObject({
      kind: "operational",
      event: { metadata: { requestId: "req_live", protocol: "openai_chat", category: "upstream_error" } },
    });
    expect(JSON.stringify(observed)).not.toContain("gho_secret");

    const persisted = db.prepare("SELECT metadata_json FROM operational_events ORDER BY event_id LIMIT 1").get() as {
      metadata_json: string;
    };
    expect(persisted.metadata_json).toBe(JSON.stringify({ protocol: "openai_chat" }));

    unsubscribe();
    recorder.recordEvent({ occurredAtMs: NOW, kind: "gateway_started", severity: "info" });
    await recorder.flush();
    expect(observed).toHaveLength(2);
  });

  it("honors an already-aborted query signal", async () => {
    const db = await database();
    const telemetry = new SqliteAdminTelemetry(db);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(telemetry.queryEvents({
      fromMs: null,
      toMs: null,
      limit: 100,
      cursor: null,
    }, controller.signal)).rejects.toThrow("cancelled");
  });
});
