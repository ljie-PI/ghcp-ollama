import { mkdtemp } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLogger, LOG_FILE_BYTES } from "../../../src/telemetry/logger.js";

describe("RM-05 JSONL logger", () => {
  it("sanitizes records, caps line size, and rotates at 10 MiB", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-log-"));
    const logger = new JsonlLogger(dir, () => 1_700_000_000_000);
    logger.write({ protocol: "ollama", token: "SECRET", prompt: "CANARY" });
    const active = path.join(dir, "gateway.log");
    const first = readFileSync(active, "utf8");
    expect(first).toContain("ollama");
    expect(first).not.toContain("SECRET");
    expect(first).not.toContain("CANARY");

    logger.write({ protocol: "n".repeat(70_000) });
    const after = readFileSync(active, "utf8");
    expect(after).toContain("log_line_truncated");

    const chunk = "x".repeat(512 * 1024);
    const writes = Math.ceil(LOG_FILE_BYTES / (512 * 1024)) + 2;
    for (let index = 0; index < writes; index += 1) {
      logger.write({ chunk });
    }
    const names = readdirSync(dir);
    expect(names.some((name) => name.startsWith("gateway.") && name.endsWith(".log"))).toBe(true);
    expect(names.length).toBeLessThanOrEqual(6);
  });
});
