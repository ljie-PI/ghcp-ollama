import { serializeWireJson, type WireJson } from "../../serialization/wire_json.js";

const encoder = new TextEncoder();

export function encodeOpenAiChatSseChunk(value: WireJson): Uint8Array {
  return concat([
    encoder.encode("data: "),
    serializeWireJson(value),
    encoder.encode("\n\n"),
  ]);
}

export function encodeOpenAiChatDone(): Uint8Array {
  return encoder.encode("data: [DONE]\n\n");
}

export function serializeOpenAiErrorBody(message: string, type: string): string {
  return JSON.stringify({
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
