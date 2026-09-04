import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/refactor/**/*.{test,spec}.ts"],
    exclude: [
      "node_modules/**",
      "tests/refactor/sdk/**",
      "tests/live/**",
      "tests/refactor/e2e/**",
    ],
    globals: true,
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    setupFiles: ["./scripts/tooling/ci_network_guard.ts"],
  },
});
