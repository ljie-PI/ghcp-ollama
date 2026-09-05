import { describe, expect, it } from "vitest";
import type { CatalogSnapshot } from "../../src/copilot/model_catalog.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import { planResponsesExecution } from "../../src/protocols/responses/planner.js";
import { isWireJsonObject, parseWireJson } from "../../src/serialization/wire_json.js";
import { resolveModel } from "../../src/protocols/model_catalog/resolver.js";

describe("Responses planner", () => {
  it("selects native or bridge from resolved routing metadata without model-name inference", () => {
    expect(plan("native", { mode: "responses", supportedEndpoints: [] }).kind).toBe("native_responses");
    expect(plan("chat", { mode: "chat", supportedEndpoints: ["/v1/responses"] }).kind).toBe("chat_bridge");
    expect(plan("endpoint", { supportedEndpoints: ["/v1/responses"] }).kind).toBe("native_responses");
    expect(plan("unknown", { mode: "other", supportedEndpoints: ["/v1/chat/completions"] }).kind).toBe("chat_bridge");
    expect(plan("gpt-looks-native", {}).kind).toBe("chat_bridge");
  });

  it("freezes the original request, resolved model, stream flag, and normalized native URL", () => {
    const request = decode("{\"stream\":true,\"model\":\"native\",\"input\":\"hi\"}");
    const resolved = resolvedFromCatalog("native", { mode: "responses" });
    const plan = planResponsesExecution(request, resolved, {
      endpoint: "https://api.githubcopilot.com/",
      token: "secret",
    });
    expect(plan).toMatchObject({
      kind: "native_responses",
      originalRequest: request,
      resolvedModel: resolved,
      upstreamUrl: "https://api.githubcopilot.com/responses",
      stream: true,
    });
  });

  function plan(model: string, routing: CatalogSnapshot["models"][number]["routing"]) {
    const request = decode(`{"model":"${model}"}`);
    return planResponsesExecution(request, resolvedFromCatalog(model, routing), {
      endpoint: "https://copilot.example.test",
      token: "secret",
    });
  }

  function resolvedFromCatalog(model: string, routing: CatalogSnapshot["models"][number]["routing"]) {
    const catalog: CatalogSnapshot = {
      accountId: "github.com/1",
      fetchedAt: "2026-01-01T00:00:00Z",
      generation: 1,
      models: [{ id: model, name: model, vendor: "github", modelPickerEnabled: true, ...(routing === undefined ? {} : { routing }) }],
    };
    const resolved = resolveModel(catalog, model, null);
    if ("kind" in resolved) {
      throw new Error("expected resolved model");
    }
    return resolved;
  }

  function decode(json: string) {
    const parsed = parseWireJson(new TextEncoder().encode(json), { maxBytes: 1024, maxDepth: 16 });
    if (!isWireJsonObject(parsed)) {
      throw new Error("expected object");
    }
    return decodeResponsesRequest(parsed);
  }
});
