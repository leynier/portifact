// Shared StrykerJS settings for the critical packages (bun run test:mutation).
// Each package's stryker.config.mjs adds what it mutates and its break threshold,
// which is set from the measured score recorded in docs/testing.md.
/** @param {{ mutate: string[], break: number | null, concurrency?: number }} options */
export function strykerConfig({ mutate, break: breakAt, concurrency = 2 }) {
  return {
    $schema: "../../node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    packageManager: "npm",
    testRunner: "vitest",
    plugins: ["@stryker-mutator/vitest-runner"],
    // Runs each mutant only against the tests that cover it.
    coverageAnalysis: "perTest",
    mutate,
    reporters: ["clear-text", "progress", "html", "json"],
    htmlReporter: { fileName: "reports/mutation/index.html" },
    jsonReporter: { fileName: "reports/mutation/mutation.json" },
    clearTextReporter: { allowEmojis: false, logTests: false, reportScoreTable: true },
    thresholds: { high: 90, low: 80, break: breakAt },
    // A mutant that loops forever is a timeout (counted as detected); keep the wait short.
    // Heavy property tests run a few times slower under instrumentation, hence the factor.
    timeoutMS: 15_000,
    timeoutFactor: 3,
    // A mutant can also loop while allocating. The test:mutation scripts cap every Node
    // process's heap through NODE_OPTIONS, which turns that into an out-of-memory crash Stryker
    // recovers from (it restarts the runner) instead of growing until the machine kills the
    // whole run. Worker threads ignore the cap, so tests run in forked processes.
    vitest: { pool: "forks" },
    // Two test runner processes keep memory bounded on shared machines and CI runners
    // (each Vitest worker holds the instrumented bundle). Raise it with --concurrency.
    concurrency,
    // Vitest keeps every reloaded module graph in a long-lived runner, so memory grows with
    // each mutant; restarting runners regularly keeps a run within a few GB.
    maxTestRunnerReuse: 25,
    // TypeScript 7 has no JS API, so Stryker's tsconfig rewrite crashes: point it at a file
    // that does not exist to skip it. Instead, every sandbox lives at the same depth as the
    // packages (<root>/.stryker-tmp/sandbox-*), so "extends": "../../tsconfig.base.json"
    // still resolves when Vite reads the package's tsconfig. Only the sandbox is deleted.
    tsconfigFile: "stryker-skip-tsconfig-rewrite.json",
    tempDirName: "../../.stryker-tmp",
    cleanTempDir: "always",
    // Reuses results for unchanged code and tests between local runs; the file is ignored by
    // git and CI starts from scratch. Pass --force to rerun every mutant.
    incremental: true,
    incrementalFile: "reports/mutation/stryker-incremental.json",
  };
}
