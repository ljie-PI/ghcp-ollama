import type { AccountDirectory} from "../../accounts/account_directory.js";
import { AccountDirectoryError, type AccountSummary } from "../../accounts/account_directory.js";
import { DeviceFlowError, type DeviceFlowService } from "../../accounts/device_flow.js";
import { PreferenceRevisionError } from "../../accounts/model_preferences.js";
import type { CopilotModelCatalog } from "../../copilot/model_catalog.js";
import type { RuntimeConfigStore } from "../../config/runtime_config.js";
import { RuntimeConfigError } from "../../config/runtime_config.js";
import { defaultRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from "../../config/schema.js";
import { PreferredModelManager } from "../../protocols/model_catalog/preferred.js";
import {
  CliError,
  adminAccountFromSummary,
  adminModelsFromCatalog,
  type AdminAccounts,
  type AdminRuntimeConfig,
  type ControlClient,
  type ControlOperation,
  type ControlOperationMap,
} from "../control_client.js";

export interface CommandDispatcherDependencies {
  readonly directory: AccountDirectory;
  readonly deviceFlows: Pick<DeviceFlowService, "start" | "poll">;
  readonly catalog: CopilotModelCatalog;
  readonly runtimeConfig: RuntimeConfigStore;
}

export class CommandDispatcher {
  constructor(private readonly dependencies: CommandDispatcherDependencies) {}

  async dispatch<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
  ): Promise<ControlOperationMap[Operation]["result"]> {
    try {
      return await this.dispatchUnsafe(operation, args);
    } catch (error: unknown) {
      throw mapDispatcherError(error);
    }
  }

  private async dispatchUnsafe<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
  ): Promise<ControlOperationMap[Operation]["result"]> {
    switch (operation) {
    case "auth.login.start": {
      const input = args as ControlOperationMap["auth.login.start"]["args"];
      const started = await this.dependencies.deviceFlows.start(input.host ?? "github.com");
      return {
        flowId: started.flowId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresAt: new Date(started.expiresAtMs).toISOString(),
        pollIntervalSeconds: started.pollIntervalSeconds,
      } as ControlOperationMap[Operation]["result"];
    }
    case "auth.login.poll": {
      const input = args as ControlOperationMap["auth.login.poll"]["args"];
      const result = await this.dependencies.deviceFlows.poll(input.flowId);
      if (result.status === "pending") {
        return { state: "pending" } as ControlOperationMap[Operation]["result"];
      }
      const account = this.requireAccount(result.accountId);
      return { state: "complete", account: this.adminAccount(account) } as ControlOperationMap[Operation]["result"];
    }
    case "auth.logout": {
      const input = args as ControlOperationMap["auth.logout"]["args"];
      const account = input.accountId === undefined ? this.defaultAccount() : this.requireAccount(input.accountId);
      const removed = await this.dependencies.directory.remove(account.accountId, account.revision);
      return this.adminAccount(removed) as ControlOperationMap[Operation]["result"];
    }
    case "auth.status":
    case "accounts.list":
      return this.adminAccounts() as ControlOperationMap[Operation]["result"];
    case "accounts.use": {
      const input = args as ControlOperationMap["accounts.use"]["args"];
      this.dependencies.directory.use(input.accountId, this.dependencies.directory.defaultPreference().revision);
      return this.adminAccounts() as ControlOperationMap[Operation]["result"];
    }
    case "accounts.remove": {
      const input = args as ControlOperationMap["accounts.remove"]["args"];
      const account = this.requireAccount(input.accountId);
      const removed = await this.dependencies.directory.remove(input.accountId, account.revision);
      return this.adminAccount(removed) as ControlOperationMap[Operation]["result"];
    }
    case "models.list": {
      const input = args as ControlOperationMap["models.list"]["args"];
      const accountId = input.accountId ?? this.defaultAccount().accountId;
      const catalog = await this.dependencies.catalog.get(accountId, new AbortController().signal);
      return adminModelsFromCatalog(
        accountId,
        catalog,
        this.dependencies.directory.preferences.get(accountId),
      ) as ControlOperationMap[Operation]["result"];
    }
    case "models.current": {
      const account = this.defaultAccount();
      return {
        accountId: account.accountId,
        preferredModel: this.dependencies.directory.preferences.get(account.accountId),
      } as ControlOperationMap[Operation]["result"];
    }
    case "models.set": {
      const input = args as ControlOperationMap["models.set"]["args"];
      const account = this.defaultAccount();
      const catalog = await this.dependencies.catalog.get(account.accountId, new AbortController().signal);
      const current = this.dependencies.directory.preferences.get(account.accountId);
      const manager = new PreferredModelManager(this.dependencies.directory.preferences);
      return manager.setPreferred(account.accountId, input.modelId, current?.revision ?? 0, catalog) as ControlOperationMap[Operation]["result"];
    }
    case "config.get": {
      const input = args as ControlOperationMap["config.get"]["args"];
      const admin = this.adminRuntimeConfig();
      if (input.key === undefined) {
        return admin as ControlOperationMap[Operation]["result"];
      }
      const entry = configEntry(admin.config, input.key);
      return { key: input.key, value: entry.value, range: entry.range } as ControlOperationMap[Operation]["result"];
    }
    case "config.set": {
      const input = args as ControlOperationMap["config.set"]["args"];
      const current = this.dependencies.runtimeConfig.readSnapshot();
      const next = setConfigValue(current, input.key, input.value);
      this.dependencies.runtimeConfig.update(next, this.dependencies.runtimeConfig.readRevision());
      return this.adminRuntimeConfig() as ControlOperationMap[Operation]["result"];
    }
    }
  }

  private adminAccounts(): AdminAccounts {
    const preference = this.dependencies.directory.defaultPreference();
    return {
      defaultRevision: preference.revision,
      defaultAccountId: preference.defaultAccountId,
      items: this.dependencies.directory.list().map((account) => this.adminAccount(account)),
    };
  }

  private adminAccount(summary: AccountSummary) {
    return adminAccountFromSummary(summary, this.dependencies.directory.preferences.get(summary.accountId));
  }

  private defaultAccount(): AccountSummary {
    const accountId = this.dependencies.directory.defaultPreference().defaultAccountId;
    if (accountId === null) {
      throw new CliError("not_found");
    }
    return this.requireAccount(accountId);
  }

  private requireAccount(accountId: string): AccountSummary {
    const account = this.dependencies.directory.list().find((item) => item.accountId === accountId);
    if (account === undefined) {
      throw new CliError("not_found");
    }
    return account;
  }

  private adminRuntimeConfig(): AdminRuntimeConfig {
    return {
      revision: this.dependencies.runtimeConfig.readRevision(),
      config: this.dependencies.runtimeConfig.readSnapshot(),
      ranges: CONFIG_RANGES,
    };
  }
}

export class DispatcherControlClient implements Pick<ControlClient, "request"> {
  constructor(private readonly dispatcher: CommandDispatcher) {}

  async request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    _context: Parameters<ControlClient["request"]>[2],
  ): Promise<ControlOperationMap[Operation]["result"]> {
    return await this.dispatcher.dispatch(operation, args);
  }
}

const CONFIG_RANGES: AdminRuntimeConfig["ranges"] = {
  "limits.requestBodyBytes": { min: 1_048_576, max: 67_108_864, unit: "bytes" },
  "limits.sseEventBytes": { min: 65_536, max: 16_777_216, unit: "bytes" },
  "limits.nonstreamBodyBytes": { min: 1_048_576, max: 134_217_728, unit: "bytes" },
  "limits.accumulatorBytes": { min: 1_048_576, max: 134_217_728, unit: "bytes" },
  "admission.activeMax": { min: 1, max: 16, unit: "count" },
  "admission.queueMax": { min: 0, max: 64, unit: "count" },
  "timeouts.queueMs": { min: 1_000, max: 300_000, unit: "ms" },
  "timeouts.connectMs": { min: 1_000, max: 120_000, unit: "ms" },
  "timeouts.firstByteMs": { min: 5_000, max: 600_000, unit: "ms" },
  "timeouts.streamIdleMs": { min: 5_000, max: 600_000, unit: "ms" },
  "timeouts.totalMs": { min: 60_000, max: 7_200_000, unit: "ms" },
  "accounts.maxAuthenticated": { min: 1, max: 32, unit: "count" },
  "history.ttlDays": { min: 1, max: 365, unit: "days" },
  "usage.retentionDays": { min: 1, max: 365, unit: "days" },
  "events.retentionDays": { min: 1, max: 30, unit: "days" },
};

function configEntry(config: RuntimeConfigSnapshot, key: string): {
  readonly value: number;
  readonly range: { readonly min: number; readonly max: number; readonly unit: string };
} {
  const range = CONFIG_RANGES[key];
  if (range === undefined) {
    throw new CliError(startupOnlyKeys.has(key) ? "validation_error" : "not_found");
  }
  const value = readConfigNumber(config, key);
  return { value, range };
}

function setConfigValue(config: RuntimeConfigSnapshot, key: string, rawValue: string): RuntimeConfigSnapshot {
  const range = CONFIG_RANGES[key];
  if (range === undefined || startupOnlyKeys.has(key)) {
    throw new CliError("validation_error");
  }
  if (!/^[0-9]+$/u.test(rawValue)) {
    throw new CliError("validation_error");
  }
  const value = Number.parseInt(rawValue, 10);
  if (value < range.min || value > range.max) {
    throw new CliError("validation_error");
  }
  const next = defaultRuntimeConfigSnapshot();
  Object.assign(next.limits, config.limits);
  Object.assign(next.admission, config.admission);
  Object.assign(next.timeouts, config.timeouts);
  Object.assign(next.accounts, config.accounts);
  Object.assign(next.history, config.history);
  Object.assign(next.usage, config.usage);
  Object.assign(next.events, config.events);
  assignConfigNumber(next, key, value);
  return next;
}

function readConfigNumber(config: RuntimeConfigSnapshot, key: string): number {
  switch (key) {
  case "limits.requestBodyBytes": return config.limits.requestBodyBytes;
  case "limits.sseEventBytes": return config.limits.sseEventBytes;
  case "limits.nonstreamBodyBytes": return config.limits.nonstreamBodyBytes;
  case "limits.accumulatorBytes": return config.limits.accumulatorBytes;
  case "admission.activeMax": return config.admission.activeMax;
  case "admission.queueMax": return config.admission.queueMax;
  case "timeouts.queueMs": return config.timeouts.queueMs;
  case "timeouts.connectMs": return config.timeouts.connectMs;
  case "timeouts.firstByteMs": return config.timeouts.firstByteMs;
  case "timeouts.streamIdleMs": return config.timeouts.streamIdleMs;
  case "timeouts.totalMs": return config.timeouts.totalMs;
  case "accounts.maxAuthenticated": return config.accounts.maxAuthenticated;
  case "history.ttlDays": return config.history.ttlDays;
  case "usage.retentionDays": return config.usage.retentionDays;
  case "events.retentionDays": return config.events.retentionDays;
  default: throw new CliError("not_found");
  }
}

function assignConfigNumber(config: RuntimeConfigSnapshot, key: string, value: number): void {
  switch (key) {
  case "limits.requestBodyBytes": config.limits.requestBodyBytes = value; return;
  case "limits.sseEventBytes": config.limits.sseEventBytes = value; return;
  case "limits.nonstreamBodyBytes": config.limits.nonstreamBodyBytes = value; return;
  case "limits.accumulatorBytes": config.limits.accumulatorBytes = value; return;
  case "admission.activeMax": config.admission.activeMax = value; return;
  case "admission.queueMax": config.admission.queueMax = value; return;
  case "timeouts.queueMs": config.timeouts.queueMs = value; return;
  case "timeouts.connectMs": config.timeouts.connectMs = value; return;
  case "timeouts.firstByteMs": config.timeouts.firstByteMs = value; return;
  case "timeouts.streamIdleMs": config.timeouts.streamIdleMs = value; return;
  case "timeouts.totalMs": config.timeouts.totalMs = value; return;
  case "accounts.maxAuthenticated": config.accounts.maxAuthenticated = value; return;
  case "history.ttlDays": config.history.ttlDays = value; return;
  case "usage.retentionDays": config.usage.retentionDays = value; return;
  case "events.retentionDays": config.events.retentionDays = value; return;
  default: throw new CliError("validation_error");
  }
}

function mapDispatcherError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof AccountDirectoryError) {
    if (error.code === "revision_conflict") {
      return new CliError("revision_conflict");
    }
    if (error.code === "not_found" || error.code === "no_default") {
      return new CliError("not_found");
    }
    return new CliError("unavailable");
  }
  if (error instanceof PreferenceRevisionError) {
    return new CliError("revision_conflict");
  }
  if (error instanceof RuntimeConfigError) {
    return new CliError(error.code === "revision_conflict" ? "revision_conflict" : "validation_error");
  }
  if (error instanceof DeviceFlowError) {
    return new CliError(error.code === "not_found" || error.code === "expired" ? "not_found" : "unavailable");
  }
  return new CliError("internal_error");
}

const startupOnlyKeys = new Set(["port", "dataDir", "logLevel"]);
