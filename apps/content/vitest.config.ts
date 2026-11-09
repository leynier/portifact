import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/migrations", import.meta.url)),
  );
  const accessMigrations = await readD1Migrations(
    fileURLToPath(new URL("../../packages/db/access-migrations", import.meta.url)),
  );
  return {
    resolve: {
      alias: {
        "@portifact/render/diagrams-bundle": fileURLToPath(
          new URL("./test/diagrams-bundle.stub.ts", import.meta.url),
        ),
        "@portifact/render/diagrams-version": fileURLToPath(
          new URL("./test/diagrams-version.stub.ts", import.meta.url),
        ),
      },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Fixed value that only exists in local tests. The real one uses wrangler secret.
            READ_SESSION_SECRET: "test-only-read-session-secret-0123456789abcdef",
            TEST_MIGRATIONS: migrations,
            TEST_ACCESS_MIGRATIONS: accessMigrations,
          },
        },
      }),
    ],
    test: {
      // CI runs every package's tests at once on one runner; time budgets are asserted
      // explicitly where they matter, so the timeout only catches hangs.
      testTimeout: 30_000,
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul" as const,
        reporter: ["text", "json-summary"],
        include: ["src/**/*.ts"],
        thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  };
});
