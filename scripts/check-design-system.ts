// Fails when UI code bypasses the design system. Runs as part of `bun run check`.
import { Glob } from "bun";
import { checkFile, isTokenSource } from "../packages/ui/src/design-check.ts";

const root = new URL("..", import.meta.url).pathname;
const patterns = ["apps/*/*.html", "apps/*/src/**/*", "packages/*/src/**/*"];
const extensions = /\.(css|ts|tsx|html)$/;
const ignored = /\.test\.tsx?$|\/node_modules\/|\/dist\//;

let files = 0;
const violations = [];
for (const pattern of patterns) {
  for await (const file of new Glob(pattern).scan(root)) {
    if (!extensions.test(file) || ignored.test(file) || isTokenSource(file)) continue;
    files += 1;
    violations.push(...checkFile(file, await Bun.file(`${root}${file}`).text()));
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.rule}  ${v.text}`);
  console.error(`\n${violations.length} design-system violation(s). See docs/design.md.`);
  process.exit(1);
}
console.log(`design system ok: ${files} files`);
