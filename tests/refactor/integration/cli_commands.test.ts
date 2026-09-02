import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDirectory } from "../../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../../src/accounts/credential_store.js";
import { DeviceFlowService, type DeviceOAuthClient } from "../../../src/accounts/device_flow.js";
import { ScriptedCopilotBackend } from "../../../src/copilot/backend.js";
import { createCopilotEndpointDiscovery, refreshCopilotToken } from "../../../src/copilot/credential_provider.js";
import { CopilotModelCatalog } from "../../../src/copilot/model_catalog.js";
import type { TokenRefreshError } from "../../../src/copilot/token_refresh.js";
import { runCli } from "../../../src/cli/main.js";
import { CliError, HttpControlClient, ScriptedControlClient } from "../../../src/cli/control_client.js";
import { CommandDispatcher, DispatcherControlClient } from "../../../src/cli/commands/dispatcher.js";
import { defaultRuntimeConfigSnapshot } from "../../../src/config/schema.js";
import { RuntimeConfigStore } from "../../../src/config/runtime_config.js";
import { parseStartupConfig } from "../../../src/config/startup_config.js";
import { closeDatabase, openDatabase } from "../../../src/persistence/database.js";
import { embedMigration } from "../../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../../src/persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "../../../src/persistence/migrations/020_telemetry.js";
import { migration as historyMigration } from "../../../src/persistence/migrations/030_responses_history.js";
import { bootstrapGateway, createPublicRouteRegistrations } from "../../../src/main.js";
import { litellmStyleTokenCounter } from "../../../src/protocols/ollama_chat/token_counter.js";
import { SqliteResponsesHistory } from "../../../src/protocols/responses/history.js";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

class CaptureStream {
  chunks = "";
  write(chunk: string): void {
    this.chunks += chunk;
  }
}

describe("RM-18 CLI commands", () => {
  it("separates human stdout/stderr, JSON envelopes, and exit codes", async () => {
    const client = new ScriptedControlClient({
      "accounts.list": [{ defaultRevision: 1, defaultAccountId: null, items: [] }],
      "lifecycle.status": [{ state: "stopped", managed: null, pid: null, startedAt: null, port: null, dataDir: "wrong" }],
      "models.current": [new CliError("revision_conflict")],
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli({ argv: ["accounts", "list"], homedir: "Q:/tmp/home", stdout, stderr, controlClient: client })).toBe(0);
    expect(stdout.chunks).toBe(`${JSON.stringify({ defaultRevision: 1, defaultAccountId: null, items: [] }, null, 2)}\n`);
    expect(stderr.chunks).toBe("");

    const statusOut = new CaptureStream();
    expect(await runCli({ argv: ["--json", "status"], homedir: "Q:/tmp/home", stdout: statusOut, stderr, controlClient: client })).toBe(3);
    expect(statusOut.chunks).toBe(`${JSON.stringify({ ok: true, data: { state: "stopped", managed: null, pid: null, startedAt: null, port: null, dataDir: "wrong" } })}\n`);

    const errorOut = new CaptureStream();
    const errorErr = new CaptureStream();
    expect(await runCli({ argv: ["--json", "models", "current"], homedir: "Q:/tmp/home", stdout: errorOut, stderr: errorErr, controlClient: client })).toBe(3);
    expect(errorOut.chunks).toBe("");
    expect(errorErr.chunks).toBe(`${JSON.stringify({ ok: false, error: { code: "revision_conflict", message: "revision conflict" } })}\n`);

    const helpOut = new CaptureStream();
    expect(await runCli({ argv: ["--json", "auth", "--help"], homedir: "Q:/tmp/home", stdout: helpOut, stderr: new CaptureStream(), controlClient: client })).toBe(0);
    expect(JSON.parse(helpOut.chunks)).toMatchObject({ ok: true, data: { help: expect.stringContaining("Usage: ghcg") } });
  });

  it("sends exact control operations to the selected data directory", async () => {
    const client = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 5 }],
      "admin.open": [{ opened: true }],
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli({ argv: ["--json", "--data-dir", "selected", "auth", "login", "--host", "ghe.example.com"], homedir: "Q:/tmp/home", stdout, stderr, controlClient: client })).toBe(0);
    expect(JSON.parse(stdout.chunks)).toEqual({ ok: true, data: { flowId: "flow", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 5 } });
    expect(stderr.chunks).toBe("");
    expect(client.calls[0]).toEqual({ kind: "control", operation: "auth.login.start", args: { host: "ghe.example.com" }, dataDir: expect.stringContaining("selected") });

    const adminOut = new CaptureStream();
    expect(await runCli({ argv: ["--data-dir", "selected", "admin", "open"], homedir: "Q:/tmp/home", stdout: adminOut, stderr, controlClient: client })).toBe(0);
    expect(adminOut.chunks).toBe(`${JSON.stringify({ opened: true }, null, 2)}\n`);
    expect(client.calls[1]).toEqual({ kind: "admin.open", operation: "admin.open", args: {}, dataDir: expect.stringContaining("selected") });
  });

  it("polls interactive login until terminal and handles interruption without leaking tokens", async () => {
    const client = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 1 }],
      "auth.login.poll": [{ state: "pending" }, { state: "complete", account: accountDto("github.com/42") }],
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCli({ argv: ["auth", "login"], homedir: "Q:/tmp/home", stdout, stderr, controlClient: client, pollDelayMs: 0 })).toBe(0);
    expect(stdout.chunks).toBe("Code: ABCD-1234\nOpen: https://github.com/login/device\nAuthenticated: github.com/42\n");
    expect(stdout.chunks).not.toContain("token");
    expect(stderr.chunks).toBe("");

    const abort = new AbortController();
    const interrupted = new ScriptedControlClient({
      "auth.login.start": [{ flowId: "flow", userCode: "WXYZ-9999", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-02T00:00:00.000Z", pollIntervalSeconds: 30 }],
      "auth.login.poll": [{ state: "pending" }],
    });
    const interruptedErr = new CaptureStream();
    abort.abort();
    expect(await runCli({ argv: ["auth", "login"], homedir: "Q:/tmp/home", stdout: new CaptureStream(), stderr: interruptedErr, controlClient: interrupted, shutdownSignal: abort.signal })).toBe(130);
    expect(interruptedErr.chunks).toBe("error: interrupted\n");
    expect(interrupted.calls.at(-1)).toEqual({ kind: "auth.login.cancel", operation: "auth.login.cancel", args: { flowId: "flow" }, dataDir: expect.any(String) });
  });

  it("dispatches management commands through application modules with one CAS attempt", async () => {
    const harness = await dispatcherHarness();
    try {
      const client = new DispatcherControlClient(harness.dispatcher);
      const login = await client.request("auth.login.start", { host: "github.com" }, { dataDir: "unused" });
      expect(login.pollIntervalSeconds).toBe(5);
      const poll = await client.request("auth.login.poll", { flowId: login.flowId }, { dataDir: "unused" });
      expect(poll).toMatchObject({ state: "complete", account: { accountId: "github.com/42" } });
      expect(await client.request("accounts.list", {}, { dataDir: "unused" })).toMatchObject({ defaultAccountId: "github.com/42", defaultRevision: 1 });
      const originalGet = harness.directory.preferences.get.bind(harness.directory.preferences);
      let forceMissingPreferenceConflict = true;
      harness.directory.preferences.get = (accountId: string) => {
        const current = originalGet(accountId);
        if (accountId === "github.com/42" && forceMissingPreferenceConflict && current === null) {
          forceMissingPreferenceConflict = false;
          harness.directory.preferences.set(accountId, { modelId: "gpt", catalogGeneration: 0 }, 0);
          return null;
        }
        return current;
      };
      await expect(client.request("models.list", {}, { dataDir: "unused" })).rejects.toMatchObject({ code: "revision_conflict" });
      harness.directory.preferences.get = originalGet;
      expect(await client.request("models.list", {}, { dataDir: "unused" })).toMatchObject({ accountId: "github.com/42", items: [{ id: "gpt" }] });
      expect(await client.request("models.set", { modelId: "gpt" }, { dataDir: "unused" })).toMatchObject({ accountId: "github.com/42", modelId: "gpt", validity: "valid" });
      await client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(harness.directory.preferences.get("github.com/42")?.validity).toBe("valid");
      harness.catalog.invalidate("github.com/42");
      harness.capiModels = [];
      await client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(harness.directory.preferences.get("github.com/42")?.validity).toBe("invalid");
      harness.catalog.invalidate("github.com/42");
      harness.capiModels = [{ id: "claude", name: "Claude", vendor: "anthropic", model_picker_enabled: true }];
      expect(await client.request("models.set", { modelId: "claude" }, { dataDir: "unused" })).toMatchObject({ accountId: "github.com/42", modelId: "claude", validity: "valid" });
      harness.catalog.invalidate("github.com/42");
      harness.capiModels = [];
      const getPreference = harness.directory.preferences.get.bind(harness.directory.preferences);
      let forcePreferenceConflict = true;
      harness.directory.preferences.get = (accountId: string) => {
        const current = getPreference(accountId);
        if (accountId === "github.com/42" && forcePreferenceConflict && current !== null) {
          forcePreferenceConflict = false;
          harness.directory.preferences.set(accountId, { modelId: "gpt", catalogGeneration: 99 }, current.revision);
        }
        return current;
      };
      await expect(client.request("models.list", { accountId: "github.com/42" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "revision_conflict" });
      expect(await client.request("config.get", { key: "admission.activeMax" }, { dataDir: "unused" })).toMatchObject({ key: "admission.activeMax", value: 4 });
      expect(await client.request("config.set", { key: "admission.activeMax", value: "2" }, { dataDir: "unused" })).toMatchObject({ config: { admission: { activeMax: 2, queueMax: 16 } } });
      const readSnapshot = harness.runtimeConfig.readSnapshot.bind(harness.runtimeConfig);
      let forceConflict = true;
      harness.runtimeConfig.readSnapshot = () => {
        if (forceConflict) {
          forceConflict = false;
          harness.runtimeConfig.update(defaultRuntimeConfigSnapshot(), harness.runtimeConfig.readRevision());
        }
        return readSnapshot();
      };
      await expect(client.request("config.set", { key: "admission.activeMax", value: "3" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "revision_conflict" });
      await expect(client.request("config.set", { key: "port", value: "31401" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "validation_error" });
      await expect(client.request("models.set", { modelId: "missing" }, { dataDir: "unused" })).rejects.toMatchObject({ code: "not_found" });
      expect(await client.request("auth.status", {}, { dataDir: "unused" })).toMatchObject({ defaultAccountId: "github.com/42", accounts: [{ accountId: "github.com/42" }] });
      const removed = await client.request("accounts.remove", { accountId: "github.com/42" }, { dataDir: "unused" });
      expect(removed.state).toBe("removed");
    } finally {
      harness.close();
    }
  });

  it("returns device-flow expired and failed terminal states without retaining flow state", async () => {
    let nowValue = 1_800_000_000_000;
    const expiredHarness = await dispatcherHarness({ device: expiringDeviceClient(), now: () => nowValue });
    try {
      const client = new DispatcherControlClient(expiredHarness.dispatcher);
      const started = await client.request("auth.login.start", {}, { dataDir: "unused" });
      nowValue += 2_000;
      expect(await client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).toEqual({ state: "expired" });
      await expect(client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).rejects.toMatchObject({ code: "not_found" });
    } finally {
      expiredHarness.close();
    }

    const failedHarness = await dispatcherHarness({ device: failedDeviceClient() });
    try {
      const client = new DispatcherControlClient(failedHarness.dispatcher);
      const started = await client.request("auth.login.start", {}, { dataDir: "unused" });
      expect(await client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).toEqual({ state: "failed" });
      await expect(client.request("auth.login.poll", { flowId: started.flowId }, { dataDir: "unused" })).rejects.toMatchObject({ code: "not_found" });
    } finally {
      failedHarness.close();
    }
  });

  it("uses the protected loopback control transport when an identity exists", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const opened: string[] = [];
    const client = new HttpControlClient(async (url, init) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      const body = init?.body;
      if (typeof body === "string" && body.includes("\"operation\":\"config.set\"")) {
        return new Response(JSON.stringify({ error: { code: "revision_conflict", message: "revision conflict" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/admin-bootstrap")) {
        return new Response(JSON.stringify({ data: { token: "bootstrap-secret", expiresAt: "2026-09-02T00:01:00.000Z" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, async () => ({
      managed: false,
      pid: 123,
      processStartIdentity: "start",
      instanceNonce: "nonce",
      controlToken: "control-token",
      port: 31_400,
    }), async (url) => {
      opened.push(url);
    });
    await client.request("config.get", {}, { dataDir: "selected" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:31400/__ghcg/control/v1/command");
    expect(calls[0]?.init?.headers).toMatchObject({
      "x-ghcg-control-token": "control-token",
      "x-ghcg-instance-nonce": "nonce",
    });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ operation: "config.get", arguments: {} }));

    await expect(client.request("config.set", { key: "admission.activeMax", value: "2" }, { dataDir: "selected" })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await client.adminOpen({ dataDir: "selected" })).toEqual({ opened: true });
    expect(opened).toEqual(["http://127.0.0.1:31400/admin/#bootstrap_token=bootstrap-secret"]);

    const unavailable = new HttpControlClient(fetch, async () => null);
    await expect(unavailable.request("config.get", {}, { dataDir: "missing" })).rejects.toMatchObject({ code: "unavailable" });

    const foreground = new HttpControlClient(fetch, async () => ({
      managed: false,
      controlToken: "control-token",
      instanceNonce: "nonce",
      port: 31_400,
    }));
    await expect(foreground.lifecycle("stop", { dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });
    await expect(foreground.lifecycle("restart", { dataDir: "selected" })).rejects.toMatchObject({ code: "daemon_conflict" });
  });

  it("maps control timeout and caller abort without leaking as daemon failures", async () => {
    const endpoint = async () => ({
      managed: true,
      controlToken: "control-token",
      instanceNonce: "nonce",
      port: 31_400,
    });
    const never = new HttpControlClient(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }), endpoint);
    await expect(never.request("config.get", {}, { dataDir: "selected", timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });

    const abort = new AbortController();
    const aborted = new HttpControlClient(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      abort.abort();
    }), endpoint);
    await expect(aborted.request("config.get", {}, { dataDir: "selected", signal: abort.signal })).rejects.toMatchObject({ code: "interrupted" });
  });

  it("foreground serve emits one running result and closes on shutdown", async () => {
    const abort = new AbortController();
    let listened = false;
    let closed = false;
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const run = runCli({
      argv: ["serve", "--port", "31403"],
      homedir: "Q:/tmp/home",
      stdout,
      stderr,
      pid: 123,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      shutdownSignal: abort.signal,
      createGateway: async (startup) => ({
        fetch: async () => new Response(null, { status: 404 }),
        listen: async () => {
          listened = true;
          return { host: "127.0.0.1", port: startup.port };
        },
        close: async () => {
          closed = true;
        },
      }),
    });
    await Promise.resolve();
    await eventually(() => listened);
    expect(stderr.chunks).toBe("");
    expect(JSON.parse(stdout.chunks)).toEqual({ state: "running", managed: false, pid: 123, startedAt: "2026-09-02T00:00:00.000Z", port: 31_403, dataDir: expect.any(String) });
    abort.abort();
    expect(await run).toBe(0);
    expect(closed).toBe(true);
  });

  it("foreground composition registers all completed public routes without legacy fallback", async () => {
    const harness = await dispatcherHarness();
    try {
      await harness.directory.upsertAuthenticated({
        host: "github.com",
        userId: "42",
        secret: { generation: 0, githubToken: "gho_scripted" },
      });
      const routes = createPublicRouteRegistrations({
        directory: harness.directory,
        catalog: harness.catalog,
        copilot: harness.backend,
        history: harness.history,
        tokenCounter: litellmStyleTokenCounter,
      });
      expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
        "GET /v1/models",
        "GET /api/tags",
        "POST /v1/chat/completions",
        "GET /api/version",
        "POST /api/chat",
        "POST /v1/messages",
        "POST /v1/responses",
      ]);
      const gateway = await bootstrapGateway({
        startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/home" }),
        routes,
        dependencies: { createRequestId: () => "req_cli_routes" },
      });
      try {
        const version = await gateway.fetch(new Request("http://127.0.0.1:31400/api/version"));
        expect(version.status).toBe(200);
        expect(await version.text()).toBe("{\"version\":\"0.1.0\"}");
        const ollama = await gateway.fetch(new Request("http://127.0.0.1:31400/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt", stream: false, messages: [{ role: "user", content: "hello world" }] }),
        }));
        expect(ollama.status).toBe(200);
        expect(await ollama.text()).toContain("\"prompt_eval_count\":2");
        const legacy = await gateway.fetch(new Request("http://127.0.0.1:31400/models"));
        expect(legacy.status).toBe(404);
      } finally {
        await gateway.close();
      }
    } finally {
      harness.close();
    }
  });

  it("classifies production Copilot token refresh failures without leaking response bodies", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ token: "copilot-token", expires_in: 120 }), { status: 200 }));
    await expect(refreshCopilotToken("gho_secret")).resolves.toMatchObject({ token: "copilot-token" });

    vi.stubGlobal("fetch", async () => new Response("secret upstream body", { status: 401 }));
    await expect(refreshCopilotToken("gho_secret")).rejects.toMatchObject({ code: "unauthorized" } satisfies Partial<TokenRefreshError>);

    vi.stubGlobal("fetch", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(refreshCopilotToken("gho_secret")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses Copilot endpoint discovery success and falls back on malformed responses", async () => {
    const store = new MemoryCredentialStore();
    await store.putGeneration("github.com/42", 1, { generation: 1, githubToken: "gho_secret" });
    const account = {
      accountId: "github.com/42",
      environment: {
        kind: "github.com" as const,
        host: "github.com" as const,
        webBaseUrl: "https://github.com" as const,
        apiBaseUrl: "https://api.github.com" as const,
        clientId: "Iv1.b507a08c87ecfe98" as const,
        deviceCodeUrl: "https://github.com/login/device/code" as const,
        accessTokenUrl: "https://github.com/login/oauth/access_token" as const,
      },
      userId: "42",
      login: null,
      displayName: null,
      credentialGeneration: 1,
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      copilot_plan: "individual",
      quota_reset_date: "2026-09-02",
      quota_snapshots: {
        chat: { entitlement: 1, remaining: 1, percent_remaining: 100, unlimited: false },
        completions: { entitlement: 1, remaining: 1, percent_remaining: 100, unlimited: false },
        premium_interactions: { entitlement: 1, remaining: 1, percent_remaining: 100, unlimited: false },
      },
      endpoints: { api: "https://api.githubcopilot.com/custom" },
    }), { status: 200 }));
    await expect(createCopilotEndpointDiscovery(store)(account)).resolves.toBe("https://api.githubcopilot.com/custom");

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ endpoints: {} }), { status: 200 }));
    await expect(createCopilotEndpointDiscovery(store)(account)).resolves.toBeNull();

    vi.stubGlobal("fetch", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(createCopilotEndpointDiscovery(store)(account)).rejects.toMatchObject({ name: "AbortError" });
  });
});

async function dispatcherHarness(options: {
  readonly device?: DeviceOAuthClient;
  readonly now?: () => number;
} = {}): Promise<{
  readonly dispatcher: CommandDispatcher;
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly backend: ScriptedCopilotBackend;
  readonly history: SqliteResponsesHistory;
  readonly runtimeConfig: RuntimeConfigStore;
  capiModels: Array<{ readonly id: string; readonly name: string; readonly vendor: string; readonly model_picker_enabled: boolean }>;
  readonly close: () => void;
}> {
  const now = options.now ?? (() => 1_800_000_000_000);
  const database = openDatabase({
    path: ":memory:",
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(historyMigration),
    ],
    nowMs: now,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), now);
  const harness = {
    capiModels: [{ id: "gpt", name: "GPT", vendor: "openai", model_picker_enabled: true }],
  };
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return { data: harness.capiModels };
    },
  });
  const runtimeConfig = new RuntimeConfigStore(database, now);
  runtimeConfig.seedIfEmpty({});
  const history = new SqliteResponsesHistory(database, { nowMs: now });
  const backend = new ScriptedCopilotBackend({
    chat: { status: 200, headers: new Headers(), body: encoder.encode("{\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}") },
    responses: { status: 200, headers: new Headers(), body: encoder.encode("{}") },
  });
  const dispatcher = new CommandDispatcher({
    directory,
    deviceFlows: new DeviceFlowService(directory, options.device ?? deviceClient(), now),
    catalog,
    runtimeConfig,
  });
  return {
    dispatcher,
    directory,
    catalog,
    backend,
    history,
    runtimeConfig,
    get capiModels() {
      return harness.capiModels;
    },
    set capiModels(value) {
      harness.capiModels = value;
    },
    close: () => closeDatabase(database),
  };
}

function expiringDeviceClient(): DeviceOAuthClient {
  return {
    async requestDeviceCode() {
      return {
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        intervalSec: 5,
        expiresInSec: 1,
      };
    },
    async exchangeDeviceCode() {
      return { status: "pending" };
    },
  };
}

function failedDeviceClient(): DeviceOAuthClient {
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
      return { status: "failed" };
    },
  };
}

function deviceClient(): DeviceOAuthClient {
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

function accountDto(accountId: string) {
  return {
    accountId,
    host: "github.com",
    numericUserId: "42",
    login: "octo",
    displayName: "Octo",
    state: "active" as const,
    revision: 1,
    authenticatedAt: "2026-09-02T00:00:00.000Z",
    preferredModel: null,
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not met");
}
