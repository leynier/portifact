// Runs the contributor license agreement check in the `cla` workflow:
// bun scripts/cla-main.ts <dir>
// <dir> holds what the workflow read from GitHub: pull-request.json, commits.jsonl,
// comments.jsonl, files.jsonl, head-signers.md and head-cla.md (a file that does not exist means it is missing
// at the head). The base signers file and agreement are cla-signers.md and cla.md of the checkout. The evidence the
// maintainer archives is written to <dir>/evidence.json. The workflow runs this from the base
// branch, so a pull request cannot change the check it is judged by.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGREEMENT_FILE,
  checkCla,
  parseComments,
  parseCommits,
  parseFiles,
  parseSnapshot,
  SIGNERS_FILE,
} from "./cla.ts";

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error("usage: cla-main.ts <directory read from GitHub>");
  process.exit(2);
}
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
const { author, snapshot } = parseSnapshot(readFileSync(join(dir, "pull-request.json"), "utf8"));

const { problems, required, evidence } = checkCla({
  author,
  snapshot,
  commits: parseCommits(readFileSync(join(dir, "commits.jsonl"), "utf8")),
  comments: parseComments(readFileSync(join(dir, "comments.jsonl"), "utf8")),
  changedFiles: parseFiles(readFileSync(join(dir, "files.jsonl"), "utf8")),
  baseSigners: read(SIGNERS_FILE),
  headSigners: read(join(dir, "head-signers.md")),
  baseAgreement: read(AGREEMENT_FILE),
  headAgreement: read(join(dir, "head-cla.md")),
});
writeFileSync(join(dir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(
  required.length === 0
    ? "Only exempt accounts authored this pull request; the signers file is intact."
    : `Signed and submitted by ${required.map((a) => `@${a.login} (${a.id})`).join(", ")}.`,
);
