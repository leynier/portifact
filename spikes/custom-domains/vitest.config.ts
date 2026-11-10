import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// One migration history for both control databases, as decision 0005 recommends. GLOBAL is the
// control database and also holds the default region, the layout production would use; DB_EU is
// a regional database of its own, so every cross-database path is exercised.
const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["GLOBAL", "DB_EU"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
