import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import { CopilotModelCatalog } from "../../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { createGateway } from "../../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { PreferredModelManager } from "../../../src/protocols/model_catalog/preferred.js";
import { createModelCatalogRoutes } from "../../../src/protocols/model_catalog/routes.js";

const nowMs = (): number => 1_700_000_000_000;

describe("RM-08 model routes errors and preferences", () => {
  it("returns 401 without an account and invalidates missing preferences", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return { data: [{ id: "visible", name: "V", vendor: "x", model_picker_enabled: true }] };
      },
    });
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      catalog,
      preferences: accounts.preferences,
    }));
    try {
      const missing = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(missing.status).toBe(401);
      await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "t" },
      });
      const ok = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(ok.status).toBe(200);
      const snapshot = await catalog.get("github.com/1", new AbortController().signal);
      const manager = new PreferredModelManager(accounts.preferences);
      manager.setPreferred("github.com/1", "visible", 0, snapshot);
      catalog.invalidate("github.com/1");
      const empty = new CopilotModelCatalog({
        async fetch() {
          return { data: [] };
        },
      });
      await empty.get("github.com/1", new AbortController().signal);
      accounts.preferences.markInvalidIfMissing("github.com/1", new Set(), 2);
      expect(accounts.preferences.get("github.com/1")?.validity).toBe("invalid");
    } finally {
      await gw.close();
      closeDatabase(database);
    }
  });
});
