import path from "node:path";
import type { AccountSummary } from "../accounts/account_directory.js";
import type { ModelPreference } from "../accounts/model_preferences.js";
import type { CatalogSnapshot } from "../copilot/model_catalog.js";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { StartupConfig } from "../config/startup_config.js";

export type CliErrorCode =
  | "internal_error"
  | "usage_error"
  | "validation_error"
  | "not_found"
  | "revision_conflict"
  | "permission_denied"
  | "security_error"
  | "remote_error"
  | "timeout"
  | "unavailable"
  | "daemon_stale"
  | "daemon_conflict"
  | "daemon_unreachable"
  | "interrupted";

export class CliError extends Error {
  constructor(readonly code: CliErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "CliError";
  }
}

export const CLI_ERROR_EXIT: Readonly<Record<CliErrorCode, number>> = {
  internal_error: 1,
  usage_error: 2,
  validation_error: 2,
  not_found: 3,
  revision_conflict: 3,
  permission_denied: 4,
  security_error: 4,
  remote_error: 5,
  timeout: 5,
  unavailable: 5,
  daemon_stale: 5,
  daemon_conflict: 5,
  daemon_unreachable: 5,
  interrupted: 130,
};

export const SAFE_ERROR_MESSAGES: Readonly<Record<CliErrorCode, string>> = {
  internal_error: "internal error",
  usage_error: "usage error",
  validation_error: "validation error",
  not_found: "not found",
  revision_conflict: "revision conflict",
  permission_denied: "permission denied",
  security_error: "security error",
  remote_error: "remote error",
  timeout: "timeout",
  unavailable: "gateway unavailable",
  daemon_stale: "daemon stale",
  daemon_conflict: "daemon conflict",
  daemon_unreachable: "daemon unreachable",
  interrupted: "interrupted",
};

export type LifecycleAction = "start" | "stop" | "restart" | "status";

export interface CliLifecycleContext {
  readonly dataDir: string;
  readonly startup?: StartupConfig;
}

export interface CliLifecycleResult {
  readonly state: "running" | "stopped" | "stale" | "conflict" | "unreachable";
  readonly managed: boolean | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly port: number | null;
  readonly dataDir: string;
}

export interface CliAdminOpenResult {
  readonly opened: true;
}

export interface AdminAccount {
  readonly accountId: string;
  readonly host: string;
  readonly numericUserId: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly state: "active" | "removing" | "removed";
  readonly revision: number;
  readonly authenticatedAt: string | null;
  readonly preferredModel: {
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
  } | null;
}

export interface AdminAccounts {
  readonly defaultRevision: number;
  readonly defaultAccountId: string | null;
  readonly items: readonly AdminAccount[];
}

export interface AdminModels {
  readonly accountId: string;
  readonly catalogGeneration: number;
  readonly fetchedAt: string;
  readonly preferredModel: {
    readonly revision: number;
    readonly modelId: string;
    readonly validity: "valid" | "invalid";
  } | null;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly maxInputTokens: number | null;
    readonly maxOutputTokens: number | null;
  }[];
}

export interface AdminRuntimeConfig {
  readonly revision: number;
  readonly config: RuntimeConfigSnapshot;
  readonly ranges: Record<string, { readonly min: number; readonly max: number; readonly unit: string }>;
}

export interface DeviceFlowStartResult {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
}

export type DeviceFlowPollResult =
  | { readonly state: "pending" }
  | { readonly state: "complete"; readonly account: AdminAccount }
  | { readonly state: "expired" }
  | { readonly state: "failed" };

export interface ControlOperationMap {
  readonly "auth.login.start": {
    readonly args: { readonly host?: string };
    readonly result: DeviceFlowStartResult;
  };
  readonly "auth.login.poll": {
    readonly args: { readonly flowId: string };
    readonly result: DeviceFlowPollResult;
  };
  readonly "auth.logout": {
    readonly args: { readonly accountId?: string };
    readonly result: AdminAccount;
  };
  readonly "auth.status": {
    readonly args: Record<string, never>;
    readonly result: AdminAccounts;
  };
  readonly "accounts.list": {
    readonly args: Record<string, never>;
    readonly result: AdminAccounts;
  };
  readonly "accounts.use": {
    readonly args: { readonly accountId: string };
    readonly result: AdminAccounts;
  };
  readonly "accounts.remove": {
    readonly args: { readonly accountId: string };
    readonly result: AdminAccount;
  };
  readonly "models.list": {
    readonly args: { readonly accountId?: string };
    readonly result: AdminModels;
  };
  readonly "models.current": {
    readonly args: Record<string, never>;
    readonly result: { readonly accountId: string | null; readonly preferredModel: ModelPreference | null };
  };
  readonly "models.set": {
    readonly args: { readonly modelId: string };
    readonly result: ModelPreference;
  };
  readonly "config.get": {
    readonly args: { readonly key?: string };
    readonly result: AdminRuntimeConfig | { readonly key: string; readonly value: number; readonly range: { readonly min: number; readonly max: number; readonly unit: string } };
  };
  readonly "config.set": {
    readonly args: { readonly key: string; readonly value: string };
    readonly result: AdminRuntimeConfig;
  };
}

export type ControlOperation = keyof ControlOperationMap;

export interface ControlClient {
  lifecycle(action: LifecycleAction, context: CliLifecycleContext): Promise<CliLifecycleResult>;
  request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    context: CliLifecycleContext,
  ): Promise<ControlOperationMap[Operation]["result"]>;
  adminOpen(context: CliLifecycleContext): Promise<CliAdminOpenResult>;
  close?(): Promise<void> | void;
}

export class ScriptedControlClient implements ControlClient {
  readonly calls: Array<{
    readonly kind: "lifecycle" | "control" | "admin.open";
    readonly operation: string;
    readonly args: unknown;
    readonly dataDir?: string;
  }> = [];

  private readonly script = new Map<string, unknown[]>();

  constructor(entries: Readonly<Record<string, readonly unknown[]>> = {}) {
    for (const [key, values] of Object.entries(entries)) {
      this.script.set(key, [...values]);
    }
  }

  enqueue(key: string, value: unknown): void {
    const values = this.script.get(key) ?? [];
    values.push(value);
    this.script.set(key, values);
  }

  async lifecycle(action: LifecycleAction, context: CliLifecycleContext): Promise<CliLifecycleResult> {
    this.calls.push({ kind: "lifecycle", operation: action, args: {}, dataDir: context.dataDir });
    return this.pop(`lifecycle.${action}`) as CliLifecycleResult;
  }

  async request<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    context: CliLifecycleContext,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    this.calls.push({ kind: "control", operation, args, dataDir: context.dataDir });
    return this.pop(operation) as ControlOperationMap[Operation]["result"];
  }

  async adminOpen(context: CliLifecycleContext): Promise<CliAdminOpenResult> {
    this.calls.push({ kind: "admin.open", operation: "admin.open", args: {}, dataDir: context.dataDir });
    return this.pop("admin.open") as CliAdminOpenResult;
  }

  private pop(key: string): unknown {
    const values = this.script.get(key);
    if (values === undefined || values.length === 0) {
      throw new CliError("internal_error");
    }
    const value = values.shift();
    if (value instanceof CliError) {
      throw value;
    }
    return value;
  }
}

export class HttpControlClient implements ControlClient {
  async lifecycle(action: LifecycleAction, context: CliLifecycleContext): Promise<CliLifecycleResult> {
    if (action === "status" || action === "stop") {
      return stoppedLifecycle(context.dataDir);
    }
    throw new CliError("unavailable");
  }

  async request<Operation extends ControlOperation>(
    _operation: Operation,
    _args: ControlOperationMap[Operation]["args"],
    _context: CliLifecycleContext,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    throw new CliError("unavailable");
  }

  async adminOpen(_context: CliLifecycleContext): Promise<CliAdminOpenResult> {
    throw new CliError("unavailable");
  }
}

export function stoppedLifecycle(dataDir: string): CliLifecycleResult {
  return {
    state: "stopped",
    managed: null,
    pid: null,
    startedAt: null,
    port: null,
    dataDir: path.resolve(dataDir),
  };
}

export function adminAccountFromSummary(
  summary: AccountSummary,
  preferredModel: ModelPreference | null,
): AdminAccount {
  return {
    accountId: summary.accountId,
    host: summary.host,
    numericUserId: summary.userId,
    login: summary.login,
    displayName: summary.displayName,
    state: summary.state,
    revision: summary.revision,
    authenticatedAt: summary.authenticatedAtMs === null ? null : new Date(summary.authenticatedAtMs).toISOString(),
    preferredModel: preferredModel === null
      ? null
      : {
        revision: preferredModel.revision,
        modelId: preferredModel.modelId,
        validity: preferredModel.validity,
      },
  };
}

export function adminModelsFromCatalog(
  accountId: string,
  catalog: CatalogSnapshot,
  preferredModel: ModelPreference | null,
): AdminModels {
  return {
    accountId,
    catalogGeneration: catalog.generation,
    fetchedAt: catalog.fetchedAt,
    preferredModel: preferredModel === null
      ? null
      : {
        revision: preferredModel.revision,
        modelId: preferredModel.modelId,
        validity: preferredModel.validity,
      },
    items: catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      maxInputTokens: null,
      maxOutputTokens: null,
    })),
  };
}
