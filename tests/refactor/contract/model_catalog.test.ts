import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import {
  CopilotModelCatalog,
  parseCapiModels,
} from "../../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { createGateway } from "../../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { createModelCatalogRoutes } from "../../../src/protocols/model_catalog/routes.js";
import { resolveModel } from "../../../src/protocols/model_catalog/resolver.js";
import { serializeAnthropicModels, serializeOllamaTags, serializeOpenAiModels } from "../../../src/protocols/model_catalog/wire.js";

const nowMs = (): number => 1_700_000_000_000;

const CAPI = {
  data: [
    { id: "keep", name: "Keep", vendor: "x", model_picker_enabled: true, capabilities: { mode: "chat", supported_endpoints: ["/v1/chat/completions"] } },
    { id: "hidden", name: "Hidden", vendor: "x", model_picker_enabled: false },
    { id: "keep", name: "Dup", vendor: "x", model_picker_enabled: true },
  ],
};

describe("RM-08 CAPI parse and cache", () => {
  it("keeps picker-enabled models in upstream order including duplicates", () => {
    const models = parseCapiModels(CAPI);
    expect(models.map((model) => model.id)).toEqual(["keep", "keep"]);
  });

  it("rejects incomplete CAPI items", () => {
    expect(() => parseCapiModels({ data: [{ id: "x" }] })).toThrow(/invalid/u);
  });

  it("does not write cache after invalidate generation change", async () => {
    let fetches = 0;
    const catalog = new CopilotModelCatalog({
      async fetch() {
        fetches += 1;
        return CAPI;
      },
    }, () => new Date("2026-08-30T05:00:00.000Z"));
    const first = catalog.get("github.com/1", new AbortController().signal);
    catalog.invalidate("github.com/1");
    const snapshot = await first;
    expect(snapshot.models[0]?.id).toBe("keep");
    await catalog.get("github.com/1", new AbortController().signal);
    expect(fetches).toBe(2);
  });

  it("caches empty catalogs per account and does not share them", async () => {
    const seen: string[] = [];
    const catalog = new CopilotModelCatalog({
      async fetch(accountId) {
        seen.push(accountId);
        return { data: [] };
      },
    });
    const a = await catalog.get("github.com/1", new AbortController().signal);
    const b = await catalog.get("github.com/1", new AbortController().signal);
    const c = await catalog.get("github.com/2", new AbortController().signal);
    expect(a.models).toEqual([]);
    expect(b.models).toEqual([]);
    expect(c.accountId).toBe("github.com/2");
    expect(seen).toEqual(["github.com/1", "github.com/2"]);
  });
});

describe("RM-08 model resolver", () => {
  const catalog = {
    accountId: "github.com/1",
    fetchedAt: "t",
    generation: 1,
    models: [{ id: "gpt", name: "GPT", vendor: "x", modelPickerEnabled: true }],
  };

  it("uses valid visible preference only when model is missing", () => {
    const resolved = resolveModel(catalog, undefined, { modelId: "gpt", validity: "valid" });
    expect(resolved).toMatchObject({ source: "preferred", upstreamModel: "gpt" });
    expect(resolveModel(catalog, undefined, { modelId: "gpt", validity: "invalid" })).toEqual({ kind: "invalid_request" });
    expect(resolveModel(catalog, "nope", { modelId: "gpt", validity: "valid" })).toEqual({ kind: "model_not_found" });
    expect(resolveModel(catalog, "", null)).toEqual({ kind: "invalid_request" });
  });
});

describe("RM-08 listing routes", () => {
  it("serializes one snapshot as OpenAI, Anthropic, and Ollama shapes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return CAPI;
      },
    }, () => new Date("2026-08-30T05:00:00.000Z"));
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      catalog,
      preferences: accounts.preferences,
    }));
    try {
      const openai = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(openai.status).toBe(200);
      const openaiBody = JSON.parse(await openai.text()) as { object: string; data: Array<{ id: string; owned_by: string; created: number }> };
      expect(openaiBody.object).toBe("list");
      expect(openaiBody.data[0]).toMatchObject({ id: "keep", owned_by: "openai", created: 1_677_610_602 });
      expect(openai.headers.get("cache-control")).toBe("no-store");

      const anthropic = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models", {
        headers: { "anthropic-version": "" },
      }));
      const anthropicBody = JSON.parse(await anthropic.text()) as { first_id: string; data: Array<{ type: string; max_tokens: null }> };
      expect(anthropicBody.first_id).toBe("keep");
      expect(anthropicBody.data[0]?.type).toBe("model");
      expect(anthropicBody.data[0]?.max_tokens).toBeNull();

      const tags = await gw.fetch(new Request("http://127.0.0.1:31400/api/tags"));
      const tagsBody = JSON.parse(await tags.text()) as { models: Array<{ name: string; digest: string }> };
      expect(tagsBody.models[0]?.name).toBe("keep");
      expect(tagsBody.models[0]?.digest).toBe("copilot-keep");

      expect((await gw.fetch(new Request("http://127.0.0.1:31400/models"))).status).toBe(404);
    } finally {
      await gw.close();
      closeDatabase(database);
    }
  });
});

describe("RM-08 serializers", () => {
  it("omits routing metadata from public OpenAI objects", () => {
    const catalog = {
      accountId: "a",
      fetchedAt: "2026-08-30T05:00:00Z",
      generation: 1,
      models: [{
        id: "m",
        name: "M",
        vendor: "v",
        modelPickerEnabled: true,
        routing: { mode: "responses", supportedEndpoints: ["/v1/responses"] },
      }],
    };
    const openai = JSON.parse(serializeOpenAiModels(catalog, new Map())) as { data: Array<Record<string, unknown>> };
    expect(openai.data[0]?.supported_endpoints).toBeUndefined();
    expect(JSON.parse(serializeAnthropicModels(catalog, new Map())).data[0].display_name).toBe("m");
    expect(JSON.parse(serializeOllamaTags(catalog)).models[0].modified_at).toBe("2026-08-30T05:00:00Z");
  });
});
