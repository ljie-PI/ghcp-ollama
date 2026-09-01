import { copilotHeaders } from "./identity.js";
import { capiModelsUrl, type CapiModelsResponse, type CopilotModelsSource } from "./model_catalog.js";
import { MAX_REDIRECTS, stripSecretsOnRedirect } from "./endpoint_discovery.js";

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
  ) {}

  async fetch(accountId: string, signal: AbortSignal): Promise<CapiModelsResponse> {
    const { token, endpoint } = await this.resolve(accountId, signal);
    const url = capiModelsUrl(endpoint);
    const response = await getWithRedirects(this.fetchImpl, url, token, signal);
    if (response.status < 200 || response.status >= 300) {
      const retryAfter = response.status === 429 ? response.headers.get("retry-after") : null;
      if (retryAfter === null || retryAfter === undefined) {
        throw new CapiFetchError(response.status);
      }
      throw new CapiFetchError(response.status, retryAfter);
    }
    return await response.json() as CapiModelsResponse;
  }
}

async function getWithRedirects(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  let headers = new Headers({ ...copilotHeaders(), authorization: `Bearer ${token}`, "content-type": "application/json" });
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const response = await fetchImpl(current, { method: "GET", headers, signal, redirect: "manual" });
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
  throw new CapiFetchError(502);
}
