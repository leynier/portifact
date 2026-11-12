import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The corpus test renders a few thousand documents; on a loaded CI runner that takes longer
    // than the default five seconds. The timeout only catches hangs.
    testTimeout: 120_000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 95, branches: 85, functions: 95, statements: 95 },
    },
  },
});
