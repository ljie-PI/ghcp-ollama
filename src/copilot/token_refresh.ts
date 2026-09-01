import type { BoundAccount } from "../accounts/account_directory.js";
import type { CredentialStore, SecretCredential } from "../accounts/credential_store.js";

export const REFRESH_SKEW_MS = 60_000;

export class TokenRefreshError extends Error {
  readonly code: "missing" | "unauthorized" | "network" | "timeout";

  constructor(code: TokenRefreshError["code"], message: string) {
    super(message);
    this.name = "TokenRefreshError";
    this.code = code;
  }
}

const locks = new Map<string, Promise<void>>();

export async function withAccountLock(accountId: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const previous = locks.get(accountId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(accountId, queued);
  try {
    await waitForPrevious(previous, signal);
  } catch (error: unknown) {
    release();
    void queued.finally(() => {
      if (locks.get(accountId) === queued) {
        locks.delete(accountId);
      }
    });
    throw error;
  }
  try {
    await work();
  } finally {
    release();
    if (locks.get(accountId) === queued) {
      locks.delete(accountId);
    }
  }
}

export function needsRefresh(credential: SecretCredential, nowMs: number, environmentKind: "github.com" | "ghes"): boolean {
  if (environmentKind === "ghes") {
    return false;
  }
  if (credential.copilotToken === undefined || credential.copilotExpiresAtMs === undefined) {
    return true;
  }
  return credential.copilotExpiresAtMs - nowMs < REFRESH_SKEW_MS;
}

export async function getValidToken(
  store: CredentialStore,
  account: BoundAccount,
  nowMs: number,
  refresh: (githubToken: string, signal?: AbortSignal) => Promise<{ token: string; expiresAtMs: number }>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const generation = account.credentialGeneration;
  let current = await store.readGeneration(account.accountId, generation);
  throwIfAborted(signal);
  if (current === null) {
    throw new TokenRefreshError("missing", "credential missing");
  }
  if (account.environment.kind === "ghes") {
    return current.githubToken;
  }
  await withAccountLock(account.accountId, async () => {
    throwIfAborted(signal);
    const again = await store.readGeneration(account.accountId, generation);
    throwIfAborted(signal);
    if (again === null) {
      throw new TokenRefreshError("missing", "credential missing");
    }
    current = again;
    if (!needsRefresh(again, nowMs, "github.com")) {
      return;
    }
    const refreshed = await refresh(again.githubToken, signal);
    throwIfAborted(signal);
    current = {
      ...again,
      copilotToken: refreshed.token,
      copilotExpiresAtMs: refreshed.expiresAtMs,
    };
    await store.putGeneration(account.accountId, generation, current);
    throwIfAborted(signal);
  }, signal);
  if (current.copilotToken === undefined) {
    throw new TokenRefreshError("missing", "copilot token missing");
  }
  return current.copilotToken;
}

async function waitForPrevious(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (signal === undefined) {
    await previous;
    return;
  }
  let removeAbortListener = (): void => undefined;
  await Promise.race([
    previous,
    new Promise<void>((_resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }),
  ]).finally(removeAbortListener);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}
