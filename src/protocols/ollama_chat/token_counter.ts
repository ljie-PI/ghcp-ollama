import type { OllamaTokenCounter } from "./bridge.js";

export const defaultOllamaTokenCounter: OllamaTokenCounter = (input) => {
  const text = input.text ?? flattenTokenCounterInput(input.messages);
  return tokenizeForUsageFallback(text).length;
};

function flattenTokenCounterInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenTokenCounterInput).join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).map(flattenTokenCounterInput).join("\n");
  }
  return "";
}

function tokenizeForUsageFallback(text: string): readonly string[] {
  return text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
}
