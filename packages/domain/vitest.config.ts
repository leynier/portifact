import { defineConfig } from "vitest/config";

// Critical package: thresholds from docs/testing.md (95% lines and branches).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
