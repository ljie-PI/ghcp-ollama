import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./node_version.js";

export interface PackSmokeResult {
  readonly fileCount: number;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageBytes: number;
  readonly unpackedBytes: number;
  readonly adminBytes: number;
  readonly adminAssets: readonly AdminAssetEvidence[];
  readonly viteManifest: Readonly<Record<string, ViteManifestEntry>>;
  readonly defaultCutoverIdentityPreserved: boolean;
  readonly browserArtifactsIncluded: false;
  readonly artifactPath: string;
}

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
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: readonly NpmPackFile[];
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

function packagePath(relativePath: string): string {
  return path.posix.join("dist-refactor/admin", relativePath.replaceAll(path.sep, "/"));
}

function isHashedAsset(relativePath: string, extension: "js" | "css"): boolean {
  return new RegExp(`^assets/.+[-.][A-Za-z0-9_-]{8,}\\.${extension}$`, "u").test(relativePath);
}

export async function inspectAdminBundle(
  entry: Readonly<Pick<NpmPackEntry, "files">>,
  root = path.resolve("dist-refactor", "admin"),
): Promise<Readonly<{
  assets: readonly AdminAssetEvidence[];
  bytes: number;
  viteManifest: Readonly<Record<string, ViteManifestEntry>>;
}>> {
  const manifestPath = path.join(root, ".vite", "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const viteManifest = JSON.parse(manifestText) as Readonly<Record<string, ViteManifestEntry>>;
  const referenced = Object.values(viteManifest).flatMap((item) => [item.file, ...(item.css ?? [])]);
  const javascript = referenced.find((file) => isHashedAsset(file, "js"));
  const stylesheet = referenced.find((file) => isHashedAsset(file, "css"));
  if (javascript === undefined || stylesheet === undefined) {
    throw new Error("Admin Vite manifest must reference hashed JavaScript and CSS assets");
  }

  const relativePaths = ["index.html", ".vite/manifest.json", javascript, stylesheet];
  const packagedPaths = new Set(entry.files.map((file) => file.path.replaceAll("\\", "/")));
  const assets = await Promise.all(relativePaths.map(async (relativePath): Promise<AdminAssetEvidence> => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const body = await readFile(absolutePath);
    const packaged = packagedPaths.has(packagePath(relativePath));
    return {
      path: packagePath(relativePath),
      bytes: (await stat(absolutePath)).size,
      sha256: createHash("sha256").update(body).digest("hex"),
      packaged,
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

export async function runPackSmoke(): Promise<PackSmokeResult> {
  const entry = await npmPackDryRun();
  const admin = await inspectAdminBundle(entry);
  await mkdir("dist-refactor", { recursive: true });
  const artifactPath = path.resolve("dist-refactor", "pack-smoke.json");
  const result = {
    fileCount: entry.files.length,
    packageName: entry.name,
    packageVersion: entry.version,
    packageBytes: entry.size,
    unpackedBytes: entry.unpackedSize,
    adminBytes: admin.bytes,
    adminAssets: admin.assets,
    viteManifest: admin.viteManifest,
    defaultCutoverIdentityPreserved: entry.name === "@ljie-pi/ghcp-ollama" && entry.version === "0.1.6",
    browserArtifactsIncluded: false as const,
    artifactPath,
  };
  if (!result.defaultCutoverIdentityPreserved) {
    throw new Error("RM-21 must not change the default package identity before RM-22");
  }
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
