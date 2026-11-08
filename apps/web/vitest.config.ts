import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/main.ts",
        "src/pages/**",
        "src/auth/test-page.ts",
        "src/dashboard/main.tsx",
        "src/dashboard/test-support.tsx",
      ],
      thresholds: { lines: 85, branches: 80, functions: 85, statements: 85 },
    },
  },
});
