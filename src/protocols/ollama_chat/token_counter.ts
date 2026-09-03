import type { OllamaTokenCounter } from "./bridge.js";

export const litellmStyleTokenCounter: OllamaTokenCounter = (input) => {
  const text = input.text ?? flattenMessagesForTokenCounter(input.messages);
  return text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ?? 0;
};

function flattenMessagesForTokenCounter(value: unknown): string {
  if (!isWireArray(value)) {
    return "";
  }
  return value.items.map((item) => contentFromChatMessage(item)).join("\n");
}

function contentFromChatMessage(value: unknown): string {
  if (!isWireObject(value)) {
    return "";
  }
  const content = wireMember(value, "content");
  if (typeof content === "string") {
    return content;
  }
  if (isWireArray(content)) {
    return content.items.map(textFromContentPart).join("\n");
  }
  return "";
}

function textFromContentPart(value: unknown): string {
  if (!isWireObject(value)) {
    return "";
  }
  const text = wireMember(value, "text");
  return typeof text === "string" ? text : "";
}

function wireMember(value: { readonly members: readonly { readonly key: string; readonly value: unknown }[] }, key: string): unknown {
  return value.members.find((member) => member.key === key)?.value;
}

function isWireArray(value: unknown): value is { readonly kind: "array"; readonly items: readonly unknown[] } {
  return isRecord(value) && value.kind === "array" && Array.isArray(value.items);
}

function isWireObject(value: unknown): value is { readonly kind: "object"; readonly members: readonly { readonly key: string; readonly value: unknown }[] } {
  return isRecord(value) && value.kind === "object" && Array.isArray(value.members);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
