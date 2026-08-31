import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import {
  DeviceFlowError,
  DeviceFlowService,
  MAX_DEVICE_FLOWS,
  type DeviceOAuthClient,
} from "../../../src/accounts/device_flow.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";

const nowMs = (): number => 1_700_000_000_000;

function scriptedClient(): DeviceOAuthClient {
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
      return {
        status: "complete",
        accessToken: "gho_scripted",
        user: { id: "42", login: "octo", name: "Octo" },
      };
    },
  };
}

describe("RM-06 device flow", () => {
  it("completes a scripted login into a bound account", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
      const flows = new DeviceFlowService(accounts, scriptedClient(), nowMs);
      const started = await flows.start("github.com");
      expect(started.userCode).toBe("ABCD-1234");
      const result = await flows.poll(started.flowId);
      expect(result).toEqual({ status: "complete", accountId: "github.com/42" });
      const bound = await accounts.bindDefault();
      expect(bound.login).toBe("octo");
    } finally {
      closeDatabase(database);
    }
  });

  it("rejects a ninth concurrent flow", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
      const pendingClient: DeviceOAuthClient = {
        async requestDeviceCode() {
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 5,
            expiresInSec: 900,
          };
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      };
      const flows = new DeviceFlowService(accounts, pendingClient, nowMs);
      for (let index = 0; index < MAX_DEVICE_FLOWS; index += 1) {
        await flows.start("github.com");
      }
      await expect(flows.start("github.com")).rejects.toBeInstanceOf(DeviceFlowError);
    } finally {
      closeDatabase(database);
    }
  });

  it("cancels and expires scripted flows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-flow-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    try {
      const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
      let now = nowMs();
      const flows = new DeviceFlowService(accounts, {
        async requestDeviceCode() {
          return {
            deviceCode: "device",
            userCode: "CODE",
            verificationUri: "https://github.com/login/device",
            intervalSec: 5,
            expiresInSec: 1,
          };
        },
        async exchangeDeviceCode() {
          return { status: "pending" };
        },
      }, () => now);
      const started = await flows.start("ghe.example.com");
      flows.cancel(started.flowId);
      await expect(flows.poll(started.flowId)).rejects.toBeInstanceOf(DeviceFlowError);
      const second = await flows.start("ghe.example.com");
      now += 2_000;
      await expect(flows.poll(second.flowId)).rejects.toBeInstanceOf(DeviceFlowError);
    } finally {
      closeDatabase(database);
    }
  });
});
