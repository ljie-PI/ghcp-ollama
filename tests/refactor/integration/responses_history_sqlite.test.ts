import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as responsesHistoryMigration } from "../../../src/persistence/migrations/030_responses_history.js";
import { decodeResponsesRequest } from "../../../src/protocols/responses/decoder.js";
import {
  ResponsesHistoryAdminError,
  SqliteResponsesHistory,
  type ResponsesHistoryRecord,
} from "../../../src/protocols/responses/history.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../../src/serialization/wire_json.js";

const LIMITS = { maxBytes: 8192, maxDepth: 32 } as const;
const DAY_MS = 86_400_000;

function objectFromJson(json: string): WireJsonObject {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(isWireJsonObject(value)).toBe(true);
  return value as WireJsonObject;
}

function outputFromJson(json: string): readonly WireJson[] {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(isWireJsonArray(value)).toBe(true);
  return (value as { items: readonly WireJson[] }).items;
}

function record(responseId: string, callId: string): ResponsesHistoryRecord {
  return {
    responseId,
    output: outputFromJson([
      "[{\"type\":\"function_call\",\"call_id\":\"",
      callId,
      "\",\"name\":\"fn\",\"arguments\":\"{}\"}]",
    ].join("")),
  };
}

async function dbPath(name: string): Promise<string> {
  const dir = path.resolve("dist-refactor", "test-data", `rm-12-${process.pid}-${name}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return path.join(dir, "state.db");
}

function openHistory(db: string, nowMs: () => number, ttlDays = 7): {
  readonly database: ReturnType<typeof openDatabase>;
  readonly store: SqliteResponsesHistory;
} {
  const database = openDatabase({
    path: db,
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(responsesHistoryMigration)],
    nowMs,
  });
  return {
    database,
    store: new SqliteResponsesHistory(database, { nowMs, ttlDays }),
  };
}

async function enrichCallName(store: SqliteResponsesHistory, callId: string): Promise<string | undefined> {
  const enriched = await store.enrich(decodeResponsesRequest(objectFromJson([
    "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",",
    "\"call_id\":\"",
    callId,
    "\",\"output\":\"ok\"}}",
  ].join(""))), new AbortController().signal);
  if (!isWireJsonArray(enriched.input)) {
    return undefined;
  }
  const call = enriched.input.items[0];
  return isWireJsonObject(call) ? memberValues(call, "name")[0] as string | undefined : undefined;
}

describe("RM-12 Responses history SQLite", () => {
  it("recovers after restart and evicts by global insertion order", async () => {
    const file = await dbPath("restart-evict");
    let now = 1_700_000_000_000;
    const first = openHistory(file, () => now);
    try {
      await first.store.record(record("resp_first", "call_first"), new AbortController().signal);
      for (let index = 0; index < 512; index += 1) {
        await first.store.record(record(`resp_${index}`, `call_${index}`), new AbortController().signal);
      }
      expect(first.store.inspect().totalResponses).toBe(512);
      closeDatabase(first.database);

      now += 1_000;
      const reopened = openHistory(file, () => now);
      try {
        expect(await enrichCallName(reopened.store, "call_first")).toBeUndefined();
        expect(await enrichCallName(reopened.store, "call_511")).toBe("fn");
        expect(reopened.store.inspect().nextInsertionSeq).toBe(514);
      } finally {
        closeDatabase(reopened.database);
      }
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("cleans seven-day TTL at startup, lookup, and record without sliding expiry", async () => {
    const file = await dbPath("ttl");
    let now = 1_700_000_000_000;
    const first = openHistory(file, () => now);
    try {
      await first.store.record(record("resp_old", "call_old"), new AbortController().signal);
      now += 7 * DAY_MS + 1;
      expect(await enrichCallName(first.store, "call_old")).toBeUndefined();
      const afterLookupRevision = first.store.inspect().revision;
      expect(afterLookupRevision).toBe(2);
      await first.store.record(record("resp_new", "call_new"), new AbortController().signal);
      expect(first.store.inspect().totalResponses).toBe(1);
      closeDatabase(first.database);

      now += 7 * DAY_MS + 1;
      const reopened = openHistory(file, () => now);
      try {
        expect(reopened.store.inspect().totalResponses).toBe(0);
        expect(reopened.store.inspect().revision).toBe(4);
      } finally {
        closeDatabase(reopened.database);
      }
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("keeps revision-safe admin clear separate from inference operations", async () => {
    const file = await dbPath("admin-clear");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      expect(opened.store.inspect().revision).toBe(0);
      expect(opened.store.clear(0).revision).toBe(0);
      await opened.store.record(record("resp_one", "call_one"), new AbortController().signal);
      const afterRecord = opened.store.inspect();
      expect(afterRecord.revision).toBe(1);
      expect(() => opened.store.clear(0)).toThrow(ResponsesHistoryAdminError);
      const afterClear = opened.store.clear(afterRecord.revision);
      expect(afterClear.revision).toBe(2);
      expect(afterClear.totalResponses).toBe(0);
      await opened.store.record(record("resp_two", "call_two"), new AbortController().signal);
      expect(opened.store.inspect().nextInsertionSeq).toBe(3);
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("rolls back failed records and rejects aborted operations", async () => {
    const file = await dbPath("rollback-abort");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      await expect(opened.store.record({
        responseId: "resp_bad",
        output: [{
          kind: "object",
          members: [
            { key: "type", value: "function_call" },
            { key: "call_id", value: "call_bad" },
            { key: "arguments", value: { kind: "number", lexeme: "01" } },
          ],
        }],
      }, new AbortController().signal)).rejects.toThrow();
      expect(opened.store.inspect().revision).toBe(0);
      expect(opened.store.inspect().totalResponses).toBe(0);

      const controller = new AbortController();
      controller.abort();
      await expect(opened.store.record(record("resp_aborted", "call_aborted"), controller.signal))
        .rejects.toThrow(/aborted/u);
      await expect(opened.store.enrich(decodeResponsesRequest(objectFromJson("{\"model\":\"gpt\"}")), controller.signal))
        .rejects.toThrow(/aborted/u);
      expect(opened.store.inspect().totalResponses).toBe(0);
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("commits Semantic Checkpoint-sized records within the p95 evidence threshold", async () => {
    const file = await dbPath("checkpoint-bench");
    const opened = openHistory(file, () => 1_700_000_000_000);
    try {
      const samples: number[] = [];
      for (let index = 0; index < 30; index += 1) {
        const started = performance.now();
        await opened.store.record(record(`resp_bench_${index}`, `call_bench_${index}`), new AbortController().signal);
        samples.push(performance.now() - started);
      }
      const p95 = samples.slice().sort((left, right) => left - right)[Math.ceil(0.95 * samples.length) - 1] ?? 0;
      expect(p95).toBeLessThan(5);
    } finally {
      closeDatabase(opened.database);
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});
