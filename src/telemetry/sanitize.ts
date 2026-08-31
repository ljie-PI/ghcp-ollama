const ALLOWLIST = new Set([
  "protocol",
  "metric",
  "thresholdms",
  "actualms",
  "status",
  "reason",
  "outcome",
]);

export const METADATA_LIMIT_BYTES = 16 * 1024;
export const LOG_LINE_LIMIT_BYTES = 64 * 1024;

export function sanitizeMetadata(input: unknown): Record<string, string | number | boolean> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (!ALLOWLIST.has(normalized)) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function metadataJsonOrRejected(metadata: Record<string, string | number | boolean>): {
  readonly json: string;
  readonly kind: string;
} {
  const json = JSON.stringify(metadata);
  if (utf8Bytes(json) <= METADATA_LIMIT_BYTES) {
    return { json, kind: "ok" };
  }
  return { json: JSON.stringify({ reason: "metadata_rejected" }), kind: "metadata_rejected" };
}
