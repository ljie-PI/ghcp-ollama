import type { BoundAccount } from "../accounts/account_directory.js";
import type { CredentialStore } from "../accounts/credential_store.js";
import { discoverEndpoint, MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";
import { outboundHeaders } from "./backend.js";
import { getValidToken } from "./token_refresh.js";
import type { CopilotBackend, CopilotTarget, BoundCopilot } from "./backend.js";
import type { ChatResponse, UpstreamByteResponse, UpstreamByteStream } from "../protocols/chat_completions/types.js";

export class UpstreamBodyLimitError extends Error {
  constructor() {
    super("upstream response body exceeds limit");
    this.name = "UpstreamBodyLimitError";
  }
}

export class UpstreamTimeoutError extends Error {
  constructor() {
    super("upstream timeout");
    this.name = "UpstreamTimeoutError";
  }
}

export interface CopilotTransportDeps {
  readonly credentials: CredentialStore;
  readonly nowMs?: () => number;
  readonly refreshCopilotToken: (githubToken: string) => Promise<{ token: string; expiresAtMs: number }>;
  readonly fetchDiscovery: (account: BoundAccount) => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

export class HttpCopilotBackend implements CopilotBackend {
  constructor(private readonly deps: CopilotTransportDeps) {}

  async bind(account: Readonly<BoundAccount>, signal: AbortSignal): Promise<BoundCopilot> {
    const nowMs = this.deps.nowMs ?? Date.now;
    const token = await getValidToken(this.deps.credentials, account, nowMs(), this.deps.refreshCopilotToken, signal);
    const discovered = await discoverEndpoint(account, this.deps.fetchDiscovery, signal);
    const target: CopilotTarget = { endpoint: discovered.endpoint, token };
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return {
      accountId: account.accountId,
      target,
      completeChat: (request) => this.completeJson(`${target.endpoint}/chat/completions`, target.token, request.body, request.signal, fetchImpl, request.nonstreamBodyBytes, request.firstByteTimeoutMs, chatExtraHeaders(request.hasVisionInput)),
      openChatStream: (request) => this.openStream(`${target.endpoint}/chat/completions`, target.token, request.body, request.signal, fetchImpl, request.firstByteTimeoutMs, chatExtraHeaders(request.hasVisionInput)),
      completeResponses: (request) => this.completeJson(`${target.endpoint}/responses`, target.token, request.body, request.signal, fetchImpl, undefined, undefined),
      openResponsesStream: (request) => this.openStream(`${target.endpoint}/responses`, target.token, request.body, request.signal, fetchImpl, undefined),
    };
  }

  private async completeJson(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    maxBodyBytes: number | undefined,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<ChatResponse & UpstreamByteResponse> {
    const response = await fetchWithRedirects(fetchImpl, url, token, body, signal, firstByteTimeoutMs, extraHeaders);
    if (response.status < 200 || response.status >= 300) {
      return { status: response.status, headers: response.headers, body: new Uint8Array() };
    }
    const bytes = await readResponseBody(response, maxBodyBytes, signal);
    return { status: response.status, headers: response.headers, body: bytes };
  }

  private async openStream(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<UpstreamByteStream> {
    const response = await fetchWithRedirects(fetchImpl, url, token, body, signal, firstByteTimeoutMs, extraHeaders);
    const stream = response.body;
    return {
      status: response.status,
      headers: response.headers,
      bytes: stream === null ? empty() : iterateBody(stream),
    };
  }
}

async function fetchWithRedirects(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body: Uint8Array,
  signal: AbortSignal,
  firstByteTimeoutMs: number | undefined,
  extraHeaders?: Headers,
): Promise<Response> {
  let current = url;
  let headers = outboundHeaders(token, extraHeaders);
  const timeout = firstByteTimeoutMs === undefined ? undefined : firstByteTimeout(firstByteTimeoutMs);
  const fetchSignal = timeout === undefined ? signal : AbortSignal.any([signal, timeout.signal]);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "POST",
        headers,
        body: Buffer.from(body),
        signal: fetchSignal,
        redirect: "manual",
      });
    } catch (error: unknown) {
      if (timeout?.timedOut() === true) {
        throw new UpstreamTimeoutError();
      }
      throw error;
    } finally {
      timeout?.clear();
    }
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      return response;
    }
    const next = new URL(location, current).toString();
    headers = stripSecretsOnRedirect(current, next, headers);
    current = next;
  }
  throw new Error("too many redirects");
}

function firstByteTimeout(ms: number): { readonly signal: AbortSignal; readonly clear: () => void; readonly timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new UpstreamTimeoutError());
  }, ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
}

function chatExtraHeaders(hasVisionInput: boolean): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (hasVisionInput) {
    headers.set("copilot-vision-request", "true");
  }
  return headers;
}

async function* empty(): AsyncIterable<Uint8Array> {}

async function readResponseBody(response: Response, maxBodyBytes: number | undefined, signal: AbortSignal): Promise<Uint8Array> {
  if (maxBodyBytes === undefined || response.body === null) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("aborted", "AbortError");
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (next.value === undefined) {
        continue;
      }
      total += next.value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamBodyLimitError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function* iterateBody(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      if (next.value !== undefined) {
        yield next.value;
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
