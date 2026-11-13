import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The acceptance claim runs as a real D1 batch on local D1 in workerd, like the other spikes'
// database tests. Part of `bun run test` (the package's `test` script runs both configurations).
const migrations = await readD1Migrations(
  new URL("./workers/migrations", import.meta.url).pathname,
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["workers/**/*.test.ts"],
    setupFiles: ["./workers/apply-migrations.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/workers",
      include: ["workers/acceptance.ts"],
      thresholds: { lines: 95, branches: 85, functions: 95, statements: 95 },
    },
  },
});
