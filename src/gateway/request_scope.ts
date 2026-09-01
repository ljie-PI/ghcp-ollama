import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { TimeoutScheduler } from "./timeouts.js";

export interface RequestScope {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly config: Readonly<RuntimeConfigSnapshot>;
  readonly scheduler: TimeoutScheduler;
}

export function createRequestScope(
  requestId: string,
  signal: AbortSignal,
  config: Readonly<RuntimeConfigSnapshot>,
  scheduler: TimeoutScheduler,
): RequestScope {
  return { requestId, signal, config, scheduler };
}
