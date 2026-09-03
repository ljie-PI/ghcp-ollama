export type {
  AdminAccount,
  AdminAccounts,
  AdminHistorySummary,
  AdminModels,
  AdminPerformanceMetric,
  AdminPreference,
  AdminRuntimeConfig,
  AdminStatus,
} from "../../src/admin/api.js";
export type { AdminSessionMetadata } from "../../src/admin/auth.js";
export type {
  AdminEventPage,
  AdminOperationalEvent,
  AdminUsagePage,
} from "../../src/telemetry/admin.js";

export interface DeviceFlow {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
}

export type DeviceFlowPoll =
  | { readonly state: "pending" | "expired" | "failed" }
  | { readonly state: "complete"; readonly account: import("./types.js").AdminAccount };
