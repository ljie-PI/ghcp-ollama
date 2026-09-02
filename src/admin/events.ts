import type { AdminOperationalEvent, AdminStatus, DefaultAdminManagementApi } from "./api.js";
import { AdminApiError } from "./api.js";

export const ADMIN_EVENT_SUBSCRIBER_CAP = 8;
export const ADMIN_EVENT_QUEUE_CAP = 128;
export const ADMIN_EVENT_QUEUE_BYTES = 1_048_576;
export const ADMIN_EVENT_HEARTBEAT_MS = 15_000;

interface Subscriber {
  readonly id: number;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  queuedFrames: number;
  queuedBytes: number;
  closed: boolean;
  heartbeat?: NodeJS.Timeout;
}

export class AdminEventStreamHub {
  private readonly subscribers = new Map<number, Subscriber>();
  private nextId = 0;

  constructor(
    private readonly api: Pick<DefaultAdminManagementApi, "status" | "replayAfter">,
    private readonly setTimer: typeof setInterval = setInterval,
    private readonly clearTimer: typeof clearInterval = clearInterval,
  ) {}

  activeSubscribers(): number {
    return this.subscribers.size;
  }

  publishOperational(event: AdminOperationalEvent): void {
    const frame = operationalFrame(event);
    for (const subscriber of [...this.subscribers.values()]) {
      this.send(subscriber, frame);
    }
  }

  publishPerformance(status: AdminStatus): void {
    const frame = performanceFrame(status);
    for (const subscriber of [...this.subscribers.values()]) {
      this.send(subscriber, frame);
    }
  }

  open(lastEventId: string | null): Response {
    if (this.subscribers.size >= ADMIN_EVENT_SUBSCRIBER_CAP) {
      throw new AdminApiError("capacity_exceeded", "capacity exceeded");
    }
    if (lastEventId !== null && !/^[0-9]+$/u.test(lastEventId)) {
      throw new AdminApiError("validation_failed", "validation failed");
    }
    const frames = this.initialFrames(lastEventId);
    let openedSubscriber: Subscriber | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const subscriber: Subscriber = {
          id: this.nextId,
          controller,
          queuedFrames: 0,
          queuedBytes: 0,
          closed: false,
        };
        openedSubscriber = subscriber;
        this.nextId += 1;
        this.subscribers.set(subscriber.id, subscriber);
        for (const frame of frames) {
          this.send(subscriber, frame);
        }
        subscriber.heartbeat = this.setTimer(() => {
          this.send(subscriber, ": keep-alive\n\n");
        }, ADMIN_EVENT_HEARTBEAT_MS);
      },
      pull: (controller) => {
        const subscriber = this.findByController(controller);
        if (subscriber !== undefined) {
          subscriber.queuedFrames = 0;
          subscriber.queuedBytes = 0;
        }
      },
      cancel: () => {
        if (openedSubscriber !== undefined) {
          this.close(openedSubscriber);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  closeAll(): void {
    for (const subscriber of [...this.subscribers.values()]) {
      this.close(subscriber);
    }
  }

  private initialFrames(lastEventId: string | null): readonly string[] {
    const frames: string[] = [];
    if (lastEventId !== null) {
      const replay = this.api.replayAfter(lastEventId, ADMIN_EVENT_QUEUE_CAP);
      if (replay.found) {
        frames.push(...replay.items.map(operationalFrame));
      } else {
        frames.push(resetFrame(replay.latestEventId));
      }
    }
    frames.push(performanceFrame(this.api.status()));
    return frames;
  }

  private send(subscriber: Subscriber, frame: string): void {
    if (subscriber.closed) {
      return;
    }
    const bytes = new TextEncoder().encode(frame);
    if (
      subscriber.queuedFrames >= ADMIN_EVENT_QUEUE_CAP
      || subscriber.queuedBytes + bytes.byteLength > ADMIN_EVENT_QUEUE_BYTES
      || (subscriber.controller.desiredSize !== null && subscriber.controller.desiredSize < 0)
    ) {
      this.close(subscriber);
      return;
    }
    subscriber.queuedFrames += 1;
    subscriber.queuedBytes += bytes.byteLength;
    try {
      subscriber.controller.enqueue(bytes);
    } catch {
      this.close(subscriber);
    }
  }

  private close(subscriber: Subscriber): void {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    if (subscriber.heartbeat !== undefined) {
      this.clearTimer(subscriber.heartbeat);
    }
    this.subscribers.delete(subscriber.id);
    try {
      subscriber.controller.close();
    } catch {
      // Already closed by the consumer.
    }
  }

  private findByController(controller: ReadableStreamDefaultController<Uint8Array>): Subscriber | undefined {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.controller === controller) {
        return subscriber;
      }
    }
    return undefined;
  }
}

function operationalFrame(event: AdminOperationalEvent): string {
  return `id: ${event.eventId}\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event })}\n\n`;
}

function performanceFrame(status: AdminStatus): string {
  return `event: performance\ndata: ${JSON.stringify({ kind: "performance", status })}\n\n`;
}

function resetFrame(latestEventId: string | null): string {
  return `event: reset\ndata: ${JSON.stringify({ kind: "reset", reason: "history_unavailable", latestEventId })}\n\n`;
}
