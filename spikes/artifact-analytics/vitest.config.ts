import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const control = await readD1Migrations(new URL("./migrations/control", import.meta.url).pathname);
const access = await readD1Migrations(new URL("./migrations/access", import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        // CONTROL is `portifact-control` and ACCESS is `portifact-access`, reduced.
        d1Databases: ["CONTROL", "ACCESS"],
        // Only to record what the local Analytics Engine binding does; nothing reads it.
        analyticsEngineDatasets: { VIEWS_AE: { dataset: "spike_views" } },
        bindings: { CONTROL_MIGRATIONS: control, ACCESS_MIGRATIONS: access },
      },
    }),
  ],
  test: {
    // A slow runner takes several times longer than a laptop; the 5 and 10 second defaults fail there.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
