// Reads a git repository for `publish --source` (plan section 6, "Fuentes desde git"): which files
// git would version, the tree of a commit, and the origin to attach to the version. git runs as a
// child process with arguments, never through a shell, with the filesystem monitor off and no
// prompts. Without the git binary, or outside a repository, callers treat the folder as plain.

import { spawn } from "node:child_process";
import type { SourceOrigin } from "@portifact/contracts";
import { stripRemoteCredentials } from "@portifact/domain";
import { childEnvironment } from "./child-env.ts";

export interface GitResult {
  code: number;
  stdout: Buffer;
}

export interface GitCallOptions {
  /** Bytes written to git's standard input. */
  input?: Buffer | undefined;
  /** Extra environment variables, such as the author of a commit or a separate index file. */
  env?: Readonly<Record<string, string>> | undefined;
}

/** Runs git with `args` in `cwd`; rejects only when git cannot start (for example, not installed). */
export type Git = (
  args: readonly string[],
  cwd: string,
  options?: GitCallOptions,
) => Promise<GitResult>;

/** Settings that keep git from running repository-configured programs or asking for input. */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off"];

export function gitRunner(binary = "git"): Git {
  return (args, cwd, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, ["--no-pager", ...SAFE_CONFIG, ...args], {
        cwd,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        env: {
          ...childEnvironment(process.env),
          ...options.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
        },
      });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) }));
      if (child.stdin) {
        // git may exit before reading everything (a refused command); its exit code reports it.
        child.stdin.on("error", () => {});
        child.stdin.end(options.input);
      }
    });
}

export interface Repository {
  /** The root of the work tree. */
  top: string;
  /** The folder's path inside the repository, with a trailing slash; empty at the root. */
  prefix: string;
}

/** The repository a folder belongs to, or undefined without git or outside a work tree. */
export async function repositoryOf(git: Git, folder: string): Promise<Repository | undefined> {
  let result: GitResult;
  try {
    result = await git(
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix"],
      folder,
    );
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const [inside, top = "", prefix = ""] = result.stdout.toString("utf8").split("\n");
  if (inside !== "true" || top === "") return undefined;
  return { top, prefix };
}

export interface TrackedFiles {
  /** Paths relative to the folder: versioned files and new files git does not ignore. */
  files: string[];
  /** Submodules and nested repositories, left out. */
  submodules: string[];
}

/** `git ls-files --cached --others --exclude-standard`, without submodules. */
export async function trackedFiles(git: Git, folder: string): Promise<TrackedFiles> {
  const staged = await run(git, ["ls-files", "-z", "--stage"], folder);
  const submodules = new Set<string>();
  for (const line of split(staged)) {
    const tab = line.indexOf("\t");
    if (line.startsWith("160000 ") && tab > 0) submodules.add(line.slice(tab + 1));
  }
  const listed = await run(
    git,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    folder,
  );
  const files = new Set<string>();
  for (const path of split(listed)) {
    // An untracked nested repository is listed as its folder, with a trailing slash.
    if (path.endsWith("/")) submodules.add(path.slice(0, -1));
    else if (!submodules.has(path)) files.add(path);
  }
  return { files: [...files].sort(byCodePoint), submodules: [...submodules].sort(byCodePoint) };
}

/** The commit `ref` names, or undefined when it names none. Refs starting with `-` are refused. */
export async function resolveCommit(
  git: Git,
  folder: string,
  ref: string,
): Promise<string | undefined> {
  if (ref.startsWith("-") || ref.length === 0) return undefined;
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], folder);
  const commit = result.stdout.toString("utf8").trim();
  return result.code === 0 && commit ? commit : undefined;
}

/**
 * Writes the tree of `commit` under the folder (exactly that tree, nothing from the work tree)
 * as a ZIP file. Resolves false when the folder does not exist in that commit.
 */
export async function archiveTree(
  git: Git,
  repository: Repository,
  commit: string,
  output: string,
): Promise<boolean> {
  // From a subfolder git archive keeps only that subfolder of the tree, so it runs at the root.
  const tree = `${commit}:${repository.prefix}`;
  const result = await git(["archive", "--format=zip", "-o", output, tree], repository.top);
  return result.code === 0;
}

/**
 * The origin to attach to the version: the commit, the branch, the branch's remote (or origin)
 * without credentials, and whether the folder had uncommitted changes. With `commit`, the files
 * came from that commit, so they are clean by definition.
 */
export async function originOf(
  git: Git,
  folder: string,
  pinned?: { ref: string; commit: string },
): Promise<SourceOrigin> {
  const commit =
    pinned?.commit ?? (await optional(git, ["rev-parse", "--verify", "--quiet", "HEAD"], folder));
  let branch: string | undefined;
  if (pinned) {
    const full = await optional(git, ["rev-parse", "--symbolic-full-name", pinned.ref], folder);
    branch = full?.startsWith("refs/heads/") ? full.slice("refs/heads/".length) : undefined;
  } else {
    branch = await optional(git, ["symbolic-ref", "--quiet", "--short", "HEAD"], folder);
  }
  const remoteName =
    (branch && (await optional(git, ["config", "--get", `branch.${branch}.remote`], folder))) ||
    "origin";
  const remoteUrl = await optional(git, ["config", "--get", `remote.${remoteName}.url`], folder);
  const remote = remoteUrl === undefined ? null : stripRemoteCredentials(remoteUrl);
  let dirty = false;
  if (!pinned) {
    const status = await git(
      [
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all",
        "--",
        ".",
      ],
      folder,
    );
    dirty = status.code !== 0 || status.stdout.length > 0;
  }
  return {
    commit: commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? commit : null,
    branch: branch && branch.length <= 255 ? branch : null,
    remote: remote && remote.length <= 2_048 ? remote : null,
    dirty,
  };
}

async function run(git: Git, args: string[], folder: string): Promise<Buffer> {
  const result = await git(args, folder);
  return result.code === 0 ? result.stdout : Buffer.alloc(0);
}

/** Trimmed output of a command that may fail; undefined when it fails or prints nothing. */
async function optional(git: Git, args: string[], folder: string): Promise<string | undefined> {
  const result = await git(args, folder);
  const text = result.stdout.toString("utf8").trim();
  return result.code === 0 && text.length > 0 ? text : undefined;
}

function split(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
