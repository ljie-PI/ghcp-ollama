#!/usr/bin/env node

const [majorText] = process.versions.node.split(".");
const major = Number.parseInt(majorText ?? "", 10);

if (!Number.isInteger(major) || major < 24) {
  console.error(`Node.js 24 or newer is required for the project toolchain; current ${process.versions.node}`);
  process.exit(1);
}

async function registerTypeScriptLoader() {
  await import("tsx/esm");
}

if (process.env.GHC_GATEWAY_CI_NETWORK_GUARD === "1") {
  await registerTypeScriptLoader();
  await import("./ci_network_guard.ts");
}

const { pathToFileURL } = await import("node:url");
const path = await import("node:path");
const invokedAsMain = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsMain) {
  const target = process.argv[2];

  if (target === "--check" || target === undefined) {
    process.exit(0);
  }

  if (!target.endsWith(".ts")) {
    console.error("usage: node scripts/tooling/bootstrap.mjs [--check | <script.ts> ...args]");
    process.exit(2);
  }

  await registerTypeScriptLoader();
  const resolvedTarget = path.resolve(target);
  process.argv = [process.argv[0] ?? "node", resolvedTarget, ...process.argv.slice(3)];
  await import(pathToFileURL(resolvedTarget).href);
}
