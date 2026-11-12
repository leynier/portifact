import { defineConfig } from "vitest/config";

// Critical package: thresholds from docs/testing.md (95% lines and branches).
export default defineConfig({
  test: {
    // CI runs every package's tests at once on one runner; time budgets are asserted
    // explicitly where they matter, so the timeout only catches hangs.
    testTimeout: 30_000,
    // Hooks start the Worker and its databases; the 10 second default fails on a slow runner.
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
