export function ollamaErrorBody(text: string): string {
  return ollamaJsonStringify({ error: text });
}

export function ollamaCreatedAt(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/u, "Z");
}

export function encodeNdjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${ollamaJsonStringify(value)}\n`);
}

export function ollamaJsonStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
