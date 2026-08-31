import type { BoundAccount } from "../accounts/account_directory.js";
import { STRIP_ON_CROSS_HOST } from "./identity.js";

export const GITHUB_COM_FALLBACK = "https://api.githubcopilot.com";
export const MAX_REDIRECTS = 10;

export interface DiscoveredEndpoint {
  readonly endpoint: string;
  readonly cached: boolean;
}

const cache = new Map<string, string>();
const locks = new Map<string, Promise<void>>();

export async function discoverEndpoint(
  account: BoundAccount,
  fetchDiscovery: (account: BoundAccount) => Promise<string | null>,
): Promise<DiscoveredEndpoint> {
  const cached = cache.get(account.accountId);
  if (cached !== undefined) {
    return { endpoint: cached, cached: true };
  }
  const previous = locks.get(account.accountId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(account.accountId, previous.then(() => gate));
  await previous;
  try {
    const again = cache.get(account.accountId);
    if (again !== undefined) {
      return { endpoint: again, cached: true };
    }
    const discovered = await fetchDiscovery(account);
    const endpoint = discovered ?? fallbackEndpoint(account);
    cache.set(account.accountId, endpoint);
    return { endpoint, cached: false };
  } finally {
    release();
    if (locks.get(account.accountId) === gate) {
      locks.delete(account.accountId);
    }
  }
}

export function invalidateEndpoint(accountId: string): void {
  cache.delete(accountId);
}

export function fallbackEndpoint(account: BoundAccount): string {
  if (account.environment.kind === "github.com") {
    return GITHUB_COM_FALLBACK;
  }
  const host = account.environment.host.split(":")[0] ?? account.environment.host;
  return `https://copilot-api.${host}`;
}

export function stripSecretsOnRedirect(fromUrl: string, toUrl: string, headers: Headers): Headers {
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  const same = from.hostname === to.hostname && effectivePort(from) === effectivePort(to);
  if (same) {
    return headers;
  }
  const next = new Headers(headers);
  for (const name of STRIP_ON_CROSS_HOST) {
    next.delete(name);
  }
  return next;
}

function effectivePort(url: URL): string {
  if (url.port !== "") {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}
