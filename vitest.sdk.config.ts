import { defineConfig } from "vitest/config";

const live = process.env.GHC_GATEWAY_LIVE_TESTS === "1";

export default defineConfig({
  test: {
    name: live ? "live-sdk" : "offline-sdk",
    include: [live ? "tests/live/sdk/**/*.sdk.test.ts" : "tests/refactor/sdk/**/*.sdk.test.ts"],
    exclude: ["node_modules/**", live ? "tests/refactor/**" : "tests/live/**"],
    globals: true,
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});
