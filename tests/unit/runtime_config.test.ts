import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { RuntimeConfigError, RuntimeConfigStore } from "../../src/config/runtime_config.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";

const nowMs = (): number => 1_700_000_000_000;

async function openStore(env: NodeJS.ProcessEnv = {}): Promise<{
  store: RuntimeConfigStore;
  close: () => void;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cfg-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration)],
    nowMs,
  });
  const store = new RuntimeConfigStore(database, nowMs);
  store.seedIfEmpty(env);
  return {
    store,
    close: () => closeDatabase(database),
  };
}

describe("runtime config", () => {
  it("seeds from environment only when no row exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cfg-"));
    const dbPath = path.join(dir, "state.db");
    const firstDb = openDatabase({
      path: dbPath,
      migrations: [embedMigration(runtimeConfigMigration)],
      nowMs,
    });
    const first = new RuntimeConfigStore(firstDb, nowMs);
    first.seedIfEmpty({ GHC_GATEWAY_ADMISSION_ACTIVE_MAX: "2" });
    expect(first.readSnapshot().admission.activeMax).toBe(2);
    expect(first.readRevision()).toBe(1);
    closeDatabase(firstDb);

    const secondDb = openDatabase({
      path: dbPath,
      migrations: [embedMigration(runtimeConfigMigration)],
      nowMs,
    });
    const second = new RuntimeConfigStore(secondDb, nowMs);
    second.seedIfEmpty({ GHC_GATEWAY_ADMISSION_ACTIVE_MAX: "8" });
    expect(second.readSnapshot().admission.activeMax).toBe(2);
    expect(second.readRevision()).toBe(1);
    closeDatabase(secondDb);
  });

  it("rejects TypeBox coercion and keeps the previous snapshot on failed update", async () => {
    const { store, close } = await openStore();
    try {
      const before = store.readSnapshot();
      expect(() => store.update({
        ...defaultRuntimeConfigSnapshot(),
        admission: { activeMax: "4", queueMax: 16 },
      }, store.readRevision())).toThrow(RuntimeConfigError);
      expect(store.readSnapshot()).toBe(before);
      expect(store.readRevision()).toBe(1);
    } finally {
      close();
    }
  });

  it("compare-and-swaps revisions and leaves in-flight snapshots unchanged", async () => {
    const { store, close } = await openStore();
    try {
      const inFlight = store.readSnapshot();
      const candidate = defaultRuntimeConfigSnapshot();
      candidate.admission.activeMax = 3;
      const updated = store.update(candidate, 1);
      expect(updated.admission.activeMax).toBe(3);
      expect(store.readRevision()).toBe(2);
      expect(inFlight.admission.activeMax).toBe(4);
      expect(() => {
        inFlight.admission.activeMax = 9;
      }).toThrow();
      expect(() => store.update(candidate, 1)).toThrow(RuntimeConfigError);
      expect(store.readSnapshot().admission.activeMax).toBe(3);
    } finally {
      close();
    }
  });

  it("records commit timing evidence", async () => {
    const { store, close } = await openStore();
    try {
      const samples: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const candidate = defaultRuntimeConfigSnapshot();
        candidate.timeouts.queueMs = 30_000 + index;
        const started = performance.now();
        store.update(candidate, store.readRevision());
        samples.push(performance.now() - started);
      }
      const artifactDir = path.resolve("artifacts", "bench");
      await mkdir(artifactDir, { recursive: true });
      const sorted = samples.slice().sort((left, right) => left - right);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
      await writeFile(path.join(artifactDir, "persistence.json"), `${JSON.stringify({
        kind: "runtime_config_commit",
        samples,
        p95,
      }, null, 2)}\n`);
      expect(p95).toBeGreaterThanOrEqual(0);
    } finally {
      close();
    }
  });
});
