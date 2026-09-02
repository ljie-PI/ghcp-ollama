import { serializeWireJson, type WireJsonObject } from "../../serialization/wire_json.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export const RESPONSES_JSON_HEADERS = JSON_HEADERS;

export const RESPONSES_STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
} as const;

export function encodeResponsesSseEvent(event: WireJsonObject): Uint8Array {
  const type = event.members.find((member) => member.key === "type")?.value;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error("Responses SSE event type must be non-empty");
  }
  return new TextEncoder().encode(`event: ${type}\ndata: ${new TextDecoder().decode(serializeWireJson(event))}\n\n`);
}

export function serializeResponsesErrorBody(message: string, type: string): string {
  return JSON.stringify({
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  });
}
