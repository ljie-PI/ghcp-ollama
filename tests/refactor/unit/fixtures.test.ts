import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyFixtureManifests } from "../../../scripts/tooling/fixtures.js";

const FIXTURE_ROOT = path.resolve("tests/refactor/fixtures");

describe("RM-22 fixture family closure", () => {
  it("byte-verifies executable manifests without documentation metadata", async () => {
    const entries = await verifyFixtureManifests();
    const count = (owner: string): number => entries.filter((entry) => entry.owner === owner).length;

    expect(entries).toHaveLength(54);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("source");
    }
    expect(count("RM-11")).toBe(4);
    expect(count("RM-13")).toBe(4);
    expect(count("RM-14")).toBe(3);
    expect(count("RM-15")).toBe(2);
    expect(count("RM-16")).toBe(2);
    expect(count("RM-17")).toBe(3);
    expect(entries.some((entry) => entry.caseId.startsWith("gateway-http-host."))).toBe(true);
    expect(entries.some((entry) => entry.caseId.startsWith("gateway-http."))).toBe(false);
  });

  it("rejects a stale expected object instead of only parsing its manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-fixtures-test-"));
    await cp(FIXTURE_ROOT, root, { recursive: true });
    const expectedPath = path.join(root, "responses-native", "request", "preservation.expected.json");
    try {
      const original = await readFile(expectedPath, "utf8");
      await writeFile(expectedPath, original.replace("resolved", "stale"), "utf8");
      await expect(verifyFixtureManifests(root)).rejects.toThrow(/expected bytes are stale/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
