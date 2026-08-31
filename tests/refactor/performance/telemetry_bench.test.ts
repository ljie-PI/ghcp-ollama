import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as telemetryMigration } from "../../../src/persistence/migrations/020_telemetry.js";
import { TelemetryRecorder } from "../../../src/telemetry/recorder.js";

describe("RM-05 telemetry bench", () => {
  it("records flush timing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-tbench-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(telemetryMigration)],
    });
    const recorder = new TelemetryRecorder(database);
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      recorder.recordUsage({
        occurredAtMs: Date.now(),
        accountId: "github.com/1",
        protocol: "openai_chat",
        resolvedModel: "gpt",
        outcome: "success",
        requestCount: 1,
        errorCount: 0,
        inputTokens: 1,
        outputTokens: 1,
        cacheTokens: 0,
        latencyMs: 1,
      });
      const started = performance.now();
      await recorder.flush();
      samples.push(performance.now() - started);
    }
    closeDatabase(database);
    const artifactDir = path.resolve("dist-refactor", "bench");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "telemetry.json"), `${JSON.stringify({ samples }, null, 2)}\n`);
    expect(samples).toHaveLength(20);
  });
});
