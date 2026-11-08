// Private sources from real git repositories, plain folders, files and ZIP files.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "./errors.ts";
import { gitRunner, originOf, repositoryOf, resolveCommit } from "./git.ts";
import { discardManifest } from "./manifest.ts";
import { buildSourceManifest, type SourceManifest } from "./sources.ts";
import { buildZip } from "./testing/zip-writer.ts";

let folder: string;
const built: SourceManifest[] = [];

beforeAll(() => {
  // The developer's own git configuration (global ignores, hooks) must not leak into the tests.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "portifact-sources-"));
});

afterEach(async () => {
  for (const manifest of built.splice(0)) await discardManifest(manifest);
  await rm(folder, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A repository with one commit on main and an origin remote with a token in its URL. */
async function repository(files: Record<string, string>): Promise<string> {
  const root = join(folder, "repo");
  await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  await write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  git(root, "remote", "add", "origin", "https://x-access-token:ghs_secret@github.com/o/r.git");
  return root;
}

async function sources(path: string, ref?: string, binary?: string) {
  const manifest = await buildSourceManifest(path, {
    ref,
    git: binary ? gitRunner(binary) : undefined,
  });
  built.push(manifest);
  return manifest;
}

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const paths = (manifest: SourceManifest) => manifest.files.map((file) => file.path);

describe("sources in a git repository", () => {
  it("attaches versioned and new unignored files, never secrets, with the origin", async () => {
    const root = await repository({
      ".gitignore": "dist/\n*.log\n",
      "src/app.ts": "export const a = 1;",
      "node_modules/kept/index.js": "committed on purpose",
      "config/.env": "TOKEN=committed-by-mistake",
    });
    await write(root, {
      "src/new.ts": "export const b = 2;",
      "dist/bundle.js": "built",
      "debug.log": "noise",
    });
    const head = git(root, "rev-parse", "HEAD");

    const manifest = await sources(root);
    expect(manifest.chosenBy).toBe("git");
    // Git chose the files: committed node_modules stay, ignored build output does not.
    expect(paths(manifest)).toEqual([
      ".gitignore",
      "node_modules/kept/index.js",
      "src/app.ts",
      "src/new.ts",
    ]);
    expect(manifest.excluded).toEqual([{ path: "config/.env", reason: "secret" }]);
    expect(manifest.origin).toEqual({
      commit: head,
      branch: "main",
      // The token in the remote URL is never attached.
      remote: "https://github.com/o/r.git",
      dirty: true,
    });
  });

  it("is clean when nothing changed, and uses the branch's own remote", async () => {
    const root = await repository({ "a.txt": "a" });
    git(root, "remote", "add", "upstream", "git@example.test:team/r.git");
    git(root, "config", "branch.main.remote", "upstream");
    const manifest = await sources(root);
    expect(manifest.origin).toMatchObject({ remote: "git@example.test:team/r.git", dirty: false });
  });

  it("attaches only the folder's subtree, relative to it", async () => {
    const root = await repository({
      "web/src/index.ts": "x",
      "web/readme.md": "r",
      "api/x.ts": "y",
    });
    const manifest = await sources(join(root, "web"));
    expect(paths(manifest)).toEqual(["readme.md", "src/index.ts"]);
    expect(manifest.origin?.dirty).toBe(false);
  });

  it("leaves out submodules and nested repositories, skips deleted files and flags LFS pointers", async () => {
    const root = await repository({ "a.txt": "a", "gone.txt": "bye" });
    const sha = git(root, "rev-parse", "HEAD");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},vendor/lib`);
    const nested = join(root, "nested");
    await mkdir(nested);
    git(nested, "init", "-q");
    await write(nested, { "inner.txt": "inner" });
    await rm(join(root, "gone.txt"));
    await write(root, {
      "big.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123456789\n",
    });

    const manifest = await sources(root);
    expect(paths(manifest)).toEqual(["a.txt", "big.bin"]);
    expect(manifest.excluded).toEqual([
      { path: "nested", reason: "submodule" },
      { path: "vendor/lib", reason: "submodule" },
    ]);
    expect(manifest.lfsPointers).toEqual(["big.bin"]);
  });

  it("refuses a versioned symbolic link", async () => {
    const root = await repository({ "a.txt": "a" });
    await symlink("/etc/passwd", join(root, "link"));
    git(root, "add", "link");
    expect((await refusal(sources(root))).message).toMatch(/symbolic link/);
  });

  it("reports a repository without commits, on no branch remote", async () => {
    const root = join(folder, "empty");
    await mkdir(root);
    git(root, "init", "-q", "-b", "main");
    await write(root, { "draft.md": "# Draft" });
    const manifest = await sources(root);
    expect(paths(manifest)).toEqual(["draft.md"]);
    expect(manifest.origin).toEqual({ commit: null, branch: "main", remote: null, dirty: true });
  });
});

describe("sources at a ref", () => {
  it("attaches exactly the commit's tree, whatever the work tree holds", async () => {
    const root = await repository({ "src/app.ts": "v1", "keys/deploy.pem": "-----BEGIN" });
    const first = git(root, "rev-parse", "HEAD");
    git(root, "branch", "release");
    await write(root, { "src/app.ts": "v2", "src/later.ts": "later" });
    git(root, "commit", "-qam", "second");
    await write(root, { "src/app.ts": "uncommitted", "untracked.txt": "u" });

    const manifest = await sources(root, "release");
    expect(manifest.chosenBy).toBe("git");
    expect(paths(manifest)).toEqual(["src/app.ts"]);
    expect(manifest.excluded).toEqual([{ path: "keys/deploy.pem", reason: "secret" }]);
    const app = manifest.files[0];
    expect(await readFile(app?.source as string, "utf8")).toBe("v1");
    expect(manifest.origin).toEqual({
      commit: first,
      branch: "release",
      remote: "https://github.com/o/r.git",
      dirty: false,
    });

    const detached = await sources(root, first);
    expect(detached.origin?.branch).toBeNull();
    const head = await sources(root, "HEAD");
    expect(head.origin?.branch).toBe("main");
  });

  it("archives only the folder's subtree at the ref", async () => {
    const root = await repository({ "web/index.ts": "w", "api/x.ts": "a" });
    const manifest = await sources(join(root, "web"), "HEAD");
    expect(paths(manifest)).toEqual(["index.ts"]);
  });

  it("refuses refs that name no commit, look like options, or lack the folder", async () => {
    const root = await repository({ "a.txt": "a" });
    expect((await refusal(sources(root, "no-such-branch"))).message).toMatch(
      /does not name a commit/,
    );
    expect((await refusal(sources(root, "--output=/tmp/x"))).message).toMatch(
      /does not name a commit/,
    );
    await mkdir(join(root, "fresh"));
    await write(root, { "fresh/new.txt": "n" });
    expect((await refusal(sources(join(root, "fresh"), "HEAD"))).message).toMatch(
      /does not exist in HEAD/,
    );
  });

  it("needs a git repository", async () => {
    await write(folder, { "plain/a.txt": "a" });
    expect((await refusal(sources(join(folder, "plain"), "HEAD"))).message).toMatch(/--ref needs/);
    expect((await refusal(sources(join(folder, "plain/a.txt"), "HEAD"))).message).toMatch(
      /--ref needs/,
    );
  });
});

describe("sources without git", () => {
  it("walks a folder with the default exclusions when git is not installed", async () => {
    const root = await repository({ "a.txt": "a", "node_modules/x.js": "x", ".env": "S=1" });
    const manifest = await sources(root, undefined, join(folder, "no-such-git"));
    expect(manifest.chosenBy).toBe("folder");
    expect(manifest.origin).toBeUndefined();
    expect(paths(manifest)).toEqual(["a.txt"]);
    expect(manifest.excluded.map((entry) => entry.path)).toEqual([".env", ".git", "node_modules"]);
  });

  it("attaches a single file, refusing secret files", async () => {
    await write(folder, { "notes.txt": "n", id_rsa: "key" });
    const single = await sources(join(folder, "notes.txt"));
    expect(paths(single)).toEqual(["notes.txt"]);
    expect((await refusal(sources(join(folder, "id_rsa")))).message).toMatch(/secrets/);
  });

  it("expands a ZIP file of sources without its shared folder", async () => {
    const zip = join(folder, "project.zip");
    await writeFile(
      zip,
      buildZip([
        { name: "project/src/main.ts", data: "main" },
        { name: "project/.env", data: "S=1" },
      ]),
    );
    const manifest = await sources(zip);
    expect(paths(manifest)).toEqual(["src/main.ts"]);
    expect(manifest.excluded).toEqual([{ path: "project/.env", reason: "secret" }]);
    expect(manifest.temporary).toBeDefined();
  });

  it("refuses empty sources, links and missing paths", async () => {
    await write(folder, { "only/.env": "S=1" });
    expect((await refusal(sources(join(folder, "only")))).message).toMatch(/no source files/);
    await symlink(join(folder, "only"), join(folder, "link"));
    expect((await refusal(sources(join(folder, "link")))).message).toMatch(/symbolic link/);
    expect((await refusal(sources(join(folder, "missing")))).message).toMatch(/does not exist/);
  });
});

describe("git helpers", () => {
  it("treat a folder outside any repository as plain", async () => {
    expect(await repositoryOf(gitRunner(), folder)).toBeUndefined();
    expect(await repositoryOf(gitRunner(join(folder, "missing-git")), folder)).toBeUndefined();
  });

  it("refuse an empty ref and fall back when the remote URL cannot be parsed", async () => {
    const root = await repository({ "a.txt": "a" });
    expect(await resolveCommit(gitRunner(), root, "")).toBeUndefined();
    git(root, "remote", "set-url", "origin", "https://[broken/r.git");
    expect((await originOf(gitRunner(), root)).remote).toBeNull();
  });
});
