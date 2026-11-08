import { defineConfig } from "vitest/config";

// Only scripts with pure, tested logic are measured; the others are thin command wrappers
// exercised by CI itself (build, smoke and release jobs).
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["ci-scope.ts"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
