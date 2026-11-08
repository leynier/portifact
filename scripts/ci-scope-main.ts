// `bun scripts/ci-scope-main.ts <base> <head> [full]`: wires ci-scope.ts to the process.
import { appendFileSync, readFileSync } from "node:fs";
import { run } from "./ci-scope.ts";

const outputFile = process.env.GITHUB_OUTPUT;
run(process.argv.slice(2), {
  readCliManifest: () => readFileSync("packages/cli/package.json", "utf8"),
  log: (line) => console.log(line),
  writeOutput: outputFile ? (text) => appendFileSync(outputFile, text) : undefined,
});
