import type { RuntimeConfigSnapshot } from "../config/schema.js";

export interface RequestScope {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly config: Readonly<RuntimeConfigSnapshot>;
}

export function createRequestScope(
  requestId: string,
  signal: AbortSignal,
  config: Readonly<RuntimeConfigSnapshot>,
): RequestScope {
  return { requestId, signal, config };
}
