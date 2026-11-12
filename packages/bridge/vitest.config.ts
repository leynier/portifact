import { defineConfig } from "vitest/config";

// Thresholds of "other packages" in docs/testing.md, with lines held at 95%.
export default defineConfig({
  test: {
    // CI runs every package's tests at once on one runner; the timeout only catches hangs.
    testTimeout: 30_000,
    // Hooks start the Worker and its databases; the 10 second default fails on a slow runner.
    hookTimeout: 30_000,
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/entry.ts", "src/test-helpers.ts"],
      thresholds: { lines: 95, branches: 85, functions: 90, statements: 95 },
    },
  },
});
