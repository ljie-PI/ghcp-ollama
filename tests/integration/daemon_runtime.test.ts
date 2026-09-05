import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { runDaemonRuntime } from "../../src/daemon/runtime.js";

describe("daemon runtime listener", () => {
  it("rejects unsupported Node.js runtimes before publishing daemon identity", async () => {
    const events: string[] = [];
    await expect(runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-unsupported"], {}),
      env: {},
      managed: true,
      shutdownSignal: new AbortController().signal,
      stderr: { write: () => undefined },
      composeGateway: async () => { throw new Error("must not compose"); },
      dependencies: {
        nodeVersion: "24.0.0",
        pid: 123,
        captureProcessIdentity: async () => {
          events.push("process-identity");
          return "windows:1";
        },
        acquireIdentity: () => {
          events.push("acquire");
          throw new Error("must not acquire");
        },
        createLogger: () => {
          events.push("logger");
          return { write() {} };
        },
      },
    })).rejects.toThrow("Node.js 24.20.0 or newer is required");
    expect(events).toEqual([]);
  });

  it("holds the identity lease before composition and cleans only its lease after shutdown", async () => {
    const events: string[] = [];
    const shutdown = new AbortController();
    await runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-data", "--port", "31406"], {}),
      env: {},
      managed: true,
      shutdownSignal: shutdown.signal,
      stderr: { write: () => undefined },
      composeGateway: async (context) => {
        events.push(`compose:${context.identity.managed}:${context.identity.port}`);
        return {
          fetch: async () => new Response(null),
          listen: async () => {
            events.push("listen");
            return { host: "127.0.0.1", port: 31_406 };
          },
          close: async () => { events.push("close"); },
        };
      },
      onListening: () => shutdown.abort(),
      dependencies: {
        pid: 123,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        createSecret: (() => {
          const values = ["nonce", "token"];
          return () => values.shift() ?? "unexpected";
        })(),
        captureProcessIdentity: async () => "windows:133852868960001234",
        acquireIdentity: (_dataDir, identity) => {
          events.push(`acquire:${identity.instanceNonce}:${identity.controlToken}`);
          return {
            identity,
            cleanup: () => { events.push("cleanup"); return true; },
            release: () => { events.push("release"); },
          };
        },
        createLogger: () => ({ write: () => undefined }),
      },
    });
    expect(events).toEqual([
      "acquire:nonce:token",
      "compose:true:31406",
      "listen",
      "close",
      "cleanup",
      "release",
    ]);
  });

  it("cleans and releases its published identity when composition fails", async () => {
    const events: string[] = [];
    await expect(runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-failure"], {}),
      env: {},
      managed: false,
      shutdownSignal: new AbortController().signal,
      stderr: { write: () => undefined },
      composeGateway: async () => { throw new Error("store failed"); },
      dependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => { events.push("cleanup"); return true; },
          release: () => { events.push("release"); },
        }),
        createLogger: () => ({ write() {} }),
      },
    })).rejects.toThrow("store failed");
    expect(events).toEqual(["cleanup", "release"]);
  });

  it("cleans and releases its published identity when logger construction fails", async () => {
    const events: string[] = [];
    await expect(runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-logger-failure"], {}),
      env: {},
      managed: true,
      shutdownSignal: new AbortController().signal,
      stderr: { write: () => undefined },
      composeGateway: async () => { throw new Error("must not compose"); },
      dependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => { events.push("cleanup"); return true; },
          release: () => { events.push("release"); },
        }),
        createLogger: () => { throw new Error("logger failed"); },
      },
    })).rejects.toThrow("logger failed");
    expect(events).toEqual(["cleanup", "release"]);
  });

  it("does not report listening until the server emits listening", async () => {
    const server = fakeServer();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", "31407"], {}),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [], { listen: () => server });

    let settled = false;
    const listening = gateway.listen().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    server.emit("listening");
    await expect(listening).resolves.toEqual({ host: "127.0.0.1", port: 31_407 });
    await gateway.close();
  });

  it("rejects the listener error instead of publishing readiness", async () => {
    const server = fakeServer();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", "31408"], {}),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [], { listen: () => server });

    const listening = gateway.listen();
    const error = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
    server.emit("error", error);
    await expect(listening).rejects.toBe(error);
    await gateway.close();
  });

  it("releases the daemon lease after a gateway close exceeds 10 seconds", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const shutdown = new AbortController();
    const running = runDaemonRuntime({
      startup: parseStartupConfig(["--data-dir", "runtime-timeout"], {}),
      env: {},
      managed: true,
      shutdownSignal: shutdown.signal,
      stderr: { write: () => undefined },
      composeGateway: async () => ({
        fetch: async () => new Response(null),
        listen: async () => ({ host: "127.0.0.1", port: 31_400 }),
        close: async () => await new Promise<void>(() => undefined),
      }),
      onListening: () => shutdown.abort(),
      dependencies: {
        pid: 123,
        captureProcessIdentity: async () => "windows:1",
        createSecret: () => "secret",
        acquireIdentity: (_dataDir, identity) => ({
          identity,
          cleanup: () => { events.push("cleanup"); return true; },
          release: () => events.push("release"),
        }),
        createLogger: () => ({ write: (record) => events.push(String(record.category)) }),
      },
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events).not.toContain("cleanup");
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(events).toContain("shutdown_timeout");
    expect(events.slice(-2)).toEqual(["cleanup", "release"]);
    vi.useRealTimers();
  });
});

function fakeServer() {
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    close(callback: (error?: Error) => void): void;
  };
  server.listening = false;
  server.on("listening", () => { server.listening = true; });
  server.close = vi.fn((callback) => callback());
  return server;
}
