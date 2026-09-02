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
  private closed = false;

  constructor(
    private readonly nowMs: () => number = Date.now,
    private readonly createToken: () => string = randomToken,
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
    return refreshed;
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
      this.sessions.delete(key);
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
    this.sessions.clear();
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
        this.sessions.delete(sessionId);
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
