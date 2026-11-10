// Regenerates the third-party notices from the installed packages: `third-party-notices.md` at
// the repository root (served at portifact.com/third-party-notices) and the CLI's embedded copy.
// `--check` fails when either is stale or a shipped package has a license that is not known to be
// compatible with AGPL-3.0, or not permissive enough for the commercial license without a reviewed
// exception (COMMERCIAL_EXCEPTIONS); `bun run check` runs it.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Component,
  collectPackages,
  licenseProblems,
  type PackageFs,
  renderCliModule,
  renderMarkdown,
  renderPlainText,
} from "./notices.ts";

const repoRoot = join(import.meta.dirname, "..");

export const COMPONENTS: Component[] = [
  { id: "workers", title: "Workers", roots: ["apps/app", "apps/content", "apps/jobs"] },
  // Vite injects its module preload helper and Tailwind generates the stylesheet's base layer.
  { id: "web", title: "Web pages", roots: ["apps/web"], extras: ["tailwindcss", "vite"] },
  { id: "cli", title: "CLI", roots: ["packages/cli"] },
];

const RUNTIME_NOTICES = [
  {
    component: "cli",
    text: "The CLI binary is compiled with Bun and embeds the Bun runtime, which is MIT licensed and statically links third-party libraries under their own licenses, including JavaScriptCore and WebKit (LGPL-2.0) and tinycc (LGPL-2.1). Bun's license and the full list: https://bun.com/docs/project/licensing. Portifact's complete source and its build script (`bun run build:cli`) are public at https://github.com/leynier/portifact, so the binary can be rebuilt against a modified runtime.",
  },
];

const OUTPUTS = {
  markdown: join(repoRoot, "third-party-notices.md"),
  cli: join(repoRoot, "packages/cli/src/third-party-notices.ts"),
};

const fs: PackageFs = {
  read: (path) =>
    existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined,
  list: (path) => (existsSync(path) ? readdirSync(path) : []),
  realpath: (path) => (existsSync(path) ? realpathSync(path) : undefined),
};

const packages = collectPackages(fs, repoRoot, COMPONENTS);
const expected = {
  markdown: renderMarkdown(packages, { components: COMPONENTS, runtimeNotices: RUNTIME_NOTICES }),
  cli: renderCliModule(renderPlainText(packages, "cli", RUNTIME_NOTICES)),
};

const problems = licenseProblems(packages);
if (process.argv.includes("--check")) {
  for (const [key, path] of Object.entries(OUTPUTS) as [keyof typeof OUTPUTS, string][]) {
    if (fs.read(path) !== expected[key]) {
      problems.push(`${path.slice(repoRoot.length + 1)} is stale: run \`bun run notices\``);
    }
  }
} else {
  for (const [key, path] of Object.entries(OUTPUTS) as [keyof typeof OUTPUTS, string][]) {
    writeFileSync(path, expected[key]);
  }
  console.log(`Wrote the notices of ${packages.length} packages.`);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
