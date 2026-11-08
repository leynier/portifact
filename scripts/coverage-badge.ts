// Aggregates line coverage from every package's coverage-summary.json and prints a
// shields.io endpoint document for the README badge. Used by CI on pushes to develop.
//
//   bun scripts/coverage-badge.ts > coverage.json
import { Glob } from "bun";

interface Summary {
  total: { lines: { total: number; covered: number } };
}

const root = new URL("..", import.meta.url).pathname;
let total = 0;
let covered = 0;
let files = 0;

for await (const path of new Glob("{apps,packages}/*/coverage/coverage-summary.json").scan(root)) {
  const summary = (await Bun.file(`${root}${path}`).json()) as Summary;
  total += summary.total.lines.total;
  covered += summary.total.lines.covered;
  files += 1;
}

if (files === 0 || total === 0) {
  console.error("No coverage summaries found. Run `bun run test` first.");
  process.exit(1);
}

const percent = Math.floor((covered / total) * 1000) / 10;
// Conventional coverage badge colors, so the badge reads like any other project's.
const color =
  percent >= 95
    ? "brightgreen"
    : percent >= 90
      ? "green"
      : percent >= 80
        ? "yellowgreen"
        : percent >= 70
          ? "yellow"
          : percent >= 60
            ? "orange"
            : "red";
console.log(JSON.stringify({ schemaVersion: 1, label: "coverage", message: `${percent}%`, color }));
