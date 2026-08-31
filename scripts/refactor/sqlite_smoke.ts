import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./node_version.js";

export interface SqliteSmokeResult {
  readonly journalMode: string;
  readonly rowCount: number;
  readonly databasePath: string;
}

export async function runSqliteWalSmoke(): Promise<SqliteSmokeResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-sqlite-"));
  const databasePath = path.join(dir, "state.db");
  const database = new Database(databasePath);

  try {
    const journalMode = String(database.pragma("journal_mode = WAL", { simple: true }));
    database.pragma("synchronous = FULL");
    database.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const transaction = database.transaction(() => {
      database.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
    });
    transaction();
    const row = database.prepare("SELECT COUNT(*) AS count FROM smoke").get() as { count: number };

    return { journalMode, rowCount: row.count, databasePath };
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
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
