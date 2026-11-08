import { defineConfig } from "vitest/config";

// Only scripts with pure, tested logic are measured; the others are thin command wrappers
// exercised by CI itself (build, smoke and release jobs).
export default defineConfig({
  test: {
    // CI runs every package's tests at once on one runner; time budgets are asserted
    // explicitly where they matter, so the timeout only catches hangs.
    testTimeout: 30_000,
    include: ["*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["ci-scope.ts"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
