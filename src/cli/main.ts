#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CliError, HttpControlClient, type CliLifecycleResult, type ControlClient } from "./control_client.js";
import { parseCli } from "./parser.js";
import { exitCodeForError, writeError, writeSuccess, type WritableCliStream } from "./output.js";
import { bootstrapGateway, type BootstrapOptions } from "../main.js";
import type { HostedGateway } from "../gateway/create_gateway.js";
import type { StartupConfig } from "../config/startup_config.js";

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
  readonly stdout?: WritableCliStream;
  readonly stderr?: WritableCliStream;
  readonly controlClient?: ControlClient;
  readonly createGateway?: (startup: StartupConfig, env: NodeJS.ProcessEnv) => Promise<HostedGateway>;
  readonly shutdownSignal?: AbortSignal;
  readonly pollDelayMs?: number;
  readonly pid?: number;
  readonly now?: () => Date;
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let json = false;
  let client: ControlClient | undefined;
  try {
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const parsed = parseCli(argv, { env, ...(options.homedir === undefined ? {} : { homedir: options.homedir }) });
    json = parsed.json;
    const command = parsed.command;
    if (command.kind === "help") {
      stdout.write(command.text);
      return 0;
    }
    client = options.controlClient ?? new HttpControlClient();
    if (command.kind === "serve") {
      return await runServe(command.startup, parsed.json, stdout, options);
    }
    if (command.kind === "lifecycle") {
      const context = { dataDir: parsed.dataDir, ...(command.startup === undefined ? {} : { startup: command.startup }) };
      const result = await client.lifecycle(command.action, context);
      writeSuccess(stdout, parsed.json, result);
      return lifecycleExitCode(command.action, result);
    }
    if (command.kind === "admin.open") {
      writeSuccess(stdout, parsed.json, await client.adminOpen({ dataDir: parsed.dataDir }));
      return 0;
    }
    if (command.operation === "auth.login.start" && !parsed.json) {
      return await runInteractiveLogin(client, command.args as { readonly host?: string }, { dataDir: parsed.dataDir }, stdout, options);
    }
    writeSuccess(stdout, parsed.json, await client.request(command.operation, command.args, { dataDir: parsed.dataDir }));
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
  const started = await client.request("auth.login.start", args, context);
  stdout.write(`Code: ${started.userCode}\n`);
  stdout.write(`Open: ${started.verificationUri}\n`);
  for (;;) {
    const result = await client.request("auth.login.poll", { flowId: started.flowId }, context);
    if (result.state === "complete") {
      stdout.write(`Authenticated: ${result.account.accountId}\n`);
      return 0;
    }
    if (result.state !== "pending") {
      throw new CliError("remote_error");
    }
    await sleep(options.pollDelayMs ?? started.pollIntervalSeconds * 1000, options.shutdownSignal);
  }
}

async function runServe(
  startup: StartupConfig,
  json: boolean,
  stdout: WritableCliStream,
  options: RunCliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const gateway = await (options.createGateway ?? defaultCreateGateway)(startup, env);
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    await gateway.listen();
    const result: CliLifecycleResult = {
      state: "running",
      managed: false,
      pid: options.pid ?? process.pid,
      startedAt,
      port: startup.port,
      dataDir: startup.dataDir,
    };
    writeSuccess(stdout, json, result);
    await waitForShutdown(options.shutdownSignal);
    await gateway.close();
    return 0;
  } catch (error: unknown) {
    await gateway.close().catch(() => undefined);
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("internal_error");
  }
}

function defaultCreateGateway(startup: StartupConfig, env: NodeJS.ProcessEnv): Promise<HostedGateway> {
  const options: BootstrapOptions = { startup, env };
  return bootstrapGateway(options);
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

async function waitForShutdown(signal: AbortSignal | undefined): Promise<void> {
  if (signal !== undefined) {
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const reason = signal.reason;
        if (reason instanceof CliError) {
          reject(reason);
          return;
        }
        resolve();
      }, { once: true });
    });
    return;
  }
  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const onSignal = (): void => {
      cleanup();
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
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
