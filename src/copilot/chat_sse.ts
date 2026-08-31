import { isWireJsonObject, parseWireJson } from "../serialization/wire_json.js";
import type { ChatStreamFrame } from "../protocols/chat_completions/types.js";

const DEFAULT_EVENT_LIMIT = 4 * 1024 * 1024;

export class ChatSseError extends Error {
  readonly code: "event_too_large" | "truncated";

  constructor(code: ChatSseError["code"], message: string) {
    super(message);
    this.name = "ChatSseError";
    this.code = code;
  }
}

export async function* parseChatSse(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes = DEFAULT_EVENT_LIMIT,
): AsyncGenerator<ChatStreamFrame> {
  let line = "";
  let pendingCr = false;
  let eventLines: string[] = [];
  let eventBytes = 0;
  let terminal = false;
  let bomSkip = 3;

  const finishLine = function* (): Generator<ChatStreamFrame> {
    if (line.length === 0) {
      const frame = parseEvent(eventLines);
      eventLines = [];
      eventBytes = 0;
      if (frame !== undefined) {
        yield frame;
        if (frame.kind === "done" || frame.kind === "error") {
          terminal = true;
        }
      }
      return;
    }
    eventLines.push(line);
    line = "";
  };

  const pushByte = function* (byte: number): Generator<ChatStreamFrame> {
    if (bomSkip > 0) {
      const expected = bomSkip === 3 ? 0xef : bomSkip === 2 ? 0xbb : 0xbf;
      if (byte === expected) {
        bomSkip -= 1;
        return;
      }
      bomSkip = 0;
    }
    eventBytes += 1;
    if (eventBytes > eventLimitBytes) {
      throw new ChatSseError("event_too_large", "SSE event exceeds limit");
    }
    if (pendingCr) {
      pendingCr = false;
      if (byte === 0x0a) {
        yield* finishLine();
        return;
      }
      yield* finishLine();
    }
    if (byte === 0x0d) {
      pendingCr = true;
      return;
    }
    if (byte === 0x0a) {
      yield* finishLine();
      return;
    }
    line += String.fromCharCode(byte);
  };

  for await (const part of bytes) {
    for (const byte of part) {
      yield* pushByte(byte);
      if (terminal) {
        return;
      }
    }
  }
  if (pendingCr) {
    yield* finishLine();
  }
  if (line.length > 0 || eventLines.length > 0 || !terminal) {
    throw new ChatSseError("truncated", "truncated SSE stream");
  }
}

function parseEvent(lines: readonly string[]): ChatStreamFrame | undefined {
  const dataLines: string[] = [];
  let eventName = "message";
  for (const raw of lines) {
    if (raw.length === 0 || raw.startsWith(":")) {
      continue;
    }
    if (raw.startsWith("event:")) {
      eventName = raw.slice(6).replace(/^ /u, "");
      continue;
    }
    if (raw.startsWith("data:")) {
      dataLines.push(raw.slice(5).replace(/^ /u, ""));
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const data = dataLines.join("\n");
  if (eventName === "error") {
    return { kind: "error", value: data };
  }
  if (data === "[DONE]") {
    return { kind: "done" };
  }
  try {
    const payload = parseWireJson(new TextEncoder().encode(data), {
      maxBytes: Math.max(data.length, 1),
      maxDepth: 64,
    });
    if (!isWireJsonObject(payload)) {
      return { kind: "error", value: data };
    }
    return { kind: "chunk", chunk: { payload } };
  } catch (_error) {
    return { kind: "error", value: data };
  }
}
