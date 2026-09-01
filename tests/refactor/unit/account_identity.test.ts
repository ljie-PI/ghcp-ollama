import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountDirectory, AccountDirectoryError } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore, type CredentialStore, type SecretCredential } from "../../../src/accounts/credential_store.js";
import {
  canonicalUserId,
  formatAccountId,
  GitHubEnvironmentError,
  normalizeGitHubHost,
  resolveGitHubEnvironment,
} from "../../../src/accounts/github_environment.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";

const nowMs = (): number => 1_700_000_000_000;

async function directory(maxAuthenticated = 8): Promise<{
  directory: AccountDirectory;
  database: ReturnType<typeof openDatabase>;
  credentials: MemoryCredentialStore;
  close: () => void;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-acc-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    nowMs,
  });
  const credentials = new MemoryCredentialStore();
  return {
    directory: new AccountDirectory(database, credentials, nowMs, maxAuthenticated),
    database,
    credentials,
    close: () => closeDatabase(database),
  };
}

describe("RM-06 GitHub host and account id", () => {
  it("normalizes host case, trailing dot, default port, and IDNA", () => {
    expect(normalizeGitHubHost("GitHub.COM.")).toBe("github.com");
    expect(normalizeGitHubHost("github.com:443")).toBe("github.com");
    expect(normalizeGitHubHost("ghe.example.com:8443")).toBe("ghe.example.com:8443");
    expect(normalizeGitHubHost("bücher.example")).toBe(normalizeGitHubHost("xn--bcher-kva.example"));
    expect(() => normalizeGitHubHost("github.com/path")).toThrow(GitHubEnvironmentError);
    expect(() => normalizeGitHubHost("https://github.com")).toThrow(GitHubEnvironmentError);
    expect(() => normalizeGitHubHost("user@github.com")).toThrow(GitHubEnvironmentError);
    expect(canonicalUserId("00789")).toBe("789");
    expect(formatAccountId("github.com", "00789")).toBe("github.com/789");
  });

  it("derives github.com and GHES URLs and client IDs", () => {
    const dotcom = resolveGitHubEnvironment("github.com");
    expect(dotcom).toMatchObject({
      kind: "github.com",
      apiBaseUrl: "https://api.github.com",
      clientId: "Iv1.b507a08c87ecfe98",
      deviceCodeUrl: "https://github.com/login/device/code",
    });
    const ghes = resolveGitHubEnvironment("ghe.example.com:8443");
    expect(ghes.kind).toBe("ghes");
    expect(ghes.apiBaseUrl).toBe("https://ghe.example.com:8443/api/v3");
    expect(ghes.clientId).toBe("Ov23li8tweQw6odWQebz");
    expect(ghes.deviceCodeUrl).toBe("https://ghe.example.com:8443/login/device/code");
  });
});

describe("RM-06 account directory", () => {
  it("binds a stable identity across login changes and relogin", async () => {
    const { directory: accounts, close } = await directory();
    try {
      const first = await accounts.upsertAuthenticated({
        host: "GitHub.COM",
        userId: "00789",
        login: "old",
        secret: { generation: 0, githubToken: "token-a" },
      });
      expect(first.accountId).toBe("github.com/789");
      const again = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: 789,
        login: "new",
        secret: { generation: 0, githubToken: "token-b" },
      });
      expect(again.accountId).toBe(first.accountId);
      expect(again.login).toBe("new");
      expect(accounts.list()).toHaveLength(1);
      const bound = await accounts.bindDefault();
      expect(bound.accountId).toBe("github.com/789");
    } finally {
      close();
    }
  });

  it("enforces authenticated capacity and default fallback order", async () => {
    const { directory: accounts, close } = await directory(1);
    try {
      await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "a" },
      });
      await expect(accounts.upsertAuthenticated({
        host: "github.com",
        userId: "2",
        secret: { generation: 0, githubToken: "b" },
      })).rejects.toBeInstanceOf(AccountDirectoryError);
    } finally {
      close();
    }
  });

  it("removes credentials and preferences but keeps identity", async () => {
    const { directory: accounts, close } = await directory();
    try {
      const bound = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "secret" },
      });
      accounts.preferences.set(bound.accountId, { modelId: "gpt", catalogGeneration: 1 }, 0);
      const removed = await accounts.remove(bound.accountId, 1);
      expect(removed.state).toBe("removed");
      expect(accounts.preferences.get(bound.accountId)).toBeNull();
      expect(accounts.list()[0]?.state).toBe("removed");
      const relogin = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "new" },
      });
      expect(relogin.accountId).toBe(bound.accountId);
    } finally {
      close();
    }
  });

  it("uses removing revision for resume and treats removed as idempotent", async () => {
    const { directory: accounts, close } = await directory();
    try {
      const bound = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "secret" },
      });
      const first = await accounts.remove(bound.accountId, 1);
      expect(first.state).toBe("removed");
      const again = await accounts.remove(bound.accountId, first.revision);
      expect(again.revision).toBe(first.revision);
      await expect(accounts.remove(bound.accountId, 1)).rejects.toBeInstanceOf(AccountDirectoryError);
    } finally {
      close();
    }
  });

  it("reconciles removing rows on startup", async () => {
    const { directory: accounts, database, close } = await directory();
    try {
      const bound = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "3",
        secret: { generation: 0, githubToken: "secret" },
      });
      database.prepare(
        "UPDATE accounts SET credential_state = 'removing', revision = revision + 1 WHERE account_id = ?",
      ).run(bound.accountId);
      await accounts.reconcile();
      expect(accounts.list()[0]?.state).toBe("removed");
    } finally {
      close();
    }
  });

  it("keeps other accounts' secrets when one identity relogs in", async () => {
    const { directory: accounts, credentials, close } = await directory();
    try {
      const first = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "one" },
      });
      const second = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "2",
        secret: { generation: 0, githubToken: "two" },
      });
      await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "one-b" },
      });
      expect(await credentials.readGeneration(first.accountId, 2)).toEqual({
        generation: 2,
        githubToken: "one-b",
      });
      expect(await credentials.readGeneration(second.accountId, 1)).toEqual({
        generation: 1,
        githubToken: "two",
      });
    } finally {
      close();
    }
  });

  it("prunes a newly written credential if account activation rolls back", async () => {
    const { directory: accounts, credentials, database, close } = await directory();
    try {
      database.prepare(
        "CREATE TRIGGER fail_account_insert BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'account insert failed'); END",
      ).run();
      await expect(accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "orphan" },
      })).rejects.toThrow(/account insert failed/u);
      expect(await credentials.readGeneration("github.com/1", 1)).toBeNull();
      expect(accounts.list()).toEqual([]);
    } finally {
      close();
    }
  });

  it("keeps the previous active generation if relogin activation rolls back", async () => {
    const { directory: accounts, credentials, database, close } = await directory();
    try {
      const first = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "old" },
      });
      database.prepare(
        "CREATE TRIGGER fail_account_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, 'account update failed'); END",
      ).run();
      await expect(accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "new" },
      })).rejects.toThrow(/account update failed/u);
      expect(await credentials.readGeneration(first.accountId, 1)).toEqual({
        generation: 1,
        githubToken: "old",
      });
      expect(await credentials.readGeneration(first.accountId, 2)).toBeNull();
      expect((await accounts.bindDefault()).credentialGeneration).toBe(1);
    } finally {
      close();
    }
  });

  it("does not mutate account state when the credential write fails first", async () => {
    class FailingCredentialStore implements CredentialStore {
      async readGeneration(): Promise<SecretCredential | null> {
        return null;
      }

      async putGeneration(): Promise<void> {
        throw new Error("credential write failed");
      }

      async removeAccount(): Promise<void> {}

      async prune(): Promise<void> {}
    }

    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-acc-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new FailingCredentialStore(), nowMs);
    try {
      await expect(accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "new" },
      })).rejects.toThrow(/credential write failed/u);
      expect(accounts.list()).toEqual([]);
      await expect(accounts.bindDefault()).rejects.toBeInstanceOf(AccountDirectoryError);
    } finally {
      closeDatabase(database);
    }
  });

  it("does not let a failed activation prune another committed credential", async () => {
    const { directory: accounts, credentials, database, close } = await directory();
    try {
      database.prepare(
        "CREATE TRIGGER fail_user_one_insert BEFORE INSERT ON accounts WHEN NEW.numeric_user_id = '1' BEGIN SELECT RAISE(ABORT, 'account insert failed'); END",
      ).run();
      const other = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "2",
        secret: { generation: 0, githubToken: "other" },
      });
      await expect(accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "failed" },
      })).rejects.toThrow(/account insert failed/u);
      expect(await credentials.readGeneration(other.accountId, other.credentialGeneration)).toEqual({
        generation: 1,
        githubToken: "other",
      });
      expect(await credentials.readGeneration("github.com/1", 1)).toBeNull();
    } finally {
      close();
    }
  });

  it("serializes concurrent same-account activation across generation pruning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-acc-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const credentials = new MemoryCredentialStore();
    const accounts = new AccountDirectory(database, credentials, nowMs);
    try {
      const first = accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "first" },
      });
      const second = accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "second" },
      });
      const settled = await Promise.allSettled([first, second]);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      const bound = await accounts.bindDefault();
      expect(bound.credentialGeneration).toBe(2);
      expect(await credentials.readGeneration(bound.accountId, 1)).toBeNull();
      expect(await credentials.readGeneration(bound.accountId, 2)).toEqual({
        generation: 2,
        githubToken: "second",
      });
    } finally {
      closeDatabase(database);
    }
  });

  it("marks missing preferred models invalid without choosing another", async () => {
    const { directory: accounts, close } = await directory();
    try {
      const bound = await accounts.upsertAuthenticated({
        host: "github.com",
        userId: "1",
        secret: { generation: 0, githubToken: "secret" },
      });
      accounts.preferences.set(bound.accountId, { modelId: "gpt-4.1", catalogGeneration: 3 }, 0);
      const invalid = accounts.preferences.markInvalidIfMissing(bound.accountId, new Set(["other"]), 4);
      expect(invalid?.validity).toBe("invalid");
      expect(invalid?.modelId).toBe("gpt-4.1");
    } finally {
      close();
    }
  });
});
