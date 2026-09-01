import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as responsesHistoryMigration } from "../../../src/persistence/migrations/030_responses_history.js";
import { decodeResponsesRequest } from "../../../src/protocols/responses/decoder.js";
import {
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

const LIMITS = { maxBytes: 8192, maxDepth: 64 } as const;

function objectFromJson(json: string): WireJsonObject {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(isWireJsonObject(value)).toBe(true);
  return value as WireJsonObject;
}

function callRecord(responseId: string, outputJson: string): ResponsesHistoryRecord {
  return { responseId, output: outputFromJson(outputJson) };
}

function outputFromJson(json: string): readonly WireJson[] {
  const value = parseWireJson(new TextEncoder().encode(json), LIMITS);
  expect(isWireJsonArray(value)).toBe(true);
  return (value as { items: readonly WireJson[] }).items;
}

function history(nowMs = 1_700_000_000_000): {
  readonly database: Database.Database;
  readonly store: SqliteResponsesHistory;
} {
  const database = new Database(":memory:");
  applyMigrations(database, [
    embedMigration(runtimeConfigMigration),
    embedMigration(responsesHistoryMigration),
  ], () => nowMs);
  return {
    database,
    store: new SqliteResponsesHistory(database, { nowMs: () => nowMs }),
  };
}

function typesFromInput(input: WireJson | undefined): readonly string[] {
  expect(input).toBeDefined();
  if (isWireJsonObject(input)) {
    return [String(memberValues(input, "type")[0])];
  }
  expect(isWireJsonArray(input)).toBe(true);
  return (input as { items: readonly WireJson[] }).items.map((item) => {
    expect(isWireJsonObject(item)).toBe(true);
    return String(memberValues(item as WireJsonObject, "type")[0]);
  });
}

function firstCall(input: WireJson | undefined): WireJsonObject {
  expect(isWireJsonArray(input)).toBe(true);
  const item = (input as { items: readonly WireJson[] }).items.find((candidate) => {
    return isWireJsonObject(candidate) && memberValues(candidate, "type")[0] === "function_call";
  });
  expect(isWireJsonObject(item)).toBe(true);
  return item as WireJsonObject;
}

describe("RM-12 Responses history enrichment", () => {
  it("uses previous_response_id first and restores ordered calls before outputs", async () => {
    const { database, store } = history();
    try {
      await store.record(callRecord("resp_previous", [
        "[",
        "{\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"first\",\"arguments\":\"{}\"},",
        "{\"type\":\"custom_tool_call\",\"call_id\":\"call_b\",\"name\":\"second\",\"input\":\"payload\"}",
        "]",
      ].join("")), new AbortController().signal);
      await store.record(callRecord("resp_other", [
        "[{\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"wrong\",\"arguments\":\"{}\"}]",
      ].join("")), new AbortController().signal);

      const request = decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",",
        "\"previous_response_id\":\"resp_previous\",",
        "\"input\":[",
        "{\"type\":\"function_call_output\",\"call_id\":\"call_a\",\"output\":\"one\"},",
        "{\"type\":\"custom_tool_call_output\",\"call_id\":\"call_b\",\"output\":\"two\"}",
        "]}",
      ].join("")));
      const enriched = await store.enrich(request, new AbortController().signal);

      expect(typesFromInput(enriched.input)).toEqual([
        "function_call",
        "custom_tool_call",
        "function_call_output",
        "custom_tool_call_output",
      ]);
      const restored = firstCall(enriched.input);
      expect(memberValues(restored, "name")[0]).toBe("first");
    } finally {
      database.close();
    }
  });

  it("falls back only to a globally unique call id and misses ambiguous calls", async () => {
    const { database, store } = history();
    try {
      await store.record(callRecord("resp_one", [
        "[{\"type\":\"function_call\",\"call_id\":\"unique_call\",\"name\":\"only\",\"arguments\":\"{}\"}]",
      ].join("")), new AbortController().signal);
      await store.record(callRecord("resp_two", [
        "[{\"type\":\"function_call\",\"call_id\":\"ambiguous\",\"name\":\"first\",\"arguments\":\"{}\"}]",
      ].join("")), new AbortController().signal);
      await store.record(callRecord("resp_three", [
        "[{\"type\":\"custom_tool_call\",\"call_id\":\"ambiguous\",\"name\":\"second\",\"input\":\"x\"}]",
      ].join("")), new AbortController().signal);

      const unique = await store.enrich(decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",",
        "\"call_id\":\"unique_call\",\"output\":\"ok\"}}",
      ].join(""))), new AbortController().signal);
      expect(typesFromInput(unique.input)).toEqual(["function_call", "function_call_output"]);

      const ambiguous = await store.enrich(decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",",
        "\"call_id\":\"ambiguous\",\"output\":\"skip\"}}",
      ].join(""))), new AbortController().signal);
      expect(typesFromInput(ambiguous.input)).toEqual(["function_call_output"]);
    } finally {
      database.close();
    }
  });

  it("fills only empty call fields and leaves non-empty request fields authoritative", async () => {
    const { database, store } = history();
    try {
      await store.record(callRecord("resp_previous", [
        "[{\"type\":\"function_call\",\"call_id\":\"call_a\",\"name\":\"cached\",",
        "\"arguments\":\"{\\\"cached\\\":true}\",\"status\":\"completed\"}]",
      ].join("")), new AbortController().signal);
      const request = decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"previous_response_id\":\"resp_previous\",",
        "\"input\":{\"type\":\"function_call\",\"call_id\":\"call_a\",",
        "\"name\":\"\",\"arguments\":\"\",\"status\":\"in_progress\"}}",
      ].join("")));

      const enriched = await store.enrich(request, new AbortController().signal);
      const call = firstCall(enriched.input);

      expect(typesFromInput(enriched.input)).toEqual(["function_call"]);
      expect(memberValues(call, "name")[0]).toBe("cached");
      expect(memberValues(call, "arguments")[0]).toBe("{\"cached\":true}");
      expect(memberValues(call, "status")[0]).toBe("in_progress");
    } finally {
      database.close();
    }
  });

  it("recovers Unicode call payloads using UTF-8 byte limits", async () => {
    const { database, store } = history();
    try {
      await store.record(callRecord("resp_unicode", [
        "[{\"type\":\"custom_tool_call\",\"call_id\":\"unicode\",\"name\":\"render\",\"input\":\"汉\"}]",
      ].join("")), new AbortController().signal);
      const request = decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"input\":{\"type\":\"custom_tool_call_output\",",
        "\"call_id\":\"unicode\",\"output\":\"ok\"}}",
      ].join("")));
      const enriched = await store.enrich(request, new AbortController().signal);
      const items = isWireJsonArray(enriched.input) ? enriched.input.items : [];
      const restored = items[0];
      expect(isWireJsonObject(restored)).toBe(true);
      if (isWireJsonObject(restored)) {
        expect(memberValues(restored, "input")[0]).toBe("汉");
      }
    } finally {
      database.close();
    }
  });

  it("stores only recordable call kinds and minimal fields used for enrichment", async () => {
    const { database, store } = history();
    try {
      await store.record(callRecord("resp_previous", [
        "[",
        "{\"type\":\"message\",\"content\":\"ignored\"},",
        "{\"type\":\"tool_search_call\",\"call_id\":\"search\",\"arguments\":{\"q\":\"docs\"},\"extra\":\"drop\"},",
        "{\"type\":\"custom_tool_call\",\"call_id\":\"custom\",\"name\":\"render\",\"input\":\"card\",\"extra\":\"drop\"}",
        "]",
      ].join("")), new AbortController().signal);
      expect(store.inspect().count).toBe(1);

      const request = decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"previous_response_id\":\"resp_previous\",",
        "\"input\":{\"type\":\"tool_search_output\",\"call_id\":\"search\",\"output\":[]}}",
      ].join("")));
      const enriched = await store.enrich(request, new AbortController().signal);
      const items = isWireJsonArray(enriched.input) ? enriched.input.items : [];
      const restored = items[0];

      expect(typesFromInput(enriched.input)).toEqual([
        "tool_search_call",
        "custom_tool_call",
        "tool_search_output",
      ]);
      expect(isWireJsonObject(restored)).toBe(true);
      if (isWireJsonObject(restored)) {
        expect(memberValues(restored, "extra")).toEqual([]);
      }
    } finally {
      database.close();
    }
  });

  it("keeps a single object input unchanged when no history applies", async () => {
    const { database, store } = history();
    try {
      const request = decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"previous_response_id\":\"missing\",",
        "\"input\":{\"type\":\"message\",\"role\":\"user\",\"content\":\"hi\"}}",
      ].join("")));
      const enriched = await store.enrich(request, new AbortController().signal);

      expect(enriched).toBe(request);
      expect(isWireJsonObject(enriched.input)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("does not trim previous response IDs before scoped lookup", async () => {
    const { database, store } = history();
    try {
      await store.record(callRecord("resp_previous", [
        "[{\"type\":\"function_call\",\"call_id\":\"ambiguous\",\"name\":\"scoped\",\"arguments\":\"{}\"}]",
      ].join("")), new AbortController().signal);
      await store.record(callRecord("resp_other", [
        "[{\"type\":\"function_call\",\"call_id\":\"ambiguous\",\"name\":\"other\",\"arguments\":\"{}\"}]",
      ].join("")), new AbortController().signal);

      const enriched = await store.enrich(decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"previous_response_id\":\" resp_previous \",",
        "\"input\":{\"type\":\"function_call_output\",\"call_id\":\"ambiguous\",\"output\":\"ok\"}}",
      ].join(""))), new AbortController().signal);

      expect(typesFromInput(enriched.input)).toEqual(["function_call_output"]);
    } finally {
      database.close();
    }
  });

  it("recovers history stored at the accepted WireJson depth", async () => {
    const { database, store } = history();
    try {
      const nested = "{\"x\":".repeat(40) + "\"leaf\"" + "}".repeat(40);
      await store.record(callRecord("resp_deep", [
        "[{\"type\":\"function_call\",\"call_id\":\"deep\",\"name\":\"fn\",\"arguments\":",
        nested,
        "}]",
      ].join("")), new AbortController().signal);
      const enriched = await store.enrich(decodeResponsesRequest(objectFromJson([
        "{\"model\":\"gpt\",\"input\":{\"type\":\"function_call_output\",",
        "\"call_id\":\"deep\",\"output\":\"ok\"}}",
      ].join(""))), new AbortController().signal);
      expect(typesFromInput(enriched.input)).toEqual(["function_call", "function_call_output"]);
    } finally {
      database.close();
    }
  });
});
