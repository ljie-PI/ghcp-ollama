import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./node_version.js";

export interface FixtureManifestEntry {
  readonly caseId: string;
  readonly owner: string;
  readonly source: string;
  readonly input: string;
  readonly expected: string;
  readonly encoder: string;
}

const FIXTURE_ROOT = path.resolve("tests/refactor/fixtures");

async function findManifests(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return findManifests(fullPath);
    }
    return entry.name === "manifest.json" ? [fullPath] : [];
  }));

  return nested.flat().sort();
}

function assertManifestEntry(value: unknown, manifestPath: string, index: number): FixtureManifestEntry {
  if (value === null || typeof value !== "object") {
    throw new Error(`${manifestPath} entry ${index} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const fields = ["caseId", "owner", "source", "input", "expected", "encoder"] as const;

  for (const field of fields) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      throw new Error(`${manifestPath} entry ${index} field ${field} must be a non-empty string`);
    }
  }

  return candidate as unknown as FixtureManifestEntry;
}

export async function verifyFixtureManifests(root = FIXTURE_ROOT): Promise<readonly FixtureManifestEntry[]> {
  const manifests = await findManifests(root);
  const seen = new Set<string>();
  const entries: FixtureManifestEntry[] = [];

  for (const manifest of manifests) {
    const raw = await readFile(manifest, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];

    for (const [index, value] of list.entries()) {
      const entry = assertManifestEntry(value, manifest, index);
      if (seen.has(entry.caseId)) {
        throw new Error(`duplicate fixture caseId: ${entry.caseId}`);
      }
      seen.add(entry.caseId);
      entries.push(entry);
    }
  }

  return entries;
}

export async function writeFixtureReport(entries: readonly FixtureManifestEntry[]): Promise<string> {
  const reportPath = path.resolve("dist-refactor", "fixtures-report.json");
  const payload = {
    generatedAt: new Date(0).toISOString(),
    count: entries.length,
    checksum: createHash("sha256")
      .update(entries.map((entry) => entry.caseId).join("\n"))
      .digest("hex"),
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reportPath;
}

export function assertFixtureGeneratorAvailable(caseId: string, entries: readonly FixtureManifestEntry[]): never {
  const known = entries.some((entry) => entry.caseId === caseId);
  const reason = known ? "does not have an RM-01 generator" : "is not registered in a manifest";
  throw new Error(`fixture case ${caseId} ${reason}; golden generation is implemented by the owning protocol slice`);
}

async function main(): Promise<void> {
  assertNode24();
  const [command, ...args] = process.argv.slice(2);

  if (command === "verify") {
    const entries = await verifyFixtureManifests();
    console.log(`Verified ${entries.length} refactor fixture manifest entries.`);
    return;
  }

  if (command === "generate") {
    if (!args.includes("--accept")) {
      throw new Error("fixture generation is explicit-only; pass --accept and --case <caseId>");
    }
    const caseIndex = args.indexOf("--case");
    const caseId = args[caseIndex + 1];
    if (caseIndex === -1 || caseId === undefined) {
      throw new Error("fixture generation requires --case <caseId>");
    }

    const entries = await verifyFixtureManifests();
    const entry = entries.find((candidate) => candidate.caseId === caseId);
    if (entry?.owner === "RM-09") {
      await generateOpenAiChatFixture(entry);
      return;
    }
    assertFixtureGeneratorAvailable(caseId, entries);
  }

  throw new Error("usage: fixtures.ts verify | generate --case <caseId> --accept");
}

async function generateOpenAiChatFixture(entry: FixtureManifestEntry): Promise<void> {
  const expectedPath = path.join(FIXTURE_ROOT, "openai-chat", entry.expected);
  if (entry.caseId === "openai-chat.request.model-rewrite") {
    await writeFile(expectedPath, "{\"unknown\":1e+2,\"stream\":true,\"model\":\"resolved\",\"stream_options\":{\"include_usage\":true},\"messages\":[]}\n", "utf8");
    return;
  }
  if (entry.caseId === "openai-chat.stream.done") {
    await writeFile(expectedPath, "data: {\"choices\":[]}\n\ndata: [DONE]\n\n", "utf8");
    return;
  }
  if (entry.caseId === "openai-chat.presenter.model-not-found") {
    await writeFile(expectedPath, "{\"error\":{\"message\":\"model not found\",\"type\":\"not_found_error\",\"param\":null,\"code\":null}}\n", "utf8");
    return;
  }
  assertFixtureGeneratorAvailable(entry.caseId, [entry]);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
