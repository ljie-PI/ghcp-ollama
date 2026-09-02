import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminBootstrapResult } from "../gateway/create_gateway.js";

export const ADMIN_BOOTSTRAP_TTL_MS = 60_000;
export const ADMIN_IDLE_TIMEOUT_MS = 30 * 60_000;
export const ADMIN_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;
export const ADMIN_SESSION_CAP = 8;
export const ADMIN_BOOTSTRAP_TOKEN_CAP = 8;
export const ADMIN_SESSION_COOKIE = "ghcg_admin_session";

export interface AdminSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
}

export interface AdminSessionMetadata {
  readonly csrfToken: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export class AdminAuthError extends Error {
  constructor(readonly code: "unauthenticated" | "capacity") {
    super(code === "capacity" ? "capacity exceeded" : "unauthenticated");
    this.name = "AdminAuthError";
  }
}

interface BootstrapToken {
  readonly expiresAtMs: number;
}

export class AdminAuth {
  private readonly bootstrapTokens = new Map<string, BootstrapToken>();
  private readonly sessions = new Map<string, AdminSession>();
  private readonly sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionWatchers = new Map<string, Set<() => void>>();
  private closed = false;

  constructor(
    private readonly nowMs: () => number = Date.now,
    private readonly createToken: () => string = randomToken,
    private readonly setTimer: typeof setTimeout = setTimeout,
    private readonly clearTimer: typeof clearTimeout = clearTimeout,
  ) {}

  mintBootstrap(): AdminBootstrapResult {
    if (this.closed) {
      return { kind: "closed" };
    }
    this.collectExpired();
    if (this.bootstrapTokens.size >= ADMIN_BOOTSTRAP_TOKEN_CAP) {
      return { kind: "capacity" };
    }
    const token = this.createUniqueToken(this.bootstrapTokens);
    const expiresAtMs = this.nowMs() + ADMIN_BOOTSTRAP_TTL_MS;
    this.bootstrapTokens.set(token, { expiresAtMs });
    return { kind: "issued", token, expiresAt: toIso(expiresAtMs) };
  }

  exchange(token: string): AdminSession {
    this.requireOpen();
    this.collectExpired();
    const key = findMatchingKey(this.bootstrapTokens, token);
    if (key === undefined) {
      throw new AdminAuthError("unauthenticated");
    }
    const bootstrap = this.bootstrapTokens.get(key);
    this.bootstrapTokens.delete(key);
    if (bootstrap === undefined || bootstrap.expiresAtMs <= this.nowMs()) {
      throw new AdminAuthError("unauthenticated");
    }
    if (this.sessions.size >= ADMIN_SESSION_CAP) {
      throw new AdminAuthError("capacity");
    }
    const now = this.nowMs();
    const session: AdminSession = {
      sessionId: this.createUniqueToken(this.sessions),
      csrfToken: this.createToken(),
      idleExpiresAtMs: now + ADMIN_IDLE_TIMEOUT_MS,
      absoluteExpiresAtMs: now + ADMIN_ABSOLUTE_TIMEOUT_MS,
    };
    this.sessions.set(session.sessionId, session);
    this.scheduleExpiry(session);
    return session;
  }

  requireSession(sessionId: string | null): AdminSession {
    this.requireOpen();
    this.collectExpired();
    if (sessionId === null || sessionId.length === 0) {
      throw new AdminAuthError("unauthenticated");
    }
    const key = findMatchingKey(this.sessions, sessionId);
    const current = key === undefined ? undefined : this.sessions.get(key);
    if (current === undefined) {
      throw new AdminAuthError("unauthenticated");
    }
    const now = this.nowMs();
    const refreshed: AdminSession = {
      ...current,
      idleExpiresAtMs: Math.min(now + ADMIN_IDLE_TIMEOUT_MS, current.absoluteExpiresAtMs),
    };
    this.sessions.set(current.sessionId, refreshed);
    this.scheduleExpiry(refreshed);
    return refreshed;
  }

  watchSession(sessionId: string, listener: () => void): () => void {
    this.requireOpen();
    if (!this.sessions.has(sessionId)) {
      throw new AdminAuthError("unauthenticated");
    }
    const watchers = this.sessionWatchers.get(sessionId) ?? new Set<() => void>();
    watchers.add(listener);
    this.sessionWatchers.set(sessionId, watchers);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      watchers.delete(listener);
      if (watchers.size === 0) {
        this.sessionWatchers.delete(sessionId);
      }
    };
  }

  verifyCsrf(session: AdminSession, candidate: string | null): boolean {
    return candidate !== null && constantTimeEquals(session.csrfToken, candidate);
  }

  logout(sessionId: string | null): void {
    if (sessionId === null) {
      return;
    }
    const key = findMatchingKey(this.sessions, sessionId);
    if (key !== undefined) {
      this.invalidateSession(key);
    }
  }

  metadata(session: AdminSession): AdminSessionMetadata {
    return {
      csrfToken: session.csrfToken,
      idleExpiresAt: toIso(session.idleExpiresAtMs),
      absoluteExpiresAt: toIso(session.absoluteExpiresAtMs),
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.bootstrapTokens.clear();
    for (const sessionId of [...this.sessions.keys()]) {
      this.invalidateSession(sessionId);
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new AdminAuthError("unauthenticated");
    }
  }

  private collectExpired(): void {
    const now = this.nowMs();
    for (const [token, value] of this.bootstrapTokens) {
      if (value.expiresAtMs <= now) {
        this.bootstrapTokens.delete(token);
      }
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.idleExpiresAtMs <= now || session.absoluteExpiresAtMs <= now) {
        this.invalidateSession(sessionId);
      }
    }
  }

  private scheduleExpiry(session: AdminSession): void {
    const previous = this.sessionTimers.get(session.sessionId);
    if (previous !== undefined) {
      this.clearTimer(previous);
    }
    const expiresAtMs = Math.min(session.idleExpiresAtMs, session.absoluteExpiresAtMs);
    const timer = this.setTimer(() => {
      const current = this.sessions.get(session.sessionId);
      if (current === undefined) {
        return;
      }
      if (current.idleExpiresAtMs <= this.nowMs() || current.absoluteExpiresAtMs <= this.nowMs()) {
        this.invalidateSession(session.sessionId);
      } else {
        this.scheduleExpiry(current);
      }
    }, Math.max(0, expiresAtMs - this.nowMs()));
    this.sessionTimers.set(session.sessionId, timer);
  }

  private invalidateSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    const timer = this.sessionTimers.get(sessionId);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.sessionTimers.delete(sessionId);
    }
    const watchers = this.sessionWatchers.get(sessionId);
    this.sessionWatchers.delete(sessionId);
    if (watchers !== undefined) {
      for (const watcher of watchers) {
        try {
          watcher();
        } catch {
          // One watcher cannot prevent invalidation of the others.
        }
      }
    }
  }

  private createUniqueToken(values: ReadonlyMap<string, unknown>): string {
    for (;;) {
      const token = this.createToken();
      if (token.length > 0 && !values.has(token)) {
        return token;
      }
    }
  }
}

export function serializeSessionCookie(sessionId: string, absoluteExpiresAtMs: number): string {
  return `${ADMIN_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/admin; Expires=${new Date(absoluteExpiresAtMs).toUTCString()}`;
}

export function serializeExpiredSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function readSessionCookie(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (cookie === null) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ADMIN_SESSION_COOKIE) {
      return value.join("=");
    }
  }
  return null;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function findMatchingKey<T>(values: ReadonlyMap<string, T>, candidate: string): string | undefined {
  for (const key of values.keys()) {
    if (constantTimeEquals(key, candidate)) {
      return key;
    }
  }
  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
