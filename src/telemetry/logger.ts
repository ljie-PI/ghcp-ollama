import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LOG_LINE_LIMIT_BYTES, sanitizeMetadata, utf8Bytes } from "./sanitize.js";

export const LOG_FILE_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class JsonlLogger {
  constructor(
    private readonly directory: string,
    private readonly nowMs: () => number = Date.now,
  ) {
    mkdirSync(directory, { recursive: true });
  }

  write(record: Record<string, unknown>): void {
    const sanitized = sanitizeMetadata(record);
    let line = JSON.stringify({ ts: this.nowMs(), ...sanitized });
    if (utf8Bytes(line) > LOG_LINE_LIMIT_BYTES) {
      line = JSON.stringify({ ts: this.nowMs(), overflow: true, reason: "log_line_truncated" });
    }
    const filePath = this.activeFile();
    appendFileSync(filePath, `${line}\n`, "utf8");
    this.rotateIfNeeded(filePath);
    this.prune();
  }

  private activeFile(): string {
    return path.join(this.directory, "gateway.log");
  }

  private rotateIfNeeded(filePath: string): void {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch (_error) {
      return;
    }
    if (size < LOG_FILE_BYTES) {
      return;
    }
    const stamp = this.nowMs();
    const rotated = path.join(this.directory, `gateway.${stamp}.log`);
    try {
      renameSync(filePath, rotated);
    } catch (_error) {
      // keep writing the active file if rotation races
    }
  }

  private prune(): void {
    const now = this.nowMs();
    const files = readdirSync(this.directory)
      .filter((name) => name.startsWith("gateway.") && name.endsWith(".log"))
      .map((name) => path.join(this.directory, name))
      .sort();
    const extra = files.length - (LOG_FILE_COUNT - 1);
    if (extra > 0) {
      for (const file of files.slice(0, extra)) {
        unlinkSync(file);
      }
    }
    for (const file of files.slice(Math.max(0, extra))) {
      try {
        if (now - statSync(file).mtimeMs > LOG_MAX_AGE_MS) {
          unlinkSync(file);
        }
      } catch (_error) {
        // ignore missing
      }
    }
  }
}
