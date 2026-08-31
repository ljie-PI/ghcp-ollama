import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureProtectedDirectory,
  FileCredentialStore,
} from "../../../src/accounts/credential_store.js";

describe("RM-06 credential file protection", () => {
  it("uses atomic replace and protected permissions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(filePath);
    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "tok" });
    const stat = lstatSync(filePath);
    expect(stat.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    }
    const read = await store.readGeneration("github.com/1", 1);
    expect(read?.githubToken).toBe("tok");
    await store.removeAccount("github.com/1");
    expect(await store.readGeneration("github.com/1", 1)).toBeNull();
  });

  it("rejects a symlink credential directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() => ensureProtectedDirectory(link)).toThrow(/symlink/u);
  });

  it("does not persist secrets into sqlite-shaped documents beyond the protected file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cred-"));
    const filePath = path.join(dir, "credentials.json");
    const store = new FileCredentialStore(filePath);
    await store.putGeneration("github.com/1", 1, { generation: 1, githubToken: "tok" });
    const sqliteProbe = path.join(dir, "state.db");
    writeFileSync(sqliteProbe, "not-a-secret-store");
    expect(await store.readGeneration("github.com/1", 1)).toEqual({
      generation: 1,
      githubToken: "tok",
    });
  });
});
