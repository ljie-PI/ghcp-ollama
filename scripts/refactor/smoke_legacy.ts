import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface PackageJson {
  readonly main?: string;
  readonly bin?: Record<string, string>;
}

function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runLegacySmoke(): Promise<void> {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
  const expected = {
    main: "src/server.js",
    ghcpo: "./src/ghcpo.js",
    server: "./src/serverctl.js",
  };

  if (pkg.main !== expected.main) {
    throw new Error(`legacy main changed: ${pkg.main ?? "<missing>"}`);
  }

  if (pkg.bin?.ghcpo !== expected.ghcpo || pkg.bin?.["ghcpo-server"] !== expected.server) {
    throw new Error("legacy bins changed");
  }

  const help = await run(process.execPath, ["src/ghcpo.js", "status", "--help"]);
  if (help.code !== 0 || !help.stdout.includes("GitHub Copilot CLI Tool")) {
    throw new Error(`legacy CLI help smoke failed: ${help.stderr}`);
  }

  console.log(JSON.stringify({ ok: true, main: pkg.main, bins: pkg.bin }));
}

async function main(): Promise<void> {
  await runLegacySmoke();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
