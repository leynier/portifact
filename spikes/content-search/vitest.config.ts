import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        // DB is one regional database, reduced to the tables the index touches.
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    // The spike measures: it writes megabytes into D1 and times queries, which takes several
    // times longer on a loaded CI runner than the default five seconds allow.
    testTimeout: 60_000,
    // Hooks start the Worker and its databases; the 10 second default fails on a slow runner.
    hookTimeout: 60_000,
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
