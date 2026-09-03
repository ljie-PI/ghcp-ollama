#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseStartupConfig } from "../config/startup_config.js";
import { composeProductionDaemonGateway } from "../main.js";
import { runDaemonRuntime } from "./runtime.js";

export async function runManagedChild(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const startup = parseStartupConfig(argv, env);
  const shutdown = new AbortController();
  const stop = (): void => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runDaemonRuntime({
      startup,
      env,
      managed: true,
      composeGateway: composeProductionDaemonGateway,
      shutdownSignal: shutdown.signal,
      stderr: process.stderr,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runManagedChild().catch(() => {
    process.exitCode = 1;
  });
}
