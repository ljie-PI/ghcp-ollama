import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AgentError, type AgentId, type AgentMapping } from "./types.js";
import { assertNoLinks, assertPrivate, exists, privateDirectory, protect, type FileImage } from "./files.js";
import { timestampBackupPattern } from "./backups.js";

const Image = Type.Union([Type.Null(), Type.Object({
  bytes: Type.String({ maxLength: 1_398_104, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
  mode: Type.Integer({ minimum: 0, maximum: 511 }), acl: Type.Union([Type.Null(), Type.String({ maxLength: 16384 })]),
}, { additionalProperties: false })]);
const Mapping = Type.Object({ displayName: Type.String({ maxLength: 80 }), modelId: Type.String({ maxLength: 128 }) }, { additionalProperties: false });
const Backup = Type.Object({
  path: Type.String({ maxLength: 4096 }), digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
}, { additionalProperties: false });
const Target = Type.Object({
  path: Type.String({ maxLength: 4096 }), original: Image, expected: Image,
  backups: Type.Array(Backup, { maxItems: 365 }),
}, { additionalProperties: false });
const Step = Type.Object({
  target: Type.Integer({ minimum: 0, maximum: 1 }), before: Image, after: Image,
  scratch: Type.String({ maxLength: 4096 }),
  backup: Type.String({ maxLength: 4096 }),
  phase: Type.Union([Type.Literal("planned"), Type.Literal("displaced"), Type.Literal("published")]),
}, { additionalProperties: false });
const StateSchema = Type.Object({
  version: Type.Literal(4), revision: Type.Integer({ minimum: 0 }),
  targets: Type.Array(Target, { maxItems: 2 }), mappings: Type.Array(Mapping, { maxItems: 16 }),
  lastAppliedAt: Type.Union([Type.Null(), Type.String({ maxLength: 40 })]),
  pending: Type.Union([Type.Null(), Type.Object({
    kind: Type.Literal("apply"),
    steps: Type.Array(Step, { minItems: 1, maxItems: 2 }),
    garbage: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 2 }),
  }, { additionalProperties: false })]),
}, { additionalProperties: false });
export type AgentState = Static<typeof StateSchema>;
export type StepState = NonNullable<AgentState["pending"]>["steps"][number];
export function emptyState(): AgentState {
  return { version: 4, revision: 0, targets: [], mappings: [], lastAppliedAt: null, pending: null };
}

// A separate SQLite exclusive transaction is an OS-backed cross-process mutex.
// It is released by the OS after a crash: no PID files, time-based lock stealing,
// or competing stale-lock unlink races. Journal writes use a different database.
export class AgentStore {
  constructor(
    private readonly root: string,
    private readonly agent: AgentId,
  ) {}
  private get directory(): string { return path.join(this.root, this.agent); }
  private get statePath(): string { return path.join(this.directory, "state.db"); }

  async read(): Promise<AgentState> {
    assertNoLinks(this.root);
    if (!exists(this.statePath)) return emptyState();
    await this.checkDirectory();
    return readStateDatabase(this.statePath, this.agent);
  }

  async locked<T>(work: (save: (state: AgentState, beforeCommit?: () => void) => Promise<void>) => Promise<T>): Promise<T> {
    if (!exists(path.dirname(this.root))) await privateDirectory(path.dirname(this.root));
    await privateDirectory(this.root);
    await privateDirectory(this.directory);
    await this.checkDirectory();
    const lockPath = path.join(this.directory, "lock.db");
    if (exists(lockPath)) await assertPrivate(lockPath, false);
    if (!exists(lockPath)) {
      let created = false;
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        fs.closeSync(fd);
        created = true;
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
      }
      if (created) await protect(lockPath);
    }
    await assertPrivateDatabase(lockPath);
    await assertPrivateDatabaseSidecars(lockPath);
    const lock = new DatabaseSync(lockPath, { timeout: 0 });
    try {
      try { lock.exec("BEGIN EXCLUSIVE"); } catch { throw new AgentError("agent_busy"); }
      return await work((state, beforeCommit) => this.save(state, beforeCommit));
    } finally { lock.close(); }
  }

  private async save(state: AgentState, beforeCommit?: () => void): Promise<void> {
    if (!Value.Check(StateSchema, state)) throw new AgentError("agent_recovery_required");
    const normalized = normalizeStateImages(state);
    validateStatePaths(normalized, this.agent);
    await this.checkDirectory();
    if (exists(this.statePath)) await assertPrivateDatabase(this.statePath);
    beforeCommit?.();
    if (!exists(this.statePath)) {
      const fd = fs.openSync(this.statePath, "wx", 0o600);
      fs.closeSync(fd);
      protect(this.statePath);
    }
    await assertPrivateDatabase(this.statePath);
    await assertPrivateDatabaseSidecars(this.statePath);
    const db = new DatabaseSync(this.statePath, { timeout: 0 });
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)");
      db.prepare("INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(JSON.stringify(normalized));
    } finally { db.close(); }
  }
  private async checkDirectory(): Promise<void> {
    await assertPrivate(this.root, true);
    await assertPrivate(this.directory, true);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = this.statePath + suffix;
      if (exists(sidecar)) {
        await assertPrivateDatabase(sidecar);
      }
    }
  }
}

async function readStateDatabase(statePath: string, agent: AgentId): Promise<AgentState> {
  await assertPrivateDatabase(statePath);
  await assertPrivateDatabaseSidecars(statePath);
  const db = new DatabaseSync(statePath, { readOnly: true, timeout: 0 });
  try {
    const row = db.prepare("SELECT document FROM state WHERE id=1").get();
    if (row === undefined) return emptyState();
    if (typeof row.document !== "string" || row.document.length > 32 * 1024 * 1024) throw new AgentError("agent_recovery_required");
    const state: unknown = JSON.parse(row.document);
    if (!Value.Check(StateSchema, state)) throw new AgentError("agent_recovery_required");
    validateStatePaths(state, agent);
    return normalizeStateImages(state);
  } catch (error: unknown) {
    if (error instanceof AgentError) throw error;
    if (isSqliteBusy(error)) throw new AgentError("agent_busy");
    throw new AgentError("agent_recovery_required");
  } finally { db.close(); }
}

function normalizeStateImages(state: AgentState): AgentState {
  const image = (value: FileImage | null): FileImage | null => value === null ? null : { ...value, acl: null };
  return {
    ...state,
    targets: state.targets.map((target) => ({
      ...target,
      original: image(target.original),
      expected: image(target.expected),
    })),
    pending: state.pending === null ? null : {
      ...state.pending,
      steps: state.pending.steps.map((step) => ({
        ...step,
        before: image(step.before),
        after: image(step.after),
      })),
    },
  };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function assertPrivateDatabase(target: string): Promise<void> {
  await assertPrivate(target, false);
  if (fs.lstatSync(target).nlink !== 1) throw new AgentError("agent_unsafe_path");
}

async function assertPrivateDatabaseSidecars(target: string): Promise<void> {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = target + suffix;
    if (exists(sidecar)) await assertPrivateDatabase(sidecar);
  }
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ERR_SQLITE_ERROR" || error.code === "SQLITE_BUSY")
    && "message" in error && typeof error.message === "string" && error.message.includes("database is locked");
}

function validateStatePaths(state: AgentState, agent: AgentId): void {
  const count = agent === "codex" ? 2 : 1;
  if (state.targets.length !== 0 && state.targets.length !== count) throw new AgentError("agent_recovery_required");
  for (const target of state.targets) {
    if (!path.isAbsolute(target.path)) throw new AgentError("agent_recovery_required");
    const backups = target.backups;
    if (backups.some((backup) => path.dirname(backup.path) !== path.dirname(target.path)
      || !timestampBackupPattern(path.basename(target.path)).test(path.basename(backup.path)))
      || new Set(backups.map((backup) => backup.path)).size !== backups.length) {
      throw new AgentError("agent_recovery_required");
    }
  }
  const steps = state.pending?.steps ?? [];
  if (new Set(steps.map((step) => step.target)).size !== steps.length) throw new AgentError("agent_recovery_required");
  for (const step of steps) {
    const target = state.targets[step.target];
    if (!target || path.dirname(step.scratch) !== path.dirname(target.path)
      || !new RegExp(`^\\.ghcg-agents-${agent}-[0-9a-f-]{36}$`, "u").test(path.basename(step.scratch))) throw new AgentError("agent_recovery_required");
    if (path.dirname(step.backup) !== path.dirname(target.path)
      || !timestampBackupPattern(path.basename(target.path)).test(path.basename(step.backup))) {
      throw new AgentError("agent_recovery_required");
    }
  }
  const backups = steps.map((step) => step.backup);
  if (new Set(backups).size !== backups.length) throw new AgentError("agent_recovery_required");
  for (const garbage of state.pending?.garbage ?? []) {
    if (!state.targets.some((target) => path.dirname(target.path) === path.dirname(garbage))
      || !new RegExp(`^\\.ghcg-agents-${agent}-[0-9a-f-]{36}$`, "u").test(path.basename(garbage))) throw new AgentError("agent_recovery_required");
  }
}
export function newImage(bytes: Buffer, original: FileImage | null): FileImage {
  return { bytes: bytes.toString("base64"), mode: original?.mode ?? 0o600, acl: null };
}
export function copyMappings(mappings: readonly AgentMapping[]): AgentMapping[] {
  return mappings.map((row) => ({ displayName: row.displayName, modelId: row.modelId }));
}
