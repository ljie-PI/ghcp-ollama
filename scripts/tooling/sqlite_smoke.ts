import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { assertNode24 } from "./node_version.js";

export interface SqliteSmokeResult {
  readonly journalMode: string;
  readonly rowCount: number;
  readonly databasePath: string;
  readonly rollback: true;
  readonly nestedRollback: true;
  readonly reopened: true;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
}

export async function runSqliteWalSmoke(): Promise<SqliteSmokeResult> {
  const parent = path.resolve("artifacts", "test-data");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "ghc-gateway-sqlite-"));
  const databasePath = path.join(dir, "state.db");
  let database: ReturnType<typeof openDatabase> | undefined;

  try {
    database = openDatabase({ path: databasePath, migrations: [], nowMs: () => 0 });
    const journalMode = String(database.pragma("journal_mode", { simple: true }));
    assert.equal(journalMode, "wal");
    assert.equal(database.pragma("synchronous", { simple: true }), 2);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(database.pragma("busy_timeout", { simple: true }), 1000);
    assert.equal(database.pragma("wal_autocheckpoint", { simple: true }), 1000);
    assert.equal(database.pragma("journal_size_limit", { simple: true }), 67_108_864);
    database.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO smoke (value) VALUES (?)");
    const failure = new Error("smoke rollback");
    const rollback = database.transaction(() => {
      insert.run("discarded");
      throw failure;
    });
    const transaction = database.transaction(() => {
      insert.run("ok");
      assert.throws(rollback, (error: unknown) => error === failure);
      return "committed";
    });
    assert.equal(transaction(), "committed");
    assert.throws(rollback, (error: unknown) => error === failure);
    assert.deepEqual(database.prepare("SELECT value FROM smoke ORDER BY id").all(), [{ value: "ok" }]);
    closeDatabase(database);
    database = undefined;
    database = openDatabase({ path: databasePath, migrations: [], nowMs: () => 0 });
    assert.deepEqual(database.prepare("SELECT value FROM smoke ORDER BY id").all(), [{ value: "ok" }]);
    const row = database.prepare("SELECT COUNT(*) AS count FROM smoke").get() as { readonly count: number };
    const version = database.prepare("SELECT sqlite_version() AS version").get() as { readonly version: string };

    return {
      journalMode, rowCount: row.count, databasePath,
      rollback: true, nestedRollback: true, reopened: true,
      nodeVersion: process.versions.node, sqliteVersion: version.version,
    };
  } finally {
    try {
      if (database !== undefined) closeDatabase(database);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  assertNode24();
  const result = await runSqliteWalSmoke();
  console.log(JSON.stringify(result));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
