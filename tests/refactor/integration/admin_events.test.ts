import { describe, expect, it } from "vitest";
import { createAdminModule } from "../../../src/admin/routes.js";
import { ADMIN_EVENT_SUBSCRIBER_CAP } from "../../../src/admin/events.js";
import type { AdminModule } from "../../../src/gateway/create_gateway.js";
import { createGateway, type Gateway } from "../../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { adminDependencies, login, operationalEvent, type TestAdminDependencies } from "../contract/admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";

describe("RM-20 Admin event stream", () => {
  it("emits exact replay, performance, operational, and reset frames", async () => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      const replay = await open(harness.gateway, session.cookie, "1");
      const reader = replay.body!.getReader();
      expect(decode((await reader.read()).value)).toBe(
        `id: 2\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event: operationalEvent("2") })}\n\n`,
      );
      expect(decode((await reader.read()).value)).toContain("event: performance\ndata: {\"kind\":\"performance\",\"status\":");
      harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent("3") });
      expect(decode((await reader.read()).value)).toBe(
        `id: 3\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event: operationalEvent("3") })}\n\n`,
      );
      await reader.cancel();

      const reset = await open(harness.gateway, session.cookie, "99");
      const resetReader = reset.body!.getReader();
      expect(decode((await resetReader.read()).value)).toBe(
        "event: reset\ndata: {\"kind\":\"reset\",\"reason\":\"history_unavailable\",\"latestEventId\":\"2\"}\n\n",
      );
      await resetReader.cancel();
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed Last-Event-ID, caps subscribers, and closes streams on module close", async () => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      expect((await open(harness.gateway, session.cookie, "01")).status).toBe(400);
      const responses: Response[] = [];
      for (let index = 0; index < ADMIN_EVENT_SUBSCRIBER_CAP; index += 1) {
        responses.push(await open(harness.gateway, session.cookie));
      }
      expect((await open(harness.gateway, session.cookie)).status).toBe(503);
      harness.admin.close();
      for (const response of responses) {
        const reader = response.body!.getReader();
        await reader.read();
        expect((await reader.read()).done).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it("emits a 15-second heartbeat only when no event is queued", async () => {
    let heartbeat: (() => void) | undefined;
    const base = adminDependencies();
    const dependencies: TestAdminDependencies = { ...base,
      setInterval: ((handler: TimerHandler) => {
        heartbeat = handler as () => void;
        return 1 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await open(harness.gateway, session.cookie);
      const reader = response.body!.getReader();
      await reader.read();
      heartbeat?.();
      expect(decode((await reader.read()).value)).toBe(": keep-alive\n\n");
      await reader.cancel();
    } finally {
      await harness.close();
    }
  });

  it("loads retained replay lazily in bounded batches beyond the live queue cap", async () => {
    const dependencies = adminDependencies();
    const calls: string[] = [];
    dependencies.telemetry.replayEvents = async (after, signal) => {
      signal.throwIfAborted();
      calls.push(after);
      const start = Number(after) + 1;
      const items = Array.from(
        { length: Math.min(128, Math.max(0, 513 - start + 1)) },
        (_, index) => operationalEvent(String(start + index)),
      );
      return {
        found: true,
        latestEventId: "513",
        items,
      };
    };
    const harness = await createHarness(dependencies);
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await open(harness.gateway, session.cookie, "1");
      expect(response.status).toBe(200);
      expect(calls).toEqual(["1"]);
      const reader = response.body!.getReader();
      let text = "";
      text += decode((await reader.read()).value);
      harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent("129") });
      harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent("514") });
      for (let index = 1; index < 514; index += 1) {
        text += decode((await reader.read()).value);
      }
      expect(calls).toEqual(["1", "33", "65", "97", "129", "161", "193", "225", "257", "289", "321", "353", "385", "417", "449", "481"]);
      expect(text).toContain("id: 2\n");
      expect(text).toContain("id: 513\n");
      expect(text).toContain("event: performance\n");
      expect(text.match(/id: 129\n/gu)).toHaveLength(1);
      expect(text.indexOf("id: 513\n")).toBeLessThan(text.indexOf("event: performance\n"));
      expect(text.indexOf("event: performance\n")).toBeLessThan(text.indexOf("id: 514\n"));
      await reader.cancel();
    } finally {
      await harness.close();
    }
  });

  it("closes authenticated streams on logout, idle expiry, and caller abort", async () => {
    const now = { value: 1_800_000_000_000 };
    const timers = fakeTimeouts(now);
    const dependencies = {
      ...adminDependencies(now),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    };
    const harness = await createHarness(dependencies);
    try {
      const firstSession = await login(harness.gateway, harness.admin);
      const logoutStream = await open(harness.gateway, firstSession.cookie);
      const logoutReader = logoutStream.body!.getReader();
      await logoutReader.read();
      const logout = await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/logout`, {
        method: "POST",
        headers: {
          cookie: firstSession.cookie,
          origin: ORIGIN,
          "x-ghcg-csrf": firstSession.csrf,
        },
      }));
      expect(logout.status).toBe(204);
      expect((await logoutReader.read()).done).toBe(true);

      const secondSession = await login(harness.gateway, harness.admin);
      const idleStream = await open(harness.gateway, secondSession.cookie);
      const idleReader = idleStream.body!.getReader();
      await idleReader.read();
      timers.advance(30 * 60_000);
      expect((await idleReader.read()).done).toBe(true);

      const thirdSession = await login(harness.gateway, harness.admin);
      const caller = new AbortController();
      const abortedStream = await open(harness.gateway, thirdSession.cookie, undefined, caller.signal);
      const abortedReader = abortedStream.body!.getReader();
      await abortedReader.read();
      caller.abort();
      expect((await abortedReader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("keeps an SSE watcher across idle refreshes and closes it at absolute expiry", async () => {
    const now = { value: 1_800_000_000_000 };
    const timers = fakeTimeouts(now);
    const harness = await createHarness({
      ...adminDependencies(now),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await open(harness.gateway, session.cookie);
      const reader = response.body!.getReader();
      await reader.read();
      for (let interval = 1; interval < 36; interval += 1) {
        timers.advance(20 * 60_000);
        expect((await harness.gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/session`, {
          headers: { cookie: session.cookie },
        }))).status).toBe(200);
      }
      timers.advance(20 * 60_000);
      expect((await reader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("disconnects a subscriber whose live queue reaches 128 events", async () => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await open(harness.gateway, session.cookie);
      const reader = response.body!.getReader();
      await reader.read();
      for (let eventId = 1; eventId <= 129; eventId += 1) {
        harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent(String(eventId)) });
      }
      expect((await reader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("disconnects a subscriber whose live queue exceeds 1 MiB before 128 events", async () => {
    const harness = await createHarness();
    try {
      const session = await login(harness.gateway, harness.admin);
      const response = await open(harness.gateway, session.cookie);
      const reader = response.body!.getReader();
      await reader.read();
      for (let eventId = 1; eventId <= 70; eventId += 1) {
        harness.dependencies.emitted.publish({
          kind: "operational",
          event: { ...operationalEvent(String(eventId)), metadata: { status: "x".repeat(16_000) } },
        });
      }
      expect((await reader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

async function createHarness(dependencies = adminDependencies()): Promise<{
  readonly gateway: Gateway;
  readonly admin: AdminModule;
  readonly dependencies: TestAdminDependencies;
  readonly close: () => Promise<void>;
}> {
  let token = 0;
  const admin = createAdminModule({ ...dependencies, createToken: () => `event-token-${++token}` });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/rm20-events" }), runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_events" });
  return { gateway, admin, dependencies, close: async () => gateway.close() };
}

async function open(
  gateway: Gateway,
  cookie: string,
  lastEventId?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers({ cookie });
  if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
  return await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/events/stream`, {
    headers,
    ...(signal === undefined ? {} : { signal }),
  }));
}

function decode(value: Uint8Array | undefined): string {
  return new TextDecoder().decode(value);
}

function fakeTimeouts(now: { value: number }): {
  readonly setTimeout: typeof setTimeout;
  readonly clearTimeout: typeof clearTimeout;
  readonly advance: (milliseconds: number) => void;
} {
  let nextId = 0;
  const timers = new Map<number, { readonly due: number; readonly handler: () => void }>();
  return {
    setTimeout: ((handler: () => void, delay?: number) => {
      const id = ++nextId;
      timers.set(id, { due: now.value + (delay ?? 0), handler });
      return id as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeout: ((timer: NodeJS.Timeout | number | string | undefined) => {
      timers.delete(Number(timer));
    }) as typeof clearTimeout,
    advance(milliseconds: number): void {
      now.value += milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now.value)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (due === undefined) {
          return;
        }
        timers.delete(due[0]);
        due[1].handler();
      }
    },
  };
}
