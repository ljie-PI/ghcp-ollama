export const WINDOW_MS = 5 * 60 * 1000;
export const MIN_OBSERVATIONS = 20;
export const THRESHOLDS = {
  bufferedMs: 5,
  eventMs: 2,
  checkpointMs: 5,
  eventLoopMs: 10,
} as const;

export type PerformanceStatus = "healthy" | "degraded";
export type MetricStatus = "healthy" | "over" | "insufficient_data";

export interface PerformanceSnapshot {
  readonly status: PerformanceStatus;
  readonly startedAtMs: number | null;
  readonly metrics: {
    readonly bufferedMs: { readonly p95: number | null; readonly status: MetricStatus };
    readonly eventMs: { readonly p95: number | null; readonly status: MetricStatus };
    readonly checkpointMs: { readonly p95: number | null; readonly status: MetricStatus };
    readonly eventLoopMs: { readonly p95: number | null; readonly status: MetricStatus };
  };
}

export class PerformanceWindows {
  private readonly buffered: number[] = [];
  private readonly event: number[] = [];
  private readonly checkpoint: number[] = [];
  private readonly eventLoop: number[] = [];
  private overWindows = 0;
  private healthyWindows = 0;
  private status: PerformanceStatus = "healthy";
  private degradedSinceMs: number | null = null;

  constructor(private readonly nowMs: () => number = Date.now) {}

  observeBuffered(ms: number): void {
    this.buffered.push(ms);
  }

  observeEvent(ms: number): void {
    this.event.push(ms);
  }

  observeCheckpoint(ms: number): void {
    this.checkpoint.push(ms);
  }

  observeEventLoop(ms: number): void {
    this.eventLoop.push(ms);
  }

  evaluateWindow(): { readonly snapshot: PerformanceSnapshot; readonly transition: "enter" | "clear" | null } {
    const buffered = summarize(this.buffered, THRESHOLDS.bufferedMs);
    const event = summarize(this.event, THRESHOLDS.eventMs);
    const checkpoint = summarize(this.checkpoint, THRESHOLDS.checkpointMs);
    const eventLoop = summarize(this.eventLoop, THRESHOLDS.eventLoopMs);
    this.buffered.length = 0;
    this.event.length = 0;
    this.checkpoint.length = 0;
    this.eventLoop.length = 0;

    const evaluated = [buffered, event, checkpoint, eventLoop].filter((metric) => metric.status !== "insufficient_data");
    let transition: "enter" | "clear" | null = null;
    if (evaluated.length > 0) {
      const over = evaluated.some((metric) => metric.status === "over");
      if (over) {
        this.overWindows += 1;
        this.healthyWindows = 0;
        if (this.status === "healthy" && this.overWindows >= 3) {
          this.status = "degraded";
          this.degradedSinceMs = this.nowMs();
          transition = "enter";
          this.overWindows = 0;
        }
      } else {
        this.healthyWindows += 1;
        this.overWindows = 0;
        if (this.status === "degraded" && this.healthyWindows >= 3) {
          this.status = "healthy";
          this.degradedSinceMs = null;
          transition = "clear";
          this.healthyWindows = 0;
        }
      }
    }

    return {
      snapshot: {
        status: this.status,
        startedAtMs: this.degradedSinceMs,
        metrics: {
          bufferedMs: buffered,
          eventMs: event,
          checkpointMs: checkpoint,
          eventLoopMs: eventLoop,
        },
      },
      transition,
    };
  }
}

export function nearestRankP95(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function summarize(samples: readonly number[], threshold: number): { readonly p95: number | null; readonly status: MetricStatus } {
  if (samples.length < MIN_OBSERVATIONS) {
    return { p95: nearestRankP95(samples), status: "insufficient_data" };
  }
  const p95 = nearestRankP95(samples);
  if (p95 === null) {
    return { p95: null, status: "insufficient_data" };
  }
  return { p95, status: p95 > threshold ? "over" : "healthy" };
}
