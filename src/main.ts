import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AccountDirectory, BoundAccount } from "./accounts/account_directory.js";
import { FileCredentialStore, type CredentialStore } from "./accounts/credential_store.js";
import { HttpCopilotModelsSource } from "./copilot/models_source.js";
import { CopilotModelCatalog, type CopilotModelsSource } from "./copilot/model_catalog.js";
import { HttpCopilotBackend } from "./copilot/transport.js";
import type { CopilotBackend } from "./copilot/backend.js";
import { getValidToken } from "./copilot/token_refresh.js";
import { discoverEndpoint } from "./copilot/endpoint_discovery.js";
import { RuntimeConfigStore } from "./config/runtime_config.js";
import { defaultRuntimeConfigSnapshot } from "./config/schema.js";
import { parseStartupConfig, type StartupConfig } from "./config/startup_config.js";
import { createGateway, type GatewayDependencies, type HostedGateway, type RouteRegistration } from "./gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "./persistence/database.js";
import { embedMigration } from "./persistence/migrations.js";
import { migration as runtimeConfigMigration } from "./persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "./persistence/migrations/010_accounts.js";
import { migration as telemetryMigration } from "./persistence/migrations/020_telemetry.js";
import { migration as responsesHistoryMigration } from "./persistence/migrations/030_responses_history.js";
import { AccountDirectory as SqliteAccountDirectory } from "./accounts/account_directory.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import { createModelCatalogRoutes } from "./protocols/model_catalog/routes.js";
import { createOpenAiChatRoute } from "./protocols/openai_chat/endpoint.js";
import { createOllamaChatRoutes } from "./protocols/ollama_chat/endpoint.js";
import { createAnthropicMessagesRoute } from "./protocols/anthropic_messages/endpoint.js";
import { createResponsesRoute } from "./protocols/responses/endpoint.js";
import { SqliteResponsesHistory, type ResponsesHistory } from "./protocols/responses/history.js";
import type Database from "better-sqlite3";

export interface BootstrapOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly startup?: StartupConfig;
  readonly routes?: readonly RouteRegistration[];
  readonly dependencies?: Readonly<GatewayDependencies>;
  readonly homedir?: string;
  readonly application?: Readonly<ApplicationContext>;
}

export interface ApplicationContext {
  readonly database?: Database.Database;
  readonly credentials?: CredentialStore;
  readonly directory: AccountDirectory;
  readonly catalog: CopilotModelCatalog;
  readonly copilot: CopilotBackend;
  readonly history: ResponsesHistory;
  readonly telemetry?: TelemetryRecorder;
  readonly modelsSource?: CopilotModelsSource;
  readonly runtime?: RuntimeConfigStore;
  close?(): Promise<void> | void;
}

export async function bootstrapGateway(options: BootstrapOptions = {}): Promise<HostedGateway> {
  const env = options.env ?? {};
  const startup = options.startup ?? parseStartupConfig(
    options.argv ?? [],
    env,
    options.homedir === undefined ? {} : { homedir: options.homedir },
  );
  const context = options.application ?? (options.routes === undefined ? await createProductionApplicationContext(startup, env) : undefined);
  const routes = options.routes ?? (context === undefined ? [] : createPublicRouteRegistrations(context));
  return createGateway(
    {
      startup,
      runtime: context?.runtime?.readSnapshot() ?? defaultRuntimeConfigSnapshot(),
    },
    routes,
    {
      ...options.dependencies,
      onClose: async () => {
        await options.dependencies?.onClose?.();
        await context?.close?.();
      },
    },
  );
}

export function createPublicRouteRegistrations(context: Readonly<ApplicationContext>): readonly RouteRegistration[] {
  const preferences = context.directory.preferences;
  return [
    ...createModelCatalogRoutes({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
    }),
    createOpenAiChatRoute({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      copilot: context.copilot,
      ...(context.telemetry === undefined ? {} : { usageRecorder: context.telemetry }),
    }),
    ...createOllamaChatRoutes({
      directory: context.directory,
      copilot: context.copilot,
      tokenCounter: () => 0,
    }),
    createAnthropicMessagesRoute({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      copilot: context.copilot,
    }),
    createResponsesRoute({
      directory: context.directory,
      catalog: context.catalog,
      preferences,
      copilot: context.copilot,
      history: context.history,
    }),
  ];
}

export async function createProductionApplicationContext(
  startup: StartupConfig,
  env: NodeJS.ProcessEnv = {},
): Promise<ApplicationContext> {
  mkdirSync(startup.dataDir, { recursive: true });
  const database = openDatabase({
    path: path.join(startup.dataDir, "state.db"),
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(telemetryMigration),
      embedMigration(responsesHistoryMigration),
    ],
  });
  const runtime = new RuntimeConfigStore(database);
  const snapshot = runtime.seedIfEmpty(env);
  const credentials = new FileCredentialStore(path.join(startup.dataDir, "credentials.json"));
  const directory = new SqliteAccountDirectory(database, credentials, Date.now, snapshot.accounts.maxAuthenticated);
  await directory.reconcile();
  const fetchDiscovery = async (account: BoundAccount, signal?: AbortSignal): Promise<string | null> => await fetchCopilotDiscovery(credentials, account, signal);
  const modelsSource = new HttpCopilotModelsSource(async (accountId, signal) => {
    const account = await directory.bindAccount(accountId, signal);
    const token = await getValidToken(credentials, account, Date.now(), refreshCopilotToken, signal);
    const { endpoint } = await discoverEndpoint(account, fetchDiscovery, signal);
    return { token, endpoint };
  });
  const catalog = new CopilotModelCatalog(modelsSource);
  const copilot = new HttpCopilotBackend({
    credentials,
    refreshCopilotToken,
    fetchDiscovery,
  });
  const telemetry = new TelemetryRecorder(database);
  const history = new SqliteResponsesHistory(database, {
    ttlDays: snapshot.history.ttlDays,
  });
  return {
    database,
    credentials,
    directory,
    catalog,
    copilot,
    history,
    telemetry,
    modelsSource,
    runtime,
    async close() {
      await telemetry.flush();
      await catalog.close();
      closeDatabase(database);
    },
  };
}

async function refreshCopilotToken(githubToken: string, signal?: AbortSignal): Promise<{ token: string; expiresAtMs: number }> {
  const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/json",
    },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error("copilot token refresh failed");
  }
  const body = await response.json() as { readonly token?: unknown; readonly expires_at?: unknown; readonly expires_in?: unknown };
  if (typeof body.token !== "string") {
    throw new Error("copilot token refresh failed");
  }
  return {
    token: body.token,
    expiresAtMs: tokenExpiry(body),
  };
}

async function fetchCopilotDiscovery(credentials: CredentialStore, account: BoundAccount, signal?: AbortSignal): Promise<string | null> {
  const credential = await credentials.readGeneration(account.accountId, account.credentialGeneration);
  if (credential === null) {
    return null;
  }
  const base = account.environment.apiBaseUrl;
  const url = new URL("copilot_internal/user", `${base.replace(/\/+$/u, "")}/`);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${credential.githubToken}`,
        accept: "application/json",
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const endpoint = endpointFromCopilotUser(await response.json() as unknown);
    return endpoint;
  } catch (_error: unknown) {
    return null;
  }
}

function endpointFromCopilotUser(value: unknown): string | null {
  if (!isObject(value) || typeof value.copilot_plan !== "string" || typeof value.quota_reset_date !== "string" || !isQuotaSnapshots(value.quota_snapshots)) {
    return null;
  }
  if (value.endpoints === undefined || value.endpoints === null) {
    return null;
  }
  if (!isObject(value.endpoints) || typeof value.endpoints.api !== "string") {
    return null;
  }
  return value.endpoints.api;
}

function isQuotaSnapshots(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return isQuotaDetail(value.chat) && isQuotaDetail(value.completions) && isQuotaDetail(value.premium_interactions);
}

function isQuotaDetail(value: unknown): boolean {
  return isObject(value)
    && Number.isInteger(value.entitlement)
    && Number.isInteger(value.remaining)
    && typeof value.percent_remaining === "number"
    && typeof value.unlimited === "boolean";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenExpiry(body: { readonly expires_at?: unknown; readonly expires_in?: unknown }): number {
  if (typeof body.expires_at === "number") {
    return body.expires_at * 1000;
  }
  if (typeof body.expires_in === "number") {
    return Date.now() + body.expires_in * 1000;
  }
  return Date.now() + 30 * 60 * 1000;
}
