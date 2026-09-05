import { describe, expect, it } from "vitest";
import { runBenchmarkIteration } from "../../scripts/tooling/bench.js";

describe("full-gateway benchmark smoke", () => {
  it("measures production gateway, stream, and SQLite seams with scripted remotes", async () => {
    const result = await runBenchmarkIteration(1, {
      memoryStreams: 10,
      bufferedSamples: 20,
      eventSamples: 20,
      checkpointStreams: 4,
      openAdmin: false,
    });

    expect(result.offlineScripted).toBe(true);
    expect(result.listener).toBe("loopback");
    expect(result.streams.executionCount).toBe(10);
    expect(result.buffered.valuesMs).toHaveLength(20);
    expect(result.streamEvent.valuesMs).toHaveLength(20);
    expect(result.checkpoint.valuesMs.length).toBeGreaterThanOrEqual(4);
    expect(result.eventLoop.valuesMs.length).toBeGreaterThanOrEqual(100);
    expect(result.buffered.valuesMs.some((value) => value > 0)).toBe(true);
    expect(result.checkpoint.valuesMs.some((value) => value > 0)).toBe(true);
  }, 60_000);
});
