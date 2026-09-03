import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { assertNode24 } from "./node_version.js";

const execFileAsync = promisify(execFile);

export interface BaselineSample {
  readonly residentBytes: number;
  readonly metric: "windows_private_bytes" | "linux_pss_bytes" | "linux_rss_bytes" | "macos_rss_bytes" | "node_rss_bytes";
}

export interface StackSmokeResult {
  readonly module: string;
  readonly loaded: boolean;
}

export interface BenchmarkEnvironment {
  readonly node: string;
  readonly npmUserAgent: string | null;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cpus: number;
}

export interface BaselineResult {
  readonly kind: "baseline";
  readonly repeat: number;
  readonly sampleCount: number;
  readonly rssLimitBytes: number;
  readonly environment: BenchmarkEnvironment;
  readonly samples: readonly BaselineSample[];
  readonly adminPage?: AdminPageRssEvidence;
  readonly stackSmoke: readonly StackSmokeResult[];
  readonly passed: boolean;
}

export interface AdminPageRssEvidence {
  readonly browserIncluded: false;
  readonly assetRoot: string;
  readonly closedSamples: readonly BaselineSample[];
  readonly openSamples: readonly BaselineSample[];
  readonly deltaBytes: readonly number[];
}

const RSS_LIMIT_BYTES = 64 * 1024 * 1024;

function parseArgs(argv: readonly string[]): { repeat: number } {
  const [command = "baseline", ...rest] = argv;
  const repeatIndex = rest.indexOf("--repeat");
  const repeat = repeatIndex === -1 ? 1 : Number.parseInt(rest[repeatIndex + 1] ?? "", 10);

  if (command !== "baseline") {
    throw new Error("bench:refactor currently supports only the baseline benchmark");
  }

  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }

  return { repeat };
}

async function execText(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], { encoding: "utf8" });
  return stdout.trim();
}

async function linuxResidentBytes(pid: number): Promise<BaselineSample> {
  try {
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const pssLine = rollup.split("\n").find((line) => line.startsWith("Pss:"));
    const pssKb = Number.parseInt(pssLine?.match(/\d+/u)?.[0] ?? "", 10);
    if (Number.isInteger(pssKb)) {
      return { residentBytes: pssKb * 1024, metric: "linux_pss_bytes" };
    }
  } catch (_error) {
    // Fall back to RSS when PSS is unavailable on the current runner.
  }

  const statm = await readFile(`/proc/${pid}/statm`, "utf8");
  const rssPages = Number.parseInt(statm.split(" ")[1] ?? "", 10);
  if (!Number.isInteger(rssPages)) {
    throw new Error("could not read Linux RSS from /proc/<pid>/statm");
  }
  return { residentBytes: rssPages * 4096, metric: "linux_rss_bytes" };
}

async function macosResidentBytes(pid: number): Promise<BaselineSample> {
  const stdout = await execText("ps", ["-o", "rss=", "-p", String(pid)]);
  const rssKb = Number.parseInt(stdout, 10);
  if (!Number.isInteger(rssKb)) {
    throw new Error(`could not read macOS RSS for pid ${pid}`);
  }
  return { residentBytes: rssKb * 1024, metric: "macos_rss_bytes" };
}

async function windowsResidentBytes(pid: number): Promise<BaselineSample> {
  try {
    const stdout = await execText("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid}).PrivateMemorySize64`,
    ]);
    const privateBytes = Number.parseInt(stdout, 10);
    if (Number.isInteger(privateBytes)) {
      return { residentBytes: privateBytes, metric: "windows_private_bytes" };
    }
  } catch (_error) {
    // Git Bash images can hide powershell.exe from spawned PATH; use Node RSS as a last-resort local fallback.
  }

  return runJsonProbe<BaselineSample>("console.log(JSON.stringify({ residentBytes: process.memoryUsage().rss, metric: 'node_rss_bytes' }));");
}

async function measureResidentBytes(pid: number): Promise<BaselineSample> {
  if (process.platform === "linux") {
    return linuxResidentBytes(pid);
  }
  if (process.platform === "darwin") {
    return macosResidentBytes(pid);
  }
  if (process.platform === "win32") {
    return windowsResidentBytes(pid);
  }

  return runJsonProbe<BaselineSample>("console.log(JSON.stringify({ residentBytes: process.memoryUsage().rss, metric: 'node_rss_bytes' }));");
}

async function runJsonProbe<T>(probe: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", probe], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GHC_GATEWAY_CI_NETWORK_GUARD: "",
        NODE_ENV: "production",
        NODE_OPTIONS: "",
      },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`probe failed with ${code}: ${stderr}`));
        return;
      }

      resolve(JSON.parse(stdout.trim()) as T);
    });
  });
}

async function runSample(): Promise<BaselineSample> {
  const probe = [
    "import { Hono } from 'hono';",
    "import { Type } from '@sinclair/typebox';",
    "const app = new Hono();",
    "app.get('/healthz', (c) => c.text('ok'));",
    "Type.Object({ ok: Type.Boolean() });",
    "console.log('READY');",
    "setInterval(() => undefined, 1000);",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--jitless", "--max-old-space-size=16", "--input-type=module", "--eval", probe], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GHC_GATEWAY_CI_NETWORK_GUARD: "",
        NODE_ENV: "production",
        NODE_OPTIONS: "",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error: Error | null, sample?: BaselineSample): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      if (error !== null) {
        reject(error);
        return;
      }
      if (sample === undefined) {
        reject(new Error("baseline probe produced no sample"));
        return;
      }
      resolve(sample);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY") && child.pid !== undefined) {
        measureResidentBytes(child.pid).then((sample) => finish(null, sample), finish);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`baseline probe failed with ${code}: ${stderr}`));
      }
    });
  });
}

async function runAdminPageSample(assetRoot: string): Promise<Readonly<{
  closed: BaselineSample;
  open: BaselineSample;
}>> {
  const gatewayUrl = new URL("../../dist-refactor/src/gateway/create_gateway.js", import.meta.url).href;
  const staticUrl = new URL("../../dist-refactor/src/admin/static.js", import.meta.url).href;
  const configUrl = new URL("../../dist-refactor/src/config/schema.js", import.meta.url).href;
  const startupUrl = new URL("../../dist-refactor/src/config/startup_config.js", import.meta.url).href;
  const probe = [
    `import { createGateway } from ${JSON.stringify(gatewayUrl)};`,
    `import { createAdminStaticModule } from ${JSON.stringify(staticUrl)};`,
    `import { defaultRuntimeConfigSnapshot } from ${JSON.stringify(configUrl)};`,
    `import { parseStartupConfig } from ${JSON.stringify(startupUrl)};`,
    `const assetRoot = ${JSON.stringify(assetRoot)};`,
    "const admin = { async handle() { return new Response(null, { status: 404 }); }, mintBootstrap() { return { kind: 'closed' }; }, close() {} };",
    "const gateway = await createGateway({ startup: parseStartupConfig(['--data-dir', assetRoot, '--port', '31400'], {}), runtime: defaultRuntimeConfigSnapshot() }, [], { admin, adminStatic: createAdminStaticModule(assetRoot) });",
    "async function loadAdmin() {",
    "  const index = await gateway.fetch(new Request('http://127.0.0.1:31400/admin/'));",
    "  const html = await index.text();",
    "  const assets = [...html.matchAll(/(?:src|href)=\"([^\"]+)\"/gu)].map((match) => match[1]).filter((value) => value?.startsWith('/admin/assets/'));",
    "  for (const asset of assets) { const response = await gateway.fetch(new Request(`http://127.0.0.1:31400${asset}`)); await response.arrayBuffer(); }",
    "}",
    "console.log('READY_CLOSED');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.once('data', async () => {",
    "  await loadAdmin();",
    "  console.log('READY_OPEN');",
    "});",
    "setInterval(() => undefined, 1000);",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--jitless", "--max-old-space-size=16", "--input-type=module", "--eval", probe], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GHC_GATEWAY_CI_NETWORK_GUARD: "",
        NODE_ENV: "production",
        NODE_OPTIONS: "",
      },
    });
    let stdout = "";
    let stderr = "";
    let closed: BaselineSample | undefined;
    let measuring = false;
    let settled = false;

    const finish = (error: Error | null, open?: BaselineSample): void => {
      if (settled) return;
      settled = true;
      child.kill();
      if (error !== null) reject(error);
      else if (closed === undefined || open === undefined) reject(new Error("Admin RSS probe produced incomplete samples"));
      else resolve({ closed, open });
    };
    const inspectOutput = (): void => {
      if (measuring || child.pid === undefined) return;
      if (closed === undefined && stdout.includes("READY_CLOSED")) {
        measuring = true;
        measureResidentBytes(child.pid).then((sample) => {
          closed = sample;
          measuring = false;
          child.stdin.write("OPEN\n");
          inspectOutput();
        }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      } else if (closed !== undefined && stdout.includes("READY_OPEN")) {
        measuring = true;
        measureResidentBytes(child.pid).then((sample) => finish(null, sample), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; inspectOutput(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Admin RSS probe failed with ${code}: ${stderr}`));
    });
  });
}

async function runStackSmoke(): Promise<readonly StackSmokeResult[]> {
  const modules = [
    "@hono/node-server",
    "undici",
    "better-sqlite3",
    "svelte/compiler",
    "vite",
    "vitest",
    "@playwright/test",
  ];
  const probe = [
    `const modules = ${JSON.stringify(modules)};`,
    "const results = [];",
    "for (const moduleName of modules) { await import(moduleName); results.push({ module: moduleName, loaded: true }); }",
    "console.log(JSON.stringify(results));",
  ].join("\n");

  return runJsonProbe<StackSmokeResult[]>(probe);
}

export async function runBaselineBenchmark(repeat: number, includeAdminPage = false): Promise<BaselineResult> {
  const samples: BaselineSample[] = [];
  const adminClosedSamples: BaselineSample[] = [];
  const adminOpenSamples: BaselineSample[] = [];
  const adminAssetRoot = path.resolve("dist-refactor", "admin");
  for (let index = 0; index < repeat; index += 1) {
    samples.push(await runSample());
    if (includeAdminPage) {
      const admin = await runAdminPageSample(adminAssetRoot);
      adminClosedSamples.push(admin.closed);
      adminOpenSamples.push(admin.open);
    }
  }

  const stackSmoke = await runStackSmoke();

  return {
    kind: "baseline",
    repeat,
    sampleCount: samples.length,
    rssLimitBytes: RSS_LIMIT_BYTES,
    environment: {
      node: process.version,
      npmUserAgent: process.env.npm_config_user_agent ?? null,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    samples,
    ...(includeAdminPage
      ? {
        adminPage: {
          browserIncluded: false as const,
          assetRoot: adminAssetRoot,
          closedSamples: adminClosedSamples,
          openSamples: adminOpenSamples,
          deltaBytes: adminOpenSamples.map((sample, index) => sample.residentBytes - (adminClosedSamples[index]?.residentBytes ?? 0)),
        },
      }
      : {}),
    stackSmoke,
    passed: samples.every((sample) => sample.residentBytes <= RSS_LIMIT_BYTES)
      && stackSmoke.every((sample) => sample.loaded),
  };
}

async function main(): Promise<void> {
  assertNode24();
  const { repeat } = parseArgs(process.argv.slice(2));
  const result = await runBaselineBenchmark(repeat, true);
  const artifactDir = path.resolve("dist-refactor", "bench");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, "baseline.json");
  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ ...result, artifactPath }));

  if (!result.passed) {
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
