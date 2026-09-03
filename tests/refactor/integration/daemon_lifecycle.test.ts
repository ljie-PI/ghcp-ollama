import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StartupConfig } from "../../../src/config/startup_config.js";
import {
  DaemonController,
  type DaemonControllerDependencies,
  type DaemonControlRequest,
  type SpawnedDaemon,
} from "../../../src/daemon/controller.js";
import type { DaemonIdentity } from "../../../src/daemon/identity_file.js";

const DATA_DIR = path.resolve("test-data");
const STARTUP: StartupConfig = {
  host: "127.0.0.1",
  port: 31_400,
  dataDir: DATA_DIR,
  logLevel: "info",
};
const FIRST: DaemonIdentity = {
  version: 1,
  managed: true,
  pid: 4_242,
  processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:100",
  instanceNonce: "nonce-1",
  controlToken: "token-1",
  port: 31_400,
  createdAt: "2026-09-03T12:00:00.000Z",
};
const SECOND: DaemonIdentity = {
  ...FIRST,
  pid: 4_243,
  processStartIdentity: "linux:01234567-89ab-cdef-0123-456789abcdef:200",
  instanceNonce: "nonce-2",
  controlToken: "token-2",
  createdAt: "2026-09-03T12:01:00.000Z",
};

describe("RM-19 DaemonController lifecycle", () => {
  it("reports stopped and treats an authenticated existing foreground gateway as start success", async () => {
    const stopped = harness();
    await expect(stopped.controller.status(DATA_DIR)).resolves.toEqual({
      state: "stopped",
      managed: null,
      pid: null,
      startedAt: null,
      port: null,
      dataDir: DATA_DIR,
    });

    const foreground = harness({ identity: { ...FIRST, managed: false } });
    await expect(foreground.controller.start(STARTUP)).resolves.toMatchObject({
      state: "running",
      managed: false,
      pid: FIRST.pid,
    });
    expect(foreground.spawn).not.toHaveBeenCalled();
  });

  it("spawns one detached daemon and waits for its authenticated ready identity before unref", async () => {
    const fixture = harness();
    fixture.onDelay = () => {
      fixture.identity = FIRST;
      fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    };

    await expect(fixture.controller.start(STARTUP)).resolves.toMatchObject({
      state: "running",
      managed: true,
      pid: FIRST.pid,
      startedAt: FIRST.createdAt,
      port: FIRST.port,
    });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.spawn).toHaveBeenCalledWith(STARTUP);
    expect(fixture.child.unref).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual(["spawn", "delay:100", "control:GET:status", "unref"]);
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("coalesces concurrent starts into one detached child", async () => {
    const fixture = harness();
    let releaseDelay = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { releaseDelay = resolve; });
    let firstDelay = true;
    fixture.onDelayAsync = async () => {
      if (!firstDelay) {
        return;
      }
      firstDelay = false;
      await blocked;
      fixture.identity = FIRST;
      fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    };

    const first = fixture.controller.start(STARTUP);
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
    const second = fixture.controller.start(STARTUP);
    releaseDelay();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "running", pid: FIRST.pid }),
      expect.objectContaining({ state: "running", pid: FIRST.pid }),
    ]);
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it("terminates only its process-identity-verified child after the 30 second ready deadline", async () => {
    const fixture = harness();
    fixture.processes.set(FIRST.pid, FIRST.processStartIdentity);
    fixture.onDelay = () => { fixture.identity = FIRST; };
    fixture.controlRequest = async () => {
      throw new Error("not ready");
    };
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    const result = await fixture.controller.start(STARTUP);
    expect(result.state).toBe("unreachable");
    expect(fixture.elapsedMs).toBe(30_000);
    expect(fixture.terminate).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith(FIRST);
    expect(fixture.removed).toEqual([FIRST]);
    expect(fixture.child.unref).toHaveBeenCalledOnce();
  });

  it("gracefully stops a managed daemon and removes identity only after process death", async () => {
    const fixture = harness({ identity: FIRST });
    fixture.onDelay = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toEqual({
      state: "stopped",
      managed: null,
      pid: null,
      startedAt: null,
      port: null,
      dataDir: DATA_DIR,
    });
    expect(fixture.controlCalls.map((call) => `${call.method}:${call.path}`)).toEqual([
      "GET:/__ghcg/control/v1/status",
      "POST:/__ghcg/control/v1/stop",
    ]);
    expect(fixture.elapsedMs).toBe(100);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("waits 10 seconds then uses a fresh process identity before force termination", async () => {
    const fixture = harness({ identity: FIRST });
    fixture.onTerminate = () => fixture.processes.delete(FIRST.pid);

    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({ state: "stopped" });
    expect(fixture.elapsedMs).toBe(10_000);
    expect(fixture.processReads.at(-1)).toEqual(FIRST.pid);
    expect(fixture.terminate).toHaveBeenCalledWith(FIRST);
    expect(fixture.removed).toEqual([FIRST]);
  });

  it("rejects stop for foreground serve and leaves the process untouched", async () => {
    const fixture = harness({ identity: { ...FIRST, managed: false } });
    await expect(fixture.controller.stop(DATA_DIR)).resolves.toMatchObject({
      state: "conflict",
      managed: false,
      pid: FIRST.pid,
    });
    expect(fixture.controlCalls).toHaveLength(1);
    expect(fixture.terminate).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([]);
  });

  it("implements restart as verified stop followed by start with a new start identity and nonce", async () => {
    const fixture = harness({ identity: FIRST, spawnedPid: SECOND.pid });
    let delayCount = 0;
    fixture.onDelay = () => {
      delayCount += 1;
      if (delayCount === 1) {
        fixture.processes.delete(FIRST.pid);
        return;
      }
      fixture.identity = SECOND;
      fixture.processes.set(SECOND.pid, SECOND.processStartIdentity);
    };

    await expect(fixture.controller.restart(STARTUP)).resolves.toMatchObject({
      state: "running",
      pid: SECOND.pid,
      startedAt: SECOND.createdAt,
    });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.controlCalls.at(-1)?.identity).toEqual(SECOND);
  });
});

interface HarnessOptions {
  readonly identity?: DaemonIdentity;
  readonly spawnedPid?: number;
}

function harness(options: HarnessOptions = {}) {
  const fixture = {
    identity: options.identity ?? null as DaemonIdentity | null,
    processes: new Map<number, string>(),
    removed: [] as DaemonIdentity[],
    processReads: [] as number[],
    controlCalls: [] as Array<{ readonly identity: DaemonIdentity; readonly method: string; readonly path: string }>,
    events: [] as string[],
    elapsedMs: 0,
    onDelay: undefined as (() => void) | undefined,
    onDelayAsync: undefined as (() => Promise<void>) | undefined,
    onTerminate: undefined as (() => void) | undefined,
    controlRequest: undefined as DaemonControlRequest | undefined,
  };
  if (fixture.identity !== null) {
    fixture.processes.set(fixture.identity.pid, fixture.identity.processStartIdentity);
  }
  const child: SpawnedDaemon = {
    pid: options.spawnedPid ?? FIRST.pid,
    unref: vi.fn(() => fixture.events.push("unref")),
  };
  const spawn = vi.fn(async () => {
    fixture.events.push("spawn");
    return child;
  });
  const terminate = vi.fn(async (_identity: Readonly<DaemonIdentity>) => fixture.onTerminate?.());
  const dependencies: DaemonControllerDependencies = {
    identityFile: {
      read: async () => fixture.identity,
      remove: async (_dataDir, expected) => {
        if (fixture.identity === null || !sameIdentity(fixture.identity, expected)) {
          return false;
        }
        fixture.removed.push(fixture.identity);
        fixture.identity = null;
        return true;
      },
    },
    processIdentity: async (pid) => {
      fixture.processReads.push(pid);
      return fixture.processes.get(pid) ?? null;
    },
    spawn,
    delay: async (ms) => {
      fixture.elapsedMs += ms;
      fixture.events.push(`delay:${ms}`);
      fixture.onDelay?.();
      await fixture.onDelayAsync?.();
    },
    controlRequest: async (identity, method, requestPath, context) => {
      fixture.controlCalls.push({ identity: { ...identity }, method, path: requestPath });
      fixture.events.push(`control:${method}:${requestPath.split("/").at(-1)}`);
      if (fixture.controlRequest !== undefined) {
        return await fixture.controlRequest(identity, method, requestPath, context);
      }
      return method === "GET"
        ? { state: "running", instance: instanceOf(identity) }
        : { instance: instanceOf(identity) };
    },
    terminate,
  };
  return Object.assign(fixture, {
    child,
    spawn,
    terminate,
    controller: new DaemonController(dependencies),
  });
}

function instanceOf(identity: Readonly<DaemonIdentity>) {
  return {
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    instanceNonce: identity.instanceNonce,
  };
}

function sameIdentity(left: Readonly<DaemonIdentity>, right: Readonly<DaemonIdentity>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
