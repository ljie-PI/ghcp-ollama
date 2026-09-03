import path from "node:path";
import { createAdminModule } from "./admin/routes.js";
import type { AccountDirectory } from "./accounts/account_directory.js";
import { DeviceFlowService } from "./accounts/device_flow.js";
import { HttpDeviceOAuthClient } from "./accounts/device_oauth.js";
import { FileCredentialStore, type CredentialStore } from "./accounts/credential_store.js";
import { createCopilotEndpointDiscovery, refreshCopilotToken } from "./copilot/credential_provider.js";
import { HttpCopilotModelsSource } from "./copilot/models_source.js";
import { CopilotModelCatalog, type CopilotModelsSource } from "./copilot/model_catalog.js";
import { productionModelInfoLookup, type NormalizedModelInfo } from "./copilot/model_metadata.js";
import { HttpCopilotBackend } from "./copilot/transport.js";
import type { CopilotBackend } from "./copilot/backend.js";
import { getValidToken } from "./copilot/token_refresh.js";
import { discoverEndpoint, invalidateEndpoint } from "./copilot/endpoint_discovery.js";
import { CommandDispatcher } from "./cli/commands/dispatcher.js";
import { RuntimeConfigStore } from "./config/runtime_config.js";
import { defaultRuntimeConfigSnapshot, parseRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "./config/schema.js";
import { parseStartupConfig, type StartupConfig } from "./config/startup_config.js";
import { createGateway, type GatewayDependencies, type HostedGateway, type RouteRegistration } from "./gateway/create_gateway.js";
import type { DaemonRuntimeComposition } from "./daemon/runtime.js";
import { createLocalControlModule } from "./daemon/local_control.js";
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
import { litellmStyleTokenCounter } from "./protocols/ollama_chat/token_counter.js";
import { createOpenAiChatRoute } from "./protocols/openai_chat/endpoint.js";
import { createOllamaChatRoutes } from "./protocols/ollama_chat/endpoint.js";
import { createAnthropicMessagesRoute } from "./protocols/anthropic_messages/endpoint.js";
import { createResponsesRoute } from "./protocols/responses/endpoint.js";
import { PreferredModelManager } from "./protocols/model_catalog/preferred.js";
import { SqliteResponsesHistory, type ResponsesHistory, type ResponsesHistoryAdmin } from "./protocols/responses/history.js";
import { SqliteAdminTelemetry } from "./telemetry/admin.js";
import { VERSION } from "./version.js";
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

export interface ProductionDaemonCompositionOptions {
  readonly application?: Readonly<ApplicationContext>;
  readonly uptimeMs?: () => number;
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
  readonly modelMetadata?: ReadonlyMap<string, NormalizedModelInfo>;
  readonly runtime?: RuntimeConfigStore;
  readonly tokenCounter: OllamaTokenCounter;
  close?(): Promise<void> | void;
  forceClose?(): Promise<void> | void;
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
      onForceClose: () => {
        try {
          void Promise.resolve(options.dependencies?.onForceClose?.()).catch(() => undefined);
        } catch {
          // Continue forcing application resources closed.
        }
        try {
          void Promise.resolve(context?.forceClose?.()).catch(() => undefined);
        } catch {
          // Gateway shutdown must remain bounded.
        }
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
      ...(context.modelMetadata === undefined ? {} : { metadata: context.modelMetadata }),
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
  const modelsSource = HttpCopilotModelsSource.production(async (accountId, signal) => {
    const account = await directory.bindAccount(accountId, signal);
    const token = await getValidToken(credentials, account, Date.now(), refreshCopilotToken, signal);
    const { endpoint } = await discoverEndpoint(account, fetchDiscovery, signal);
    return { token, endpoint };
  }, productionModelInfoLookup);
  const catalog = new CopilotModelCatalog(modelsSource);
  const copilot = new HttpCopilotBackend({
    credentials,
    refreshCopilotToken,
    fetchDiscovery,
  });
  const telemetry = new TelemetryRecorder(
    database,
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    snapshot.usage.retentionDays,
    snapshot.events.retentionDays,
  );
  const history = new SqliteResponsesHistory(database, {
    ttlDays: snapshot.history.ttlDays,
  });
  let databaseClosed = false;
  const closeDatabaseOnce = (): void => {
    if (!databaseClosed) {
      databaseClosed = true;
      closeDatabase(database);
    }
  };
  return {
    database,
    credentials,
    directory,
    catalog,
    copilot,
    history,
    telemetry,
    modelsSource,
    modelMetadata: modelsSource.modelMetadata,
    runtime,
    tokenCounter: litellmStyleTokenCounter,
    async close() {
      await telemetry.flush();
      await catalog.close();
      closeDatabaseOnce();
    },
    forceClose() {
      modelsSource.forceClose();
      closeDatabaseOnce();
    },
  };
}

export async function composeProductionDaemonGateway(
  composition: Readonly<DaemonRuntimeComposition>,
  options: Readonly<ProductionDaemonCompositionOptions> = {},
): Promise<HostedGateway> {
  const application = options.application
    ?? await createProductionApplicationContext(composition.startup, composition.env);
  try {
    const runtime = application.runtime;
    const database = application.database;
    const telemetryRecorder = application.telemetry;
    if (runtime === undefined || database === undefined || telemetryRecorder === undefined
      || !(application.directory instanceof SqliteAccountDirectory)
      || !(application.history instanceof SqliteResponsesHistory)
      || !isResponsesHistoryAdmin(application.history)) {
      throw new Error("production management dependencies are unavailable");
    }

    const adminTelemetry = new SqliteAdminTelemetry(database, { recorder: telemetryRecorder });
    telemetryRecorder.setObserver((event) => adminTelemetry.observeOperationalEvent(event));
    const updateRuntimeConfig = createRuntimeConfigCoordinator(
      runtime,
      application.directory,
      application.history,
      telemetryRecorder,
    );
    const deviceFlows = new DeviceFlowService(application.directory, new HttpDeviceOAuthClient());
    const accountCaches = {
      invalidate(accountId: string): void {
        application.catalog.invalidate(accountId);
        invalidateEndpoint(accountId);
      },
    };
    const uptimeMs = options.uptimeMs ?? (() => Math.max(0, Math.floor(process.uptime() * 1000)));
    const admin = createAdminModule({
      accounts: application.directory,
      deviceFlows,
      catalog: application.catalog,
      preferences: application.directory.preferences,
      preferredModels: new PreferredModelManager(application.directory.preferences),
      modelMetadata: {
        get: (modelId) => application.modelMetadata?.get(modelId) ?? null,
      },
      runtimeConfig: {
        read: () => ({ revision: runtime.readRevision(), config: runtime.readSnapshot() }),
        updateAndApply: updateRuntimeConfig,
      },
      history: application.history,
      telemetry: adminTelemetry,
      runtimeStatus: {
        snapshot: () => ({
          version: VERSION,
          uptimeMs: uptimeMs(),
          daemon: {
            managed: composition.identity.managed,
            pid: composition.identity.pid,
            startedAt: composition.identity.createdAt,
          },
        }),
      },
      accountCaches,
    });
    const dispatcher = new CommandDispatcher({
      directory: application.directory,
      deviceFlows,
      catalog: application.catalog,
      runtimeConfig: runtime,
      updateRuntimeConfig,
      invalidateAccountCaches: (accountId) => accountCaches.invalidate(accountId),
      ...(application.modelMetadata === undefined ? {} : { modelMetadata: application.modelMetadata }),
    });
    const control = createLocalControlModule({
      identity: composition.identity,
      admin,
      dispatcher,
      requestStop: composition.requestStop,
    });
    return await bootstrapGateway({
      startup: composition.startup,
      env: composition.env,
      application,
      dependencies: {
        admin,
        control,
        readRuntimeConfig: () => runtime.readSnapshot(),
        onShutdownTimeout: () => composition.logger.write({
          level: "error",
          category: "shutdown_timeout",
          managed: composition.identity.managed,
          pid: composition.identity.pid,
        }),
      },
    });
  } catch (error: unknown) {
    await application.close?.();
    throw error;
  }
}

function createRuntimeConfigCoordinator(
  runtime: RuntimeConfigStore,
  directory: SqliteAccountDirectory,
  history: SqliteResponsesHistory,
  telemetry: TelemetryRecorder,
): (
  candidate: RuntimeConfigSnapshot,
  expectedRevision: number,
  signal: AbortSignal,
) => Readonly<{ revision: number; config: RuntimeConfigSnapshot }> {
  return (candidate, expectedRevision, signal) => {
    signal.throwIfAborted();
    const validated = parseRuntimeConfigSnapshot(candidate);
    const config = runtime.update(validated, expectedRevision);
    directory.setMaxAuthenticated(config.accounts.maxAuthenticated);
    history.setTtlDays(config.history.ttlDays);
    telemetry.setRetentionDays(config.usage.retentionDays, config.events.retentionDays);
    return { revision: runtime.readRevision(), config };
  };
}

function isResponsesHistoryAdmin(value: ResponsesHistory): value is ResponsesHistory & ResponsesHistoryAdmin {
  return "inspect" in value && typeof value.inspect === "function"
    && "clear" in value && typeof value.clear === "function";
}
