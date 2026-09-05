import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/main.js";

class CaptureStream {
  chunks = "";
  write(chunk: string): void {
    this.chunks += chunk;
  }
}

describe("CLI runtime support", () => {
  it("fails early with a safe unsupported-runtime diagnostic", async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(runCli({
      argv: ["--json", "status"],
      homedir: "Q:\\tmp\\home",
      stdout,
      stderr,
      nodeVersion: "24.0.0",
    })).resolves.toBe(2);

    expect(stdout.chunks).toBe("");
    expect(stderr.chunks).toBe(`${JSON.stringify({
      ok: false,
      error: {
        code: "unsupported_runtime",
        message: "Node.js 24.20.0 or newer is required",
      },
    })}\n`);
  });
});
