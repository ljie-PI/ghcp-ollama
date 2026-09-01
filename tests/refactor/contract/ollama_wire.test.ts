import { describe, expect, it } from "vitest";
import { ollamaErrorBody } from "../../../src/protocols/ollama_chat/wire.js";
import { VERSION } from "../../../src/version.js";

describe("RM-10 Ollama wire helpers", () => {
  it("uses the fixed error envelope and gateway version", () => {
    expect(ollamaErrorBody("invalid request")).toBe("{\"error\":\"invalid request\"}");
    expect(VERSION).toBe("0.1.0");
  });
});
