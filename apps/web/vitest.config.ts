import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/main.ts"],
      thresholds: { lines: 85, branches: 80, functions: 85, statements: 85 },
    },
  },
});
