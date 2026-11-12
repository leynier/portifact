import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The runner is the data Worker of decision 0026: it exports `ArtifactDocuments` (wrangler.jsonc).
// `portifact-app-spike` stands for every other Worker that binds the class by `script_name`
// (the content, app and jobs Workers): a separate script whose binding names the data Worker.
// The pool renames the runner to `vitest-plugin-runner-<project name>`, so the auxiliary
// Worker's `scriptName` uses that name (the project is named below).
const PROJECT = "artifact-data";
const DATA_WORKER = `vitest-plugin-runner-${PROJECT}`;
const APP_WORKER = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(url.searchParams.get("artifact")));
    return stub.fetch("https://data.internal/peek" + url.search);
  },
};
`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: { APP: "portifact-app-spike" },
        r2Buckets: ["JOURNAL"],
        workers: [
          {
            name: "portifact-app-spike",
            modules: true,
            script: APP_WORKER,
            compatibilityDate: "2026-08-01",
            durableObjects: {
              DOCUMENTS: { className: "ArtifactDocuments", scriptName: DATA_WORKER },
            },
          },
        ],
      },
    }),
  ],
  test: {
    name: PROJECT,
    // The spike measures: an expensive owner statement runs for a second or more on purpose.
    testTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
