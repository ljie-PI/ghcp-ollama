import { describe, expect, it } from "vitest";
import { encodeNdjson } from "../../../src/protocols/ollama_chat/wire.js";

describe("RM-10 Ollama stream wire", () => {
  it("encodes one compact JSON object and a trailing LF", () => {
    const bytes = encodeNdjson({ done: true });
    expect(new TextDecoder().decode(bytes)).toBe("{\"done\":true}\n");
  });
});
