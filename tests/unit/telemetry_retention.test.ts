import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as telemetryMigration } from "../../src/persistence/migrations/020_telemetry.js";
import {
  floorToUtcHour,
  TelemetryRecorder,
  type UsageUpdate,
} from "../../src/telemetry/recorder.js";

const HOUR = 3_600_000;

function usage(partial: Partial<UsageUpdate> & Pick<UsageUpdate, "occurredAtMs" | "accountId">): UsageUpdate {
  return {
    protocol: "openai_chat",
    resolvedModel: "gpt",
    outcome: "success",
    requestCount: 1,
    errorCount: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheTokens: 0,
    latencyMs: 4,
    ...partial,
  };
}

async function recorder(now: () => number, usageRowCap = 5, eventRowCap = 3, queueCap = 8): Promise<{
  recorder: TelemetryRecorder;
  database: ReturnType<typeof openDatabase>;
  close: () => void;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-tel-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(telemetryMigration)],
    nowMs: now,
  });
  return {
    recorder: new TelemetryRecorder(database, now, usageRowCap, eventRowCap, queueCap),
    database,
    close: () => closeDatabase(database),
  };
}

describe("usage and events", () => {
  it("aggregates by UTC hour, account, protocol, model, and outcome", async () => {
    const now = (): number => 1_700_000_000_000;
    const { recorder: tel, database, close } = await recorder(now);
    try {
      tel.recordUsage(usage({ occurredAtMs: now(), accountId: "github.com/1", latencyMs: 3 }));
      tel.recordUsage(usage({ occurredAtMs: now() + 10, accountId: "github.com/1", latencyMs: 9 }));
      await tel.flush();
      const row = database.prepare("SELECT request_count, latency_sum_ms, latency_max_ms, utc_hour_ms FROM usage_buckets").get() as {
        request_count: number;
        latency_sum_ms: number;
        latency_max_ms: number;
        utc_hour_ms: number;
      };
      expect(row.request_count).toBe(2);
      expect(row.latency_sum_ms).toBe(12);
      expect(row.latency_max_ms).toBe(9);
      expect(row.utc_hour_ms).toBe(floorToUtcHour(now()));
    } finally {
      close();
    }
  });

  it("retains usage identity after account-shaped removal and caps rows deterministically", async () => {
    const now = 1_800_000_000_000;
    const { recorder: tel, database, close } = await recorder(() => now, 3, 3, 32);
    try {
      for (let index = 0; index < 5; index += 1) {
        tel.recordUsage(usage({
          occurredAtMs: now - index * HOUR,
          accountId: "github.com/1",
          resolvedModel: `m${index}`,
        }));
      }
      await tel.flush();
      expect((database.prepare("SELECT COUNT(*) AS count FROM usage_buckets").get() as { count: number }).count).toBe(3);
      const oldest = database.prepare("SELECT MIN(utc_hour_ms) AS hour FROM usage_buckets").get() as { hour: number };
      expect(oldest.hour).toBe(floorToUtcHour(now - 2 * HOUR));
    } finally {
      close();
    }
  });

  it("drops oversize metadata and denylists secrets/canaries", async () => {
    const now = (): number => 1_700_000_000_000;
    const { recorder: tel, database, close } = await recorder(now);
    try {
      tel.recordEvent({
        occurredAtMs: now(),
        kind: "gateway_started",
        severity: "info",
        metadata: {
          token: "gho_secret",
          prompt: "CANARY_PROMPT",
          requestId: "req_hidden",
          protocol: "openai_chat",
        },
      });
      tel.recordEvent({
        occurredAtMs: now(),
        kind: "runtime_config_changed",
        severity: "warning",
        metadata: { protocol: "x".repeat(20_000) },
      });
      await tel.flush();
      const rows = database.prepare("SELECT kind, metadata_json FROM operational_events ORDER BY event_id").all() as Array<{
        kind: string;
        metadata_json: string;
      }>;
      expect(rows[0]?.metadata_json).toContain("openai_chat");
      expect(rows[0]?.metadata_json).not.toContain("gho_secret");
      expect(rows[0]?.metadata_json).not.toContain("CANARY_PROMPT");
      expect(rows[0]?.metadata_json).not.toContain("req_hidden");
      expect(rows[1]?.kind).toBe("metadata_rejected");
    } finally {
      close();
    }
  });

  it("applies type-specific queue eviction and persisted drop counters", async () => {
    const now = (): number => 1_700_000_000_000;
    const { recorder: tel, close } = await recorder(now, 100, 100, 2);
    try {
      tel.recordUsage(usage({ occurredAtMs: now(), accountId: "github.com/1", requestCount: 4 }));
      tel.recordUsage(usage({ occurredAtMs: now(), accountId: "github.com/2", requestCount: 5 }));
      tel.recordUsage(usage({ occurredAtMs: now(), accountId: "github.com/3", requestCount: 6 }));
      tel.recordEvent({ occurredAtMs: now(), kind: "gateway_started", severity: "info" });
      expect(tel.pendingCount()).toBe(2);
      await tel.flush();
      const dropped = tel.droppedCounters();
      expect(dropped.droppedUsageUpdates).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("deletes usage older than 90 days and events older than 7 days", async () => {
    const now = 2_000_000_000_000;
    const { recorder: tel, database, close } = await recorder(() => now, 100, 512, 32);
    try {
      tel.recordUsage(usage({ occurredAtMs: now - 91 * 24 * 60 * 60 * 1000, accountId: "github.com/1" }));
      tel.recordUsage(usage({ occurredAtMs: now, accountId: "github.com/1", resolvedModel: "fresh" }));
      tel.recordEvent({ occurredAtMs: now - 8 * 24 * 60 * 60 * 1000, kind: "gateway_started", severity: "info" });
      tel.recordEvent({ occurredAtMs: now, kind: "runtime_config_changed", severity: "info" });
      await tel.flush();
      expect((database.prepare("SELECT COUNT(*) AS count FROM usage_buckets").get() as { count: number }).count).toBe(1);
      expect((database.prepare("SELECT COUNT(*) AS count FROM operational_events").get() as { count: number }).count).toBe(1);
    } finally {
      close();
    }
  });

  it("does not let usage evict events or events evict usage at 1024", async () => {
    const now = (): number => 1_700_000_000_000;
    const { recorder: tel, close } = await recorder(now, 1000, 1000, 1024);
    try {
      for (let index = 0; index < 1024; index += 1) {
        tel.recordEvent({ occurredAtMs: now(), kind: "gateway_started", severity: "info" });
      }
      tel.recordUsage(usage({ occurredAtMs: now(), accountId: "github.com/1", requestCount: 9 }));
      expect(tel.pendingCount()).toBe(1024);
      await tel.flush();
      expect(tel.droppedCounters().droppedUsageUpdates).toBe(9);
    } finally {
      close();
    }
  });
});
