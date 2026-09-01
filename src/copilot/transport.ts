import type { BoundAccount } from "../accounts/account_directory.js";
import type { CredentialStore } from "../accounts/credential_store.js";
import { Agent, errors as undiciErrors, request as undiciRequest } from "undici";
import type { IncomingHttpHeaders } from "node:http";
import { discoverEndpoint, MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";
import { outboundHeaders } from "./backend.js";
import type { TokenRefreshError } from "./token_refresh.js";
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
  readonly refreshCopilotToken: (githubToken: string, signal?: AbortSignal) => Promise<{ token: string; expiresAtMs: number }>;
  readonly fetchDiscovery: (account: BoundAccount, signal?: AbortSignal) => Promise<string | null>;
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
      completeChat: (request) => this.completeJson(`${target.endpoint}/chat/completions`, target.token, request.body, request.signal, fetchImpl, request.nonstreamBodyBytes, request.connectTimeoutMs, request.firstByteTimeoutMs, chatExtraHeaders(request.hasVisionInput)),
      openChatStream: (request) => this.openStream(`${target.endpoint}/chat/completions`, target.token, request.body, request.signal, fetchImpl, request.connectTimeoutMs, request.firstByteTimeoutMs, chatExtraHeaders(request.hasVisionInput)),
      completeResponses: (request) => this.completeJson(`${target.endpoint}/responses`, target.token, request.body, request.signal, fetchImpl, undefined, undefined, undefined),
      openResponsesStream: (request) => this.openStream(`${target.endpoint}/responses`, target.token, request.body, request.signal, fetchImpl, undefined, undefined),
    };
  }

  private async completeJson(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    maxBodyBytes: number | undefined,
    connectTimeoutMs: number | undefined,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<ChatResponse & UpstreamByteResponse> {
    const response = fetchImpl === fetch
      ? await undiciWithRedirects(url, token, body, signal, connectTimeoutMs, firstByteTimeoutMs, extraHeaders)
      : await fetchWithRedirects(fetchImpl, url, token, body, signal, connectTimeoutMs, firstByteTimeoutMs, extraHeaders);
    if (response.status < 200 || response.status >= 300) {
      await response.cancel();
      return { status: response.status, headers: response.headers, body: new Uint8Array() };
    }
    try {
      const bytes = await readResponseBody(response.bytes, maxBodyBytes, firstByteTimeoutMs, signal);
      return { status: response.status, headers: response.headers, body: bytes };
    } catch (error: unknown) {
      await response.cancel();
      throw error;
    }
  }

  private async openStream(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    connectTimeoutMs: number | undefined,
    firstByteTimeoutMs: number | undefined,
    extraHeaders?: Headers,
  ): Promise<UpstreamByteStream> {
    const response = fetchImpl === fetch
      ? await undiciWithRedirects(url, token, body, signal, connectTimeoutMs, firstByteTimeoutMs, extraHeaders)
      : await fetchWithRedirects(fetchImpl, url, token, body, signal, connectTimeoutMs, firstByteTimeoutMs, extraHeaders);
    if (response.status < 200 || response.status >= 300) {
      await response.cancel();
    }
    return {
      status: response.status,
      headers: response.headers,
      bytes: response.bytes,
      cancel: response.cancel,
    };
  }
}

interface TransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

interface UndiciBody extends AsyncIterable<Uint8Array | Buffer | string> {
  destroy(error?: Error): void;
}

async function fetchWithRedirects(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body: Uint8Array,
  signal: AbortSignal,
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
  extraHeaders?: Headers,
): Promise<TransportResponse> {
  let current = url;
  let headers = outboundHeaders(token, extraHeaders);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const timeout = responseStartTimeout(connectTimeoutMs, firstByteTimeoutMs);
    const fetchSignal = timeout === undefined ? signal : AbortSignal.any([signal, timeout.signal]);
    let response: Response;
    try {
      const fetchPromise = fetchImpl(current, {
        method: "POST",
        headers,
        body: Buffer.from(body),
        signal: fetchSignal,
        redirect: "manual",
      });
      response = await (timeout === undefined
        ? fetchPromise
        : Promise.race([fetchPromise, timeout.promise]));
    } catch (error: unknown) {
      if (timeout?.timedOut() === true || error instanceof UpstreamTimeoutError) {
        throw new UpstreamTimeoutError();
      }
      throw error;
    } finally {
      timeout?.clear();
    }
    if (response.status < 300 || response.status >= 400) {
      return {
        status: response.status,
        headers: response.headers,
        bytes: response.body === null ? empty() : iterateWebBody(response.body),
        cancel: async () => cancelResponseBody(response),
      };
    }
    const location = response.headers.get("location");
    if (location === null) {
      return {
        status: response.status,
        headers: response.headers,
        bytes: response.body === null ? empty() : iterateWebBody(response.body),
        cancel: async () => cancelResponseBody(response),
      };
    }
    const next = new URL(location, current).toString();
    headers = stripSecretsOnRedirect(current, next, headers);
    current = next;
  }
  throw new Error("too many redirects");
}

async function undiciWithRedirects(
  url: string,
  token: string,
  body: Uint8Array,
  signal: AbortSignal,
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
  extraHeaders?: Headers,
): Promise<TransportResponse> {
  let current = url;
  let headers = outboundHeaders(token, extraHeaders);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const dispatcher = new Agent({
      ...(connectTimeoutMs === undefined ? {} : { connectTimeout: connectTimeoutMs }),
      ...(firstByteTimeoutMs === undefined ? {} : { headersTimeout: firstByteTimeoutMs }),
      bodyTimeout: 0,
    });
    try {
      const response = await undiciRequest(current, {
        method: "POST",
        headers: headersToRecord(headers),
        body: Buffer.from(body),
        signal,
        dispatcher,
      });
      const responseHeaders = incomingHeadersToHeaders(response.headers);
      if (response.statusCode < 300 || response.statusCode >= 400) {
        return {
          status: response.statusCode,
          headers: responseHeaders,
          bytes: iterateUndiciBody(response.body as UndiciBody, dispatcher),
          cancel: async () => {
            response.body.destroy();
            await dispatcher.close().catch(() => undefined);
          },
        };
      }
      response.body.destroy();
      await dispatcher.close().catch(() => undefined);
      const location = responseHeaders.get("location");
      if (location === null) {
        return {
          status: response.statusCode,
          headers: responseHeaders,
          bytes: empty(),
          cancel: async () => undefined,
        };
      }
      const next = new URL(location, current).toString();
      headers = stripSecretsOnRedirect(current, next, headers);
      current = next;
    } catch (error: unknown) {
      await dispatcher.close().catch(() => undefined);
      if (isUndiciTimeout(error)) {
        throw new UpstreamTimeoutError();
      }
      throw error;
    }
  }
  throw new Error("too many redirects");
}

function responseStartTimeout(
  connectTimeoutMs: number | undefined,
  firstByteTimeoutMs: number | undefined,
): {
  readonly signal: AbortSignal;
  readonly promise: Promise<Response>;
  readonly clear: () => void;
  readonly timedOut: () => boolean;
} | undefined {
  if (connectTimeoutMs === undefined && firstByteTimeoutMs === undefined) {
    return undefined;
  }
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const promise = new Promise<Response>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const ms = Math.min(connectTimeoutMs ?? Number.POSITIVE_INFINITY, firstByteTimeoutMs ?? Number.POSITIVE_INFINITY);
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new UpstreamTimeoutError();
    controller.abort(error);
    rejectTimeout(error);
  }, ms);
  return {
    signal: controller.signal,
    promise,
    clear: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function mapTokenRefreshError(error: TokenRefreshError): "authentication" | "upstream_network" | "upstream_timeout" {
  if (error.code === "missing" || error.code === "unauthorized") {
    return "authentication";
  }
  if (error.code === "timeout") {
    return "upstream_timeout";
  }
  return "upstream_network";
}

function chatExtraHeaders(hasVisionInput: boolean): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (hasVisionInput) {
    headers.set("copilot-vision-request", "true");
  }
  return headers;
}

async function* empty(): AsyncIterable<Uint8Array> {}

async function readResponseBody(
  source: AsyncIterable<Uint8Array>,
  maxBodyBytes: number | undefined,
  firstByteTimeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let seenBodyBytes = false;
  try {
    for (;;) {
      const next = seenBodyBytes || firstByteTimeoutMs === undefined
        ? await iterator.next()
        : await firstBodyChunk(iterator, firstByteTimeoutMs, signal);
      if (next.done === true) {
        break;
      }
      const chunk = next.value;
      if (signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      seenBodyBytes = true;
      total += chunk.byteLength;
      if (maxBodyBytes !== undefined && total > maxBodyBytes) {
        throw new UpstreamBodyLimitError();
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    void iterator.return?.().catch(() => undefined);
    throw error;
  } finally {
    if (!seenBodyBytes) {
      void iterator.return?.().catch(() => undefined);
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function firstBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  ms: number,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  let clear = (): void => undefined;
  const timeout = new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => reject(new UpstreamTimeoutError()), ms);
    const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    clear = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    clear();
  }
}

async function* iterateWebBody(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
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
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function* iterateUndiciBody(body: UndiciBody, dispatcher: Agent): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of body) {
      yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    }
  } finally {
    body.destroy();
    await dispatcher.close().catch(() => undefined);
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function incomingHeadersToHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    result.set(key, value);
  }
  return result;
}

function isUndiciTimeout(error: unknown): boolean {
  return error instanceof undiciErrors.ConnectTimeoutError
    || error instanceof undiciErrors.HeadersTimeoutError
    || error instanceof undiciErrors.BodyTimeoutError;
}
