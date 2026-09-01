export function ollamaErrorBody(text: string): string {
  return JSON.stringify({ error: text });
}

export function ollamaCreatedAt(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/u, "Z");
}

export function encodeNdjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}
