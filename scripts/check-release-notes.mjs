// Renders sample release notes with the same plugins and preset the release workflow uses,
// so an incompatible changelog preset fails in pull request CI instead of during a release.
// Runs on Node, like semantic-release in the release workflow.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL(".releaserc.json", root), "utf8"));
const notesPlugin = config.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/release-notes-generator",
);
if (!notesPlugin) throw new Error("release-notes-generator is not configured in .releaserc.json");

const requireFromSemanticRelease = createRequire(
  createRequire(new URL("package.json", root)).resolve("semantic-release/package.json"),
);
const { generateNotes } = await import(
  requireFromSemanticRelease.resolve("@semantic-release/release-notes-generator")
);

const notes = await generateNotes(notesPlugin[1], {
  cwd: new URL(".", root).pathname,
  options: { repositoryUrl: config.repositoryUrl },
  lastRelease: { gitTag: "v0.1.0", version: "0.1.0" },
  nextRelease: { gitTag: "v0.2.0", version: "0.2.0" },
  commits: [
    {
      hash: "0000000",
      message: "feat(cli): sample feature",
      committerDate: new Date().toISOString(),
    },
    { hash: "1111111", message: "fix: sample fix", committerDate: new Date().toISOString() },
  ],
  logger: { log() {}, error: console.error },
});

for (const expected of ["### Features", "sample feature", "### Bug Fixes", "sample fix"]) {
  if (!notes.includes(expected)) {
    console.error(notes);
    throw new Error(`Release notes are missing "${expected}"`);
  }
}
console.log("release notes ok");
