import Database from "better-sqlite3";
import { applyMigrations, type EmbeddedMigration } from "./migrations.js";

export const SQLITE_BUSY_TIMEOUT_MS = 1000;
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 67_108_864;

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly migrations: readonly EmbeddedMigration[];
  readonly nowMs?: () => number;
}

export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  const database = new Database(options.path);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 1000");
  database.pragma("wal_autocheckpoint = 1000");
  database.pragma("journal_size_limit = 67108864");
  applyMigrations(database, options.migrations, options.nowMs ?? Date.now);
  return database;
}

export function closeDatabase(database: Database.Database): void {
  database.close();
}
