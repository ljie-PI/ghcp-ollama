import { describe, expect, it } from "vitest";
import { encodeNdjson, ollamaErrorBody } from "../../src/protocols/ollama_chat/wire.js";
import { VERSION } from "../../src/version.js";

describe("Ollama wire helpers", () => {
  it("uses the fixed error envelope and gateway version", () => {
    expect(ollamaErrorBody("invalid request")).toBe("{\"error\":\"invalid request\"}");
    expect(VERSION).toBe("0.1.0");
  });

  it("matches Go escaping for HTML, Unicode separators, controls, and final LF", () => {
    const bytes = encodeNdjson({ message: { content: "<>&\u2028\u2029\nok" } });
    expect(new TextDecoder().decode(bytes)).toBe("{\"message\":{\"content\":\"\\u003c\\u003e\\u0026\\u2028\\u2029\\nok\"}}\n");
  });
});
