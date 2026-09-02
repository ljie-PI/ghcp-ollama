import path from "node:path";
import type { AccountDirectory } from "./accounts/account_directory.js";
import { FileCredentialStore, type CredentialStore } from "./accounts/credential_store.js";
import { createCopilotEndpointDiscovery, refreshCopilotToken } from "./copilot/credential_provider.js";
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
import type { OllamaTokenCounter } from "./protocols/ollama_chat/bridge.js";
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
  readonly tokenCounter: OllamaTokenCounter;
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
      tokenCounter: context.tokenCounter,
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
  const credentials = new FileCredentialStore(path.join(startup.dataDir, "credentials.json"));
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
  const directory = new SqliteAccountDirectory(database, credentials, Date.now, snapshot.accounts.maxAuthenticated);
  await directory.reconcile();
  const fetchDiscovery = createCopilotEndpointDiscovery(credentials);
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
    tokenCounter: litellmStyleTokenCounter,
    async close() {
      await telemetry.flush();
      await catalog.close();
      closeDatabase(database);
    },
  };
}

function litellmStyleTokenCounter(input: { readonly messages?: unknown; readonly text?: string }): number {
  const text = input.text ?? flattenTokenCounterInput(input.messages);
  return text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ?? 0;
}

function flattenTokenCounterInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenTokenCounterInput).join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).map(flattenTokenCounterInput).join("\n");
  }
  return "";
}
