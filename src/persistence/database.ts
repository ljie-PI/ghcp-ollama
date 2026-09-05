import { SqliteDatabase } from "./sqlite.js";
import { applyMigrations, type EmbeddedMigration } from "./migrations.js";

export const SQLITE_BUSY_TIMEOUT_MS = 1000;
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 67_108_864;

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly migrations: readonly EmbeddedMigration[];
  readonly nowMs?: () => number;
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const database = new SqliteDatabase(options.path);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    database.pragma(`wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
    database.pragma(`journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`);
    applyMigrations(database, options.migrations, options.nowMs ?? Date.now);
    return database;
  } catch (error: unknown) {
    try {
      database.close();
    } catch (closeError: unknown) {
      throw new AggregateError([error, closeError], "SQLite initialization cleanup failed");
    }
    throw error;
  }
}

export function closeDatabase(database: SqliteDatabase): void {
  database.close();
}
