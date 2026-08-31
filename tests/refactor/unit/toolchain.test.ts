import { execFile } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../../src/version.js";
import { currentNodeMajor } from "../../../scripts/refactor/node_version.js";
import { isAllowedNetworkTarget, isLoopbackHost } from "../../../scripts/refactor/ci_network_guard.js";

const execFileAsync = promisify(execFile);

interface PackageJson {
  readonly main: string;
  readonly bin: Record<string, string>;
  readonly scripts: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
}

describe("RM-01 refactor toolchain", () => {
  it("keeps the new target version separate from the legacy package", async () => {
    const pkg = await readPackageJson();

    expect(VERSION).toBe("0.1.0");
    expect(pkg.main).toBe("src/server.js");
    expect(pkg.bin).toEqual({
      ghcpo: "./src/ghcpo.js",
      "ghcpo-server": "./src/serverctl.js",
    });
  });

  it("exposes the required non-default refactor commands", async () => {
    const pkg = await readPackageJson();
    const requiredScripts = [
      "build:refactor",
      "typecheck:refactor",
      "lint:refactor",
      "test:refactor",
      "test:sdk:refactor",
      "test:live:sdk",
      "test:e2e:refactor",
      "fixtures:verify",
      "fixtures:generate",
      "bench:refactor",
      "pack:refactor",
      "smoke:legacy",
    ];

    for (const script of requiredScripts) {
      expect(pkg.scripts[script], script).toBeTypeOf("string");
    }
  });

  it("requires Node.js 24 or newer for refactor scripts", () => {
    expect(currentNodeMajor()).toBeGreaterThanOrEqual(24);
  });

  it("keeps official SDK commands behind manual opt-in guards", async () => {
    await expect(execFileAsync(process.execPath, ["scripts/refactor/require_opt_in.mjs", "GHC_GATEWAY_SDK_TESTS"], {
      env: { ...process.env, GHC_GATEWAY_SDK_TESTS: "" },
    })).rejects.toMatchObject({ code: 2 });

    await expect(execFileAsync(process.execPath, ["scripts/refactor/require_opt_in.mjs", "GHC_GATEWAY_LIVE_TESTS"], {
      env: { ...process.env, GHC_GATEWAY_LIVE_TESTS: "" },
    })).rejects.toMatchObject({ code: 2 });

    await expect(execFileAsync(process.execPath, ["scripts/refactor/require_opt_in.mjs", "GHC_GATEWAY_SDK_TESTS"], {
      env: { ...process.env, GHC_GATEWAY_SDK_TESTS: "1" },
    })).resolves.toMatchObject({ stdout: "" });
  });

  it("classifies loopback network targets for the CI network guard", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("github.com")).toBe(false);
    expect(isAllowedNetworkTarget("http://127.0.0.1:31400/healthz")).toBe(true);
    expect(isAllowedNetworkTarget("https://github.com/login/device/code")).toBe(false);
  });

  it("preloads the CI network guard without contacting external hosts", async () => {
    const guardUrl = pathToFileURL(path.resolve("scripts/refactor/ci_network_guard.mjs")).href;

    await expect(execFileAsync(process.execPath, [
      "--import",
      guardUrl,
      "--eval",
      "fetch('https://github.com').catch((error) => { console.error(error.message); process.exit(2); })",
    ])).rejects.toMatchObject({ code: 2 });
  });
});
