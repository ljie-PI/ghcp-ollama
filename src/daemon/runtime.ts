import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceOAuthClient } from "../accounts/device_flow.js";
import { authenticatedControlRequest } from "../cli/control_client.js";
import type { StartupConfig } from "../config/startup_config.js";
import type { HostedGateway } from "../gateway/create_gateway.js";
import { GRACEFUL_SHUTDOWN_MS } from "../gateway/create_gateway.js";
import { DaemonController } from "./controller.js";
import {
  DaemonIdentityFile,
  DaemonIdentityFileError,
  type DaemonIdentity,
  type DaemonIdentityLease,
} from "./identity_file.js";
import { JsonlLogger, StderrLogger, type DaemonLogger } from "./logger.js";
import { captureProcessStartIdentity } from "./process_identity.js";

export interface DaemonRuntimeComposition {
  readonly startup: StartupConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly identity: DaemonIdentity;
  readonly logger: DaemonLogger;
  requestStop(): void;
}

export type ComposeDaemonGateway = (
  context: Readonly<DaemonRuntimeComposition>,
) => Promise<HostedGateway>;

export interface DaemonRuntimeDependencies {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly createSecret?: () => string;
  readonly captureProcessIdentity?: (pid: number) => Promise<string | null>;
  readonly acquireIdentity?: (
    dataDir: string,
    identity: DaemonIdentity,
  ) => DaemonIdentityLease | Promise<DaemonIdentityLease>;
  readonly createLogger?: (managed: boolean, startup: StartupConfig) => DaemonLogger;
  readonly scheduleStop?: (stop: () => void) => void;
}

export interface ProductionDaemonControllerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly childEntry?: string;
  readonly execPath?: string;
}

export function createProductionDaemonController(
  options: Readonly<ProductionDaemonControllerOptions> = {},
): DaemonController {
  const env = options.env ?? process.env;
  const childEntry = options.childEntry ?? fileURLToPath(new URL("./child.js", import.meta.url));
  const execPath = options.execPath ?? process.execPath;
  return new DaemonController({
    identityFile: {
      read: async (dataDir) => new DaemonIdentityFile(dataDir).read(),
      remove: async (dataDir, expected) => new DaemonIdentityFile(dataDir).remove(expected),
    },
    processIdentity: captureProcessStartIdentity,
    spawn: async (startup) => {
      const child = spawn(execPath, [
        childEntry,
        "--data-dir", startup.dataDir,
        "--port", String(startup.port),
        "--log-level", startup.logLevel,
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      if (child.pid === undefined) {
        throw new Error("daemon child has no process id");
      }
      return { pid: child.pid, unref: () => child.unref() };
    },
    delay,
    nowMs: Date.now,
    controlRequest: async (identity, method, requestPath, context = {}) => await authenticatedControlRequest(
      identity,
      method,
      requestPath,
      undefined,
      context,
    ),
    terminate: async (identity) => {
      const current = await captureProcessStartIdentity(identity.pid);
      if (current !== identity.processStartIdentity) {
        return;
      }
      process.kill(identity.pid, "SIGKILL");
    },
  });
}

const DEVICE_OAUTH_RESPONSE_BYTES = 1_048_576;

export class DeviceOAuthError extends Error {
  readonly code = "remote_error";

  constructor() {
    super("remote error");
    this.name = "DeviceOAuthError";
  }
}

export class HttpDeviceOAuthClient implements DeviceOAuthClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async requestDeviceCode(environment: Parameters<DeviceOAuthClient["requestDeviceCode"]>[0], signal?: AbortSignal) {
    const response = await this.fetch(environment.deviceCodeUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: environment.clientId }),
      ...(signal === undefined ? {} : { signal }),
    }, signal);
    if (!response.ok) {
      await cancelResponse(response);
      throw new DeviceOAuthError();
    }
    const value = await readJsonObject(response, signal);
    if (!nonemptyString(value.device_code)
      || !nonemptyString(value.user_code)
      || !nonemptyString(value.verification_uri)
      || !positiveNumber(value.interval)
      || !positiveNumber(value.expires_in)) {
      throw new DeviceOAuthError();
    }
    return {
      deviceCode: value.device_code,
      userCode: value.user_code,
      verificationUri: value.verification_uri,
      intervalSec: value.interval,
      expiresInSec: value.expires_in,
    };
  }

  async exchangeDeviceCode(
    environment: Parameters<DeviceOAuthClient["exchangeDeviceCode"]>[0],
    deviceCode: string,
    signal?: AbortSignal,
  ) {
    const response = await this.fetch(environment.accessTokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: environment.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      ...(signal === undefined ? {} : { signal }),
    }, signal);
    if (!response.ok) {
      await cancelResponse(response);
      throw new DeviceOAuthError();
    }
    const value = await readJsonObject(response, signal);
    if (value.error === "authorization_pending" || value.error === "slow_down") {
      return { status: "pending" } as const;
    }
    if (typeof value.error === "string") {
      return { status: "failed" } as const;
    }
    if (!nonemptyString(value.access_token)) {
      throw new DeviceOAuthError();
    }
    const userUrl = new URL(environment.apiBaseUrl);
    userUrl.pathname = `${userUrl.pathname.replace(/\/$/u, "")}/user`;
    const userResponse = await this.fetch(userUrl, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${value.access_token}` },
      ...(signal === undefined ? {} : { signal }),
    }, signal);
    if (!userResponse.ok) {
      await cancelResponse(userResponse);
      throw new DeviceOAuthError();
    }
    const user = await readJsonObject(userResponse, signal);
    if ((typeof user.id !== "string" && typeof user.id !== "number")
      || !nonemptyString(user.login)) {
      throw new DeviceOAuthError();
    }
    return {
      status: "complete" as const,
      accessToken: value.access_token,
      user: {
        id: user.id,
        login: user.login,
        ...(typeof user.name === "string" ? { name: user.name } : {}),
      },
    };
  }

  private async fetch(input: string | URL, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    try {
      signal?.throwIfAborted();
      return await this.fetchImpl(input, init);
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        signal.throwIfAborted();
      }
      if (error instanceof DeviceOAuthError) {
        throw error;
      }
      throw new DeviceOAuthError();
    }
  }
}

async function readJsonObject(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new DeviceOAuthError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > DEVICE_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceOAuthError();
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      signal.throwIfAborted();
    }
    if (error instanceof DeviceOAuthError) {
      throw error;
    }
    throw new DeviceOAuthError();
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new DeviceOAuthError();
  }
  if (!isRecord(value)) {
    throw new DeviceOAuthError();
  }
  return value;
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export interface RunDaemonRuntimeOptions {
  readonly startup: StartupConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly managed: boolean;
  readonly composeGateway: ComposeDaemonGateway;
  readonly shutdownSignal: AbortSignal;
  readonly stderr: { write(chunk: string): unknown };
  readonly onListening?: (identity: Readonly<DaemonIdentity>) => Promise<void> | void;
  readonly dependencies?: Readonly<DaemonRuntimeDependencies>;
}

export async function runDaemonRuntime(options: Readonly<RunDaemonRuntimeOptions>): Promise<void> {
  const dependencies = options.dependencies ?? {};
  const pid = dependencies.pid ?? process.pid;
  const processStartIdentity = await (dependencies.captureProcessIdentity ?? captureProcessStartIdentity)(pid);
  if (processStartIdentity === null) {
    throw new Error("unable to capture current process identity");
  }
  const now = dependencies.now ?? (() => new Date());
  const secret = dependencies.createSecret ?? (() => randomBytes(32).toString("base64url"));
  const identity: DaemonIdentity = Object.freeze({
    version: 1,
    managed: options.managed,
    pid,
    processStartIdentity,
    instanceNonce: secret(),
    controlToken: secret(),
    port: options.startup.port,
    createdAt: now().toISOString(),
  });
  const acquire = dependencies.acquireIdentity
    ?? ((dataDir: string, value: DaemonIdentity) => new DaemonIdentityFile(dataDir).acquire(value));
  const lease = await acquire(options.startup.dataDir, identity);
  const stopping = new AbortController();
  const scheduleStop = dependencies.scheduleStop ?? ((stop: () => void) => setImmediate(stop));
  const logger = dependencies.createLogger?.(options.managed, options.startup)
    ?? (options.managed
      ? new JsonlLogger(path.join(options.startup.dataDir, "logs"))
      : new StderrLogger(options.stderr));
  let gateway: HostedGateway | undefined;
  try {
    gateway = await options.composeGateway({
      startup: options.startup,
      env: options.env,
      identity,
      logger,
      requestStop: () => scheduleStop(() => stopping.abort()),
    });
    await gateway.listen();
    logger.write({ category: "gateway_started", managed: options.managed, pid });
    await options.onListening?.(identity);
    await waitForAbort(AbortSignal.any([options.shutdownSignal, stopping.signal]));
    const closingGateway = gateway;
    gateway = undefined;
    await closeGatewayBounded(closingGateway, logger);
    logger.write({ category: "gateway_stopped", managed: options.managed, pid });
  } finally {
    try {
      if (gateway !== undefined) {
        await closeGatewayBounded(gateway, logger);
      }
    } finally {
      lease.cleanup();
      lease.release();
    }
  }
}

async function closeGatewayBounded(gateway: HostedGateway, logger: DaemonLogger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    gateway.close().then(
      () => ({ timedOut: false as const }),
      (error: unknown) => ({ timedOut: false as const, error }),
    ),
    new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), GRACEFUL_SHUTDOWN_MS);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if ("error" in result) {
    throw result.error;
  }
  if (result.timedOut) {
    logger.write({ category: "shutdown_timeout" });
  }
}

export function daemonRuntimeCliError(error: unknown): "daemon_conflict" | "security_error" | "permission_denied" | "internal_error" {
  if (error instanceof DaemonIdentityFileError) {
    if (error.code === "lease_conflict") {
      return "daemon_conflict";
    }
    if (error.code === "invalid_identity" || error.code === "unsafe_owner"
      || error.code === "unsafe_path" || error.code === "unsafe_permissions") {
      return "security_error";
    }
  }
  if (typeof error === "object" && error !== null && "code" in error
    && (error.code === "EACCES" || error.code === "EPERM")) {
    return "permission_denied";
  }
  return "internal_error";
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
