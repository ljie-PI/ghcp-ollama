import type Database from "better-sqlite3";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import {
  RESPONSE_CALL_KINDS,
  RESPONSE_CALL_OUTPUT_KINDS,
  withResponsesRequestInput,
  type ResponsesCallKind,
  type ResponsesRequest,
} from "./dto.js";

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_RESPONSES = 512;
const DAY_MS = 86_400_000;
const MINIMAL_CALL_FIELDS = new Set([
  "type",
  "id",
  "call_id",
  "name",
  "namespace",
  "arguments",
  "input",
  "status",
  "execution",
  "reasoning_content",
  "reasoning",
]);
const FILL_FIELDS = new Set([
  "name",
  "namespace",
  "arguments",
  "input",
  "status",
  "execution",
  "reasoning_content",
  "reasoning",
]);

export interface ResponsesHistory {
  enrich(request: Readonly<ResponsesRequest>, signal: AbortSignal): Promise<ResponsesRequest>;
  record(record: Readonly<ResponsesHistoryRecord>, signal: AbortSignal): Promise<void>;
}

export interface ResponsesHistoryAdmin {
  inspect(): ResponsesHistoryInspection;
  clear(expectedRevision: number): ResponsesHistoryInspection;
}

export interface ResponsesHistoryRecord {
  readonly responseId: string;
  readonly output: readonly WireJson[] | WireJson;
}

export interface ResponsesHistoryInspection {
  readonly revision: number;
  readonly count: number;
  readonly oldestAt: number | null;
  readonly newestAt: number | null;
  readonly ttlDays: number;
  readonly maxResponses: number;
}

export class ResponsesHistoryAdminError extends Error {
  readonly code = "revision_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ResponsesHistoryAdminError";
  }
}

interface ResponsesHistoryOptions {
  readonly nowMs?: () => number;
  readonly ttlDays?: number;
  readonly maxResponses?: number;
}

interface StoredCall {
  readonly responseId: string;
  readonly ordinal: number;
  readonly callId: string;
  readonly kind: ResponsesCallKind;
  readonly item: WireJsonObject;
  readonly itemJson: string;
}

interface StoredResponse {
  readonly responseId: string;
  readonly calls: readonly StoredCall[];
  readonly byCallId: ReadonlyMap<string, StoredCall>;
}

interface ResponseRow {
  readonly response_id: string;
  readonly insertion_seq: number;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
}

interface CallRow {
  readonly response_id: string;
  readonly ordinal: number;
  readonly call_id: string;
  readonly kind: ResponsesCallKind;
  readonly item_json: string;
}

interface StateRow {
  readonly revision: number;
  readonly next_insertion_seq: number;
}

export class SqliteResponsesHistory implements ResponsesHistory, ResponsesHistoryAdmin {
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly maxResponses: number;

  constructor(
    private readonly database: Database.Database,
    options: ResponsesHistoryOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = (options.ttlDays ?? DEFAULT_TTL_DAYS) * DAY_MS;
    this.maxResponses = options.maxResponses ?? DEFAULT_MAX_RESPONSES;
    this.ensureState();
    this.mutateIfChanged(() => false);
  }

  async enrich(request: Readonly<ResponsesRequest>, signal: AbortSignal): Promise<ResponsesRequest> {
    throwIfAborted(signal);
    this.mutateIfChanged(() => false);
    throwIfAborted(signal);

    const originalItems = inputItems(request.input);
    if (originalItems === undefined) {
      return request as ResponsesRequest;
    }

    const scoped = request.previousResponseId === undefined
      ? undefined
      : this.readResponse(request.previousResponseId);
    const originalCallsById = new Map<string, WireJsonObject>();
    for (const item of originalItems) {
      if (isCallItem(item)) {
        const callId = callIdFromItem(item);
        if (callId !== undefined && !originalCallsById.has(callId)) {
          originalCallsById.set(callId, item);
        }
      }
    }

    let changed = false;
    let scopedGroupInserted = false;
    const emittedCallIds = new Set<string>();
    const enrichedItems: WireJson[] = [];

    for (const item of originalItems) {
      if (isCallItem(item)) {
        const callId = callIdFromItem(item);
        if (callId !== undefined && emittedCallIds.has(callId)) {
          changed = true;
          continue;
        }
        const cached = this.cachedCallForItem(item, scoped);
        const filled = cached === undefined ? item : fillEmptyFields(item, cached.item);
        if (filled !== item) {
          changed = true;
        }
        enrichedItems.push(filled);
        if (callId !== undefined) {
          emittedCallIds.add(callId);
        }
        continue;
      }

      if (isOutputItem(item)) {
        const outputCallId = callIdFromItem(item);
        if (outputCallId !== undefined && !emittedCallIds.has(outputCallId)) {
          const scopedCall = scoped?.byCallId.get(outputCallId);
          if (scoped !== undefined && scopedCall !== undefined && !scopedGroupInserted) {
            for (const call of scoped.calls) {
              if (!emittedCallIds.has(call.callId)) {
                enrichedItems.push(restoreCall(call, originalCallsById.get(call.callId)));
                emittedCallIds.add(call.callId);
                changed = true;
              }
            }
            scopedGroupInserted = true;
          } else {
            const fallback = scopedCall ?? this.uniqueGlobalCall(outputCallId);
            if (fallback !== undefined && !emittedCallIds.has(fallback.callId)) {
              enrichedItems.push(restoreCall(fallback, originalCallsById.get(fallback.callId)));
              emittedCallIds.add(fallback.callId);
              changed = true;
            }
          }
        }
      }

      enrichedItems.push(item);
    }

    if (!changed) {
      return request as ResponsesRequest;
    }

    return withResponsesRequestInput(request as ResponsesRequest, { kind: "array", items: enrichedItems });
  }

  async record(record: Readonly<ResponsesHistoryRecord>, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const responseId = record.responseId.trim();
    if (responseId.length === 0) {
      throw new Error("Responses history responseId must be non-empty");
    }
    const calls = extractRecordableCalls(responseId, record.output);
    this.mutateIfChanged(() => {
      if (calls.length === 0) {
        return false;
      }
      return this.upsertRecord(responseId, calls);
    });
    throwIfAborted(signal);
  }

  inspect(): ResponsesHistoryInspection {
    const state = this.readState();
    const counts = this.database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM responses) AS total_responses,
         (SELECT MIN(created_at_ms) FROM responses) AS oldest_at_ms,
         (SELECT MAX(created_at_ms) FROM responses) AS newest_at_ms`,
    ).get() as {
      total_responses: number;
      oldest_at_ms: number | null;
      newest_at_ms: number | null;
    };

    return {
      revision: state.revision,
      count: counts.total_responses,
      oldestAt: counts.oldest_at_ms,
      newestAt: counts.newest_at_ms,
      ttlDays: this.ttlMs / DAY_MS,
      maxResponses: this.maxResponses,
    };
  }

  clear(expectedRevision: number): ResponsesHistoryInspection {
    const clear = this.database.transaction(() => {
      const state = this.readState();
      if (state.revision !== expectedRevision) {
        throw new ResponsesHistoryAdminError("Responses history revision conflict");
      }
      const count = this.responseCount();
      if (count === 0) {
        return;
      }
      this.database.prepare("DELETE FROM response_calls").run();
      this.database.prepare("DELETE FROM responses").run();
      this.bumpRevision(this.nowMs());
    });
    clear();
    return this.inspect();
  }

  private ensureState(): void {
    this.database.prepare(
      `INSERT OR IGNORE INTO responses_history_state
       (singleton_id, revision, next_insertion_seq, updated_at_ms)
       VALUES (1, 0, 1, 0)`,
    ).run();
  }

  private mutateIfChanged(work: () => boolean): void {
    const nowMs = this.nowMs();
    const transaction = this.database.transaction(() => {
      const cleaned = this.cleanupExpired(nowMs);
      const changed = work();
      const evicted = this.evictOverflow();
      if (cleaned || changed || evicted) {
        this.bumpRevision(nowMs);
      }
    });
    transaction();
  }

  private cleanupExpired(nowMs: number): boolean {
    this.database.prepare(
      "DELETE FROM response_calls WHERE response_id IN (SELECT response_id FROM responses WHERE created_at_ms + ? <= ?)",
    ).run(this.ttlMs, nowMs);
    const result = this.database.prepare(
      "DELETE FROM responses WHERE created_at_ms + ? <= ?",
    ).run(this.ttlMs, nowMs);
    return result.changes > 0;
  }

  private evictOverflow(): boolean {
    const overflow = this.responseCount() - this.maxResponses;
    if (overflow <= 0) {
      return false;
    }
    const rows = this.database.prepare(
      "SELECT response_id FROM responses ORDER BY insertion_seq ASC LIMIT ?",
    ).all(overflow) as Array<{ response_id: string }>;
    const deleteCalls = this.database.prepare("DELETE FROM response_calls WHERE response_id = ?");
    const deleteResponse = this.database.prepare("DELETE FROM responses WHERE response_id = ?");
    for (const row of rows) {
      deleteCalls.run(row.response_id);
      deleteResponse.run(row.response_id);
    }
    return rows.length > 0;
  }

  private upsertRecord(responseId: string, calls: readonly StoredCall[]): boolean {
    const existing = this.database.prepare(
      "SELECT response_id, insertion_seq, created_at_ms, expires_at_ms FROM responses WHERE response_id = ?",
    ).get(responseId) as ResponseRow | undefined;
    const existingCalls = this.readCalls(responseId);

    if (existing !== undefined && callsEqual(existingCalls, calls)) {
      return false;
    }

    if (existing === undefined) {
      const state = this.readState();
      const nowMs = this.nowMs();
      this.database.prepare(
        `INSERT INTO responses (response_id, insertion_seq, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)`,
      ).run(responseId, state.next_insertion_seq, nowMs, nowMs + this.ttlMs);
      this.database.prepare(
        "UPDATE responses_history_state SET next_insertion_seq = ? WHERE singleton_id = 1",
      ).run(state.next_insertion_seq + 1);
    } else {
      this.database.prepare("DELETE FROM response_calls WHERE response_id = ?").run(responseId);
    }

    const insertCall = this.database.prepare(
      `INSERT INTO response_calls (response_id, ordinal, call_id, kind, item_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const call of calls) {
      insertCall.run(responseId, call.ordinal, call.callId, call.kind, call.itemJson);
    }

    return true;
  }

  private readResponse(responseId: string): StoredResponse | undefined {
    const row = this.database.prepare(
      "SELECT response_id FROM responses WHERE response_id = ?",
    ).get(responseId) as { response_id: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const calls = this.readCalls(row.response_id);
    return responseFromCalls(row.response_id, calls);
  }

  private cachedCallForItem(item: WireJsonObject, scoped: StoredResponse | undefined): StoredCall | undefined {
    const callId = callIdFromItem(item);
    if (callId === undefined) {
      return undefined;
    }
    return scoped?.byCallId.get(callId) ?? this.uniqueGlobalCall(callId);
  }

  private uniqueGlobalCall(callId: string): StoredCall | undefined {
    const rows = this.database.prepare(
      "SELECT DISTINCT response_id FROM response_calls WHERE call_id = ? ORDER BY response_id LIMIT 2",
    ).all(callId) as Array<{ response_id: string }>;
    if (rows.length !== 1) {
      return undefined;
    }
    const responseId = rows[0]?.response_id;
    if (responseId === undefined) {
      return undefined;
    }
    return this.readResponse(responseId)?.byCallId.get(callId);
  }

  private readCalls(responseId: string): readonly StoredCall[] {
    const rows = this.database.prepare(
      `SELECT response_id, ordinal, call_id, kind, item_json
       FROM response_calls
       WHERE response_id = ?
       ORDER BY ordinal ASC`,
    ).all(responseId) as CallRow[];
    return rows.map((row) => {
      const itemBytes = new TextEncoder().encode(row.item_json);
      const item = parseWireJson(itemBytes, {
        maxBytes: Math.max(itemBytes.byteLength, 1),
        maxDepth: 64,
      });
      if (!isWireJsonObject(item)) {
        throw new Error("Responses history stored call item must be an object");
      }
      return {
        responseId: row.response_id,
        ordinal: row.ordinal,
        callId: row.call_id,
        kind: row.kind,
        itemJson: row.item_json,
        item,
      };
    });
  }

  private responseCount(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM responses").get() as { count: number }).count;
  }

  private readState(): StateRow {
    return this.database.prepare(
      "SELECT revision, next_insertion_seq FROM responses_history_state WHERE singleton_id = 1",
    ).get() as StateRow;
  }

  private bumpRevision(nowMs: number): void {
    this.database.prepare(
      `UPDATE responses_history_state
       SET revision = revision + 1, updated_at_ms = ?
       WHERE singleton_id = 1`,
    ).run(nowMs);
  }
}

function extractRecordableCalls(responseId: string, output: readonly WireJson[] | WireJson): readonly StoredCall[] {
  const items = outputItems(output);
  const calls: StoredCall[] = [];
  for (const item of items) {
    if (!isCallItem(item)) {
      continue;
    }
    const callId = callIdFromItem(item);
    if (callId === undefined) {
      continue;
    }
    const itemObject = minimalCallItem(item);
    calls.push({
      responseId,
      ordinal: calls.length,
      callId,
      kind: memberValues(item, "type")[0] as ResponsesCallKind,
      item: itemObject,
      itemJson: new TextDecoder().decode(serializeWireJson(itemObject)),
    });
  }
  return calls;
}

function outputItems(output: readonly WireJson[] | WireJson): readonly WireJson[] {
  if (Array.isArray(output)) {
    return output;
  }
  if (isWireJsonArray(output)) {
    return output.items;
  }
  if (isWireJsonObject(output)) {
    const nested = memberValues(output, "output")[0];
    if (isWireJsonArray(nested)) {
      return nested.items;
    }
    return [output];
  }
  return [];
}

function inputItems(input: WireJson | undefined): readonly WireJson[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (isWireJsonArray(input)) {
    return input.items;
  }
  if (isWireJsonObject(input)) {
    return [input];
  }
  return undefined;
}

function isCallItem(item: WireJson): item is WireJsonObject {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const type = memberValues(item, "type")[0];
  return typeof type === "string" && (RESPONSE_CALL_KINDS as readonly string[]).includes(type);
}

function isOutputItem(item: WireJson): item is WireJsonObject {
  if (!isWireJsonObject(item)) {
    return false;
  }
  const type = memberValues(item, "type")[0];
  return typeof type === "string" && (RESPONSE_CALL_OUTPUT_KINDS as readonly string[]).includes(type);
}

function callIdFromItem(item: WireJsonObject): string | undefined {
  const callId = trimmedString(memberValues(item, "call_id")[0]);
  if (callId !== undefined) {
    return callId;
  }
  return trimmedString(memberValues(item, "id")[0]);
}

function trimmedString(value: WireJson | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function minimalCallItem(item: WireJsonObject): WireJsonObject {
  return {
    kind: "object",
    members: item.members.filter((member) => MINIMAL_CALL_FIELDS.has(member.key)),
  };
}

function fillEmptyFields(item: WireJsonObject, cached: WireJsonObject): WireJsonObject {
  const existingKeys = new Set(item.members.map((member) => member.key));
  const additions = cached.members.filter((member) => {
    if (!FILL_FIELDS.has(member.key)) {
      return false;
    }
    const current = memberValues(item, member.key)[0];
    return current === undefined || current === null || current === "";
  });

  const members = item.members.map((member) => {
    if (!FILL_FIELDS.has(member.key)) {
      return member;
    }
    const replacement = member.value === null || member.value === ""
      ? memberValues(cached, member.key)[0]
      : undefined;
    return replacement === undefined ? member : { key: member.key, value: replacement };
  });
  for (const addition of additions) {
    if (!existingKeys.has(addition.key)) {
      members.push(addition);
    }
  }

  if (membersEqual(item.members, members)) {
    return item;
  }
  return { kind: "object", members };
}

function restoreCall(cached: StoredCall, original: WireJsonObject | undefined): WireJsonObject {
  return original === undefined ? cached.item : fillEmptyFields(original, cached.item);
}

function responseFromCalls(responseId: string, calls: readonly StoredCall[]): StoredResponse {
  const byCallId = new Map<string, StoredCall>();
  for (const call of calls) {
    if (!byCallId.has(call.callId)) {
      byCallId.set(call.callId, call);
    }
  }
  return { responseId, calls, byCallId };
}

function callsEqual(left: readonly StoredCall[], right: readonly StoredCall[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((call, index) => {
    const other = right[index];
    return other !== undefined
      && call.callId === other.callId
      && call.kind === other.kind
      && call.itemJson === other.itemJson;
  });
}

function membersEqual(
  left: WireJsonObject["members"],
  right: WireJsonObject["members"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((member, index) => {
    const other = right[index];
    return other !== undefined && member.key === other.key && member.value === other.value;
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("operation aborted", "AbortError");
  }
}
