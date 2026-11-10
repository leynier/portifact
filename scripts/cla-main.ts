// Runs the contributor license agreement check in the `cla` workflow:
// bun scripts/cla-main.ts <author> <commits.jsonl> <base signers file> <head signers file>
// A signers path that does not exist means the file is missing on that side. The workflow runs
// this from the base branch, so a pull request cannot change the check it is judged by.
import { existsSync, readFileSync } from "node:fs";
import { checkCla, parseCommits } from "./cla.ts";

const [author, commitsPath, basePath, headPath] = process.argv.slice(2);
if (!author || !commitsPath || !basePath || !headPath) {
  console.error("usage: cla-main.ts <author> <commits.jsonl> <base signers> <head signers>");
  process.exit(2);
}
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const { problems, required } = checkCla({
  author,
  commits: parseCommits(readFileSync(commitsPath, "utf8")),
  baseSigners: read(basePath),
  headSigners: read(headPath),
});
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(
  required.length === 0
    ? "Only exempt accounts authored this pull request."
    : `Signed by ${required.map((login) => `@${login}`).join(", ")}.`,
);
