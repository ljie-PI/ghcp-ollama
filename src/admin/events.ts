import type { GatewayActivity } from "../gateway/create_gateway.js";
import type {
  AdminMonitorEvent,
  AdminOperationalEvent,
  AdminTelemetry,
} from "../telemetry/admin.js";
import { AdminApiError, type AdminManagementApi } from "./api.js";

export const ADMIN_EVENT_SUBSCRIBER_CAP = 8;
export const ADMIN_EVENT_QUEUE_CAP = 128;
export const ADMIN_EVENT_QUEUE_BYTES = 1_048_576;
export const ADMIN_EVENT_HEARTBEAT_MS = 15_000;

const encoder = new TextEncoder();

interface Subscriber {
  readonly queue: Array<{ readonly bytes: Uint8Array; readonly counted: boolean }>;
  readonly signal: AbortSignal;
  readonly activity: GatewayActivity;
  readonly onAbort: () => void;
  readonly wake: () => void;
  readonly heartbeat: ReturnType<typeof setInterval>;
  queuedBytes: number;
  queuedEvents: number;
  waiting: (() => void) | undefined;
  latestEventId: bigint | null;
  closed: boolean;
}

interface OpeningSubscriber {
  readonly operational: Array<{ readonly eventId: bigint; readonly frame: Uint8Array }>;
  queuedBytes: number;
  overflowed: boolean;
}

export class AdminEventStreamHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly openingSubscribers = new Set<OpeningSubscriber>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly telemetry: AdminTelemetry,
    private readonly api: Pick<AdminManagementApi, "status">,
    private readonly setTimer: typeof setInterval = setInterval,
    private readonly clearTimer: typeof clearInterval = clearInterval,
  ) {
    this.unsubscribe = telemetry.subscribe((event) => this.publish(event));
  }

  activeSubscribers(): number {
    return this.subscribers.size;
  }

  async open(
    lastEventId: string | null,
    signal: AbortSignal,
    activity: GatewayActivity,
  ): Promise<Response> {
    if (this.closed || this.subscribers.size + this.openingSubscribers.size >= ADMIN_EVENT_SUBSCRIBER_CAP) {
      throw new AdminApiError("capacity_exceeded");
    }
    if (lastEventId !== null && !/^(?:0|[1-9][0-9]*)$/u.test(lastEventId)) {
      throw new AdminApiError("validation_failed");
    }
    signal.throwIfAborted();
    const opening: OpeningSubscriber = { operational: [], queuedBytes: 0, overflowed: false };
    this.openingSubscribers.add(opening);
    let initial: { readonly frames: readonly Uint8Array[]; readonly latestEventId: bigint | null };
    try {
      initial = await this.initialFrames(lastEventId, signal, activity);
      signal.throwIfAborted();
      if (this.closed) {
        throw new DOMException("closed", "AbortError");
      }
    } finally {
      this.openingSubscribers.delete(opening);
    }
    if (opening.overflowed) {
      throw new AdminApiError("capacity_exceeded");
    }
    const pendingFrames = opening.operational
      .filter((pending) => initial.latestEventId === null || pending.eventId > initial.latestEventId)
      .map((pending) => pending.frame);
    const frames = [...initial.frames, ...pendingFrames];
    if (frames.length > ADMIN_EVENT_QUEUE_CAP || totalBytes(frames) > ADMIN_EVENT_QUEUE_BYTES) {
      throw new AdminApiError("capacity_exceeded");
    }
    const latestEventId = opening.operational.at(-1)?.eventId ?? initial.latestEventId;

    let subscriber: Subscriber | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const wake = (): void => {
          const resolve = subscriber?.waiting;
          if (resolve !== undefined) {
            subscriber!.waiting = undefined;
            resolve();
          }
        };
        const onAbort = (): void => this.closeSubscriber(subscriber);
        subscriber = {
          queue: [],
          signal,
          activity,
          onAbort,
          wake,
          heartbeat: this.setTimer(() => this.enqueue(subscriber, encoder.encode(": keep-alive\n\n"), false), ADMIN_EVENT_HEARTBEAT_MS),
          queuedBytes: 0,
          queuedEvents: 0,
          waiting: undefined,
          latestEventId,
          closed: false,
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.subscribers.add(subscriber);
        for (const frame of frames) {
          this.enqueue(subscriber, frame, true);
        }
        if (subscriber.closed) {
          controller.close();
        }
      },
      pull: async (controller) => {
        const current = subscriber;
        if (current === undefined || current.closed) {
          controller.close();
          return;
        }
        if (current.queue.length === 0) {
          await new Promise<void>((resolve) => {
            current.waiting = resolve;
          });
        }
        if (current.closed || current.signal.aborted) {
          controller.close();
          return;
        }
        const frame = current.queue.shift();
        if (frame !== undefined) {
          if (frame.counted) {
            current.queuedEvents -= 1;
            current.queuedBytes -= frame.bytes.byteLength;
          }
          controller.enqueue(frame.bytes);
        }
      },
      cancel: () => this.closeSubscriber(subscriber),
    }, { highWaterMark: 0 });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe();
    for (const subscriber of [...this.subscribers]) {
      this.closeSubscriber(subscriber);
    }
  }

  private async initialFrames(
    lastEventId: string | null,
    signal: AbortSignal,
    activity: GatewayActivity,
  ): Promise<{ readonly frames: readonly Uint8Array[]; readonly latestEventId: bigint | null }> {
    const frames: Uint8Array[] = [];
    let latestEventId: bigint | null = null;
    if (lastEventId !== null) {
      const replay = await this.telemetry.replayEvents(lastEventId, signal);
      if (replay.found) {
        frames.push(...replay.items.map(operationalFrame));
      } else {
        frames.push(resetFrame(replay.latestEventId));
      }
      latestEventId = replay.latestEventId === null ? BigInt(lastEventId) : BigInt(replay.latestEventId);
    }
    frames.push(performanceFrame(this.api.status(activity)));
    if (frames.length > ADMIN_EVENT_QUEUE_CAP || totalBytes(frames) > ADMIN_EVENT_QUEUE_BYTES) {
      throw new AdminApiError("capacity_exceeded");
    }
    return { frames, latestEventId };
  }

  private publish(event: Readonly<AdminMonitorEvent>): void {
    if (event.kind === "operational") {
      const eventId = BigInt(event.event.eventId);
      const frame = operationalFrame(event.event);
      for (const opening of this.openingSubscribers) {
        if (opening.operational.length >= ADMIN_EVENT_QUEUE_CAP
          || opening.queuedBytes + frame.byteLength > ADMIN_EVENT_QUEUE_BYTES) {
          opening.overflowed = true;
          continue;
        }
        opening.operational.push({ eventId, frame });
        opening.queuedBytes += frame.byteLength;
      }
    }
    for (const subscriber of [...this.subscribers]) {
      let frame: Uint8Array;
      if (event.kind === "operational") {
        const eventId = BigInt(event.event.eventId);
        if (subscriber.latestEventId !== null && eventId <= subscriber.latestEventId) {
          continue;
        }
        subscriber.latestEventId = eventId;
        frame = operationalFrame(event.event);
      } else {
        frame = performanceFrame(this.api.status(subscriber.activity));
      }
      this.enqueue(subscriber, frame, true);
    }
  }

  private enqueue(subscriber: Subscriber | undefined, frame: Uint8Array, counted: boolean): void {
    if (subscriber === undefined || subscriber.closed) {
      return;
    }
    if (!counted && subscriber.queue.length > 0) {
      return;
    }
    if (counted && (subscriber.queuedEvents >= ADMIN_EVENT_QUEUE_CAP
      || subscriber.queuedBytes + frame.byteLength > ADMIN_EVENT_QUEUE_BYTES)) {
      this.closeSubscriber(subscriber);
      return;
    }
    subscriber.queue.push({ bytes: frame, counted });
    if (counted) {
      subscriber.queuedEvents += 1;
      subscriber.queuedBytes += frame.byteLength;
    }
    subscriber.wake();
  }

  private closeSubscriber(subscriber: Subscriber | undefined): void {
    if (subscriber === undefined || subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    this.clearTimer(subscriber.heartbeat);
    subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    subscriber.queue.length = 0;
    subscriber.queuedBytes = 0;
    subscriber.queuedEvents = 0;
    this.subscribers.delete(subscriber);
    subscriber.wake();
  }
}

function operationalFrame(event: AdminOperationalEvent): Uint8Array {
  return encoder.encode(`id: ${event.eventId}\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event })}\n\n`);
}

function performanceFrame(status: ReturnType<AdminManagementApi["status"]>): Uint8Array {
  return encoder.encode(`event: performance\ndata: ${JSON.stringify({ kind: "performance", status })}\n\n`);
}

function resetFrame(latestEventId: string | null): Uint8Array {
  return encoder.encode(`event: reset\ndata: ${JSON.stringify({ kind: "reset", reason: "history_unavailable", latestEventId })}\n\n`);
}

function totalBytes(frames: readonly Uint8Array[]): number {
  return frames.reduce((total, frame) => total + frame.byteLength, 0);
}
