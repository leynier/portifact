import { defineConfig } from "vitest/config";

// Thresholds from docs/testing.md for other packages (90% lines, 85% branches).
export default defineConfig({
  test: {
    // CI runs every package's tests at once on one runner; time budgets are asserted
    // explicitly where they matter, so the timeout only catches hangs.
    testTimeout: 30_000,
    // Hooks start the Worker and its databases; the 10 second default fails on a slow runner.
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/test-html.ts", "src/browser/entry.ts"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
