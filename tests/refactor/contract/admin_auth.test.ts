import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import { DeviceFlowService, type DeviceOAuthClient } from "../../../src/accounts/device_flow.js";
import { AdminAuth } from "../../../src/admin/auth.js";
import { DefaultAdminManagementApi, SqliteAdminTelemetry } from "../../../src/admin/api.js";
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

async function adminGateway(nowRef: { value: number }): Promise<{
  readonly gw: Gateway;
  readonly auth: AdminAuth;
  readonly close: () => Promise<void>;
}> {
  const database = openDatabase({
    path: ":memory:",
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(historyMigration),
    ],
    nowMs: () => nowRef.value,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), () => nowRef.value);
  const runtimeConfig = new RuntimeConfigStore(database, () => nowRef.value);
  runtimeConfig.seedIfEmpty({});
  const auth = new AdminAuth({ nowMs: () => nowRef.value });
  const api = new DefaultAdminManagementApi({
    directory,
    deviceFlows: new DeviceFlowService(directory, pendingDeviceFlow(), () => nowRef.value),
    catalog: new CopilotModelCatalog({ async fetch() { return { data: [] }; } }),
    preferences: directory.preferences,
    runtimeConfig,
    history: new SqliteResponsesHistory(database, { nowMs: () => nowRef.value }),
    telemetry: new SqliteAdminTelemetry(database),
    nowMs: () => nowRef.value,
    version: "test",
  });
  const gw = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:\\ghcp-ollama-worktrees\\rm-20\\.home" }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, createAdminRoutes({ auth, api, origin: ORIGIN, nowMs: () => nowRef.value }), {
    createRequestId: () => "req_admin_auth",
  });
  return {
    gw,
    auth,
    close: async () => {
      await gw.close();
      closeDatabase(database);
    },
  };
}

function pendingDeviceFlow(): DeviceOAuthClient {
  return {
    async requestDeviceCode() {
      return {
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSec: 5,
        expiresInSec: 900,
      };
    },
    async exchangeDeviceCode() {
      return { status: "pending" };
    },
  };
}

async function bootstrap(gw: Gateway, auth: AdminAuth, origin = ORIGIN): Promise<Response> {
  const token = auth.mintBootstrapToken().token;
  return await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  }));
}

async function login(gw: Gateway, auth: AdminAuth): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const response = await bootstrap(gw, auth);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  const body = await response.json() as { data: { csrfToken: string } };
  return { cookie, csrf: body.data.csrfToken };
}

describe("RM-20 admin auth", () => {
  it("exchanges bootstrap tokens once, rejects wrong origin, and sets safe cookie flags", async () => {
    const now = { value: 1_800_000_000_000 };
    const { gw, auth, close } = await adminGateway(now);
    try {
      const wrongOrigin = await bootstrap(gw, auth, "http://localhost:31400");
      expect(wrongOrigin.status).toBe(403);

      const token = auth.mintBootstrapToken().token;
      const first = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token }),
      }));
      expect(first.status).toBe(200);
      const setCookie = first.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/admin");

      const reused = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token }),
      }));
      expect(reused.status).toBe(401);

      const raceToken = auth.mintBootstrapToken().token;
      const raced = await Promise.all([0, 1].map(async () => await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token: raceToken }),
      }))));
      expect(raced.map((response) => response.status).sort()).toEqual([200, 401]);
    } finally {
      await close();
    }
  });

  it("expires bootstrap tokens and admin sessions by idle, absolute, cap, and restart boundaries", async () => {
    const now = { value: 1_800_000_000_000 };
    const { gw, auth, close } = await adminGateway(now);
    try {
      const expiredToken = auth.mintBootstrapToken().token;
      now.value += 61_000;
      const expired = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token: expiredToken }),
      }));
      expect(expired.status).toBe(401);

      const session = await login(gw, auth);
      now.value += 30 * 60_000 + 1;
      const idle = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/session`, {
        headers: { cookie: session.cookie },
      }));
      expect(idle.status).toBe(401);

      const absolute = await login(gw, auth);
      now.value += 12 * 60 * 60_000 + 1;
      const absoluteExpired = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/session`, {
        headers: { cookie: absolute.cookie },
      }));
      expect(absoluteExpired.status).toBe(401);

      auth.reset();
      const restarted = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/auth/session`, {
        headers: { cookie: absolute.cookie },
      }));
      expect(restarted.status).toBe(401);

      const fresh = await adminGateway({ value: 1_900_000_000_000 });
      try {
        for (let index = 0; index < 8; index += 1) {
          expect((await bootstrap(fresh.gw, fresh.auth)).status).toBe(200);
        }
        expect((await bootstrap(fresh.gw, fresh.auth)).status).toBe(503);
      } finally {
        await fresh.close();
      }
    } finally {
      await close();
    }
  });

  it("requires exact Origin and CSRF on mutations but not on state reads", async () => {
    const now = { value: 1_800_000_000_000 };
    const { gw, auth, close } = await adminGateway(now);
    try {
      const session = await login(gw, auth);
      const status = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/status`, {
        headers: { cookie: session.cookie },
      }));
      expect(status.status).toBe(200);

      const missingCsrf = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: session.cookie, origin: ORIGIN },
        body: JSON.stringify({ host: "github.com" }),
      }));
      expect(missingCsrf.status).toBe(403);

      const wrongOrigin = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: "http://localhost:31400",
          "x-ghcg-csrf": session.csrf,
        },
        body: JSON.stringify({ host: "github.com" }),
      }));
      expect(wrongOrigin.status).toBe(403);

      const ok = await gw.fetch(new Request(`${ORIGIN}/admin/api/v1/device-flows`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: ORIGIN,
          "x-ghcg-csrf": session.csrf,
        },
        body: JSON.stringify({ host: "github.com" }),
      }));
      expect(ok.status).toBe(201);
    } finally {
      await close();
    }
  });
});
