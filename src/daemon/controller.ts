import path from "node:path";
import { CliError, type CliLifecycleResult } from "../cli/control_client.js";
import type { StartupConfig } from "../config/startup_config.js";
import type { DaemonIdentity } from "./identity_file.js";

const POLL_INTERVAL_MS = 100;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const STATUS_PATH = "/__ghcg/control/v1/status";
const STOP_PATH = "/__ghcg/control/v1/stop";

export interface DaemonIdentityFileAccess {
  read(dataDir: string): Promise<DaemonIdentity | null>;
  remove(dataDir: string, expected: Readonly<DaemonIdentity>): Promise<boolean>;
}

export interface SpawnedDaemon {
  readonly pid: number;
  unref(): void;
}

export interface DaemonControlRequestContext {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type DaemonControlRequest = (
  identity: Readonly<DaemonIdentity>,
  method: "GET" | "POST",
  path: string,
  context?: Readonly<DaemonControlRequestContext>,
) => Promise<unknown>;

export interface DaemonControllerDependencies {
  readonly identityFile: DaemonIdentityFileAccess;
  readonly processIdentity: (pid: number) => Promise<string | null>;
  readonly spawn: (startup: Readonly<StartupConfig>) => Promise<SpawnedDaemon>;
  readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly controlRequest: DaemonControlRequest;
  readonly terminate: (identity: Readonly<DaemonIdentity>) => Promise<void>;
}

export interface DaemonLifecycleContext {
  readonly signal?: AbortSignal;
}

interface DaemonInspection {
  readonly result: CliLifecycleResult;
  readonly identity: DaemonIdentity | null;
}

export class DaemonController {
  private readonly starts = new Map<string, Promise<CliLifecycleResult>>();

  constructor(private readonly dependencies: Readonly<DaemonControllerDependencies>) {}

  async status(dataDir: string, context: Readonly<DaemonLifecycleContext> = {}): Promise<CliLifecycleResult> {
    return (await this.inspect(dataDir, context)).result;
  }

  private async inspect(
    dataDir: string,
    context: Readonly<DaemonLifecycleContext>,
  ): Promise<DaemonInspection> {
    const resolvedDataDir = path.resolve(dataDir);
    context.signal?.throwIfAborted();
    let identity: DaemonIdentity | null;
    try {
      identity = await this.dependencies.identityFile.read(resolvedDataDir);
    } catch (_error: unknown) {
      return { result: emptyResult("conflict", resolvedDataDir), identity: null };
    }
    if (identity === null) {
      return { result: emptyResult("stopped", resolvedDataDir), identity };
    }

    const processState = await this.readProcessIdentity(identity, context.signal);
    if (processState.kind === "unknown" || processState.kind === "different") {
      return { result: identityResult("conflict", identity, resolvedDataDir), identity };
    }
    if (processState.kind === "dead") {
      const removed = await this.dependencies.identityFile.remove(resolvedDataDir, identity);
      return {
        result: identityResult(removed ? "stale" : "conflict", identity, resolvedDataDir),
        identity,
      };
    }

    try {
      const response = await this.dependencies.controlRequest(identity, "GET", STATUS_PATH, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return {
        result: identityResult(validControlResponse(response, identity, true) ? "running" : "conflict", identity, resolvedDataDir),
        identity,
      };
    } catch (error: unknown) {
      rethrowCancellation(error, context.signal);
      return { result: identityResult("unreachable", identity, resolvedDataDir), identity };
    }
  }

  async start(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    const key = path.resolve(startup.dataDir);
    const active = this.starts.get(key);
    if (active !== undefined) {
      return await active;
    }
    const work = this.startOnce(startup, context).finally(() => {
      if (this.starts.get(key) === work) {
        this.starts.delete(key);
      }
    });
    this.starts.set(key, work);
    return await work;
  }

  private async startOnce(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext>,
  ): Promise<CliLifecycleResult> {
    const existing = await this.status(startup.dataDir, context);
    if (existing.state === "running" || existing.state === "conflict" || existing.state === "unreachable") {
      return existing;
    }

    context.signal?.throwIfAborted();
    const child = await this.dependencies.spawn(startup);
    let spawnedStartIdentity: string | null = null;
    try {
      spawnedStartIdentity = await this.dependencies.processIdentity(child.pid);
      for (let elapsed = 0; elapsed < START_TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
        await this.dependencies.delay(POLL_INTERVAL_MS, context.signal);
        const result = await this.status(startup.dataDir, context);
        if (result.state === "running") {
          return result;
        }
      }

      await this.cleanupFailedStart(startup.dataDir, child.pid, spawnedStartIdentity, context.signal);
      return identityResult("unreachable", await this.readIdentityOrNull(startup.dataDir), path.resolve(startup.dataDir));
    } finally {
      child.unref();
    }
  }

  async stop(
    dataDir: string,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    const resolvedDataDir = path.resolve(dataDir);
    const inspection = await this.inspect(resolvedDataDir, context);
    const current = inspection.result;
    if (current.state !== "running") {
      return current;
    }
    const identity = inspection.identity;
    if (identity === null) {
      return identityResult("conflict", identity, resolvedDataDir);
    }
    if (!identity.managed) {
      return identityResult("conflict", identity, resolvedDataDir);
    }

    try {
      const response = await this.dependencies.controlRequest(identity, "POST", STOP_PATH, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (!validControlResponse(response, identity, false)) {
        return identityResult("conflict", identity, resolvedDataDir);
      }
    } catch (error: unknown) {
      rethrowCancellation(error, context.signal);
      return identityResult("unreachable", identity, resolvedDataDir);
    }

    for (let elapsed = 0; elapsed < STOP_TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
      await this.dependencies.delay(POLL_INTERVAL_MS, context.signal);
      const processState = await this.readProcessIdentity(identity, context.signal);
      if (processState.kind === "dead") {
        await this.dependencies.identityFile.remove(resolvedDataDir, identity);
        return emptyResult("stopped", resolvedDataDir);
      }
      if (processState.kind !== "same") {
        return identityResult("conflict", identity, resolvedDataDir);
      }
    }

    const fresh = await this.readProcessIdentity(identity, context.signal);
    if (fresh.kind !== "same") {
      return identityResult(fresh.kind === "dead" ? "stale" : "conflict", identity, resolvedDataDir);
    }
    await this.dependencies.terminate(identity);
    const afterTerminate = await this.readProcessIdentity(identity, context.signal);
    if (afterTerminate.kind === "dead") {
      await this.dependencies.identityFile.remove(resolvedDataDir, identity);
      return emptyResult("stopped", resolvedDataDir);
    }
    return identityResult(afterTerminate.kind === "same" ? "unreachable" : "conflict", identity, resolvedDataDir);
  }

  async restart(
    startup: Readonly<StartupConfig>,
    context: Readonly<DaemonLifecycleContext> = {},
  ): Promise<CliLifecycleResult> {
    const stopped = await this.stop(startup.dataDir, context);
    if (stopped.state !== "stopped" && stopped.state !== "stale") {
      return stopped;
    }
    return await this.start(startup, context);
  }

  private async cleanupFailedStart(
    dataDir: string,
    childPid: number,
    spawnedStartIdentity: string | null,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (spawnedStartIdentity === null) {
      return;
    }
    const identity = await this.readIdentityOrNull(dataDir);
    if (identity === null
      || identity.pid !== childPid
      || identity.processStartIdentity !== spawnedStartIdentity) {
      return;
    }
    const fresh = await this.readProcessIdentity(identity, signal);
    if (fresh.kind !== "same") {
      if (fresh.kind === "dead") {
        await this.dependencies.identityFile.remove(path.resolve(dataDir), identity);
      }
      return;
    }
    await this.dependencies.terminate(identity);
    const afterTerminate = await this.readProcessIdentity(identity, signal);
    if (afterTerminate.kind === "dead") {
      await this.dependencies.identityFile.remove(path.resolve(dataDir), identity);
    }
  }

  private async readIdentityOrNull(dataDir: string): Promise<DaemonIdentity | null> {
    try {
      return await this.dependencies.identityFile.read(path.resolve(dataDir));
    } catch (_error: unknown) {
      return null;
    }
  }

  private async readProcessIdentity(
    identity: Readonly<DaemonIdentity>,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly kind: "same" | "different" | "dead" | "unknown" }> {
    signal?.throwIfAborted();
    try {
      const actual = await this.dependencies.processIdentity(identity.pid);
      if (actual === null) {
        return { kind: "dead" };
      }
      return { kind: actual === identity.processStartIdentity ? "same" : "different" };
    } catch (_error: unknown) {
      return { kind: "unknown" };
    }
  }
}

function validControlResponse(value: unknown, identity: Readonly<DaemonIdentity>, requireRunning: boolean): boolean {
  if (!isRecord(value) || (requireRunning && value.state !== "running") || !isRecord(value.instance)) {
    return false;
  }
  return value.instance.pid === identity.pid
    && value.instance.processStartIdentity === identity.processStartIdentity
    && value.instance.instanceNonce === identity.instanceNonce;
}

function identityResult(
  state: CliLifecycleResult["state"],
  identity: Readonly<DaemonIdentity> | null,
  dataDir: string,
): CliLifecycleResult {
  if (identity === null) {
    return emptyResult(state, dataDir);
  }
  return {
    state,
    managed: identity.managed,
    pid: identity.pid,
    startedAt: identity.createdAt,
    port: identity.port,
    dataDir: path.resolve(dataDir),
  };
}

function emptyResult(state: CliLifecycleResult["state"], dataDir: string): CliLifecycleResult {
  return {
    state,
    managed: null,
    pid: null,
    startedAt: null,
    port: null,
    dataDir: path.resolve(dataDir),
  };
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CliError("interrupted");
  }
  if (error instanceof CliError && (error.code === "interrupted" || error.code === "timeout")) {
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
