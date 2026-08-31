import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const allowed = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeHost(host) {
  return String(host).trim().toLowerCase().replace(/\.$/, "");
}

function isLoopback(host) {
  return allowed.has(normalizeHost(host));
}

function hostFrom(value) {
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
    const host = value.hostname ?? value.host;
    return typeof host === "string" ? host.split(":")[0] : null;
  }
  return null;
}

function assertAllowed(args) {
  const host = args.map(hostFrom).find((value) => value !== null);
  if (host && !isLoopback(host)) {
    throw new Error(`network access to ${host} is blocked by the refactor CI guard`);
  }
}

function patch(module) {
  for (const key of ["request", "get", "connect", "createConnection"]) {
    if (typeof module[key] !== "function") {
      continue;
    }
    const original = module[key];
    module[key] = (...args) => {
      assertAllowed(args);
      return original(...args);
    };
  }
}

if (globalThis.fetch) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    if (!isLoopback(url.hostname)) {
      return Promise.reject(new Error(`network access to ${url.hostname} is blocked by the refactor CI guard`));
    }
    return originalFetch(input, init);
  };
}

patch(http);
patch(https);
patch(net);
patch(tls);
