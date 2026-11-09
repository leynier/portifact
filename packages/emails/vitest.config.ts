import { defineConfig } from "vitest/config";

// Thresholds from docs/testing.md for other packages (90% lines, 85% branches).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
