import { defineConfig } from "vitest/config";

const live = process.env.GHC_GATEWAY_LIVE_TESTS === "1";
const offline = process.env.GHC_GATEWAY_SDK_TESTS === "1";

if (live && offline) {
  throw new Error("set exactly one of GHC_GATEWAY_LIVE_TESTS=1 or GHC_GATEWAY_SDK_TESTS=1");
}

export default defineConfig({
  test: {
    name: live ? "live-sdk" : "offline-sdk",
    include: [live ? "tests/live/sdk/**/*.sdk.test.ts" : "tests/refactor/sdk/**/*.sdk.test.ts"],
    exclude: ["node_modules/**", live ? "tests/refactor/**" : "tests/live/**"],
    globals: true,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
