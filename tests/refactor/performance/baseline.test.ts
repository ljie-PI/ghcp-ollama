import { describe, expect, it } from "vitest";
import { runBaselineBenchmark } from "../../../scripts/refactor/bench.js";
import { runSqliteWalSmoke } from "../../../scripts/refactor/sqlite_smoke.js";

describe("RM-01 baseline smoke", () => {
  it("loads better-sqlite3 and commits a WAL transaction", async () => {
    const result = await runSqliteWalSmoke();

    expect(result.journalMode.toLowerCase()).toBe("wal");
    expect(result.rowCount).toBe(1);
  });

  it("keeps the empty selected runtime stack within the idle RSS budget", async () => {
    const result = await runBaselineBenchmark(1);

    expect(result.passed, JSON.stringify(result.samples)).toBe(true);
    expect(result.samples).toHaveLength(1);
    expect(result.adminPage).toBeUndefined();
  });
});
