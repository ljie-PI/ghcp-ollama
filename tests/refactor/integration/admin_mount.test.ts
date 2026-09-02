import { describe, expect, it } from "vitest";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import {
  createGateway,
  type AdminModule,
  type AdminRequestContext,
  type AdminStaticModule,
  type LocalControlModule,
} from "../../../src/gateway/create_gateway.js";
import type { RouteRegistration } from "../../../src/gateway/hono_app.js";

const textRoute = (path: string, body: string): RouteRegistration => ({
  method: "GET",
  path,
  admission: "none",
  body: "none",
  presentFailure: () => new Response("protocol failure", { status: 500 }),
  endpoint: async () => new Response(body),
});

function startup(port = 31400) {
  return parseStartupConfig(["--port", String(port)], {}, { homedir: "Q:/tmp/rm20-mount" });
}

describe("RM-20 additive Gateway mount", () => {
  it("uses control, Admin API, protocol/probe, then Admin static precedence", async () => {
    const calls: string[] = [];
    const contexts: AdminRequestContext[] = [];
    const admin: AdminModule = {
      async handle(request, context) {
        calls.push(`admin:${new URL(request.url).pathname}`);
        contexts.push(context);
        return new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      },
      mintBootstrap: () => ({ kind: "capacity" }),
      close() {},
    };
    const control: LocalControlModule = {
      async handle(request, context) {
        calls.push(`control:${new URL(request.url).pathname}:${context.requestId}:${context.listenerOrigin}`);
        return new Response("control");
      },
      close() {},
    };
    const adminStatic: AdminStaticModule = {
      async handle(request) {
        calls.push(`static:${new URL(request.url).pathname}`);
        return new Response("static");
      },
    };
    let nextId = 0;
    const gateway = await createGateway({
      startup: startup(32123),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [textRoute("/admin/api/v1/status", "protocol"), textRoute("/v1/example", "protocol")], {
      admin,
      control,
      adminStatic,
      createRequestId: () => `req_mount_${++nextId}`,
    });

    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/__ghcg/control/v1/status"))).text()).toBe("control");
    const unknownAdmin = await gateway.fetch(new Request("http://127.0.0.1:32123/admin/api/v1/missing", {
      headers: { "x-request-id": "caller-id" },
    }));
    expect(unknownAdmin.status).toBe(404);
    expect(await unknownAdmin.json()).toEqual({ error: { code: "not_found" } });
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/v1/example"))).text()).toBe("protocol");
    expect((await gateway.fetch(new Request("http://127.0.0.1:32123/healthz"))).status).toBe(200);
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/admin/dashboard"))).text()).toBe("static");
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/admin/api/v10"))).text()).toBe("static");
    expect((await gateway.fetch(new Request("http://127.0.0.1:32123/admin/dashboard", { method: "POST" }))).status).toBe(404);

    expect(calls).toEqual([
      "control:/__ghcg/control/v1/status:req_mount_1:http://127.0.0.1:32123",
      "admin:/admin/api/v1/missing",
      "static:/admin/dashboard",
      "static:/admin/api/v10",
    ]);
    expect(contexts[0]?.requestId).toBe("req_mount_2");
    expect(contexts[0]?.listenerOrigin).toBe("http://127.0.0.1:32123");
    expect(contexts[0]?.signal.aborted).toBe(false);
    await gateway.close();

    const staticOnly = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], {
      adminStatic,
    });
    expect((await staticOnly.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/missing"))).status).toBe(404);
    expect(calls).not.toContain("static:/admin/api/v1/missing");
    await staticOnly.close();
  });

  it("combines caller and Gateway shutdown cancellation for mounted work", async () => {
    const signals: AbortSignal[] = [];
    const started: Array<() => void> = [];
    const admin: AdminModule = {
      async handle(_request, context) {
        signals.push(context.signal);
        started.shift()?.();
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        return new Response(null);
      },
      mintBootstrap: () => ({ kind: "capacity" }),
      close() {},
    };
    const gateway = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], { admin });

    const caller = new AbortController();
    const callerStarted = new Promise<void>((resolve) => started.push(resolve));
    const callerRequest = gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status", { signal: caller.signal }));
    await callerStarted;
    caller.abort();
    await callerRequest;
    expect(signals[0]?.aborted).toBe(true);

    const shutdownStarted = new Promise<void>((resolve) => started.push(resolve));
    const shutdownRequest = gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"));
    await shutdownStarted;
    await gateway.close();
    await shutdownRequest;
    expect(signals[1]?.aborted).toBe(true);
  });

  it("reports admission and active stream lifecycle through GatewayActivity", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 1;
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const route: RouteRegistration = {
      method: "GET",
      path: "/v1/stream",
      admission: "inference",
      body: "none",
      presentFailure: () => new Response("failure", { status: 503 }),
      endpoint: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
        },
      }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
    };
    const admin: AdminModule = {
      async handle(_request, context) {
        return Response.json(context.activity.snapshot());
      },
      mintBootstrap: () => ({ kind: "capacity" }),
      close() {},
    };
    const gateway = await createGateway({ startup: startup(), runtime }, [route], { admin });

    const first = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/stream"));
    const secondPromise = gateway.fetch(new Request("http://127.0.0.1:31400/v1/stream"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"))).json()).toEqual({
      activeRequests: 1,
      activeStreams: 1,
      queuedRequests: 1,
    });

    streams[0]?.close();
    await first.arrayBuffer();
    const second = await secondPromise;
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"))).json()).toEqual({
      activeRequests: 1,
      activeStreams: 1,
      queuedRequests: 0,
    });
    streams[1]?.close();
    await second.arrayBuffer();
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"))).json()).toEqual({
      activeRequests: 0,
      activeStreams: 0,
      queuedRequests: 0,
    });
    await gateway.close();
  });

  it("closes control, Admin, then existing resources exactly once", async () => {
    const order: string[] = [];
    const admin: AdminModule = {
      handle: async () => new Response(null),
      mintBootstrap: () => ({ kind: "closed" }),
      close: () => order.push("admin"),
    };
    const control: LocalControlModule = {
      handle: async () => new Response(null),
      close: () => order.push("control"),
    };
    const gateway = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], {
      admin,
      control,
      onClose: () => {
        order.push("onClose");
      },
    });

    await gateway.close();
    await gateway.close();
    expect(order).toEqual(["control", "admin", "onClose"]);
  });
});
