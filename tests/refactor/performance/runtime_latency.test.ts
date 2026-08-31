import { describe, expect, it } from "vitest";
import { nearestRankP95, THRESHOLDS } from "../../../src/telemetry/performance.js";

describe("RM-05 runtime latency gates", () => {
  it("keeps documented p95 thresholds", () => {
    expect(THRESHOLDS.bufferedMs).toBe(5);
    expect(THRESHOLDS.eventMs).toBe(2);
    expect(THRESHOLDS.checkpointMs).toBe(5);
    expect(THRESHOLDS.eventLoopMs).toBe(10);
    expect(nearestRankP95([1, 1, 1, 1])).toBe(1);
  });
});
