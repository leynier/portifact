import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // CI runs every package's tests at once on one runner; time budgets are asserted
    // explicitly where they matter, so the timeout only catches hangs.
    testTimeout: 30_000,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test-setup.ts",
        "src/main.ts",
        "src/pages/**",
        "src/auth/test-page.ts",
        "src/dashboard/main.tsx",
        "src/dashboard/publish/worker.ts",
        "src/dashboard/test-support.tsx",
      ],
      thresholds: { lines: 85, branches: 80, functions: 85, statements: 85 },
    },
  },
});
