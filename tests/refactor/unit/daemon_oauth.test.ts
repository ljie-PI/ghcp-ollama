import { describe, expect, it, vi } from "vitest";
import { resolveGitHubEnvironment } from "../../../src/accounts/github_environment.js";
import {
  DeviceOAuthError,
  HttpDeviceOAuthClient,
} from "../../../src/accounts/device_oauth.js";

const environment = resolveGitHubEnvironment("ghe.example.com");

describe("RM-19 HTTP device OAuth client", () => {
  it("uses URL-derived endpoints and accepts bounded JSON objects", async () => {
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = input.toString();
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({ access_token: "test-access-token" });
      }
      return jsonResponse({ id: 42, login: "octocat", name: "Octo Cat" });
    });
    const client = new HttpDeviceOAuthClient(fetch);

    await expect(client.exchangeDeviceCode(environment, "test-device-code")).resolves.toEqual({
      status: "complete",
      accessToken: "test-access-token",
      user: { id: 42, login: "octocat", name: "Octo Cat" },
    });
    expect(requests).toEqual([
      { url: "https://ghe.example.com/login/oauth/access_token", authorization: null },
      { url: "https://ghe.example.com/api/v3/user", authorization: "Bearer test-access-token" },
    ]);
  });

  it.each([
    ["HTTP failure", async () => new Response(null, { status: 502 })],
    ["network failure", async () => { throw new TypeError("network failed"); }],
    ["invalid JSON", async () => new Response("not JSON", { status: 200 })],
    ["non-object JSON", async () => jsonResponse(["unexpected"])],
  ])("maps %s to a typed remote error", async (_case, fetchImpl) => {
    const client = new HttpDeviceOAuthClient(fetchImpl);
    await expect(client.requestDeviceCode(environment)).rejects.toMatchObject({
      name: "DeviceOAuthError",
      code: "remote_error",
      message: "remote error",
    });
  });

  it("cancels on the first byte beyond the 1 MiB response limit", async () => {
    let reads = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(reads === 1 ? 1_048_576 : 1));
      },
      cancel() {
        canceled = true;
      },
    }, { highWaterMark: 0 });
    const client = new HttpDeviceOAuthClient(async () => new Response(body, { status: 200 }));

    await expect(client.requestDeviceCode(environment)).rejects.toBeInstanceOf(DeviceOAuthError);
    expect(reads).toBe(2);
    expect(canceled).toBe(true);
  });

  it("maps an invalid GitHub user response to remote_error", async () => {
    let requests = 0;
    const client = new HttpDeviceOAuthClient(async () => {
      requests += 1;
      return requests === 1
        ? jsonResponse({ access_token: "test-access-token" })
        : jsonResponse([]);
    });

    await expect(client.exchangeDeviceCode(environment, "test-device-code")).rejects.toBeInstanceOf(DeviceOAuthError);
    expect(requests).toBe(2);
  });

  it("preserves abort failures instead of mapping them to remote_error", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new HttpDeviceOAuthClient(async () => {
      throw new Error("fetch must not run");
    });

    await expect(client.requestDeviceCode(environment, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
