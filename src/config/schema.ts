import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const RuntimeConfigSchema = Type.Object({
  limits: Type.Object({
    requestBodyBytes: Type.Integer({ minimum: 1_048_576, maximum: 67_108_864 }),
    sseEventBytes: Type.Integer({ minimum: 65_536, maximum: 16_777_216 }),
    nonstreamBodyBytes: Type.Integer({ minimum: 1_048_576, maximum: 134_217_728 }),
    accumulatorBytes: Type.Integer({ minimum: 1_048_576, maximum: 134_217_728 }),
  }, { additionalProperties: false }),
  admission: Type.Object({
    activeMax: Type.Integer({ minimum: 1, maximum: 16 }),
    queueMax: Type.Integer({ minimum: 0, maximum: 64 }),
  }, { additionalProperties: false }),
  timeouts: Type.Object({
    queueMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    connectMs: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
    firstByteMs: Type.Integer({ minimum: 5_000, maximum: 600_000 }),
    streamIdleMs: Type.Integer({ minimum: 5_000, maximum: 600_000 }),
    totalMs: Type.Integer({ minimum: 60_000, maximum: 7_200_000 }),
  }, { additionalProperties: false }),
  accounts: Type.Object({
    maxAuthenticated: Type.Integer({ minimum: 1, maximum: 32 }),
  }, { additionalProperties: false }),
  history: Type.Object({
    ttlDays: Type.Integer({ minimum: 1, maximum: 365 }),
  }, { additionalProperties: false }),
  usage: Type.Object({
    retentionDays: Type.Integer({ minimum: 1, maximum: 365 }),
  }, { additionalProperties: false }),
  events: Type.Object({
    retentionDays: Type.Integer({ minimum: 1, maximum: 30 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

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
