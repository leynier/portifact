import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gitRunner } from "./git.ts";
import { trailerVersion } from "./history.ts";
import type { FakeArtifact } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeAll(() => {
  // The developer's git configuration must not change what the tests see.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const HOUR = 3_600_000;
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function json(output: { stdout: string }) {
  return JSON.parse(output.stdout);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

function expectNoTokens(output: { stdout: string; stderr: string }) {
  for (const token of server.issuedTokens) {
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
  }
}

/**
 * Three versions an hour apart: sources with an origin, no sources, then sources that changed one
 * file, keep another (same bytes, so one download) and had uncommitted changes.
 */
function history(): { artifact: FakeArtifact; dates: string[] } {
  const artifact = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
  const v1 = server.api.seedVersion(
    artifact,
    { published: { "index.md": "# One" }, source: { "a.txt": "a1", "src/b.txt": "shared" } },
    { sourceOrigin: { commit: COMMIT_A, branch: "main", remote: null, dirty: false } },
  );
  h.advance(HOUR);
  const v2 = server.api.seedVersion(artifact, { published: { "index.md": "# Two" } });
  h.advance(HOUR);
  const v3 = server.api.seedVersion(
    artifact,
    { published: { "index.md": "# Three" }, source: { "a.txt": "a3", "src/b.txt": "shared" } },
    { sourceOrigin: { commit: COMMIT_B, branch: "main", remote: null, dirty: true } },
  );
  const dates = [v1, v2, v3].map((v) => new Date(v.committedAt).toISOString().slice(0, 19));
  return { artifact, dates };
}

const pullGit = (id: string, out: string, ...extra: string[]) =>
  h.invoke("pull", id, "--source", "--git", "--out", out, ...extra);

describe("portifact pull --source --git", () => {
  it("builds one commit and tag per version, oldest first, with dates, author and trailers", async () => {
    h.signIn();
    const { artifact, dates } = history();
    const out = join(h.workspace, "history");

    const result = await pullGit(artifact.id, out, "--json");

    expect(result.code, result.stderr).toBe(0);
    const log = git(
      out,
      "log",
      "--reverse",
      "--format=%H|%an|%ae|%cn|%ad|%cd|%s",
      "--date=format:%Y-%m-%dT%H:%M:%S",
    )
      .split("\n")
      .map((line) => line.split("|"));
    expect(log).toHaveLength(3);
    log.forEach(([, author, email, committer, authored, committedAt, subject], index) => {
      expect(author).toBe("user-123");
      expect(email).toBe("");
      expect(committer).toBe("user-123");
      expect(authored).toBe(dates[index]);
      expect(committedAt).toBe(dates[index]);
      expect(subject).toBe(`Version ${index + 1}`);
    });
    const commits = log.map(([commit]) => commit);
    for (const [index, commit] of commits.entries()) {
      expect(git(out, "rev-parse", `v${index + 1}^{commit}`)).toBe(commit);
    }
    expect(
      ["v1", "v2", "v3"].map((tag) => git(out, "log", "-1", "--format=%(trailers:only)", tag)),
    ).toEqual([
      `Portifact-Version: 1\nSource-Commit: ${COMMIT_A}`,
      "Portifact-Version: 2",
      `Portifact-Version: 3\nSource-Commit: ${COMMIT_B}`,
    ]);

    // Version 2 has no sources: an empty commit that says so.
    expect(git(out, "rev-parse", "v2^{tree}")).toBe(git(out, "rev-parse", "v1^{tree}"));
    expect(git(out, "log", "-1", "--format=%b", "v2")).toContain(
      "Version 2 has no private sources, so this commit is empty.",
    );
    expect(git(out, "log", "-1", "--format=%b", "v3")).toContain("changes that were not committed");
    expect(git(out, "show", "v1:a.txt")).toBe("a1");
    expect(git(out, "ls-tree", "-r", "--name-only", "v3").split("\n")).toEqual([
      "a.txt",
      "src/b.txt",
    ]);

    // The work tree is the newest version, on main, with nothing to commit.
    expect(await readFile(join(out, "a.txt"), "utf8")).toBe("a3");
    expect(await readFile(join(out, "src", "b.txt"), "utf8")).toBe("shared");
    expect(git(out, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(out, "status", "--porcelain")).toBe("");
    expect(git(out, "config", "--get", "portifact.artifact")).toBe(artifact.id);

    // Three distinct blobs, each downloaded once.
    expect(server.api.gets).toHaveLength(3);
    expect(server.api.gets.every((get) => get.headers.authorization === undefined)).toBe(true);
    expect(json(result)).toEqual({
      artifactId: artifact.id,
      out,
      branch: "main",
      head: commits[2],
      versions: [
        {
          number: 1,
          versionId: expect.any(String),
          commit: commits[0],
          tag: "v1",
          sources: "attached",
          sourceCommit: COMMIT_A,
          files: 2,
        },
        {
          number: 2,
          versionId: expect.any(String),
          commit: commits[1],
          tag: "v2",
          sources: "none",
          sourceCommit: null,
          files: 0,
        },
        {
          number: 3,
          versionId: expect.any(String),
          commit: commits[2],
          tag: "v3",
          sources: "attached",
          sourceCommit: COMMIT_B,
          files: 2,
        },
      ],
    });
    expect(result.stderr).toContain("Downloaded 3 of 3.");
    expectNoTokens(result);
  });

  it("is reproducible: the same versions give the same commits", async () => {
    h.signIn();
    const { artifact } = history();

    await pullGit(artifact.id, join(h.workspace, "one"));
    await pullGit(artifact.id, join(h.workspace, "two"));

    expect(git(join(h.workspace, "one"), "rev-parse", "HEAD")).toBe(
      git(join(h.workspace, "two"), "rev-parse", "HEAD"),
    );
  });

  it("adds only the new versions on the next run, then says it is up to date", async () => {
    h.signIn();
    const { artifact } = history();
    const out = join(h.workspace, "history");
    expect((await pullGit(artifact.id, out)).code).toBe(0);
    const before = git(out, "rev-parse", "HEAD");
    const gets = server.api.gets.length;
    h.advance(HOUR);
    server.api.seedVersion(artifact, {
      published: { "index.md": "# Four" },
      source: { "a.txt": "a4", "src/b.txt": "shared", "new.txt": "new" },
    });

    const second = await pullGit(artifact.id, out);

    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe(
      `Added 1 version of ${artifact.id} to the Git history in ${out}: v4, one commit and tag each.\n`,
    );
    expect(git(out, "rev-parse", "HEAD^")).toBe(before);
    expect(git(out, "rev-parse", "v4^{commit}")).toBe(git(out, "rev-parse", "HEAD"));
    expect(git(out, "rev-list", "--count", "HEAD")).toBe("4");
    expect(await readFile(join(out, "new.txt"), "utf8")).toBe("new");
    expect(git(out, "status", "--porcelain")).toBe("");
    // Only the version's new blobs: a4 and new.txt (shared is downloaded again for this run).
    expect(server.api.gets.length - gets).toBe(3);

    const third = await pullGit(artifact.id, out, "--json");
    expect(third.code).toBe(0);
    expect(json(third)).toMatchObject({ head: git(out, "rev-parse", "HEAD"), versions: [] });
    const text = await pullGit(artifact.id, out);
    expect(text.stdout).toBe(
      `The Git history in ${out} is already up to date with version 4 of ${artifact.id}.\n`,
    );
  });

  it("removes files a newer version no longer has", async () => {
    h.signIn();
    const artifact = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(artifact, {
      published: { "index.md": "# One" },
      source: { "old.txt": "old", "keep.txt": "keep" },
    });
    server.api.seedVersion(artifact, {
      published: { "index.md": "# Two" },
      source: { "keep.txt": "keep" },
    });
    const out = join(h.workspace, "history");

    expect((await pullGit(artifact.id, out)).code).toBe(0);

    await expect(lstat(join(out, "old.txt"))).rejects.toThrow();
    expect(git(out, "show", "v1:old.txt")).toBe("old");
  });

  it("says in an empty commit when a listed version's sources are no longer retained", async () => {
    h.signIn();
    const { artifact } = history();
    server.faults.push({
      method: "GET",
      path: /\/versions\/[^/]+\/download$/,
      reply: {
        status: 404,
        body: { error: { code: "not_found", message: "This version is no longer retained." } },
      },
    });
    const out = join(h.workspace, "history");

    const result = await pullGit(artifact.id, out);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Sources no longer retained, so the commit is empty: v1.");
    expect(result.stdout).toContain("Without private sources, so the commit is empty: v2.");
    expect(git(out, "log", "-1", "--format=%b", "v1")).toContain("are no longer retained");
    expect(git(out, "ls-tree", "v1")).toBe("");
    expect(git(out, "ls-tree", "-r", "--name-only", "v3").split("\n")).toEqual([
      "a.txt",
      "src/b.txt",
    ]);
  });

  it("stops on bytes that do not match the manifest and removes the new folder", async () => {
    h.signIn();
    const { artifact } = history();
    server.faults.push({
      method: "GET",
      path: /^\/r2\/objects\//,
      reply: { status: 200, body: Buffer.from("a2") },
    });
    const out = join(h.workspace, "history");

    const result = await pullGit(artifact.id, out, "--json");

    expect(result.code).toBe(1);
    expect(json(result).error.code).toBe("download_failed");
    expect(json(result).error.message).toContain("did not match its size or SHA-256");
    expect(result.stderr).toContain(`Removed the partial download in ${out}.`);
    await expect(lstat(out)).rejects.toThrow();
  });

  it("refuses source paths with a .git segment before writing anything", async () => {
    h.signIn();
    for (const path of [
      ".git/hooks/post-commit",
      "src/.GIT/config",
      "x/git~1/HEAD",
      "../out.txt",
    ]) {
      const artifact = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(artifact, {
        published: { "index.md": "# One" },
        source: { "a.txt": "a", [path]: "evil" },
      });
      const out = join(h.workspace, `hostile-${artifact.id}`);

      const result = await pullGit(artifact.id, out, "--json");

      expect(result.code, path).toBe(1);
      expect(json(result).error.code, path).toBe("server_error");
      expect(json(result).error.message, path).toContain("cannot be written safely");
      await expect(lstat(out), path).rejects.toThrow();
    }
    expect(server.api.gets).toHaveLength(0);
  });

  it("explains that git is needed when it cannot run", async () => {
    const noGit = await createHarness({ server, git: gitRunner(join(h.workspace, "missing-git")) });
    try {
      noGit.signIn();
      const { artifact } = history();
      const out = join(noGit.workspace, "history");

      const result = await noGit.invoke(
        "pull",
        artifact.id,
        "--source",
        "--git",
        "--out",
        out,
        "--json",
      );

      expect(result.code).toBe(1);
      expect(json(result).error).toEqual({
        code: "git_failed",
        message:
          "pull --git needs Git, and the `git` command could not be run. Install Git and run the command again.",
      });
      await expect(lstat(out)).rejects.toThrow();
      expect(server.requests.filter((r) => r.path.includes("/versions"))).toHaveLength(0);
    } finally {
      await noGit.cleanup();
    }
  });

  it("refuses folders it did not make or that changed since the last pull", async () => {
    h.signIn();
    const { artifact } = history();
    const other = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(other, {
      published: { "index.md": "# Other" },
      source: { "o.txt": "o" },
    });
    const message = async (out: string, id = artifact.id) => {
      const result = await pullGit(id, out, "--json");
      expect(result.code, out).toBe(2);
      return json(result).error.message as string;
    };

    const plain = await h.files("plain", { "notes.txt": "mine" });
    expect(await message(plain)).toContain("is not a Git history made by");

    const repo = await h.files("repo", { "a.txt": "x" });
    git(repo, "init", "-q");
    expect(await message(repo)).toContain("is not a Git history made by");

    const out = join(h.workspace, "history");
    expect((await pullGit(artifact.id, out)).code).toBe(0);
    expect(await message(out, other.id)).toContain(`holds the Git history of ${artifact.id}`);

    const link = join(h.workspace, "link");
    await symlink(out, link);
    expect(await message(link)).toContain("is not a Git history made by");

    await writeFile(join(out, "a.txt"), "edited");
    expect(await message(out)).toContain("has uncommitted changes");
    git(out, "checkout", "--", "a.txt");

    git(out, "commit", "-q", "--allow-empty", "-m", "mine");
    expect(await message(out)).toContain("its last commit was not made by Portifact");
    git(out, "reset", "-q", "--hard", "v3");

    git(out, "tag", "-f", "v3", "v2");
    expect(await message(out)).toContain("tag v3 does not point to its last commit");
    git(out, "tag", "-f", "v3", "main");

    git(out, "checkout", "-q", "-b", "elsewhere");
    expect(await message(out)).toContain("main is not the checked-out branch");
    git(out, "checkout", "-q", "main");

    const fewer = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(fewer, { published: { "index.md": "# One" } });
    git(out, "config", "portifact.artifact", fewer.id);
    expect(await message(out, fewer.id)).toContain(`it has version 3, newer than ${fewer.id}`);
    git(out, "config", "portifact.artifact", artifact.id);

    const empty = join(h.workspace, "empty");
    await mkdir(empty);
    git(empty, "init", "-q");
    git(empty, "symbolic-ref", "HEAD", "refs/heads/main");
    git(empty, "config", "portifact.artifact", artifact.id);
    expect(await message(empty)).toContain("main has no commits");

    git(out, "tag", "v4", "v1");
    h.advance(HOUR);
    server.api.seedVersion(artifact, {
      published: { "index.md": "# Four" },
      source: { "a.txt": "4" },
    });
    expect(await message(out)).toContain("tag v4 already exists");
  });

  it("does not write through a file or link in the way, and leaves the history as it was", async () => {
    h.signIn();
    const { artifact } = history();
    const out = join(h.workspace, "history");
    expect((await pullGit(artifact.id, out)).code).toBe(0);
    const before = git(out, "rev-parse", "HEAD");
    const outside = join(h.workspace, "outside");
    await mkdir(outside);
    await symlink(outside, join(out, "docs"));
    h.advance(HOUR);
    server.api.seedVersion(artifact, {
      published: { "index.md": "# Four" },
      source: { "a.txt": "a3", "docs/readme.md": "inside" },
    });

    const result = await pullGit(artifact.id, out, "--json");

    expect(result.code).toBe(1);
    expect(json(result).error.code).toBe("git_failed");
    expect(json(result).error.message).toContain("is in the way");
    expect(git(out, "rev-parse", "HEAD")).toBe(before);
    expect(() => git(out, "rev-parse", "--verify", "v4")).toThrow();
    await expect(lstat(join(outside, "readme.md"))).rejects.toThrow();
    // The folder existed before, so it is kept.
    expect((await lstat(out)).isDirectory()).toBe(true);
  });

  it("renews links about to expire before downloading", async () => {
    h.signIn();
    const { artifact } = history();
    // Links valid for 10 seconds are inside the 30-second margin, so each blob gets a fresh one.
    server.api.downloadTtlMs = 10_000;
    const out = join(h.workspace, "history");

    const result = await pullGit(artifact.id, out);

    expect(result.code, result.stderr).toBe(0);
    // Two source manifests, then one fresh link for each of the three blobs.
    expect(server.requests.filter((r) => /\/download$/.test(r.path))).toHaveLength(5);
    expect(git(out, "show", "v3:a.txt")).toBe("a3");
  });

  it("names the publisher Portifact when the account ID has nothing git can use", async () => {
    server.userId = "<\u0001>";
    h.signIn();
    const { artifact } = history();
    const out = join(h.workspace, "history");

    expect((await pullGit(artifact.id, out)).code).toBe(0);
    expect(git(out, "log", "-1", "--format=%an|%cn")).toBe("Portifact|Portifact");
  });

  it("reports a source download the server refuses", async () => {
    h.signIn();
    const { artifact } = history();
    server.faults.push({
      method: "GET",
      path: /\/versions\/[^/]+\/download$/,
      reply: { status: 403, body: { error: { code: "forbidden", message: "Owner only." } } },
    });
    const out = join(h.workspace, "history");

    const result = await pullGit(artifact.id, out, "--json");

    expect(result.code).toBe(5);
    expect(json(result).error.code).toBe("forbidden");
    await expect(lstat(out)).rejects.toThrow();
  });

  it("removes a new folder when a git command fails", async () => {
    const real = gitRunner();
    const failing = await createHarness({
      server,
      git: (args, cwd, options) =>
        args[0] === "commit-tree"
          ? Promise.resolve({ code: 128, stdout: Buffer.alloc(0) })
          : real(args, cwd, options),
    });
    try {
      failing.signIn();
      const { artifact } = history();
      const out = join(failing.workspace, "history");

      const result = await failing.invoke(
        "pull",
        artifact.id,
        "--source",
        "--git",
        "--out",
        out,
        "--json",
      );

      expect(result.code).toBe(1);
      expect(json(result).error).toEqual({
        code: "git_failed",
        message: `git commit-tree failed in ${out}, so the history was not changed. Run the command again.`,
      });
      await expect(lstat(out)).rejects.toThrow();
    } finally {
      await failing.cleanup();
    }
  });

  it("refuses a tree from which git left out a file", async () => {
    const real = gitRunner();
    const skipping = await createHarness({
      server,
      git: (args, cwd, options) =>
        args[0] === "ls-files"
          ? Promise.resolve({ code: 0, stdout: Buffer.from("a.txt\0") })
          : real(args, cwd, options),
    });
    try {
      skipping.signIn();
      const { artifact } = history();
      const out = join(skipping.workspace, "history");

      const result = await skipping.invoke(
        "pull",
        artifact.id,
        "--source",
        "--git",
        "--out",
        out,
        "--json",
      );

      expect(result.code).toBe(1);
      expect(json(result).error.code).toBe("server_error");
      expect(json(result).error.message).toContain("refused by git");
    } finally {
      await skipping.cleanup();
    }
  });

  it("puts the files back when the branch cannot be moved", async () => {
    let refuseRefs = false;
    const real = gitRunner();
    const flaky = await createHarness({
      server,
      git: (args, cwd, options) =>
        refuseRefs && args[0] === "update-ref"
          ? Promise.resolve({ code: 1, stdout: Buffer.alloc(0) })
          : real(args, cwd, options),
    });
    try {
      flaky.signIn();
      const { artifact } = history();
      const out = join(flaky.workspace, "history");
      expect(
        (await flaky.invoke("pull", artifact.id, "--source", "--git", "--out", out)).code,
      ).toBe(0);
      const before = git(out, "rev-parse", "HEAD");
      flaky.advance(HOUR);
      server.api.seedVersion(artifact, {
        published: { "index.md": "# Four" },
        source: { "z.txt": "z" },
      });
      refuseRefs = true;

      const result = await flaky.invoke(
        "pull",
        artifact.id,
        "--source",
        "--git",
        "--out",
        out,
        "--json",
      );

      expect(result.code).toBe(1);
      expect(json(result).error.code).toBe("git_failed");
      expect(git(out, "rev-parse", "HEAD")).toBe(before);
      await expect(lstat(join(out, "z.txt"))).rejects.toThrow();
      expect(await readFile(join(out, "a.txt"), "utf8")).toBe("a3");
      expect(git(out, "status", "--porcelain")).toBe("");
    } finally {
      await flaky.cleanup();
    }
  });

  it("creates nothing for an artifact without versions", async () => {
    h.signIn();
    const artifact = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    const out = join(h.workspace, "history");

    const result = await pullGit(artifact.id, out);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${artifact.id} has no published versions, so no Git history was created.\n`,
    );
    await expect(lstat(out)).rejects.toThrow();
  });

  it("checks its flags and the folder before calling the server", async () => {
    h.signIn();
    const { artifact } = history();
    const out = join(h.workspace, "history");
    const cases: [string[], string][] = [
      [["--git", "--out", out], "--git works only with --source"],
      [["--git", "--source", "--published", "--out", out], "Leave out --published"],
      [["--git", "--source", "--version", "ver_1", "--out", out], "Leave out --version"],
      [["--git", "--source", "--out", join(h.workspace, "r", ".git", "x")], "inside a .git folder"],
    ];
    for (const [args, expected] of cases) {
      const result = await h.invoke("pull", artifact.id, ...args, "--json");
      expect(result.code, expected).toBe(2);
      expect(json(result).error.message).toContain(expected);
    }
    expect(server.requests.filter((r) => r.path.includes("/versions"))).toHaveLength(0);
  });
});

describe("trailerVersion", () => {
  const commit = (message: string) => `tree ${"0".repeat(40)}\nauthor a <> 1 +0000\n\n${message}`;

  it("reads the version from the last paragraph only", () => {
    expect(
      trailerVersion(commit("Version 3\n\nBody.\n\nPortifact-Version: 3\nSource-Commit: x\n")),
    ).toBe(3);
    expect(
      trailerVersion(commit("Version 3\n\nPortifact-Version: 3\n\nLater text.\n")),
    ).toBeUndefined();
    expect(trailerVersion(commit("Portifact-Version: 1\nPortifact-Version: 2\n"))).toBeUndefined();
    expect(trailerVersion(commit("Portifact-Version: 01\n"))).toBeUndefined();
    expect(trailerVersion("no message")).toBeUndefined();
  });
});
