import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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

export const RuntimeConfigSchema = Type.Object({
  limits: Type.Object({
    requestBodyBytes: rangeInteger("limits.requestBodyBytes"),
    sseEventBytes: rangeInteger("limits.sseEventBytes"),
    nonstreamBodyBytes: rangeInteger("limits.nonstreamBodyBytes"),
    accumulatorBytes: rangeInteger("limits.accumulatorBytes"),
  }, { additionalProperties: false }),
  admission: Type.Object({
    activeMax: rangeInteger("admission.activeMax"),
    queueMax: rangeInteger("admission.queueMax"),
  }, { additionalProperties: false }),
  timeouts: Type.Object({
    queueMs: rangeInteger("timeouts.queueMs"),
    connectMs: rangeInteger("timeouts.connectMs"),
    firstByteMs: rangeInteger("timeouts.firstByteMs"),
    streamIdleMs: rangeInteger("timeouts.streamIdleMs"),
    totalMs: rangeInteger("timeouts.totalMs"),
  }, { additionalProperties: false }),
  accounts: Type.Object({
    maxAuthenticated: rangeInteger("accounts.maxAuthenticated"),
  }, { additionalProperties: false }),
  history: Type.Object({
    ttlDays: rangeInteger("history.ttlDays"),
  }, { additionalProperties: false }),
  usage: Type.Object({
    retentionDays: rangeInteger("usage.retentionDays"),
  }, { additionalProperties: false }),
  events: Type.Object({
    retentionDays: rangeInteger("events.retentionDays"),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

function rangeInteger(key: RuntimeConfigKey) {
  const range = RUNTIME_CONFIG_RANGES[key];
  return Type.Integer({ minimum: range.min, maximum: range.max });
}

export type RuntimeConfigSnapshot = Static<typeof RuntimeConfigSchema>;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfigSnapshot = {
  limits: {
    requestBodyBytes: 33_554_432,
    sseEventBytes: 4_194_304,
    nonstreamBodyBytes: 33_554_432,
    accumulatorBytes: 33_554_432,
  },
  admission: {
    activeMax: 4,
    queueMax: 16,
  },
  timeouts: {
    queueMs: 30_000,
    connectMs: 30_000,
    firstByteMs: 120_000,
    streamIdleMs: 120_000,
    totalMs: 1_800_000,
  },
  accounts: {
    maxAuthenticated: 8,
  },
  history: {
    ttlDays: 7,
  },
  usage: {
    retentionDays: 90,
  },
  events: {
    retentionDays: 7,
  },
};

export function defaultRuntimeConfigSnapshot(): RuntimeConfigSnapshot {
  return structuredClone(DEFAULT_RUNTIME_CONFIG);
}

export function parseRuntimeConfigSnapshot(candidate: unknown): RuntimeConfigSnapshot {
  if (!Value.Check(RuntimeConfigSchema, candidate)) {
    throw new Error("invalid runtime config");
  }
  return structuredClone(candidate);
}
