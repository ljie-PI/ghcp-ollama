import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../../src/copilot/backend.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { createGateway } from "../../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { createOllamaChatRoutes } from "../../../src/protocols/ollama_chat/endpoint.js";

const nowMs = (): number => 1_700_000_000_000;

async function ollamaGateway(backend: ScriptedCopilotBackend) {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-ollama-"));
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
  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, createOllamaChatRoutes({
    directory: accounts,
    copilot: backend,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  }));
  return { gw, close: async () => { await gw.close(); closeDatabase(database); } };
}

describe("RM-10 Ollama request", () => {
  it("requires model and messages and defaults stream to true", async () => {
    const backend = new ScriptedCopilotBackend({
      chatStream: [new TextEncoder().encode("data: [DONE]\n\n")],
    });
    const { gw, close } = await ollamaGateway(backend);
    try {
      const missing = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }));
      expect(missing.status).toBe(400);
      expect(await missing.text()).toBe("{\"error\":\"invalid request\"}");

      const ok = await gw.fetch(new Request("http://127.0.0.1:31400/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt", messages: [{ role: "user", content: "hi" }] }),
      }));
      expect(ok.headers.get("content-type")).toBe("application/x-ndjson");
      const text = await ok.text();
      expect(text.endsWith("\n")).toBe(true);
      expect(text).toContain("\"done\":true");
    } finally {
      await close();
    }
  });
});
