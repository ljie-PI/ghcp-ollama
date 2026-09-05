import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.ts"],
    exclude: [
      "node_modules/**",
      "tests/sdk/**",
      "tests/live/**",
      "tests/e2e/**",
    ],
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    setupFiles: ["./scripts/tooling/ci_network_guard.ts"],
  },
});
