import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import {
  CopilotModelCatalog,
  parseCapiModels,
} from "../../../src/copilot/model_catalog.js";
import { CapiFetchError, HttpCopilotModelsSource } from "../../../src/copilot/models_source.js";
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

  it("maps CAPI redirects, Retry-After, body limits, and timeouts safely", async () => {
    const source = (fetchImpl: typeof fetch) => new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      fetchImpl,
      { connectTimeoutMs: 1, totalTimeoutMs: 20, bodyLimitBytes: 32 },
    );

    await expect(source(async () => new Response(null, { status: 302 })).fetch("github.com/1", new AbortController().signal))
      .rejects.toMatchObject({ status: 502 });

    await expect(source(async () => new Response("{}", {
      status: 429,
      headers: { "retry-after": "120, 240" },
    })).fetch("github.com/1", new AbortController().signal))
      .rejects.toMatchObject({ status: 429, retryAfter: undefined });

    await expect(source(async () => new Response("{}", {
      status: 429,
      headers: { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" },
    })).fetch("github.com/1", new AbortController().signal))
      .rejects.toMatchObject({ status: 429, retryAfter: "Sun, 06 Nov 1994 08:49:37 GMT" });

    await expect(source(async () => new Response(`{"data":"${"x".repeat(40)}"}`)).fetch("github.com/1", new AbortController().signal))
      .rejects.toBeInstanceOf(CapiFetchError);

    await expect(source(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("{\"data\":[]}");
    }).fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  });

  it("cleans up CAPI bodies on invalid redirects, body timeout, and caller abort", async () => {
    let redirectCanceled = false;
    const redirectSource = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          redirectCanceled = true;
        },
      }), { status: 302, headers: { location: "http://[invalid" } }),
      { connectTimeoutMs: 20, totalTimeoutMs: 20, bodyLimitBytes: 32 },
    );
    await expect(redirectSource.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    expect(redirectCanceled).toBe(true);

    let timeoutCanceled = false;
    const timeoutSource = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          timeoutCanceled = true;
        },
      }), { status: 200 }),
      { connectTimeoutMs: 20, totalTimeoutMs: 1, bodyLimitBytes: 32 },
    );
    await expect(timeoutSource.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    for (let index = 0; index < 20 && !timeoutCanceled; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(timeoutCanceled).toBe(true);

    let abortCanceled = false;
    const abortController = new AbortController();
    const abortSource = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          abortCanceled = true;
        },
      }), { status: 200 }),
      { connectTimeoutMs: 20, totalTimeoutMs: 20, bodyLimitBytes: 32 },
    );
    const pending = abortSource.fetch("github.com/1", abortController.signal);
    abortController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (let index = 0; index < 20 && !abortCanceled; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(abortCanceled).toBe(true);
  });

  it("uses the default Undici request path without automatic decompression", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/models") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(gzipSync("{\"data\":[]}"));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    try {
      const source = new HttpCopilotModelsSource(
        async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      );
      await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("strips sensitive CAPI headers on cross-host redirects", async () => {
    let calls = 0;
    let redirectedHeaders: Headers | undefined;
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://copilot.example.com/models" },
          });
        }
        redirectedHeaders = new Headers(init?.headers);
        return new Response("{\"data\":[]}", { status: 200 });
      },
      { connectTimeoutMs: 20, totalTimeoutMs: 100, bodyLimitBytes: 32 },
    );
    await source.fetch("github.com/1", new AbortController().signal);
    expect(calls).toBe(2);
    expect(redirectedHeaders?.has("authorization")).toBe(false);
    expect(redirectedHeaders?.has("cookie")).toBe(false);
    expect(redirectedHeaders?.has("cookie2")).toBe(false);
    expect(redirectedHeaders?.has("proxy-authorization")).toBe(false);
    expect(redirectedHeaders?.has("www-authenticate")).toBe(false);
  });

  it("enforces timeout on the default Undici request path", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{\"data\":[]}");
      }, 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    try {
      const source = new HttpCopilotModelsSource(
        async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
        fetch,
        { connectTimeoutMs: 100, totalTimeoutMs: 1, bodyLimitBytes: 32 },
      );
      await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
