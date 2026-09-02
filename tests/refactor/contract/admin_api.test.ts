import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import { DeviceFlowService, type DeviceOAuthClient } from "../../../src/accounts/device_flow.js";
import { DefaultAdminManagementApi, SqliteAdminTelemetry } from "../../../src/admin/api.js";
import { AdminAuth } from "../../../src/admin/auth.js";
import { createAdminRoutes } from "../../../src/admin/routes.js";
import { CopilotModelCatalog } from "../../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { RuntimeConfigStore } from "../../../src/config/runtime_config.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { createGateway, type Gateway } from "../../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../../src/persistence/migrations/020_telemetry.js";
import { migration as historyMigration } from "../../../src/persistence/migrations/030_responses_history.js";
import { SqliteResponsesHistory } from "../../../src/protocols/responses/history.js";

const ORIGIN = "http://127.0.0.1:31400";

describe("RM-20 admin API", () => {
  it("serves management DTOs, rejects coercion, and preserves no-store errors", async () => {
    const harness = await adminGateway();
    try {
      const session = await login(harness.gw, harness.auth);
      const status = await get(harness.gw, "/admin/api/v1/status", session.cookie);
      expect(status.status).toBe(200);
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toMatchObject({ data: { version: "test", health: "ok" } });

      const config = await get(harness.gw, "/admin/api/v1/config", session.cookie);
      const configBody = await config.json() as { data: { revision: number; config: unknown } };
      const bad = await mutate(harness.gw, "PUT", "/admin/api/v1/config", session, { expectedRevision: String(configBody.data.revision), config: configBody.data.config });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: { code: "validation_failed", requestId: "req_admin_api" } });

      const history = await get(harness.gw, "/admin/api/v1/history", session.cookie);
      expect(await history.json()).toMatchObject({ data: { count: 0, ttlDays: 7, maxResponses: 512 } });

      const unknownQuery = await get(harness.gw, "/admin/api/v1/usage?bad=1", session.cookie);
      expect(unknownQuery.status).toBe(400);
    } finally {
      await harness.close();
    }
  });
});

async function adminGateway(): Promise<{ readonly gw: Gateway; readonly auth: AdminAuth; readonly close: () => Promise<void> }> {
  const database = openDatabase({
    path: ":memory:",
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration), embedMigration(telemetryMigration), embedMigration(historyMigration)],
    nowMs: () => 1_800_000_000_000,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), () => 1_800_000_000_000);
  const runtimeConfig = new RuntimeConfigStore(database, () => 1_800_000_000_000);
  runtimeConfig.seedIfEmpty({});
  const auth = new AdminAuth({ nowMs: () => 1_800_000_000_000 });
  const api = new DefaultAdminManagementApi({
    directory,
    deviceFlows: new DeviceFlowService(directory, pendingDeviceFlow(), () => 1_800_000_000_000),
    catalog: new CopilotModelCatalog({ async fetch() { return { data: [] }; } }),
    preferences: directory.preferences,
    runtimeConfig,
    history: new SqliteResponsesHistory(database, { nowMs: () => 1_800_000_000_000 }),
    telemetry: new SqliteAdminTelemetry(database),
    nowMs: () => 1_800_000_000_000,
    version: "test",
  });
  const gw = await createGateway({ startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/rm20-admin" }), runtime: defaultRuntimeConfigSnapshot() }, createAdminRoutes({ auth, api, origin: ORIGIN, nowMs: () => 1_800_000_000_000 }), { createRequestId: () => "req_admin_api" });
  return { gw, auth, close: async () => { await gw.close(); closeDatabase(database); } };
}

function pendingDeviceFlow(): DeviceOAuthClient {
  return {
    async requestDeviceCode() { return { deviceCode: "device", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", intervalSec: 5, expiresInSec: 900 }; },
    async exchangeDeviceCode() { return { status: "pending" }; },
  };
}

async function login(gw: Gateway, auth: AdminAuth): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const token = auth.mintBootstrapToken().token;
  const response = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ token }) }));
  const body = await response.json() as { data: { csrfToken: string } };
  return { cookie: response.headers.get("set-cookie") ?? "", csrf: body.data.csrfToken };
}

async function get(gw: Gateway, path: string, cookie: string): Promise<Response> {
  return await gw.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
}

async function mutate(gw: Gateway, method: string, path: string, session: { readonly cookie: string; readonly csrf: string }, body: unknown): Promise<Response> {
  return await gw.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", cookie: session.cookie, origin: ORIGIN, "x-ghcg-csrf": session.csrf }, body: JSON.stringify(body) }));
}
