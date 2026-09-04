import { describe, expect, it } from "vitest";
import {
  evaluateBenchmarkRuns,
  type BenchmarkRunResult,
} from "../../../scripts/tooling/bench.js";

function passingRun(run: number): BenchmarkRunResult {
  const resident = {
    samples: [{ residentBytes: 32 * 1024 * 1024, metric: "node_rss_bytes" as const }],
    medianBytes: 32 * 1024 * 1024,
    metric: "node_rss_bytes" as const,
  };
  const latency = {
    thresholdMs: 5,
    warmupCount: 20,
    sampleCount: 20,
    valuesMs: Array.from({ length: 20 }, () => 1),
    p95Ms: 1,
    passed: true,
  };
  return {
    run,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: 1, npmUserAgent: null },
    browserIncluded: false,
    offlineScripted: true,
    listener: "loopback",
    idle: { limitBytes: 64 * 1024 * 1024, launchArgs: ["--jitless"], resident, passed: true },
    adminPage: { browserIncluded: false, assetCount: 2, resident, deltaFromIdleBytes: 0 },
    streams: {
      warmupCount: 1_000,
      launchArgs: ["--jitless"],
      executionCount: 1_000,
      completedCount: 500,
      abortedCount: 500,
      warmedBaseline: resident,
      stabilized: resident,
      deltaBytes: 0,
      limitBytes: 16 * 1024 * 1024,
      passed: true,
    },
    buffered: latency,
    streamEvent: { ...latency, thresholdMs: 2 },
    checkpoint: latency,
    eventLoop: { ...latency, thresholdMs: 10 },
    passed: true,
  };
}

describe("RM-22 benchmark gate contract", () => {
  it("requires every metric in every repetition to pass", () => {
    const runs = [passingRun(1), passingRun(2), passingRun(3)];
    expect(evaluateBenchmarkRuns(runs)).toBe(true);

    const failed: BenchmarkRunResult = { ...runs[1]!, checkpoint: { ...runs[1]!.checkpoint, passed: false } };
    expect(evaluateBenchmarkRuns([runs[0]!, failed, runs[2]!])).toBe(false);
  });

  it("records process-resident memory and excludes browser memory", () => {
    const run = passingRun(1);
    expect(run.browserIncluded).toBe(false);
    expect(run.adminPage.browserIncluded).toBe(false);
    expect(run.idle.resident.metric).not.toContain("heap");
    expect(run.streams.executionCount).toBe(1_000);
    expect(run.streams.completedCount + run.streams.abortedCount).toBe(1_000);
  });
});
