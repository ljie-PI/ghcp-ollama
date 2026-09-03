#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CliError, HttpControlClient, type CliLifecycleResult, type ControlClient } from "./control_client.js";
import { parseCli } from "./parser.js";
import { exitCodeForError, writeError, writeSuccess, type WritableCliStream } from "./output.js";
import type { HostedGateway } from "../gateway/create_gateway.js";
import type { StartupConfig } from "../config/startup_config.js";
import type { DaemonController } from "../daemon/controller.js";
import {
  createProductionDaemonController,
  daemonRuntimeCliError,
  runDaemonRuntime,
  type ComposeDaemonGateway,
  type DaemonRuntimeDependencies,
  type RunDaemonRuntimeOptions,
} from "../daemon/runtime.js";
import { composeProductionDaemonGateway } from "../main.js";

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
  readonly stdout?: WritableCliStream;
  readonly stderr?: WritableCliStream;
  readonly controlClient?: ControlClient;
  readonly createGateway?: (startup: StartupConfig, env: NodeJS.ProcessEnv) => Promise<HostedGateway>;
  readonly composeGateway?: ComposeDaemonGateway;
  readonly daemonController?: Pick<DaemonController, "start" | "stop" | "restart" | "status">;
  readonly runDaemonRuntime?: (options: Readonly<RunDaemonRuntimeOptions>) => Promise<void>;
  readonly daemonRuntimeDependencies?: Readonly<DaemonRuntimeDependencies>;
  readonly shutdownSignal?: AbortSignal;
  readonly pollDelayMs?: number;
  readonly pid?: number;
  readonly now?: () => Date;
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const argv = options.argv ?? process.argv.slice(2);
  let json = argv.includes("--json");
  let client: ControlClient | undefined;
  try {
    const env = options.env ?? process.env;
    const parsed = parseCli(argv, { env, ...(options.homedir === undefined ? {} : { homedir: options.homedir }) });
    json = parsed.json;
    const command = parsed.command;
    if (command.kind === "help") {
      if (parsed.json) {
        writeSuccess(stdout, true, { help: command.text });
      } else {
        stdout.write(command.text);
      }
      return 0;
    }
    client = options.controlClient ?? new HttpControlClient();
    if (command.kind === "serve") {
      return await runServe(command.startup, parsed.json, stdout, stderr, options);
    }
    if (command.kind === "lifecycle") {
      const controller = options.daemonController
        ?? (options.controlClient === undefined ? createProductionDaemonController({ env }) : undefined);
      const context = options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal };
      const result = controller === undefined
        ? await client.lifecycle(command.action, {
          dataDir: parsed.dataDir,
          ...(command.startup === undefined ? {} : { startup: command.startup }),
          ...context,
        })
        : command.action === "start"
          ? await controller.start(requireStartup(command.startup), context)
          : command.action === "restart"
            ? await controller.restart(requireStartup(command.startup), context)
            : command.action === "stop"
              ? await controller.stop(parsed.dataDir, context)
              : await controller.status(parsed.dataDir, context);
      writeSuccess(stdout, parsed.json, result);
      return lifecycleExitCode(command.action, result);
    }
    if (command.kind === "admin.open") {
      writeSuccess(stdout, parsed.json, await client.adminOpen({
        dataDir: parsed.dataDir,
        ...(options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal }),
      }));
      return 0;
    }
    if (command.operation === "auth.login.start" && !parsed.json) {
      return await runInteractiveLogin(client, command.args as { readonly host?: string }, { dataDir: parsed.dataDir }, stdout, options);
    }
    writeSuccess(stdout, parsed.json, await client.request(command.operation, command.args, {
      dataDir: parsed.dataDir,
      ...(options.shutdownSignal === undefined ? {} : { signal: options.shutdownSignal }),
    }));
    return 0;
  } catch (error: unknown) {
    const cliError = error instanceof CliError ? error : new CliError("internal_error");
    writeError(stderr, json, cliError.code);
    return exitCodeForError(cliError.code);
  } finally {
    await client?.close?.();
  }
}

async function runInteractiveLogin(
  client: ControlClient,
  args: { readonly host?: string },
  context: { readonly dataDir: string },
  stdout: WritableCliStream,
  options: RunCliOptions,
): Promise<number> {
  const localSignal = options.shutdownSignal === undefined
    ? processSignal()
    : { signal: options.shutdownSignal, dispose: () => undefined };
  const controlContext = {
    dataDir: context.dataDir,
    signal: localSignal.signal,
  };
  try {
    const started = await client.request("auth.login.start", args, controlContext);
    stdout.write(`Code: ${started.userCode}\n`);
    stdout.write(`Open: ${started.verificationUri}\n`);
    for (;;) {
      const result = await client.request("auth.login.poll", { flowId: started.flowId }, controlContext);
      if (result.state === "complete") {
        stdout.write(`Authenticated: ${result.account.accountId}\n`);
        return 0;
      }
      if (result.state !== "pending") {
        throw new CliError("remote_error");
      }
      await sleep(options.pollDelayMs ?? started.pollIntervalSeconds * 1000, localSignal.signal);
    }
  } finally {
    localSignal.dispose();
  }
}

function processSignal(): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new CliError("interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

async function runServe(
  startup: StartupConfig,
  json: boolean,
  stdout: WritableCliStream,
  stderr: WritableCliStream,
  options: RunCliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const managed = env.GHC_GATEWAY_INTERNAL_MANAGED_CHILD === "1";
  const shutdown = options.shutdownSignal === undefined ? processSignal() : null;
  const shutdownSignal = options.shutdownSignal ?? shutdown?.signal ?? new AbortController().signal;
  const composeGateway: ComposeDaemonGateway = options.composeGateway
    ?? (options.createGateway === undefined
      ? composeProductionDaemonGateway
      : async (context) => await options.createGateway?.(context.startup, context.env) as HostedGateway);
  try {
    await (options.runDaemonRuntime ?? runDaemonRuntime)({
      startup,
      env,
      managed,
      composeGateway,
      shutdownSignal,
      stderr,
      ...(options.daemonRuntimeDependencies === undefined
        ? {}
        : { dependencies: options.daemonRuntimeDependencies }),
      ...(!managed
        ? {
          onListening: (identity) => writeSuccess(stdout, json, lifecycleFromIdentity(identity, startup.dataDir)),
        }
        : {}),
    });
    if (shutdownSignal.reason instanceof CliError && shutdownSignal.reason.code === "interrupted") {
      throw shutdownSignal.reason;
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(daemonRuntimeCliError(error));
  } finally {
    shutdown?.dispose();
  }
}

function lifecycleExitCode(action: string, result: CliLifecycleResult): number {
  if (action === "status" && result.state === "stopped") {
    return 3;
  }
  if (result.state === "stale" || result.state === "conflict" || result.state === "unreachable") {
    return 5;
  }
  return 0;
}

function lifecycleFromIdentity(
  identity: Readonly<{
    managed: boolean;
    pid: number;
    createdAt: string;
    port: number;
  }>,
  dataDir: string,
): CliLifecycleResult {
  return {
    state: "running",
    managed: identity.managed,
    pid: identity.pid,
    startedAt: identity.createdAt,
    port: identity.port,
    dataDir,
  };
}

function requireStartup(startup: StartupConfig | undefined): StartupConfig {
  if (startup === undefined) {
    throw new CliError("internal_error");
  }
  return startup;
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    throw new CliError("interrupted");
  }
  await new Promise<void>((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, Math.max(0, ms));
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new CliError("interrupted"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function main(): Promise<void> {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
