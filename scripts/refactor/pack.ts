import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./node_version.js";

const PACKAGE_NAME = "@ljie-pi/ghc-gateway";
const PACKAGE_VERSION = "0.1.0";

export interface AdminAssetEvidence {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly packaged: boolean;
}

export interface ViteManifestEntry {
  readonly file: string;
  readonly css?: readonly string[];
  readonly isEntry?: boolean;
}

export interface NpmPackFile {
  readonly path: string;
  readonly size: number;
}

export interface NpmPackEntry {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: readonly NpmPackFile[];
}

export interface PackSmokeResult {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sha256: string;
  readonly packageBytes: number;
  readonly unpackedBytes: number;
  readonly manifest: readonly string[];
  readonly adminAssets: readonly AdminAssetEvidence[];
  readonly help: true;
  readonly foregroundHealth: true;
  readonly daemonLifecycle: true;
}

function packagePath(relativePath: string): string {
  return path.posix.join("dist/admin", relativePath.replaceAll(path.sep, "/"));
}

function isHashedAsset(relativePath: string, extension: "js" | "css"): boolean {
  return new RegExp(`^assets/.+[-.][A-Za-z0-9_-]{8,}\\.${extension}$`, "u").test(relativePath);
}

export async function inspectAdminBundle(
  entry: Readonly<Pick<NpmPackEntry, "files">>,
  root = path.resolve("dist", "admin"),
): Promise<Readonly<{
  assets: readonly AdminAssetEvidence[];
  bytes: number;
  viteManifest: Readonly<Record<string, ViteManifestEntry>>;
}>> {
  const manifestText = await readFile(path.join(root, ".vite", "manifest.json"), "utf8");
  const viteManifest = JSON.parse(manifestText) as Readonly<Record<string, ViteManifestEntry>>;
  const referenced = Object.values(viteManifest).flatMap((item) => [item.file, ...(item.css ?? [])]);
  const javascript = referenced.find((file) => isHashedAsset(file, "js"));
  const stylesheet = referenced.find((file) => isHashedAsset(file, "css"));
  if (javascript === undefined || stylesheet === undefined) {
    throw new Error("Admin Vite manifest must reference hashed JavaScript and CSS assets");
  }

  const packagedPaths = new Set(entry.files.map((file) => file.path.replaceAll("\\", "/")));
  const assets = await Promise.all([
    "index.html",
    ".vite/manifest.json",
    javascript,
    stylesheet,
  ].map(async (relativePath): Promise<AdminAssetEvidence> => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const body = await readFile(absolutePath);
    return {
      path: packagePath(relativePath),
      bytes: (await stat(absolutePath)).size,
      sha256: createHash("sha256").update(body).digest("hex"),
      packaged: packagedPaths.has(packagePath(relativePath)),
    };
  }));
  const missing = assets.filter((asset) => !asset.packaged).map((asset) => asset.path);
  if (missing.length > 0) {
    throw new Error(`npm package omits Admin assets: ${missing.join(", ")}`);
  }
  return {
    assets,
    bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
    viteManifest,
  };
}

export async function expectedPackageManifest(root = process.cwd()): Promise<readonly string[]> {
  const sourceFiles = await walkFiles(path.join(root, "src"), root);
  const productionFiles = sourceFiles
    .filter((file) => file.endsWith(".ts") && !file.startsWith("src/persistence/migrations/"))
    .map((file) => `dist/${file.slice(0, -3)}.js`);
  const manifest = JSON.parse(
    await readFile(path.join(root, "dist", "admin", ".vite", "manifest.json"), "utf8"),
  ) as Readonly<Record<string, ViteManifestEntry>>;
  const adminReferences = Object.values(manifest).flatMap((entry) => [entry.file, ...(entry.css ?? [])]);
  return [
    "LICENSE",
    "README.md",
    "package.json",
    ...productionFiles,
    "dist/admin/.vite/manifest.json",
    "dist/admin/index.html",
    ...adminReferences.map((file) => `dist/admin/${normalizePath(file)}`),
  ].sort();
}

export function assertExactManifest(
  actual: readonly string[],
  expected: readonly string[],
): void {
  const normalizedActual = [...actual].map(normalizePath).sort();
  const normalizedExpected = [...expected].map(normalizePath).sort();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    const expectedSet = new Set(normalizedExpected);
    const actualSet = new Set(normalizedActual);
    const unexpected = normalizedActual.filter((file) => !expectedSet.has(file));
    const missing = normalizedExpected.filter((file) => !actualSet.has(file));
    throw new Error(`package manifest mismatch; unexpected=[${unexpected.join(", ")}], missing=[${missing.join(", ")}]`);
  }
}

export async function runPackSmoke(): Promise<PackSmokeResult> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ghc-gateway-pack-"));
  try {
    const packDirectory = path.join(temporaryRoot, "tarball");
    const installDirectory = path.join(temporaryRoot, "install");
    await mkdir(packDirectory);
    const packed = await runNpm([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory,
    ], process.cwd());
    const entry = await readPackEntry(packed.stdout, packDirectory);
    if (entry.name !== PACKAGE_NAME || entry.version !== PACKAGE_VERSION) {
      throw new Error(`unexpected package identity ${entry.name}@${entry.version}`);
    }
    const actualManifest = entry.files.map((file) => file.path);
    assertExactManifest(actualManifest, await expectedPackageManifest());
    const admin = await inspectAdminBundle(entry);
    const tarballPath = path.join(packDirectory, entry.filename);
    const tarball = await readFile(tarballPath);

    await runNpm([
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installDirectory,
      tarballPath,
    ], temporaryRoot);
    const installedRoot = path.join(installDirectory, "node_modules", "@ljie-pi", "ghc-gateway");
    await verifyInstalledPackage(installedRoot, installDirectory, temporaryRoot);

    return {
      packageName: entry.name,
      packageVersion: entry.version,
      sha256: createHash("sha256").update(tarball).digest("hex"),
      packageBytes: entry.size,
      unpackedBytes: entry.unpackedSize,
      manifest: [...actualManifest].sort(),
      adminAssets: admin.assets,
      help: true,
      foregroundHealth: true,
      daemonLifecycle: true,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyInstalledPackage(
  installedRoot: string,
  installRoot: string,
  temporaryRoot: string,
): Promise<void> {
  const cliEntry = path.join(installedRoot, "dist", "src", "cli", "main.js");
  await access(cliEntry);
  const binPath = path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "ghcg.cmd" : "ghcg");
  await access(binPath);
  const help = await runBin(binPath, ["--help"], temporaryRoot);
  if (!help.stdout.includes("Usage: ghcg") || !help.stdout.includes("serve")) {
    throw new Error("installed ghcg --help did not return canonical help");
  }

  const foregroundData = path.join(temporaryRoot, "foreground");
  const foregroundPort = await reservePort();
  const foreground = spawn(process.execPath, [
    cliEntry,
    "serve",
    "--data-dir", foregroundData,
    "--port", String(foregroundPort),
  ], {
    cwd: temporaryRoot,
    env: sanitizedEnvironment(),
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await waitForHealth(foregroundPort);
  } finally {
    foreground.kill("SIGTERM");
    await waitForExit(foreground, 15_000);
  }

  const daemonData = path.join(temporaryRoot, "daemon");
  const daemonPort = await reservePort();
  const common = ["--data-dir", daemonData];
  await runNode(cliEntry, [...common, "start", "--port", String(daemonPort)], temporaryRoot);
  try {
    await waitForHealth(daemonPort);
    const status = await runNode(cliEntry, [...common, "status"], temporaryRoot);
    if (!status.stdout.includes("running")) {
      throw new Error("installed daemon status did not report running");
    }
  } finally {
    await runNode(cliEntry, [...common, "stop"], temporaryRoot);
  }
  const stopped = await runNode(cliEntry, [...common, "status"], temporaryRoot, [3]);
  if (!stopped.stdout.includes("stopped")) {
    throw new Error("installed daemon status did not report stopped");
  }
}

async function readPackEntry(output: string, packDirectory: string): Promise<NpmPackEntry> {
  const entries = JSON.parse(output) as NpmPackEntry[];
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error("npm pack produced no package entry");
  }
  const packed = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
  if (packed === undefined) {
    throw new Error("npm pack produced no tarball");
  }
  if (entry.filename !== packed) {
    throw new Error("npm pack filename does not match its JSON manifest");
  }
  return entry;
}

async function walkFiles(directory: string, root: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolute, root));
    } else if (entry.isFile()) {
      files.push(normalizePath(path.relative(root, absolute)));
    }
  }
  return files;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^package\//u, "");
}

function runNpm(args: readonly string[], cwd: string): Promise<CommandResult> {
  const npmCli = process.env.npm_execpath;
  return npmCli === undefined
    ? runCommand("npm", args, cwd)
    : runCommand(process.execPath, [npmCli, ...args], cwd);
}

function runNode(
  cliEntry: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return runCommand(process.execPath, [cliEntry, ...args], cwd, allowedExitCodes);
}

function runBin(binPath: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return process.platform === "win32"
    ? runCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", binPath, ...args], cwd)
    : runCommand(binPath, args, cwd);
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === null || !allowedExitCodes.includes(code)) {
        reject(new Error(`${path.basename(command)} failed with exit code ${String(code)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:GHC_GATEWAY_(?!CI_NETWORK_GUARD))/u.test(key)
      || /(?:token|secret|password|authorization|auth_token)/iu.test(key)) {
      delete env[key];
    }
  }
  env.npm_config_registry = "https://registry.npmjs.org/";
  return env;
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("unable to reserve loopback port")));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("installed gateway did not become healthy");
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("foreground gateway did not stop")), timeoutMs)),
  ]);
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
