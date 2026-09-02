import { randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_BOOTSTRAP_TTL_MS = 60_000;
export const ADMIN_IDLE_TIMEOUT_MS = 30 * 60_000;
export const ADMIN_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;
export const ADMIN_SESSION_CAP = 8;
export const ADMIN_BOOTSTRAP_TOKEN_CAP = 8;
export const ADMIN_SESSION_COOKIE = "ghcg_admin_session";

export interface AdminClock {
  nowMs(): number;
}

export interface AdminSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
  readonly idleExpiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
}

export interface AdminSessionMetadata {
  readonly csrfToken: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export class AdminAuthError extends Error {
  readonly code: "validation" | "unauthenticated" | "capacity";

  constructor(code: AdminAuthError["code"], message: string) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
  }
}

interface BootstrapToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class AdminAuth {
  private readonly bootstrapTokens = new Map<string, BootstrapToken>();
  private readonly sessions = new Map<string, AdminSession>();

  constructor(private readonly clock: AdminClock = { nowMs: Date.now }) {}

  mintBootstrapToken(): { readonly token: string; readonly expiresAt: string } {
    this.gc();
    if (this.bootstrapTokens.size >= ADMIN_BOOTSTRAP_TOKEN_CAP) {
      throw new AdminAuthError("capacity", "admin bootstrap capacity reached");
    }
    const token = randomToken();
    const expiresAtMs = this.clock.nowMs() + ADMIN_BOOTSTRAP_TTL_MS;
    this.bootstrapTokens.set(token, { token, expiresAtMs });
    return { token, expiresAt: iso(expiresAtMs) ?? "" };
  }

  exchangeBootstrapToken(token: string): AdminSession {
    this.gc();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new AdminAuthError("validation", "invalid bootstrap token");
    }
    const foundKey = findMatchingKey(this.bootstrapTokens, token);
    if (foundKey === undefined) {
      throw new AdminAuthError("unauthenticated", "invalid bootstrap token");
    }
    const bootstrap = this.bootstrapTokens.get(foundKey);
    this.bootstrapTokens.delete(foundKey);
    if (bootstrap === undefined || bootstrap.expiresAtMs <= this.clock.nowMs()) {
      throw new AdminAuthError("unauthenticated", "invalid bootstrap token");
    }
    if (this.sessions.size >= ADMIN_SESSION_CAP) {
      throw new AdminAuthError("capacity", "admin session capacity reached");
    }
    const now = this.clock.nowMs();
    const session: AdminSession = {
      sessionId: randomToken(),
      csrfToken: randomToken(),
      createdAtMs: now,
      lastSeenAtMs: now,
      idleExpiresAtMs: now + ADMIN_IDLE_TIMEOUT_MS,
      absoluteExpiresAtMs: now + ADMIN_ABSOLUTE_TIMEOUT_MS,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  requireSession(sessionId: string | null): AdminSession {
    this.gc();
    if (sessionId === null || sessionId.length === 0) {
      throw new AdminAuthError("unauthenticated", "admin session required");
    }
    const foundKey = findMatchingKey(this.sessions, sessionId);
    if (foundKey === undefined) {
      throw new AdminAuthError("unauthenticated", "admin session required");
    }
    const current = this.sessions.get(foundKey);
    if (current === undefined || this.isExpired(current)) {
      this.sessions.delete(foundKey);
      throw new AdminAuthError("unauthenticated", "admin session required");
    }
    const now = this.clock.nowMs();
    const refreshed: AdminSession = {
      ...current,
      lastSeenAtMs: now,
      idleExpiresAtMs: Math.min(now + ADMIN_IDLE_TIMEOUT_MS, current.absoluteExpiresAtMs),
    };
    this.sessions.set(current.sessionId, refreshed);
    return refreshed;
  }

  requireCsrf(session: AdminSession, csrfToken: string | null): void {
    if (csrfToken === null || !constantTimeEquals(session.csrfToken, csrfToken)) {
      throw new AdminAuthError("validation", "admin csrf token required");
    }
  }

  logout(sessionId: string | null): void {
    if (sessionId === null || sessionId.length === 0) {
      return;
    }
    const foundKey = findMatchingKey(this.sessions, sessionId);
    if (foundKey !== undefined) {
      this.sessions.delete(foundKey);
    }
  }

  sessionCount(): number {
    this.gc();
    return this.sessions.size;
  }

  bootstrapCount(): number {
    this.gc();
    return this.bootstrapTokens.size;
  }

  reset(): void {
    this.bootstrapTokens.clear();
    this.sessions.clear();
  }

  metadata(session: AdminSession): AdminSessionMetadata {
    return {
      csrfToken: session.csrfToken,
      idleExpiresAt: iso(session.idleExpiresAtMs) ?? "",
      absoluteExpiresAt: iso(session.absoluteExpiresAtMs) ?? "",
    };
  }

  private gc(): void {
    const now = this.clock.nowMs();
    for (const [token, value] of this.bootstrapTokens) {
      if (value.expiresAtMs <= now) {
        this.bootstrapTokens.delete(token);
      }
    }
    for (const [sessionId, session] of this.sessions) {
      if (this.isExpiredAt(session, now)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private isExpired(session: AdminSession): boolean {
    return this.isExpiredAt(session, this.clock.nowMs());
  }

  private isExpiredAt(session: AdminSession, now: number): boolean {
    return session.idleExpiresAtMs <= now || session.absoluteExpiresAtMs <= now;
  }
}

export function serializeSessionCookie(sessionId: string, absoluteExpiresAtMs: number): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${sessionId}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/admin",
    `Expires=${new Date(absoluteExpiresAtMs).toUTCString()}`,
  ].join("; ");
}

export function serializeExpiredSessionCookie(): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/admin",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export function readSessionCookie(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (cookie === null) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq) === ADMIN_SESSION_COOKIE) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

export function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function findMatchingKey<T>(map: ReadonlyMap<string, T>, candidate: string): string | undefined {
  for (const key of map.keys()) {
    if (constantTimeEquals(key, candidate)) {
      return key;
    }
  }
  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}
