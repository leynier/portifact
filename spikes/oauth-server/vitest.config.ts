import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // A fixed value that only exists in local tests. Real secrets use wrangler secret.
          BETTER_AUTH_SECRET: "spike-test-only-secret-not-used-anywhere-else",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/apply-migrations.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/**/*.d.ts"],
      // Auth and access-control code: the strictest thresholds in docs/testing.md.
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
