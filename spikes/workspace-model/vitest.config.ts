import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { defineConfig } from "vitest/config";

/**
 * A throwaway SAML identity provider key and self-signed certificate, made fresh for every run
 * so no key is ever committed. Workers cannot create X.509 certificates, so this runs in Node.
 */
function testIdentityProvider(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "spike-idp-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=idp.example.com",
        "-days",
        "2",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * samlify as one CommonJS file, the way wrangler's esbuild bundles it into a Worker.
 *
 * samlify's build/src/metadata-*.js call require("xml") (the npm package) and sit next to its
 * own build/src/xml.js. Loaded file by file, the Workers test runner resolves that bare name to
 * the sibling module, so `xml_1.default` is undefined and SP metadata fails with a TypeError
 * (shown in the decision record). A bundle has no sibling modules, so the problem disappears.
 */
async function bundledSamlify(): Promise<string> {
  const outfile = join(mkdtempSync(join(tmpdir(), "spike-samlify-")), "samlify.cjs");
  await build({
    entryPoints: [createRequire(import.meta.url).resolve("samlify")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}

export default defineConfig(async () => {
  // The real D1 schema of apps/app first, then the tables the plugins add, so the spike proves
  // the plugins against today's schema and triggers rather than a fresh one.
  const dbSource = dirname(createRequire(import.meta.url).resolve("@portifact/db"));
  const migrations = [
    ...(await readD1Migrations(join(dbSource, "..", "migrations"))),
    ...(await readD1Migrations(new URL("./migrations", import.meta.url).pathname)),
  ];
  const idp = testIdentityProvider();
  return {
    resolve: { alias: [{ find: /^samlify$/, replacement: await bundledSamlify() }] },
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            // A fixed value that only exists in local tests. Real secrets use wrangler secret.
            BETTER_AUTH_SECRET: "spike-test-only-secret-not-used-anywhere-else",
            TEST_MIGRATIONS: migrations,
            IDP_KEY: idp.key,
            IDP_CERT: idp.cert,
          },
        },
      }),
    ],
    test: {
      // The SSO plugin's `import ... from "samlify"` must go through the alias above.
      server: { deps: { inline: ["@better-auth/sso"] } },
      testTimeout: 30_000,
      include: ["src/**/*.test.ts"],
      setupFiles: ["./src/test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul" as const,
        reporter: ["text", "json-summary"],
        include: ["src/**/*.ts"],
        // schema.ts only declares tables (its lazy references never run); schema.test.ts checks
        // it against the fields Better Auth declares.
        exclude: ["src/**/*.test.ts", "src/test/**", "src/**/*.d.ts", "src/schema.ts"],
        thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
      },
    },
  };
});
