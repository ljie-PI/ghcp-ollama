import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./sqlite.js";

export interface MigrationModule {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface EmbeddedMigration extends MigrationModule {
  readonly checksum: string;
}

export class MigrationError extends Error {
  readonly code: "checksum_drift" | "unknown_version" | "apply_failed";

  constructor(code: MigrationError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}

export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function embedMigration(module: MigrationModule): EmbeddedMigration {
  return {
    version: module.version,
    name: module.name,
    sql: module.sql,
    checksum: checksumSql(module.sql),
  };
}

export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly EmbeddedMigration[],
  nowMs: () => number = Date.now,
): void {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const byVersion = new Map(ordered.map((migration) => [migration.version, migration]));
  const applied = readApplied(database);

  for (const row of applied) {
    const expected = byVersion.get(row.version);
    if (expected === undefined) {
      throw new MigrationError("unknown_version", `applied migration ${row.version} is unknown to this binary`);
    }
    if (expected.checksum !== row.checksum) {
      throw new MigrationError("checksum_drift", `checksum drift for migration ${row.version}`);
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, migration.checksum, nowMs());
    });
    try {
      apply();
    } catch (error: unknown) {
      throw new MigrationError("apply_failed", `failed to apply migration ${migration.version}`, { cause: error });
    }
  }
}

interface AppliedRow {
  readonly version: number;
  readonly checksum: string;
}

function readApplied(database: SqliteDatabase): readonly AppliedRow[] {
  const exists = database.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { ok: number } | undefined;
  if (exists === undefined) {
    return [];
  }
  return database.prepare(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  ).all() as AppliedRow[];
}
