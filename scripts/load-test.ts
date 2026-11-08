// Load and concurrency test (bun run test:load; docs/testing.md, "Load and concurrency").
// Runs on Node 24, because wrangler starts the local Worker. By default it targets the e2e Worker
// with local D1 and R2; --app-url targets a remote deployment such as staging, never production
// without --i-know-this-is-production.
import { closeAgents } from "./load/http.ts";
import { parseOptions, USAGE } from "./load/options.ts";
import { runScenario, type ScenarioResult } from "./load/scenarios.ts";
import { remoteTarget, type Target } from "./load/target.ts";

function print(results: ScenarioResult[]): void {
  for (const result of results) {
    console.log(`\n${result.ok ? "PASS" : "FAIL"} ${result.scenario}`);
    for (const [name, value] of Object.entries(result.metrics)) {
      if (value === undefined) continue;
      console.log(`  ${name}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
    for (const expectation of result.expectations) {
      console.log(`  ${expectation.ok ? "ok  " : "FAIL"} ${expectation.label}`);
    }
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseOptions(args);
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  let target: Target;
  if (options.target.kind === "remote") {
    target = remoteTarget(options.target.appOrigin, options.target.contentDomain);
  } else {
    console.error("Starting the local e2e Worker (local D1 and R2)...");
    const { startLocalTarget } = await import("../e2e/load/local.ts");
    target = await startLocalTarget();
  }
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of options.scenarios) {
      console.error(`Running ${scenario}...`);
      results.push(await runScenario(scenario, target, options));
    }
  } finally {
    await target.close();
    closeAgents();
  }
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else print(results);
  return results.every((result) => result.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
