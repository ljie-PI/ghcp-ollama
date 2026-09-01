import Database from "better-sqlite3";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateMigrationManifest,
  MigrationGenerateError,
  readMigrationManifest,
  writeMigrationManifest,
} from "../../../scripts/refactor/generate_migrations.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../../src/persistence/migrations/020_telemetry.js";
import { migration as responsesHistoryMigration } from "../../../src/persistence/migrations/030_responses_history.js";
import {
  applyMigrations,
  embedMigration,
  MigrationError,
} from "../../../src/persistence/migrations.js";

const nowMs = (): number => 1_700_000_000_000;

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-db-"));
  return path.join(dir, "state.db");
}

describe("RM-04 migrations", () => {
  it("opens WAL/FULL/FK with documented busy timeout and journal limits", async () => {
    const database = openDatabase({
      path: await tempDbPath(),
      migrations: [embedMigration(runtimeConfigMigration)],
      nowMs,
    });
    try {
      expect(String(database.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      expect(Number(database.pragma("synchronous", { simple: true }))).toBe(2);
      expect(Number(database.pragma("foreign_keys", { simple: true }))).toBe(1);
      expect(Number(database.pragma("busy_timeout", { simple: true }))).toBe(1000);
      expect(Number(database.pragma("wal_autocheckpoint", { simple: true }))).toBe(1000);
      expect(Number(database.pragma("journal_size_limit", { simple: true }))).toBe(67_108_864);
      const row = database.prepare("SELECT version, name FROM schema_migrations").get() as {
        version: number;
        name: string;
      };
      expect(row).toEqual({ version: 1, name: "runtime_config" });
    } finally {
      closeDatabase(database);
    }
  });

  it("is idempotent for a current database and upgrades an older one", async () => {
    const dbPath = await tempDbPath();
    const first = openDatabase({
      path: dbPath,
      migrations: [embedMigration(runtimeConfigMigration)],
      nowMs,
    });
    closeDatabase(first);

    const extra = embedMigration({
      version: 10,
      name: "accounts",
      sql: "CREATE TABLE accounts_probe (id INTEGER PRIMARY KEY);",
    });
    const upgraded = openDatabase({
      path: dbPath,
      migrations: [embedMigration(runtimeConfigMigration), extra],
      nowMs,
    });
    try {
      const versions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>;
      expect(versions.map((row) => row.version)).toEqual([1, 10]);
      expect(upgraded.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'accounts_probe'").get()).toEqual({
        ok: 1,
      });
    } finally {
      closeDatabase(upgraded);
    }
  });

  it("applies a later lower reserved version after a higher version exists", () => {
    const database = new Database(":memory:");
    const first = embedMigration(runtimeConfigMigration);
    const high = embedMigration({
      version: 20,
      name: "telemetry",
      sql: "CREATE TABLE telemetry_probe (id INTEGER PRIMARY KEY);",
    });
    const low = embedMigration({
      version: 10,
      name: "accounts",
      sql: "CREATE TABLE accounts_probe (id INTEGER PRIMARY KEY);",
    });
    applyMigrations(database, [first, high], nowMs);
    applyMigrations(database, [first, low, high], nowMs);
    const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual([1, 10, 20]);
    database.close();
  });

  it("rejects checksum drift and unknown applied versions", () => {
    const database = new Database(":memory:");
    const first = embedMigration(runtimeConfigMigration);
    applyMigrations(database, [first], nowMs);
    database.prepare("UPDATE schema_migrations SET checksum = 'drift' WHERE version = 1").run();
    expect(() => applyMigrations(database, [first], nowMs)).toThrow(MigrationError);
    database.close();

    const unknown = new Database(":memory:");
    applyMigrations(unknown, [first], nowMs);
    unknown.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (99, 'future', 'abc', 1)",
    ).run();
    expect(() => applyMigrations(unknown, [first], nowMs)).toThrow(/unknown/u);
    unknown.close();
  });

  it("rolls back a failed migration", () => {
    const database = new Database(":memory:");
    const first = embedMigration(runtimeConfigMigration);
    applyMigrations(database, [first], nowMs);
    const bad = embedMigration({
      version: 10,
      name: "bad",
      sql: "CREATE TABLE ok_probe (id INTEGER PRIMARY KEY); CREATE TABLE",
    });
    expect(() => applyMigrations(database, [first, bad], nowMs)).toThrow(MigrationError);
    const versions = database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }]);
    expect(database.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = 'ok_probe'").get()).toBeUndefined();
    database.close();
  });
});

describe("RM-04 generate_migrations", () => {
  it("embeds the reserved 001 module and writes a static manifest", async () => {
    const migrations = await generateMigrationManifest();
    expect(migrations).toEqual([
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(responsesHistoryMigration),
    ]);
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-manifest-"));
    const manifestPath = path.join(dir, "migrations-manifest.json");
    await writeMigrationManifest(migrations, manifestPath);
    const written = JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8")) as {
      migrations: unknown;
    };
    expect(written.migrations).toEqual(migrations);
    expect(readMigrationManifest(manifestPath)).toEqual(migrations);
  });

  it("rejects filename/export mismatch, duplicates, and reserved-owner violations", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-mig-"));
    await writeFile(path.join(dir, "001_wrong.ts"), "export const migration = { version: 1, name: 'x', sql: 'SELECT 1' };\n");
    await expect(generateMigrationManifest(dir)).rejects.toBeInstanceOf(MigrationGenerateError);

    const mismatch = await mkdtemp(path.join(tmpdir(), "ghc-gateway-mig-"));
    await writeFile(
      path.join(mismatch, "001_runtime_config.ts"),
      "export const migration = { version: 2, name: 'runtime_config', sql: 'SELECT 1' };\n",
    );
    await expect(generateMigrationManifest(mismatch)).rejects.toThrow(/mismatch/u);

    const unknown = await mkdtemp(path.join(tmpdir(), "ghc-gateway-mig-"));
    await writeFile(path.join(unknown, "002_extra.ts"), "export const migration = { version: 2, name: 'extra', sql: 'SELECT 1' };\n");
    await expect(generateMigrationManifest(unknown)).rejects.toThrow(/not reserved/u);
  });
});
