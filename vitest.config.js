import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Include test files
    include: ["tests/**/*.test.js"],
    // Exclude manual tests
    exclude: ["tests/manual/**", "node_modules/**"],
    // Enable globals (describe, it, expect)
    globals: true,
    // Timeout settings
    // Integration tests with semantic comparison need longer timeout
    testTimeout: 90000, // 90 seconds for integration tests with LLM semantic comparison
    hookTimeout: 30000,
    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      include: ["src/utils/**"],
      exclude: ["node_modules", "tests"],
      thresholds: {
        // Thresholds for adapter files (high coverage target)
        "src/utils/adapters/**": {
          lines: 80,
          functions: 80,
          branches: 60,
          statements: 80,
        },
        // Thresholds for image_utils.js
        "src/utils/image_utils.js": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Global thresholds are lower because auth/chat/http clients
        // require external services and are not unit-tested
        global: {
          lines: 30,
          functions: 30,
          branches: 30,
          statements: 30,
        },
      },
    },
  },
});
