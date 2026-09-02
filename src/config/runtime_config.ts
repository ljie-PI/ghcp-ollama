import type Database from "better-sqlite3";
import {
  defaultRuntimeConfigSnapshot,
  parseRuntimeConfigSnapshot,
  type RuntimeConfigSnapshot,
} from "./schema.js";

export class RuntimeConfigError extends Error {
  readonly code: "revision_conflict" | "invalid_config";

  constructor(code: RuntimeConfigError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeConfigError";
    this.code = code;
  }
}

export class RuntimeConfigStore {
  private snapshot: RuntimeConfigSnapshot;
  private revision: number;

  constructor(
    private readonly database: Database.Database,
    private readonly nowMs: () => number = Date.now,
  ) {
    const row = this.readRow();
    if (row === undefined) {
      this.snapshot = freezeSnapshot(defaultRuntimeConfigSnapshot());
      this.revision = 0;
      return;
    }
    this.snapshot = freezeSnapshot(parseRuntimeConfigSnapshot(JSON.parse(row.config_json) as unknown));
    this.revision = row.revision;
  }

  readSnapshot(): RuntimeConfigSnapshot {
    return this.snapshot;
  }

  readRevision(): number {
    return this.revision;
  }

  seedIfEmpty(env: NodeJS.ProcessEnv): RuntimeConfigSnapshot {
    if (this.readRow() !== undefined) {
      return this.snapshot;
    }
    const seeded = freezeSnapshot(parseRuntimeConfigSnapshot(overlayEnvironment(defaultRuntimeConfigSnapshot(), env)));
    this.writeRow(1, seeded);
    this.snapshot = seeded;
    this.revision = 1;
    return this.snapshot;
  }

  update(candidate: unknown, expectedRevision: number): RuntimeConfigSnapshot {
    let next: RuntimeConfigSnapshot;
    try {
      next = freezeSnapshot(parseRuntimeConfigSnapshot(candidate));
    } catch (error: unknown) {
      throw new RuntimeConfigError("invalid_config", "invalid runtime config", { cause: error });
    }

    const swap = this.database.transaction(() => {
      const row = this.readRow();
      const currentRevision = row?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new RuntimeConfigError("revision_conflict", "runtime config revision conflict");
      }
      this.writeRow(expectedRevision + 1, next);
    });

    try {
      swap();
    } catch (error: unknown) {
      if (error instanceof RuntimeConfigError) {
        throw error;
      }
      throw new RuntimeConfigError("invalid_config", "runtime config write failed", { cause: error });
    }

    this.snapshot = next;
    this.revision = expectedRevision + 1;
    return this.snapshot;
  }

  private readRow(): { revision: number; config_json: string } | undefined {
    return this.database.prepare(
      "SELECT revision, config_json FROM runtime_config WHERE singleton_id = 1",
    ).get() as { revision: number; config_json: string } | undefined;
  }

  private writeRow(revision: number, snapshot: RuntimeConfigSnapshot): void {
    this.database.prepare(
      `INSERT INTO runtime_config (singleton_id, revision, config_json, updated_at_ms)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         revision = excluded.revision,
         config_json = excluded.config_json,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(revision, JSON.stringify(snapshot), this.nowMs());
  }
}

export const RUNTIME_CONFIG_RANGES = {
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
} as const;

export type RuntimeConfigKey = keyof typeof RUNTIME_CONFIG_RANGES;

export function isRuntimeConfigKey(key: string): key is RuntimeConfigKey {
  return key in RUNTIME_CONFIG_RANGES;
}

export function readRuntimeConfigNumber(config: RuntimeConfigSnapshot, key: RuntimeConfigKey): number {
  const [section, property] = key.split(".") as [keyof RuntimeConfigSnapshot, string];
  return (config[section] as Record<string, number>)[property] as number;
}

export function withRuntimeConfigNumber(config: RuntimeConfigSnapshot, key: RuntimeConfigKey, value: number): RuntimeConfigSnapshot {
  const next = defaultRuntimeConfigSnapshot();
  Object.assign(next.limits, config.limits);
  Object.assign(next.admission, config.admission);
  Object.assign(next.timeouts, config.timeouts);
  Object.assign(next.accounts, config.accounts);
  Object.assign(next.history, config.history);
  Object.assign(next.usage, config.usage);
  Object.assign(next.events, config.events);
  const [section, property] = key.split(".") as [keyof RuntimeConfigSnapshot, string];
  (next[section] as Record<string, number>)[property] = value;
  return next;
}

function overlayEnvironment(base: RuntimeConfigSnapshot, env: NodeJS.ProcessEnv): RuntimeConfigSnapshot {
  const next = structuredClone(base);
  assignInteger(env.GHC_GATEWAY_LIMITS_REQUEST_BODY_BYTES, (value) => {
    next.limits.requestBodyBytes = value;
  });
  assignInteger(env.GHC_GATEWAY_LIMITS_SSE_EVENT_BYTES, (value) => {
    next.limits.sseEventBytes = value;
  });
  assignInteger(env.GHC_GATEWAY_LIMITS_NONSTREAM_BODY_BYTES, (value) => {
    next.limits.nonstreamBodyBytes = value;
  });
  assignInteger(env.GHC_GATEWAY_LIMITS_ACCUMULATOR_BYTES, (value) => {
    next.limits.accumulatorBytes = value;
  });
  assignInteger(env.GHC_GATEWAY_ADMISSION_ACTIVE_MAX, (value) => {
    next.admission.activeMax = value;
  });
  assignInteger(env.GHC_GATEWAY_ADMISSION_QUEUE_MAX, (value) => {
    next.admission.queueMax = value;
  });
  assignInteger(env.GHC_GATEWAY_TIMEOUTS_QUEUE_MS, (value) => {
    next.timeouts.queueMs = value;
  });
  assignInteger(env.GHC_GATEWAY_TIMEOUTS_CONNECT_MS, (value) => {
    next.timeouts.connectMs = value;
  });
  assignInteger(env.GHC_GATEWAY_TIMEOUTS_FIRST_BYTE_MS, (value) => {
    next.timeouts.firstByteMs = value;
  });
  assignInteger(env.GHC_GATEWAY_TIMEOUTS_STREAM_IDLE_MS, (value) => {
    next.timeouts.streamIdleMs = value;
  });
  assignInteger(env.GHC_GATEWAY_TIMEOUTS_TOTAL_MS, (value) => {
    next.timeouts.totalMs = value;
  });
  assignInteger(env.GHC_GATEWAY_ACCOUNTS_MAX_AUTHENTICATED, (value) => {
    next.accounts.maxAuthenticated = value;
  });
  assignInteger(env.GHC_GATEWAY_HISTORY_TTL_DAYS, (value) => {
    next.history.ttlDays = value;
  });
  assignInteger(env.GHC_GATEWAY_USAGE_RETENTION_DAYS, (value) => {
    next.usage.retentionDays = value;
  });
  assignInteger(env.GHC_GATEWAY_EVENTS_RETENTION_DAYS, (value) => {
    next.events.retentionDays = value;
  });
  return next;
}

function assignInteger(raw: string | undefined, assign: (value: number) => void): void {
  if (raw === undefined || raw === "") {
    return;
  }
  if (!/^-?[0-9]+$/u.test(raw)) {
    throw new RuntimeConfigError("invalid_config", "invalid runtime config environment integer");
  }
  assign(Number.parseInt(raw, 10));
}

function freezeSnapshot(value: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  Object.freeze(value.limits);
  Object.freeze(value.admission);
  Object.freeze(value.timeouts);
  Object.freeze(value.accounts);
  Object.freeze(value.history);
  Object.freeze(value.usage);
  Object.freeze(value.events);
  return Object.freeze(value);
}
