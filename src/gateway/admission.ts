import type { RuntimeConfigSnapshot } from "../config/schema.js";
import { GatewayFailureError } from "./failures.js";

export type DelayFn = (ms: number, signal: AbortSignal) => Promise<void>;

interface Waiter {
  readonly snapshot: RuntimeConfigSnapshot;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class AdmissionController {
  private active = 0;
  private closed = false;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly delay: DelayFn,
    private readonly nowMs: () => number,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  async acquire(snapshot: RuntimeConfigSnapshot, signal: AbortSignal): Promise<() => void> {
    if (this.closed || signal.aborted) {
      throw new GatewayFailureError({ kind: "aborted" });
    }

    if (this.active < snapshot.admission.activeMax) {
      this.active += 1;
      return () => this.release();
    }

    if (this.waiters.length >= snapshot.admission.queueMax) {
      throw new GatewayFailureError({ kind: "queue_full" });
    }

    await this.waitForSlot(snapshot, signal);
    this.active += 1;
    return () => this.release();
  }

  close(): void {
    this.closed = true;
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      waiter.reject(new GatewayFailureError({ kind: "aborted" }));
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next !== undefined) {
      next.resolve();
    }
  }

  private async waitForSlot(snapshot: RuntimeConfigSnapshot, signal: AbortSignal): Promise<void> {
    const deadline = this.nowMs() + snapshot.timeouts.queueMs;
    await new Promise<void>((resolve, reject) => {
      const timeoutAbort = new AbortController();
      const waiter: Waiter = {
        snapshot,
        signal,
        resolve: () => {
          timeoutAbort.abort();
          resolve();
        },
        reject: (error: unknown) => {
          timeoutAbort.abort();
          reject(error);
        },
      };
      this.waiters.push(waiter);

      const onAbort = (): void => {
        this.removeWaiter(waiter);
        waiter.reject(new GatewayFailureError({ kind: "aborted" }));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      const remaining = Math.max(0, deadline - this.nowMs());
      this.delay(remaining, timeoutAbort.signal).then(
        () => {
          if (this.waiters.includes(waiter)) {
            this.removeWaiter(waiter);
            signal.removeEventListener("abort", onAbort);
            waiter.reject(new GatewayFailureError({ kind: "queue_timeout" }));
          }
        },
        (error: unknown) => {
          if (!this.waiters.includes(waiter)) {
            return;
          }
          this.removeWaiter(waiter);
          signal.removeEventListener("abort", onAbort);
          waiter.reject(error instanceof GatewayFailureError ? error : new GatewayFailureError({ kind: "aborted" }));
        },
      );
    });
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }
}

export function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new GatewayFailureError({ kind: "aborted" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GatewayFailureError({ kind: "aborted" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
