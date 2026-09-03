import { mkdtemp } from "node:fs/promises";
import { readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLogger, LOG_FILE_BYTES } from "../../../src/daemon/logger.js";

describe("RM-19 daemon JSONL logger", () => {
  it("sanitizes records, caps line size, and rotates at 10 MiB", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-"));
    const dir = path.join(root, "logs");
    const logger = new JsonlLogger(dir, () => 1_700_000_000_000);
    logger.write({ protocol: "ollama", token: "SECRET", prompt: "CANARY" });
    const active = path.join(dir, "gateway.jsonl");
    const first = readFileSync(active, "utf8");
    expect(first).toContain("ollama");
    expect(first).not.toContain("SECRET");
    expect(first).not.toContain("CANARY");

    logger.write({ protocol: "n".repeat(70_000) });
    const after = readFileSync(active, "utf8");
    expect(after).toContain("log_line_truncated");

    const chunk = "x".repeat(64 * 1024 - 200);
    const writes = Math.ceil(LOG_FILE_BYTES / (64 * 1024)) + 2;
    for (let index = 0; index < writes; index += 1) {
      logger.write({ protocol: chunk });
    }
    const names = readdirSync(dir);
    expect(names.some((name) => /^gateway\.\d+\.\d+\.jsonl$/u.test(name))).toBe(true);
    expect(names.length).toBeLessThanOrEqual(5);
  });

  it.skipIf(process.platform === "win32")("protects JSONL files, rotates before overflow, and applies count and age retention", async () => {
    let now = 1_700_000_000_000;
    const root = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-protected-"));
    const dir = path.join(root, "logs");
    const logger = new JsonlLogger(dir, () => now);
    const active = path.join(dir, "gateway.jsonl");
    const chunk = "x".repeat(64 * 1024 - 200);

    for (let index = 0; index < 200; index += 1) {
      now += 1;
      logger.write({ protocol: chunk });
      expect(statSync(active).size).toBeLessThanOrEqual(LOG_FILE_BYTES);
    }

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(active).mode & 0o777).toBe(0o600);
    const rotated = readdirSync(dir).filter((name) => name !== "gateway.log");
    expect(rotated.length).toBeGreaterThan(0);
    expect(rotated.length).toBeLessThanOrEqual(4);

    const old = path.join(dir, rotated[0] ?? "missing");
    utimesSync(old, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    logger.write({ category: "retention" });
    expect(readdirSync(dir)).not.toContain(path.basename(old));
  });
});
