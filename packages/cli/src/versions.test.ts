import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeArtifact } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const MINUTE = 60_000;

function json(output: { stdout: string }) {
  return JSON.parse(output.stdout);
}

function requests(method: string, path: RegExp) {
  return server.requests.filter((r) => r.method === method && path.test(r.path));
}

/** No issued token may appear in what the CLI printed. */
function expectNoTokens(output: { stdout: string; stderr: string }) {
  for (const token of server.issuedTokens) {
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
  }
}

/** A Markdown artifact with two versions; the first one has private sources. */
function history(overrides: Partial<FakeArtifact> = {}) {
  const artifact = server.api.seed({
    type: "markdown",
    currentVersionId: null,
    versions: 0,
    ...overrides,
  });
  const v1 = server.api.seedVersion(artifact, {
    published: { "index.md": "# One", "img/logo.txt": "logo" },
    source: { "src/draft.md": "private draft", "src/notes/todo.txt": "todo" },
  });
  h.advance(MINUTE);
  const v2 = server.api.seedVersion(artifact, { published: { "index.md": "# Two" } });
  return { artifact, v1, v2 };
}

describe("portifact versions", () => {
  it("lists every version as a table, following the cursor", async () => {
    h.signIn();
    const artifact = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    for (let i = 1; i <= 102; i++)
      server.api.seedVersion(artifact, { published: { "index.md": `# ${i}` } });

    const result = await h.invoke("versions", artifact.id);

    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^VERSION\s+ID\s+CURRENT\s+FILES\s+SOURCES\s+SIZE\s+COMMITTED\s+RETAINED UNTIL$/,
    );
    expect(lines).toHaveLength(103);
    expect(lines[1]).toMatch(
      /^102\s+ver_\w+\s+yes\s+1\s+0\s+5 B\s+2026-11-08 12:00 UTC\s+current$/,
    );
    expect(lines[2]).toMatch(/\bno\b.*2026-11-15 12:00 UTC$/);
    expect(requests("GET", /\/versions$/)).toHaveLength(2);
    expectNoTokens(result);
  });

  it("prints JSON with --json and says when there is nothing to list", async () => {
    h.signIn();
    const { artifact, v1, v2 } = history();
    const result = await h.invoke("versions", artifact.id, "--json");
    expect(result.code).toBe(0);
    const body = json(result);
    expect(body.artifactId).toBe(artifact.id);
    expect(
      body.items.map((item: { id: string; current: boolean }) => [item.id, item.current]),
    ).toEqual([
      [v2.id, true],
      [v1.id, false],
    ]);
    expect(body.items[1]).toMatchObject({ publishedFiles: 2, sourceFiles: 2 });

    const empty = server.api.seed({ currentVersionId: null, versions: 0 });
    const none = await h.invoke("versions", empty.id);
    expect(none.stdout).toBe(`${empty.id} has no published versions.\n`);
  });

  it("refuses a bad artifact ID before any request and reports a missing artifact", async () => {
    h.signIn();
    const bad = await h.invoke("versions", "nope", "--json");
    expect(bad.code).toBe(2);
    expect(json(bad).error.code).toBe("invalid_input");
    const missing = await h.invoke("versions", "abcdefghij");
    expect(missing.code).toBe(5);
    expect(missing.stderr).toContain("Artifact not found.");
  });
});

describe("portifact rollback", () => {
  it("rolls back on top of the current version with an idempotency key", async () => {
    h.signIn();
    const { artifact, v1, v2 } = history({
      access: { mode: "restricted", readers: [], indexable: false, embeddable: false },
    });

    const result = await h.invoke("rollback", artifact.id, v1.id);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Rolled back ${artifact.id}: version 3 has the files of version 1. Access did not change.`,
    );
    expect(result.stdout).toContain(`URL: https://${artifact.id}.portifact.dev/`);
    const [request] = requests("POST", /\/rollback$/);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({ versionId: v1.id, baseVersionId: v2.id });
    expect(request?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifact.currentVersionId).not.toBe(v2.id);
    expect(artifact.access.mode).toBe("restricted");
    expectNoTokens(result);
  });

  it("retries a lost answer with the same key and gets the first result", async () => {
    h.signIn();
    const { artifact, v1 } = history();
    server.faults.push({ method: "POST", path: /\/rollback$/, drop: "after" });

    const result = await h.invoke("rollback", artifact.id, v1.id, "--json");

    expect(result.code).toBe(0);
    expect(json(result)).toMatchObject({
      versionNumber: 3,
      fromVersionId: v1.id,
      fromVersionNumber: 1,
    });
    const posts = requests("POST", /\/rollback$/);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers["idempotency-key"]).toBe(posts[0]?.headers["idempotency-key"]);
    expect(server.api.versions.get(artifact.id)).toHaveLength(3);
  });

  it("reports conflicts, missing versions and archived artifacts with their exit codes", async () => {
    h.signIn();
    const { artifact, v1, v2 } = history();
    // Someone publishes between reading the artifact and rolling back.
    server.faults.push({
      method: "POST",
      path: /\/rollback$/,
      effect: () => {
        server.api.seedVersion(artifact, { published: { "index.md": "# Three" } });
      },
    });
    const conflict = await h.invoke("rollback", artifact.id, v1.id, "--json");
    expect(conflict.code).toBe(6);
    expect(json(conflict).error.code).toBe("version_conflict");

    const current = await h.invoke("rollback", artifact.id, artifact.currentVersionId ?? "");
    expect(current.code).toBe(2);
    const missing = await h.invoke("rollback", artifact.id, "ver_missing");
    expect(missing.code).toBe(5);
    expect(v2.id).not.toBe(v1.id);

    artifact.state = "archived";
    const archived = await h.invoke("rollback", artifact.id, v1.id, "--json");
    expect(archived.code).toBe(6);
    expect(json(archived).error.code).toBe("artifact_archived");
  });

  it("refuses bad IDs and artifacts without a published version", async () => {
    h.signIn();
    expect((await h.invoke("rollback", "abcdefghij", "ver/x")).code).toBe(2);
    const empty = server.api.seed({ currentVersionId: null, versions: 0 });
    const result = await h.invoke("rollback", empty.id, "ver_a", "--json");
    expect(result.code).toBe(5);
    expect(json(result).error.message).toContain("has no published version");
    expect(requests("POST", /\/rollback$/)).toHaveLength(0);
  });

  it("needs a session that allows writing", async () => {
    h.signIn(["artifacts:read", "offline_access"]);
    const { artifact, v1 } = history();
    const result = await h.invoke("rollback", artifact.id, v1.id);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("does not allow that action");
  });
});

describe("portifact pull", () => {
  const listFiles = async (root: string): Promise<string[]> => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .sort();
  };

  it("downloads the published files of the current version by default", async () => {
    h.signIn();
    const { artifact, v2 } = history();
    const out = join(h.workspace, "recovered");

    const result = await h.invoke("pull", artifact.id, "--out", out);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Downloaded 1 file (5 B) of version 2 of ${artifact.id} into ${out}.\n`,
    );
    expect(await listFiles(out)).toEqual(["published/index.md"]);
    expect(await readFile(join(out, "published", "index.md"), "utf8")).toBe("# Two");
    expect(requests("GET", /\/versions\/current\/download$/)).toHaveLength(1);
    // Storage never sees the API token.
    expect(server.api.gets.every((get) => get.headers.authorization === undefined)).toBe(true);
    expect(v2.number).toBe(2);
    expectNoTokens(result);
  });

  it("downloads published files and sources of a chosen version, as JSON", async () => {
    h.signIn();
    const { artifact, v1 } = history();
    const out = join(h.workspace, "nested", "old");

    const result = await h.invoke(
      "pull",
      artifact.id,
      "--version",
      v1.id,
      "--published",
      "--source",
      "--out",
      out,
      "--json",
    );

    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual([
      "published/img/logo.txt",
      "published/index.md",
      "source/src/draft.md",
      "source/src/notes/todo.txt",
    ]);
    expect(await readFile(join(out, "source", "src", "draft.md"), "utf8")).toBe("private draft");
    const body = json(result);
    expect(body).toMatchObject({
      artifactId: artifact.id,
      versionId: v1.id,
      versionNumber: 1,
      out,
    });
    expect(body.files).toHaveLength(4);
    expect(body.totalBytes).toBe("# One".length + 4 + "private draft".length + 4);
    expect(result.stderr).toContain("Downloaded 4 of 4.");
  });

  it("takes every kind from the version the first answer named", async () => {
    h.signIn();
    const artifact = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    const v1 = server.api.seedVersion(artifact, {
      published: { "index.md": "# One" },
      source: { "draft.md": "draft one" },
    });
    // A new version lands between the published and the source requests.
    server.faults.push({
      method: "GET",
      path: new RegExp(`/versions/${v1.id}/download$`),
      effect: () => {
        server.api.seedVersion(artifact, {
          published: { "index.md": "# Two" },
          source: { "draft.md": "draft two" },
        });
      },
    });
    const out = join(h.workspace, "pinned");

    const result = await h.invoke(
      "pull",
      artifact.id,
      "--published",
      "--source",
      "--out",
      out,
      "--json",
    );

    expect(result.code).toBe(0);
    expect(json(result).versionId).toBe(v1.id);
    expect(await readFile(join(out, "source", "draft.md"), "utf8")).toBe("draft one");
    expect(artifact.currentVersionId).not.toBe(v1.id);
  });

  it("only writes into a new folder", async () => {
    h.signIn();
    const { artifact } = history();
    const existing = join(h.workspace, "existing");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "keep.txt"), "mine");

    const result = await h.invoke("pull", artifact.id, "--out", existing, "--json");

    expect(result.code).toBe(2);
    expect(json(result).error.message).toContain("already exists");
    expect(await readdir(existing)).toEqual(["keep.txt"]);
    expect(requests("GET", /\/download$/)).toHaveLength(0);

    const inGit = await h.invoke(
      "pull",
      artifact.id,
      "--out",
      join(h.workspace, "repo", ".git", "x"),
    );
    expect(inGit.code).toBe(2);
    expect(inGit.stderr).toContain("inside a .git folder");
  });

  it("refuses paths with a .git segment or that leave the folder, before writing anything", async () => {
    h.signIn();
    for (const path of [
      ".git/hooks/post-checkout",
      "src/.GIT/config",
      "../escape.txt",
      "/etc/passwd",
      "a//b.txt",
      "A.md",
    ]) {
      const artifact = server.api.seed({ type: "site", currentVersionId: null, versions: 0 });
      server.api.seedVersion(
        artifact,
        { published: { "a.md": "a", [path]: "evil" } },
        { entrypoint: "a.md" },
      );
      const out = join(h.workspace, `hostile-${artifact.id}`);

      const result = await h.invoke("pull", artifact.id, "--out", out, "--json");

      expect(result.code, path).toBe(1);
      expect(json(result).error.code, path).toBe("server_error");
      expect(json(result).error.message, path).toContain("cannot be written safely");
      await expect(lstat(out), path).rejects.toThrow();
    }
    expect(server.api.gets).toHaveLength(0);
  });

  it("stops on bytes that do not match the manifest and removes the partial folder", async () => {
    h.signIn();
    const { artifact } = history();
    server.faults.push({
      method: "GET",
      path: /^\/r2\/objects\//,
      reply: { status: 200, body: Buffer.from("# Tw0") },
    });
    const out = join(h.workspace, "tampered");

    const result = await h.invoke("pull", artifact.id, "--out", out, "--json");

    expect(result.code).toBe(1);
    expect(json(result).error.code).toBe("download_failed");
    expect(result.stderr).toContain(`Removed the partial download in ${out}.`);
    await expect(lstat(out)).rejects.toThrow();
  });

  it("renews links about to expire and retries storage hiccups", async () => {
    h.signIn();
    const { artifact } = history();
    const downloads = () => requests("GET", /\/download$/).length;
    // Links valid for 10 seconds are inside the 30-second margin, so the CLI asks for a fresh one.
    server.api.downloadTtlMs = 10_000;
    const first = await h.invoke("pull", artifact.id, "--out", join(h.workspace, "renewed"));
    expect(first.code).toBe(0);
    expect(downloads()).toBe(2);

    server.api.downloadTtlMs = 5 * MINUTE;
    server.faults.push({
      method: "GET",
      path: /^\/r2\/objects\//,
      reply: { status: 403, body: "Request has expired" },
    });
    server.faults.push({
      method: "GET",
      path: /^\/r2\/objects\//,
      reply: { status: 503, body: "SlowDown" },
    });
    const second = await h.invoke("pull", artifact.id, "--out", join(h.workspace, "retried"));
    expect(second.code).toBe(0);
    // One fresh link after the 403, one pause after the 503.
    expect(downloads()).toBe(4);
    expect(h.sleeps).toEqual([1_000]);
    expect(await readFile(join(h.workspace, "retried", "published", "index.md"), "utf8")).toBe(
      "# Two",
    );
  });

  it("gives up after repeated storage failures", async () => {
    h.signIn();
    const { artifact } = history();
    for (let i = 0; i < 3; i++) {
      server.faults.push({
        method: "GET",
        path: /^\/r2\/objects\//,
        reply: { status: 500, body: "InternalError" },
      });
    }
    const result = await h.invoke(
      "pull",
      artifact.id,
      "--out",
      join(h.workspace, "failed"),
      "--json",
    );
    expect(result.code).toBe(1);
    expect(json(result).error).toEqual({
      code: "download_failed",
      message: "Could not download index.md. Run the command again.",
    });
  });

  it("reports a version that is no longer retained", async () => {
    h.signIn();
    const { artifact, v1 } = history();
    h.advance(8 * 24 * 60 * MINUTE);
    const result = await h.invoke(
      "pull",
      artifact.id,
      "--version",
      v1.id,
      "--out",
      join(h.workspace, "gone"),
    );
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("no longer retained");
    const bad = await h.invoke(
      "pull",
      artifact.id,
      "--version",
      "v 1",
      "--out",
      join(h.workspace, "bad"),
    );
    expect(bad.code).toBe(2);
  });

  it("needs --out", async () => {
    h.signIn();
    const result = await h.invoke("pull", "abcdefghij");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out");
  });
});

describe("version numbers", () => {
  it("rolls back to a version given by its number, with or without the v", async () => {
    h.signIn();
    const { artifact, v1 } = history();

    const plain = await h.invoke("rollback", artifact.id, "1", "--json");
    expect(plain.code).toBe(0);
    expect(json(plain)).toMatchObject({ versionNumber: 3, fromVersionNumber: 1 });
    const prefixed = await h.invoke("rollback", artifact.id, "V2", "--json");
    expect(prefixed.code).toBe(0);
    expect(json(prefixed)).toMatchObject({ versionNumber: 4, fromVersionNumber: 2 });

    const bodies = requests("POST", /\/rollback$/).map((request) =>
      JSON.parse(request.body ?? "{}"),
    );
    expect(bodies[0]).toMatchObject({ versionId: v1.id });
  });

  it("explains a number that is not retained without calling the rollback", async () => {
    h.signIn();
    const { artifact } = history();

    const result = await h.invoke("rollback", artifact.id, "v9", "--json");

    expect(result.code).toBe(5);
    expect(json(result).error).toEqual({
      code: "not_found",
      message: `${artifact.id} has no retained version 9. Run \`portifact versions ${artifact.id}\` to list them.`,
    });
    expect(requests("POST", /\/rollback$/)).toHaveLength(0);
  });

  it("refuses version 0 as an invalid ID before signing in", async () => {
    const result = await h.invoke("rollback", "abcdefghij", "v0");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is not a version ID or number");
  });

  it("pulls a version given by its number", async () => {
    h.signIn();
    const { artifact, v1 } = history();
    const out = join(h.workspace, "by-number");

    const result = await h.invoke("pull", artifact.id, "--version", "1", "--out", out);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("of version 1 of");
    expect(await readFile(join(out, "published", "index.md"), "utf8")).toBe("# One");
    expect(requests("GET", new RegExp(`/versions/${v1.id}/download$`))).toHaveLength(1);
  });
});
