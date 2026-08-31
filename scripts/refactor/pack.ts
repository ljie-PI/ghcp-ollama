import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./node_version.js";

export interface PackSmokeResult {
  readonly fileCount: number;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactPath: string;
}

interface NpmPackEntry {
  readonly name: string;
  readonly version: string;
  readonly files: readonly unknown[];
}

function npmPackDryRun(): Promise<NpmPackEntry> {
  return new Promise((resolve, reject) => {
    const npmCli = process.env.npm_execpath;
    const command = npmCli === undefined ? "npm" : process.execPath;
    const args = npmCli === undefined
      ? ["pack", "--dry-run", "--json"]
      : [npmCli, "pack", "--dry-run", "--json"];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
        reject(new Error(`npm pack dry-run failed with ${code}: ${stderr}`));
        return;
      }

      const entries = JSON.parse(stdout) as NpmPackEntry[];
      const [entry] = entries;
      if (entry === undefined) {
        reject(new Error("npm pack dry-run produced no package entry"));
        return;
      }
      resolve(entry);
    });
  });
}

export async function runPackSmoke(): Promise<PackSmokeResult> {
  const entry = await npmPackDryRun();
  await mkdir("dist-refactor", { recursive: true });
  const artifactPath = path.resolve("dist-refactor", "pack-smoke.json");
  const result = {
    fileCount: entry.files.length,
    packageName: entry.name,
    packageVersion: entry.version,
    artifactPath,
  };
  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main(): Promise<void> {
  assertNode24();
  console.log(JSON.stringify(await runPackSmoke()));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
