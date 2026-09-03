import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactManifest,
  inspectAdminBundle,
  type NpmPackEntry,
} from "../../../scripts/refactor/pack.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("RM-22 package evidence", () => {
  it("requires the index, Vite manifest, and hashed JavaScript and CSS in the package", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-pack-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, ".vite"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<script src=\"/admin/assets/index-AbCd1234.js\"></script>");
    await writeFile(path.join(root, "assets", "index-AbCd1234.js"), "export {};\n");
    await writeFile(path.join(root, "assets", "index-EfGh5678.css"), "body{}\n");
    await writeFile(path.join(root, ".vite", "manifest.json"), JSON.stringify({
      "index.html": {
        file: "assets/index-AbCd1234.js",
        css: ["assets/index-EfGh5678.css"],
        isEntry: true,
      },
    }));
    const files = [
      "index.html",
      ".vite/manifest.json",
      "assets/index-AbCd1234.js",
      "assets/index-EfGh5678.css",
    ].map((file) => ({ path: `dist/admin/${file}`, size: 1 }));

    const evidence = await inspectAdminBundle({ files }, root);

    expect(evidence.assets).toHaveLength(4);
    expect(evidence.assets.every((asset) => asset.packaged)).toBe(true);
    expect(evidence.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256))).toBe(true);
    expect(evidence.bytes).toBeGreaterThan(0);
  });

  it("fails when npm dry-run omits a required built asset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-pack-missing-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, ".vite"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "admin");
    await writeFile(path.join(root, "assets", "index-AbCd1234.js"), "export {};\n");
    await writeFile(path.join(root, "assets", "index-EfGh5678.css"), "body{}\n");
    await writeFile(path.join(root, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "assets/index-AbCd1234.js", css: ["assets/index-EfGh5678.css"] },
    }));
    const entry: Pick<NpmPackEntry, "files"> = {
      files: [{ path: "dist/admin/index.html", size: 5 }],
    };

    await expect(inspectAdminBundle(entry, root)).rejects.toThrow("npm package omits Admin assets");
  });

  it("rejects extra and missing package files", () => {
    expect(() => assertExactManifest(
      ["package.json", "dist/src/main.js", "src/main.ts"],
      ["package.json", "dist/src/main.js", "dist/admin/index.html"],
    )).toThrow("unexpected=[src/main.ts], missing=[dist/admin/index.html]");
  });
});
