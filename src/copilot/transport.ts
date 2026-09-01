import type { BoundAccount } from "../accounts/account_directory.js";
import type { CredentialStore } from "../accounts/credential_store.js";
import { discoverEndpoint, MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";
import { outboundHeaders } from "./backend.js";
import { getValidToken } from "./token_refresh.js";
import type { CopilotBackend, CopilotTarget, BoundCopilot } from "./backend.js";
import type { ChatResponse, UpstreamByteResponse, UpstreamByteStream } from "../protocols/chat_completions/types.js";

export interface CopilotTransportDeps {
  readonly credentials: CredentialStore;
  readonly nowMs?: () => number;
  readonly refreshCopilotToken: (githubToken: string) => Promise<{ token: string; expiresAtMs: number }>;
  readonly fetchDiscovery: (account: BoundAccount) => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

export class HttpCopilotBackend implements CopilotBackend {
  constructor(private readonly deps: CopilotTransportDeps) {}

  async bind(account: Readonly<BoundAccount>, _signal: AbortSignal): Promise<BoundCopilot> {
    const nowMs = this.deps.nowMs ?? Date.now;
    const token = await getValidToken(this.deps.credentials, account, nowMs(), this.deps.refreshCopilotToken);
    const discovered = await discoverEndpoint(account, this.deps.fetchDiscovery);
    const target: CopilotTarget = { endpoint: discovered.endpoint, token };
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    return {
      accountId: account.accountId,
      target,
      completeChat: (request) => this.completeJson(`${target.endpoint}/chat/completions`, target.token, request.body, request.signal, fetchImpl, chatExtraHeaders(request.hasVisionInput)),
      openChatStream: (request) => this.openStream(`${target.endpoint}/chat/completions`, target.token, request.body, request.signal, fetchImpl, chatExtraHeaders(request.hasVisionInput)),
      completeResponses: (request) => this.completeJson(`${target.endpoint}/responses`, target.token, request.body, request.signal, fetchImpl),
      openResponsesStream: (request) => this.openStream(`${target.endpoint}/responses`, target.token, request.body, request.signal, fetchImpl),
    };
  }

  private async completeJson(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    extraHeaders?: Headers,
  ): Promise<ChatResponse & UpstreamByteResponse> {
    const response = await fetchWithRedirects(fetchImpl, url, token, body, signal, extraHeaders);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body: bytes };
  }

  private async openStream(
    url: string,
    token: string,
    body: Uint8Array,
    signal: AbortSignal,
    fetchImpl: typeof fetch,
    extraHeaders?: Headers,
  ): Promise<UpstreamByteStream> {
    const response = await fetchWithRedirects(fetchImpl, url, token, body, signal, extraHeaders);
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
  extraHeaders?: Headers,
): Promise<Response> {
  let current = url;
  let headers = outboundHeaders(token, extraHeaders);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const response = await fetchImpl(current, {
      method: "POST",
      headers,
      body: Buffer.from(body),
      signal,
      redirect: "manual",
    });
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

function chatExtraHeaders(hasVisionInput: boolean): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (hasVisionInput) {
    headers.set("copilot-vision-request", "true");
  }
  return headers;
}

async function* empty(): AsyncIterable<Uint8Array> {}

async function* iterateBody(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return;
      }
      if (next.value !== undefined) {
        yield next.value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
