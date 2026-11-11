// portifact export (decision 0022, second delivery): a space's every retained version, sources,
// access logs, audit log and a manifest, into a folder; resumable, verified, never outside it.
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExportManifest } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** Two artifacts: a document with two versions (the first with sources) and a one-page site. */
function space() {
  const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
  server.api.seedVersion(doc, {
    published: { "index.md": "# One", "img/logo.txt": "logo" },
    source: { "src/draft.md": "private draft" },
  });
  h.advance(MINUTE);
  server.api.seedVersion(doc, { published: { "index.md": "# Two" } });
  const site = server.api.seed({ type: "site", currentVersionId: null, versions: 0 });
  server.api.seedVersion(
    site,
    { published: { "index.html": "<h1>Site</h1>" } },
    {
      entrypoint: "index.html",
    },
  );
  server.api.accessLogs.set(doc.id, [
    { email: "ana@example.com", openedAt: "2026-11-10T10:00:00.000Z" },
  ]);
  server.api.audit.set("personal", []);
  return { doc, site };
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}

async function manifestOf(out: string) {
  return ExportManifest.parse(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
}

describe("portifact export", () => {
  it("prints counts and bytes on a dry run and writes nothing", async () => {
    h.signIn();
    space();
    const out = join(h.workspace, "dry");
    const result = await h.invoke("export", out, "--dry-run");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Would export your personal space: 2 artifacts, 3 retained versions, 5 files",
    );
    expect(result.stdout).toContain("Nothing was written.");
    await expect(lstat(out)).rejects.toThrow();
    expect(server.api.gets).toHaveLength(0);
  });

  it("names what a running grace lets go on a dry run, as JSON too", async () => {
    h.signIn();
    space();
    const grace = {
      until: "2027-01-10T00:00:00.000Z",
      plan: "pro" as const,
      limits: {
        archiveMonths: 12,
        retainedPreviousVersions: 50,
        previousVersionRetentionDays: 90,
        accessLogRetentionDays: 365,
        auditRetentionDays: 90,
      },
      features: [],
    };
    server.api.usage.plan = { ...server.api.usage.plan, grace };
    server.api.graceForecast = {
      grace,
      kinds: [{ kind: "versions", count: 4, from: "2027-01-10T00:00:00.000Z" }],
    };
    const out = join(h.workspace, "dry");
    const text = await h.invoke("export", out, "--dry-run");
    expect(text.stdout).toContain(
      "4 previous versions go from 2027-01-10 00:00 UTC unless the plan is granted again.",
    );
    const json = JSON.parse((await h.invoke("export", out, "--dry-run", "--json")).stdout);
    expect(json).toMatchObject({
      dryRun: true,
      artifacts: 2,
      versions: 3,
      files: 5,
      grace: { kinds: [{ count: 4 }] },
    });
  });

  it("exports every retained version, sources, access logs, the audit log and a manifest", async () => {
    h.signIn();
    const { doc, site } = space();
    const out = join(h.workspace, "export");
    const result = await h.invoke("export", out);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `Exported your personal space: 2 artifacts, 3 versions, 5 files`,
    );
    expect(result.stderr).toContain("Exported version 3 of 3");
    expect(await files(out)).toEqual(
      [
        ".portifact-export",
        "audit.jsonl",
        "manifest.json",
        `artifacts/${doc.id}/access-log.jsonl`,
        `artifacts/${doc.id}/v1/published/img/logo.txt`,
        `artifacts/${doc.id}/v1/published/index.md`,
        `artifacts/${doc.id}/v1/source/src/draft.md`,
        `artifacts/${doc.id}/v2/published/index.md`,
        `artifacts/${site.id}/access-log.jsonl`,
        `artifacts/${site.id}/v1/published/index.html`,
      ].sort(),
    );
    expect(
      await readFile(join(out, "artifacts", doc.id, "v1", "source", "src", "draft.md"), "utf8"),
    ).toBe("private draft");
    const manifest = await manifestOf(out);
    expect(manifest.totals).toEqual({ artifacts: 2, versions: 3, files: 5, bytes: 40 });
    expect(manifest.artifacts.find((a) => a.id === doc.id)?.accessLog).toEqual({
      file: `artifacts/${doc.id}/access-log.jsonl`,
      lines: 1,
    });
    // Storage never sees the API token.
    expect(server.api.gets.every((get) => get.headers.authorization === undefined)).toBe(true);
  });

  it("resumes: a second run keeps verified files and fetches only what is missing or wrong", async () => {
    h.signIn();
    const { doc } = space();
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    const fetched = server.api.gets.length;
    // A corrupted file and a leftover partial one: both are fetched again, nothing else is.
    await writeFile(join(out, "artifacts", doc.id, "v2", "published", "index.md"), "# Tw0");
    await writeFile(join(out, "artifacts", doc.id, "v1", "published", "index.md.part"), "# O");
    expect((await h.invoke("export", out)).code).toBe(0);
    expect(server.api.gets.length - fetched).toBe(1);
    expect(
      await readFile(join(out, "artifacts", doc.id, "v2", "published", "index.md"), "utf8"),
    ).toBe("# Two");
  });

  it("stops on a failure midway, keeps what it verified, and a second run completes it", async () => {
    h.signIn();
    space();
    const out = join(h.workspace, "export");
    server.faults.push(
      ...Array.from({ length: 3 }, () => ({
        method: "GET",
        path: /^\/r2\/objects\//,
        reply: { status: 500, body: Buffer.from("down") },
      })),
    );
    // Storage fails every attempt of the first file the export fetches (three tries).
    const first = await h.invoke("export", out, "--json");
    expect(first.code).toBe(1);
    expect(JSON.parse(first.stdout).error.code).toBe("download_failed");
    expect(first.stderr).toContain("run the same command again to resume");
    await expect(lstat(join(out, "manifest.json"))).rejects.toThrow();
    const second = await h.invoke("export", out);
    expect(second.code).toBe(0);
    expect((await manifestOf(out)).totals.files).toBe(5);
  });

  it("stops on bytes that do not match and keeps no partial file", async () => {
    h.signIn();
    const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(doc, { published: { "index.md": "# One" } });
    server.api.audit.set("personal", []);
    server.faults.push({
      method: "GET",
      path: /^\/r2\/objects\//,
      reply: { status: 200, body: Buffer.from("# 0ne") },
    });
    const out = join(h.workspace, "export");
    const result = await h.invoke("export", out, "--json");
    expect(JSON.parse(result.stdout).error.code).toBe("download_failed");
    expect((await files(out)).filter((file) => file.includes("index.md"))).toEqual([]);
  });

  it("refuses hostile paths before writing the file, and folders that are not this space's export", async () => {
    h.signIn();
    for (const path of [".git/hooks/post-checkout", "../escape.txt", "/etc/passwd", "a//b.txt"]) {
      const artifact = server.api.seed({ type: "site", currentVersionId: null, versions: 0 });
      server.api.seedVersion(
        artifact,
        { published: { "a.md": "a", [path]: "evil" } },
        { entrypoint: "a.md" },
      );
    }
    server.api.audit.set("personal", []);
    const out = join(h.workspace, "hostile");
    const result = await h.invoke("export", out, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.message).toContain("cannot be written safely");
    expect(
      (await files(out)).some((file) => file.includes("evil") || file.includes("escape")),
    ).toBe(false);

    const other = await h.files("unrelated", { "notes.txt": "mine" });
    const refused = await h.invoke("export", other, "--json");
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error.message).toContain("is not an export of this space");
    expect(await readFile(join(other, "notes.txt"), "utf8")).toBe("mine");
  });

  it("records what the caller may not read as skipped, and exports the rest", async () => {
    h.signIn();
    const { doc } = space();
    server.api.audit.delete("personal");
    server.faults.push({
      method: "GET",
      path: new RegExp(`^/api/v1/artifacts/${doc.id}/access-log`),
      reply: {
        status: 403,
        body: Buffer.from(JSON.stringify({ error: { code: "forbidden", message: "No." } })),
      },
    });
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    const manifest = await manifestOf(out);
    expect(manifest.audit).toEqual({ skipped: "not_found" });
    expect(manifest.artifacts.every((a) => "skipped" in a.accessLog)).toBe(true);
    expect(manifest.totals.files).toBe(5);
  });
});
