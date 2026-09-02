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

async function open(gateway: Gateway, cookie: string, lastEventId?: string): Promise<Response> {
  const headers = new Headers({ cookie });
  if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
  return await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/events/stream`, { headers }));
}

function decode(value: Uint8Array | undefined): string {
  return new TextDecoder().decode(value);
}
