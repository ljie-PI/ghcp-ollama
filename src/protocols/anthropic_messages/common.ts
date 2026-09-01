import {
  isWireJsonNumber,
  memberValues,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";

export function firstMember(object: WireJsonObject, key: string): WireJson | undefined {
  return memberValues(object, key)[0];
}

export function wireToJson(value: WireJson): unknown {
  return JSON.parse(new TextDecoder().decode(serializeWireJson(value))) as unknown;
}

export function emptyWireObject(): WireJsonObject {
  return { kind: "object", members: [] };
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function unsignedInteger(value: WireJson | undefined): number | undefined {
  if (!isWireJsonNumber(value)) {
    return undefined;
  }
  const parsed = Number(value.lexeme);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeToolId(raw: string): { readonly id: string; readonly signature?: string } {
  const thoughtIndex = raw.indexOf("__thought__");
  const base = thoughtIndex >= 0 ? raw.slice(0, thoughtIndex) : raw;
  const signature = thoughtIndex >= 0 ? raw.slice(thoughtIndex + "__thought__".length) : undefined;
  const id = base.replace(/[^a-zA-Z0-9_-]/gu, "_") || "tool_use_id";
  return signature === undefined || signature.length === 0 ? { id } : { id, signature };
}

export function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
  const record = asRecord(value);
  return record?.type === "text" && typeof record.text === "string";
}