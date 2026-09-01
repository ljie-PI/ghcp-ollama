import { copilotHeaders } from "./identity.js";
import { capiModelsUrl, type CapiModelsResponse, type CopilotModelsSource } from "./model_catalog.js";
import { MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";

interface CapiTransportLimits {
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly bodyLimitBytes: number;
}

const DEFAULT_CAPI_LIMITS: CapiTransportLimits = {
  connectTimeoutMs: 30_000,
  totalTimeoutMs: 600_000,
  bodyLimitBytes: 33_554_432,
};

export class CapiFetchError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super("capi fetch failed");
    this.name = "CapiFetchError";
  }
}

export class HttpCopilotModelsSource implements CopilotModelsSource {
  constructor(
    private readonly resolve: (accountId: string, signal: AbortSignal) => Promise<{ token: string; endpoint: string }>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly limits: CapiTransportLimits = DEFAULT_CAPI_LIMITS,
  ) {}

  async fetch(accountId: string, signal: AbortSignal): Promise<CapiModelsResponse> {
    const { token, endpoint } = await this.resolve(accountId, signal);
    const response = await getWithRedirects(this.fetchImpl, capiModelsUrl(endpoint), token, signal, Date.now() + this.limits.totalTimeoutMs, this.limits);
    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response);
      const status = response.status >= 300 && response.status < 400 ? 502 : response.status;
      throw new CapiFetchError(status, response.status === 429 ? validRetryAfter(response.headers) : undefined);
    }
    try {
      const bytes = await readLimitedBody(response, signal, Date.now() + this.limits.totalTimeoutMs, this.limits);
      return JSON.parse(new TextDecoder().decode(bytes)) as CapiModelsResponse;
    } catch (error: unknown) {
      if (error instanceof CapiFetchError) {
        throw error;
      }
      await cancelResponseBody(response);
      throw new CapiFetchError(502);
    }
  }
}

async function getWithRedirects(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
  deadlineMs: number,
  limits: CapiTransportLimits,
): Promise<Response> {
  let current = url;
  let headers = new Headers({ ...copilotHeaders(), authorization: `Bearer ${token}`, "content-type": "application/json" });
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const response = await fetchWithTimeout(fetchImpl, current, headers, signal, deadlineMs, limits);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (location === null) {
      return response;
    }
    const next = new URL(location, current).toString();
    headers = stripSecretsOnRedirect(current, next, headers);
    await cancelResponseBody(response);
    current = next;
  }
  throw new CapiFetchError(502);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
  signal: AbortSignal,
  deadlineMs: number,
  limits: CapiTransportLimits,
): Promise<Response> {
  const timeout = timeoutPromise<Response>(Math.min(limits.connectTimeoutMs, remainingMs(deadlineMs)), signal);
  try {
    return await Promise.race([
      fetchImpl(url, { method: "GET", headers, signal: timeout.signal, redirect: "manual" }),
      timeout.promise,
    ]);
  } catch (error: unknown) {
    if (timeout.timedOut()) {
      throw new CapiFetchError(502);
    }
    throw error;
  } finally {
    timeout.clear();
  }
}

async function readLimitedBody(response: Response, signal: AbortSignal, deadlineMs: number, limits: CapiTransportLimits): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const timeout = timeoutPromise<ReadableStreamReadResult<Uint8Array>>(remainingMs(deadlineMs), signal);
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), timeout.promise]);
      } catch (error: unknown) {
        if (timeout.timedOut()) {
          throw new CapiFetchError(502);
        }
        throw error;
      } finally {
        timeout.clear();
      }
      if (next.done) {
        break;
      }
      if (next.value === undefined) {
        continue;
      }
      total += next.value.byteLength;
      if (total > limits.bodyLimitBytes) {
        void reader.cancel().catch(() => undefined);
        throw new CapiFetchError(502);
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

function timeoutPromise<T>(ms: number, signal: AbortSignal): {
  readonly signal: AbortSignal;
  readonly promise: Promise<T>;
  readonly clear: () => void;
  readonly timedOut: () => boolean;
} {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timedOut = false;
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new CapiFetchError(502));
  }, Math.max(0, ms));
  return {
    signal: combined,
    promise,
    clear: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function validRetryAfter(headers: Headers): string | undefined {
  const value = headers.get("retry-after");
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    return value;
  }
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value) && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return undefined;
}
