import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type CallableModule = {
  request?: (...args: unknown[]) => unknown;
  get?: (...args: unknown[]) => unknown;
  connect?: (...args: unknown[]) => unknown;
  createConnection?: (...args: unknown[]) => unknown;
};

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return LOOPBACK_HOSTS.has(normalized);
}

export function isAllowedNetworkTarget(input: string | URL): boolean {
  const url = typeof input === "string" ? new URL(input) : input;
  return isLoopbackHost(url.hostname);
}

function hostFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    try {
      return new URL(value).hostname;
    } catch (_error) {
      return value;
    }
  }

  if (value instanceof URL) {
    return value.hostname;
  }

  if (value !== null && typeof value === "object") {
    const candidate = value as { hostname?: unknown; host?: unknown };
    const hostname = candidate.hostname ?? candidate.host;
    return typeof hostname === "string" ? hostname.split(":")[0] ?? hostname : null;
  }

  return null;
}

function assertAllowed(args: readonly unknown[]): void {
  const host = args.map(hostFromUnknown).find((value) => value !== null);

  if (host !== undefined && host !== null && !isLoopbackHost(host)) {
    throw new Error(`network access to ${host} is blocked by the CI network guard`);
  }
}

function patchModule(module: CallableModule): void {
  if (module.request !== undefined) {
    const original = module.request;
    module.request = (...args: unknown[]): unknown => {
      assertAllowed(args);
      return original(...args);
    };
  }

  if (module.get !== undefined) {
    const original = module.get;
    module.get = (...args: unknown[]): unknown => {
      assertAllowed(args);
      return original(...args);
    };
  }

  const connect = module.connect ?? module.createConnection;
  if (connect !== undefined) {
    const guarded = (...args: unknown[]): unknown => {
      assertAllowed(args);
      return connect(...args);
    };
    module.connect = guarded;
    module.createConnection = guarded;
  }
}

export function installCiNetworkGuard(): void {
  if (globalThis.fetch !== undefined) {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (!isAllowedNetworkTarget(url)) {
        return Promise.reject(new Error(`network access to ${url.hostname} is blocked by the CI network guard`));
      }

      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
  }

  patchModule(http as CallableModule);
  patchModule(https as CallableModule);
  patchModule(net as CallableModule);
  patchModule(tls as CallableModule);
}

if (process.env.GHC_GATEWAY_CI_NETWORK_GUARD === "1") {
  installCiNetworkGuard();
}
