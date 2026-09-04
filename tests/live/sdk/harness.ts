export const LIVE_SDK_TEST_GUARD = "GHC_GATEWAY_LIVE_TESTS";
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

export type LiveStatus = "passing" | "not_available";

export interface WeatherArguments {
  readonly city: string;
}

export interface WeatherResult {
  readonly city: string;
  readonly condition: "sunny";
  readonly temperature_c: 22;
}

export function parseWeatherArguments(value: unknown): WeatherArguments {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  } catch (_error: unknown) {
    throw new Error("get_weather arguments must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("city" in parsed) || typeof parsed.city !== "string") {
    throw new Error("get_weather arguments must contain a city string");
  }
  return { city: parsed.city };
}

export function getWeather(city: string): WeatherResult {
  if (city !== "Tokyo") {
    throw new Error("get_weather live scenario expected Tokyo");
  }
  return { city, condition: "sunny", temperature_c: 22 };
}

export function assertNonEmptyText(value: unknown, message: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
}

export function assertNonEmptyArray(value: unknown, message: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(message);
  }
}

export function assertLiveSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[LIVE_SDK_TEST_GUARD] !== "1") {
    throw new Error(`${LIVE_SDK_TEST_GUARD}=1 is required for manual live SDK tests`);
  }
}

export function liveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  assertLiveSdkTestsEnabled(env);
  const url = new URL(env.GHC_GATEWAY_LIVE_BASE_URL ?? "http://127.0.0.1:31400");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" || url.password !== "") {
    throw new Error("GHC_GATEWAY_LIVE_BASE_URL must be an unauthenticated http://127.0.0.1 URL");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.href.replace(/\/$/u, "");
}

export function loopbackOnlyFetch(origin: string): typeof globalThis.fetch {
  const expected = new URL(origin).origin;
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== expected || url.hostname !== "127.0.0.1") {
      throw new Error("live SDK tests blocked a request outside the selected local gateway");
    }
    return await globalThis.fetch(input, init);
  };
}

export function recordLiveStatus(
  check: string,
  status: LiveStatus,
  modelIds: readonly string[],
): void {
  console.info(JSON.stringify({ check, status, model_ids: modelIds }));
}

export function isManagedBridgeResponseId(id: string): boolean {
  if (!id.startsWith("resp_")) {
    return false;
  }
  const encoded = id.slice("resp_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    return false;
  }
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.toString("base64") === encoded
      && /^litellm:custom_llm_provider:.+;model_id:.+;response_id:.+$/u.test(decoded.toString("utf8"));
  } catch (_error: unknown) {
    return false;
  }
}

export async function consumeAtLeastOne<T>(stream: AsyncIterable<T>): Promise<number> {
  let count = 0;
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const item = await iterator.next();
    if (item.done === true) {
      break;
    }
    count += 1;
  }
  return count;
}

export async function expectCancelledStream<T>(
  stream: AsyncIterable<T>,
  abort: () => void,
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();
  abort();
  const settled = Promise.resolve(pending).then(
    () => true,
    () => true,
  );
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000));
  if (!await Promise.race([settled, timeout])) {
    throw new Error("cancelled live stream did not terminate within five seconds");
  }
  await iterator.return?.();
}
