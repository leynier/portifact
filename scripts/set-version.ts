// Sets the product version in the CLI manifest and refreshes the lockfile.
// Used by the release workflow; do not edit versions by hand.
import { $ } from "bun";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MANIFEST = new URL("../packages/cli/package.json", import.meta.url);

const next = process.argv[2];
if (!next || !SEMVER.test(next)) {
  console.error(`Usage: bun scripts/set-version.ts <semver>. Received: ${next ?? "nothing"}`);
  process.exit(1);
}

const manifest = await Bun.file(MANIFEST).json();
manifest.version = next;
await Bun.write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
await $`bun install`.quiet();

console.log(`Version set to ${next}`);
