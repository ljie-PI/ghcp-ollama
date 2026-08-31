export const migration = {
  version: 1,
  name: "runtime_config",
  sql: [
    "CREATE TABLE schema_migrations (",
    "  version INTEGER PRIMARY KEY,",
    "  name TEXT NOT NULL UNIQUE,",
    "  checksum TEXT NOT NULL,",
    "  applied_at_ms INTEGER NOT NULL",
    ");",
    "CREATE TABLE runtime_config (",
    "  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),",
    "  revision INTEGER NOT NULL,",
    "  config_json TEXT NOT NULL,",
    "  updated_at_ms INTEGER NOT NULL",
    ");",
  ].join("\n"),
} as const;
