import { describe, expect, it } from "vitest";
import { AdminApiError, type AdminOperationalEvent, type AdminStatus } from "../../../src/admin/api.js";
import { AdminEventStreamHub, ADMIN_EVENT_SUBSCRIBER_CAP } from "../../../src/admin/events.js";

const status: AdminStatus = {
  version: "test",
  uptimeMs: 1,
  health: "ok",
  performance: "healthy",
  performanceMetrics: [],
  admission: { activeRequests: 0, activeStreams: 0, queuedRequests: 0, activeMax: 4, queueMax: 16 },
  storage: { historyCount: 0, usageBucketCount: 0, eventCount: 0 },
  telemetry: { pendingMutations: 0, droppedUsageUpdates: 0, droppedOperationalEvents: 0 },
  daemon: { managed: false },
};

describe("RM-20 admin events stream", () => {
  it("replays, resets, caps subscribers, and cancels only one subscriber", async () => {
    const event: AdminOperationalEvent = {
      eventId: "2",
      occurredAt: "2026-09-02T00:00:00.000Z",
      kind: "gateway_started",
      severity: "info",
      metadata: {},
    };
    const hub = new AdminEventStreamHub({
      status: () => status,
      replayAfter: (eventId) => eventId === "1"
        ? { found: true, latestEventId: "2", items: [event] }
        : { found: false, latestEventId: "2", items: [] },
    }, ((_handler: () => void) => 0 as unknown as NodeJS.Timeout) as typeof setInterval, (() => undefined) as typeof clearInterval);

    const first = hub.open("1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const second = hub.open(null);
    expect(hub.activeSubscribers()).toBe(2);
    await first.body?.cancel();
    expect(hub.activeSubscribers()).toBe(1);
    await second.body?.cancel();
    expect(hub.activeSubscribers()).toBe(0);

    expect(() => hub.open("bad-id")).toThrow(AdminApiError);
    const opened: Response[] = [];
    for (let index = 0; index < ADMIN_EVENT_SUBSCRIBER_CAP; index += 1) {
      opened.push(hub.open(null));
    }
    expect(() => hub.open(null)).toThrow(AdminApiError);
    await Promise.all(opened.map(async (response) => await response.body?.cancel()));

    const reset = hub.open("99");
    const text = await readSome(reset);
    expect(text).toContain("event: reset");
  });
});

async function readSome(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const first = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(first.value);
}
