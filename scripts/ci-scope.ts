// Decides which CI jobs a change needs, from the files it touches. CI runs ci-scope-main.ts
// with the base and head commits, which writes the result to GITHUB_OUTPUT; anything it cannot classify runs
// everything, so a mistake here costs minutes, never a skipped check that mattered.
import { execFileSync } from "node:child_process";

export interface Scope {
  /** Lint, typecheck, unit and Worker tests, bundle dry-runs. */
  quality: boolean;
  /** CLI binaries for every platform and the installer smoke tests. */
  cli: boolean;
}

export const FULL_SCOPE: Scope = { quality: true, cli: true };

/** Files that change how the CLI binary or its installers are built, shipped or tested. */
const CLI_FILES = [
  /^packages\/cli\//,
  /^scripts\/(?:build-cli|set-version)\.ts$/,
  /^scripts\/(?:install\.sh|install\.ps1|smoke-linux-distros\.sh)$/,
  /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig(?:\.base)?\.json)$/,
  /^\.github\/workflows\/(?:ci|release)\.yml$/,
];

/** Files no check reads. Everything else, including readme.md and skills/, needs quality. */
const INERT_FILES = [/^docs\//, /^license$/, /^\.github\/ISSUE_TEMPLATE\//];

/** Workspace packages the CLI depends on, from its package.json dependencies. */
export function cliWorkspaceDeps(cliPackageJson: string): string[] {
  const manifest = JSON.parse(cliPackageJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith("@portifact/"))
    .map((name) => name.slice("@portifact/".length));
}

export function scopeOf(files: readonly string[], cliDeps: readonly string[] = []): Scope {
  if (files.length === 0) return FULL_SCOPE;
  const cliPatterns = [
    ...CLI_FILES,
    ...cliDeps.map((dep) => new RegExp(`^packages/${escapeRegExp(dep)}/`)),
  ];
  return {
    quality: files.some((file) => !INERT_FILES.some((pattern) => pattern.test(file))),
    cli: files.some((file) => cliPatterns.some((pattern) => pattern.test(file))),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Files changed between two commits; undefined when the range cannot be computed. */
export function changedFiles(base: string, head: string): string[] | undefined {
  if (!base || /^0+$/.test(base)) return undefined;
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      encoding: "utf8",
    });
    return output.split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
}

export function formatOutput(scope: Scope): string {
  return `quality=${scope.quality}\ncli=${scope.cli}\n`;
}

export interface RunIo {
  readCliManifest(): string;
  log(line: string): void;
  writeOutput?: ((text: string) => void) | undefined;
}

/** Entry logic for `bun scripts/ci-scope-main.ts <base> <head> [full]`. Returns the scope. */
export function run(args: readonly string[], io: RunIo): Scope {
  const [base = "", head = "HEAD", mode = ""] = args;
  const files = mode === "full" ? undefined : changedFiles(base, head);
  const scope = files ? scopeOf(files, cliWorkspaceDeps(io.readCliManifest())) : FULL_SCOPE;
  io.log(files ? `${files.length} changed file(s)` : "running everything");
  io.log(formatOutput(scope).trimEnd());
  io.writeOutput?.(formatOutput(scope));
  return scope;
}
