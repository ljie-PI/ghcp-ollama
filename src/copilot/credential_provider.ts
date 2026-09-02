import type { BoundAccount } from "../accounts/account_directory.js";
import type { CredentialStore } from "../accounts/credential_store.js";
import { copilotHeaders } from "./identity.js";
import { TokenRefreshError } from "./token_refresh.js";

const CREDENTIAL_PROVIDER_JSON_BYTES = 1_048_576;

export async function refreshCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<{ readonly token: string; readonly expiresAtMs: number }> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/copilot_internal/v2/token", {
      method: "GET",
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/json",
        ...copilotHeaders(),
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new TokenRefreshError("network", "copilot token refresh failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TokenRefreshError(response.status === 401 ? "unauthorized" : "network", "copilot token refresh failed");
  }
  let body: { readonly token?: unknown; readonly expires_at?: unknown; readonly expires_in?: unknown };
  try {
    body = await readJsonObject(response, signal) as { readonly token?: unknown; readonly expires_at?: unknown; readonly expires_in?: unknown };
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new TokenRefreshError("network", "copilot token refresh failed");
  }
  if (typeof body.token !== "string") {
    throw new TokenRefreshError("network", "copilot token refresh failed");
  }
  return {
    token: body.token,
    expiresAtMs: tokenExpiry(body),
  };
}

export function createCopilotEndpointDiscovery(
  credentials: CredentialStore,
): (account: Readonly<BoundAccount>, signal?: AbortSignal) => Promise<string | null> {
  return async (account, signal) => await fetchCopilotDiscovery(credentials, account, signal);
}

async function fetchCopilotDiscovery(
  credentials: CredentialStore,
  account: Readonly<BoundAccount>,
  signal?: AbortSignal,
): Promise<string | null> {
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
        ...copilotHeaders(),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return endpointFromCopilotUser(await readJsonObject(response, signal));
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }
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

async function readJsonObject(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return {};
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > CREDENTIAL_PROVIDER_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("credential provider response too large");
      }
      chunks.push(next.value);
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
