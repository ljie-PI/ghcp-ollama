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
  readonly stackSmoke: readonly StackSmokeResult[];
  readonly passed: boolean;
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
      env: { ...process.env, NODE_ENV: "production" },
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
      env: { ...process.env, NODE_ENV: "production" },
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

export async function runBaselineBenchmark(repeat: number): Promise<BaselineResult> {
  const samples: BaselineSample[] = [];
  for (let index = 0; index < repeat; index += 1) {
    samples.push(await runSample());
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
    stackSmoke,
    passed: samples.every((sample) => sample.residentBytes <= RSS_LIMIT_BYTES)
      && stackSmoke.every((sample) => sample.loaded),
  };
}

async function main(): Promise<void> {
  assertNode24();
  const { repeat } = parseArgs(process.argv.slice(2));
  const result = await runBaselineBenchmark(repeat);
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
