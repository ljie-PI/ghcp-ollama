import { randomUUID } from "node:crypto";
import { resolveGitHubEnvironment, type GitHubEnvironment } from "./github_environment.js";
import type { AccountDirectory } from "./account_directory.js";
import type { SecretCredential } from "./credential_store.js";

export const MAX_DEVICE_FLOWS = 8;
export const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;

export interface DeviceOAuthClient {
  requestDeviceCode(environment: GitHubEnvironment): Promise<{
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly intervalSec: number;
    readonly expiresInSec: number;
  }>;
  exchangeDeviceCode(environment: GitHubEnvironment, deviceCode: string): Promise<
    | { readonly status: "pending" }
    | { readonly status: "failed" }
    | {
        readonly status: "complete";
        readonly accessToken: string;
        readonly user: { readonly id: string | number; readonly login: string; readonly name?: string };
      }
  >;
}

export interface DeviceFlowSnapshot {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAtMs: number;
  readonly pollIntervalSeconds: number;
}

export class DeviceFlowError extends Error {
  readonly code: "capacity" | "not_found" | "expired";

  constructor(code: DeviceFlowError["code"], message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

interface PendingFlow extends DeviceFlowSnapshot {
  readonly environment: GitHubEnvironment;
  readonly deviceCode: string;
}

type TerminalFlow =
  | { readonly status: "expired" }
  | { readonly status: "failed" };

export class DeviceFlowService {
  private readonly flows = new Map<string, PendingFlow>();
  private readonly terminalFlows = new Map<string, TerminalFlow>();

  constructor(
    private readonly directory: AccountDirectory,
    private readonly oauth: DeviceOAuthClient,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async start(host: string): Promise<DeviceFlowSnapshot> {
    this.gc();
    if (this.flows.size >= MAX_DEVICE_FLOWS) {
      throw new DeviceFlowError("capacity", "too many active device flows");
    }
    const environment = resolveGitHubEnvironment(host);
    const requested = await this.oauth.requestDeviceCode(environment);
    const flowId = randomUUID();
    const snapshot: PendingFlow = {
      flowId,
      environment,
      deviceCode: requested.deviceCode,
      userCode: requested.userCode,
      verificationUri: requested.verificationUri,
      expiresAtMs: this.nowMs() + Math.min(requested.expiresInSec * 1000, DEVICE_FLOW_TTL_MS),
      pollIntervalSeconds: requested.intervalSec,
    };
    this.flows.set(flowId, snapshot);
    return {
      flowId,
      userCode: snapshot.userCode,
      verificationUri: snapshot.verificationUri,
      expiresAtMs: snapshot.expiresAtMs,
      pollIntervalSeconds: snapshot.pollIntervalSeconds,
    };
  }

  async poll(flowId: string): Promise<
    | { readonly status: "pending" }
    | { readonly status: "expired" }
    | { readonly status: "failed" }
    | { readonly status: "complete"; readonly accountId: string }
  > {
    const terminal = this.terminalFlows.get(flowId);
    if (terminal !== undefined) {
      this.terminalFlows.delete(flowId);
      return terminal;
    }
    const flow = this.flows.get(flowId);
    if (flow === undefined) {
      throw new DeviceFlowError("not_found", "device flow not found");
    }
    if (flow.expiresAtMs <= this.nowMs()) {
      this.flows.delete(flowId);
      return { status: "expired" };
    }
    const result = await this.oauth.exchangeDeviceCode(flow.environment, flow.deviceCode);
    if (result.status === "pending") {
      return { status: "pending" };
    }
    if (result.status === "failed") {
      this.flows.delete(flowId);
      return { status: "failed" };
    }
    const secret: SecretCredential = { generation: 0, githubToken: result.accessToken };
    const bound = await this.directory.upsertAuthenticated({
      host: flow.environment.host,
      userId: result.user.id,
      login: result.user.login,
      ...(result.user.name === undefined ? {} : { displayName: result.user.name }),
      secret,
    });
    this.flows.delete(flowId);
    return { status: "complete", accountId: bound.accountId };
  }

  cancel(flowId: string): void {
    this.flows.delete(flowId);
  }

  private gc(): void {
    const now = this.nowMs();
    for (const [flowId, flow] of this.flows) {
      if (flow.expiresAtMs <= now) {
        this.flows.delete(flowId);
        this.terminalFlows.set(flowId, { status: "expired" });
      }
    }
  }
}
