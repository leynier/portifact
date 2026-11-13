// portifact export (decision 0022, second delivery): a space's every retained version, sources,
// access logs, audit log and a manifest, into a folder; resumable, verified, never outside it.

import { existsSync, mkdtempSync } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRecords, ExportManifest, SpaceRecords } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oneLine, plain } from "./plain.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

const tmpdirOf = () => mkdtempSync(join(tmpdir(), "portifact-export-stop-"));

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
      ownerId: "u_fake_owner",
      grace,
      // Two holds: versions drop at each one's end, each step with its own count and date.
      kinds: [
        { kind: "versions", count: 2, from: "2026-12-01T00:00:00.000Z" },
        { kind: "versions", count: 4, from: "2027-01-10T00:00:00.000Z" },
      ],
    };
    const out = join(h.workspace, "dry");
    const text = await h.invoke("export", out, "--dry-run");
    expect(text.stdout).toContain(
      "2 previous versions go from 2026-12-01 00:00 UTC unless the plan is granted again.",
    );
    expect(text.stdout).toContain(
      "4 previous versions go from 2027-01-10 00:00 UTC unless the plan is granted again.",
    );
    const json = JSON.parse((await h.invoke("export", out, "--dry-run", "--json")).stdout);
    expect(json).toMatchObject({
      dryRun: true,
      artifacts: 2,
      versions: 3,
      files: 5,
      grace: { kinds: [{ count: 2 }, { count: 4 }] },
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
        "space.json",
        `artifacts/${doc.id}/access-log.jsonl`,
        `artifacts/${doc.id}/records.json`,
        `artifacts/${doc.id}/v1/published/img/logo.txt`,
        `artifacts/${doc.id}/v1/published/index.md`,
        `artifacts/${doc.id}/v1/source/src/draft.md`,
        `artifacts/${doc.id}/v2/published/index.md`,
        `artifacts/${site.id}/access-log.jsonl`,
        `artifacts/${site.id}/records.json`,
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
    // The records: the same bodies as the read routes, each part or why it is missing.
    const records = ArtifactRecords.parse(
      JSON.parse(await readFile(join(out, "artifacts", doc.id, "records.json"), "utf8")),
    );
    expect(records).toMatchObject({
      kind: "artifact",
      artifact: { id: doc.id },
      access: { mode: "restricted" },
      shareLinks: { artifactId: doc.id, links: [] },
      approvalReview: { artifactId: doc.id, role: "owner" },
      comments: { artifact: { id: doc.id }, threads: [] },
      commentHistory: [],
      // Edit suggestions switched off on the server: the change list's route does not exist.
      changeList: { skipped: "unavailable" },
    });
    expect(manifest.artifacts.find((a) => a.id === doc.id)?.records).toEqual({
      file: `artifacts/${doc.id}/records.json`,
    });
    const spaceRecords = SpaceRecords.parse(
      JSON.parse(await readFile(join(out, "space.json"), "utf8")),
    );
    expect(spaceRecords).toMatchObject({
      space: { ownerId: "u_fake_owner", slug: null },
      workspace: null,
      members: null,
      branding: { skipped: "dashboard_only" },
      webhooks: { webhooks: [] },
    });
    expect(manifest.spaceRecords).toEqual({ file: "space.json" });
    expect(result.stdout).toContain(
      "Branding, integrations and audit streams are in the Space records download",
    );
    expect(manifest.complete).toBe(true);
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
    // One artifact refused (a held one is refused to the people who manage it) skips only
    // that artifact's log: the others are exported.
    const logs = manifest.artifacts.map((a) => a.accessLog);
    expect(manifest.artifacts.find((a) => a.id === doc.id)?.accessLog).toEqual({
      skipped: "forbidden",
    });
    expect(logs.some((log) => "file" in log)).toBe(true);
    expect(manifest.totals.files).toBe(5);
  });

  it.skipIf(process.platform === "win32")(
    "R1: never writes through a link at a file's own name or a leftover partial name",
    async () => {
      h.signIn();
      await mkdir(h.workspace, { recursive: true });
      const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(doc, { published: { "index.md": "SERVER CONTENT", "b.md": "b" } });
      server.api.audit.set("personal", []);
      const victim = join(h.workspace, "victim.txt");
      await writeFile(victim, "the user's own file");
      const out = join(h.workspace, "export");
      // A first run claims the folder; then links are planted where the files go.
      expect((await h.invoke("export", out)).code).toBe(0);
      const published = join(out, "artifacts", doc.id, "v1", "published");
      await writeFile(join(published, "index.md"), "changed");
      const { rm } = await import("node:fs/promises");
      await rm(join(published, "index.md"));
      await symlink(victim, join(published, "index.md"));
      await symlink(victim, join(published, "b.md.part"));
      const result = await h.invoke("export", out, "--json");
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).error.message).toContain("is a link or not a regular file");
      expect(await readFile(victim, "utf8")).toBe("the user's own file");
    },
  );

  it.skipIf(process.platform === "win32")(
    "R2: never writes through a linked folder, whatever level it is at",
    async () => {
      h.signIn();
      await mkdir(h.workspace, { recursive: true });
      const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(doc, { published: { "index.md": "x" } });
      server.api.audit.set("personal", []);
      const elsewhere = join(h.workspace, "elsewhere");
      await mkdir(elsewhere);
      const out = join(h.workspace, "export");
      await mkdir(out);
      await writeFile(
        join(out, ".portifact-export"),
        `${JSON.stringify({ ownerId: "u_fake_owner" })}\n`,
      );
      await symlink(elsewhere, join(out, "artifacts"));
      const result = await h.invoke("export", out, "--json");
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).error.message).toContain("is a link or not a folder");
      expect(await readdir(elsewhere)).toEqual([]);
    },
  );

  it("R3: skips an artifact deleted or purged while the export runs, and exports the rest", async () => {
    h.signIn();
    const good = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(good, { published: { "index.md": "x" } });
    const gone = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(gone, { published: { "index.md": "y" } });
    server.api.audit.set("personal", []);
    server.faults.push({
      method: "GET",
      path: new RegExp(`^/api/v1/artifacts/${gone.id}/versions`),
      reply: {
        status: 404,
        body: Buffer.from(
          JSON.stringify({ error: { code: "not_found", message: "Artifact not found." } }),
        ),
      },
    });
    const out = join(h.workspace, "export");
    const result = await h.invoke("export", out);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Skipped ${gone.id}: it was deleted or is being purged.`);
    const manifest = await manifestOf(out);
    expect(manifest.artifacts.find((a) => a.id === gone.id)).toMatchObject({
      skipped: "not_found",
      versions: [],
    });
    expect(
      await readFile(join(out, "artifacts", good.id, "v1", "published", "index.md"), "utf8"),
    ).toBe("x");
  });

  it("R4: an artifact's `a` and `a.part` are two files, each with its own bytes", async () => {
    h.signIn();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const doc = server.api.seed({ type: "site", currentVersionId: null, versions: 0 });
      server.api.seedVersion(
        doc,
        { published: { a: "A".repeat(200_000), "a.part": "B".repeat(10) } },
        { entrypoint: "a" },
      );
      ids.push(doc.id);
    }
    server.api.audit.set("personal", []);
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    for (const id of ids) {
      const folder = join(out, "artifacts", id, "v1", "published");
      expect(await readFile(join(folder, "a"), "utf8")).toBe("A".repeat(200_000));
      expect(await readFile(join(folder, "a.part"), "utf8")).toBe("B".repeat(10));
    }
  });

  it("keeps a second export out of a folder in use, and another owner's export out of it", async () => {
    h.signIn();
    space();
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    await writeFile(join(out, ".portifact-export.lock"), "123\n");
    const locked = await h.invoke("export", out, "--json");
    expect(locked.code).toBe(6);
    expect(JSON.parse(locked.stdout).error.code).toBe("folder_in_use");
    const { rm } = await import("node:fs/promises");
    await rm(join(out, ".portifact-export.lock"));
    // The marker names the owner: a workspace's export never goes into a personal one.
    server.api.workspaces = [{ slug: "acme", name: "Acme", role: "admin" }];
    server.api.audit.set("acme", []);
    const other = await h.invoke("export", out, "--workspace", "acme", "--json");
    expect(other.code).toBe(2);
    expect(JSON.parse(other.stdout).error.message).toContain("is not an export of this space");
    expect(JSON.parse(await readFile(join(out, ".portifact-export"), "utf8"))).toEqual({
      ownerId: "u_fake_owner",
    });
  });

  it("exits 8 with everything else written when the audit log must wait, and a later run adds it", async () => {
    h.signIn();
    space();
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/audit\/export/,
      reply: {
        status: 429,
        body: Buffer.from(JSON.stringify({ error: { code: "rate_limited", message: "Wait." } })),
      },
    });
    const out = join(h.workspace, "export");
    const first = await h.invoke("export", out);
    expect(first.code).toBe(8);
    expect(first.stdout).toContain("The audit log was not exported: the server asked to wait.");
    expect(first.stdout).toContain("The export is not complete");
    expect((await manifestOf(out)).audit).toEqual({ skipped: "rate_limited" });
    expect((await manifestOf(out)).totals.files).toBe(5);
    const second = await h.invoke("export", out, "--json");
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).complete).toBe(true);
    expect((await manifestOf(out)).audit).toMatchObject({ file: "audit.jsonl" });
  });

  it("writes each artifact's comments and every page of their history into its records", async () => {
    h.signIn();
    const { doc } = space();
    const entries = Array.from({ length: 450 }, (_, i) => ({
      seq: i + 1,
      threadId: "th_1",
      messageId: null,
      kind: "thread_created" as const,
      actor: { id: "u_ada", name: "Ada", image: null },
      at: "2026-11-01T00:00:00.000Z",
    }));
    server.annotations.history.set(doc.id, entries);
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    const records = ArtifactRecords.parse(
      JSON.parse(await readFile(join(out, "artifacts", doc.id, "records.json"), "utf8")),
    );
    expect(records.commentHistory).toEqual(entries);

    // An action by a deleted account: the route answers `actor: null`, and the export keeps it.
    const gone = [
      {
        seq: 1,
        threadId: "th_1",
        messageId: null,
        kind: "thread_created" as const,
        actor: null,
        at: "2026-11-01T00:00:00.000Z",
      },
    ];
    server.annotations.history.set(doc.id, gone);
    expect((await h.invoke("export", out)).code).toBe(0);
    const withGone = ArtifactRecords.parse(
      JSON.parse(await readFile(join(out, "artifacts", doc.id, "records.json"), "utf8")),
    );
    expect(withGone.commentHistory).toEqual(gone);

    // A reader's export: the history is the owner side's, the threads are the current version's.
    server.annotations.role = "participant";
    const again = await h.invoke("export", out);
    expect(again.code).toBe(0);
    const reader = ArtifactRecords.parse(
      JSON.parse(await readFile(join(out, "artifacts", doc.id, "records.json"), "utf8")),
    );
    expect(reader.commentHistory).toEqual({ skipped: "forbidden" });
  });

  it("writes every page of an artifact's change list into its records, or why it is missing", async () => {
    h.signIn();
    const { doc } = space();
    const items = Array.from({ length: 150 }, (_, i) => ({
      id: `chg_${i}`,
      artifactId: doc.id,
      origin: "suggestion",
      threadId: null,
      versionId: "ver_1",
      path: "index.md",
      route: null,
      envelope: { format: 2 },
      reason: "spans_nodes",
      state: i % 2 === 0 ? "open" : "applied",
      createdAt: i,
      closedAt: null,
      closedVersionId: null,
      revision: 1,
    }));
    server.changes.items.set(doc.id, items);
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    const records = ArtifactRecords.parse(
      JSON.parse(await readFile(join(out, "artifacts", doc.id, "records.json"), "utf8")),
    );
    expect(records.changeList).toEqual(items);
    const pages = server.requests.filter((r) => r.path === `/api/v1/artifacts/${doc.id}/changes`);
    expect(pages).toHaveLength(2);

    // A reader: the list is the owner side's.
    server.changes.forbidden.add(doc.id);
    expect((await h.invoke("export", out)).code).toBe(0);
    const reader = ArtifactRecords.parse(
      JSON.parse(await readFile(join(out, "artifacts", doc.id, "records.json"), "utf8")),
    );
    expect(reader.changeList).toEqual({ skipped: "forbidden" });
  });

  it("exports a workspace's records that bearer routes read and names the dashboard for the rest", async () => {
    h.signIn();
    server.api.workspaces = [{ slug: "acme", name: "Acme", role: "admin" }];
    server.api.audit.set("acme", []);
    server.api.groups.set("acme", [
      {
        id: "wg_00000000000000000000000000000001",
        name: "Design",
        members: 2,
        createdAt: "2026-11-01T00:00:00.000Z",
        directory: false,
      },
    ]);
    const out = join(h.workspace, "export");
    const result = await h.invoke("export", out, "--workspace", "acme");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Space records download of the dashboard's Download your data page",
    );
    const records = SpaceRecords.parse(JSON.parse(await readFile(join(out, "space.json"), "utf8")));
    expect(records).toMatchObject({
      space: { slug: "acme" },
      workspace: { slug: "acme", name: "Acme", role: "admin" },
      groups: { items: [{ name: "Design" }] },
      groupMembers: { skipped: "dashboard_only" },
      members: { skipped: "dashboard_only" },
      invitations: { skipped: "dashboard_only" },
      serviceTokens: { skipped: "dashboard_only" },
      emailDomains: { skipped: "dashboard_only" },
      policies: { skipped: "dashboard_only" },
    });
  });

  it("resumes without reading again the records it wrote and verified in this export", async () => {
    h.signIn();
    const { doc, site } = space();
    const out = join(h.workspace, "export");
    const recordReads = () =>
      server.requests.filter((r) =>
        /^\/api\/v1\/artifacts\/[^/]+(\/(access|share-links|review\/status|stats|annotations\/export|annotations\/history))?(\?|$)/.test(
          r.path,
        ),
      ).length;
    // The audit log must wait: the run ends incomplete, so the export stays open.
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/audit\/export/,
      reply: {
        status: 429,
        body: Buffer.from(JSON.stringify({ error: { code: "rate_limited", message: "Wait." } })),
      },
    });
    expect((await h.invoke("export", out)).code).toBe(8);
    expect((await manifestOf(out)).complete).toBe(false);
    const first = recordReads();
    expect(first).toBeGreaterThanOrEqual(14);

    // A records file changed on disk is read again; the other one is kept.
    const siteRecords = join(out, "artifacts", site.id, "records.json");
    await writeFile(siteRecords, `${(await readFile(siteRecords, "utf8")).trim()} `);
    const before = recordReads();
    const second = await h.invoke("export", out);
    expect(second.code).toBe(0);
    expect(recordReads() - before).toBeGreaterThanOrEqual(7);
    expect(recordReads() - before).toBeLessThan(first);
    expect(
      server.requests.filter((r) => r.path === `/api/v1/artifacts/${site.id}/access`),
    ).toHaveLength(2);
    expect(
      server.requests.filter((r) => r.path === `/api/v1/artifacts/${doc.id}/access`),
    ).toHaveLength(1);
    expect((await manifestOf(out)).complete).toBe(true);
    expect(existsSync(join(out, ".portifact-export-records.json"))).toBe(false);
    ArtifactRecords.parse(JSON.parse(await readFile(siteRecords, "utf8")));

    // A complete export is closed: the next run reads every record again.
    const third = recordReads();
    expect((await h.invoke("export", out)).code).toBe(0);
    expect(
      server.requests.filter((r) => r.path === `/api/v1/artifacts/${doc.id}/access`),
    ).toHaveLength(2);
    expect(recordReads() - third).toBeGreaterThanOrEqual(14);
  });

  it("notes a feature switched off as unavailable and still completes", async () => {
    h.signIn();
    space();
    server.faults.push({
      method: "GET",
      path: /^\/api\/v1\/webhooks/,
      reply: {
        status: 503,
        body: Buffer.from(
          JSON.stringify({ error: { code: "capacity_unavailable", message: "Off." } }),
        ),
      },
    });
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    const records = SpaceRecords.parse(JSON.parse(await readFile(join(out, "space.json"), "utf8")));
    expect(records.webhooks).toEqual({ skipped: "unavailable" });
  });

  it("exits 8 when a part of the records must wait, and a later run fills it", async () => {
    h.signIn();
    const { doc } = space();
    server.faults.push({
      method: "GET",
      path: new RegExp(`^/api/v1/artifacts/${doc.id}/review/status`),
      reply: {
        status: 429,
        body: Buffer.from(JSON.stringify({ error: { code: "rate_limited", message: "Wait." } })),
      },
    });
    const out = join(h.workspace, "export");
    const first = await h.invoke("export", out);
    expect(first.code).toBe(8);
    const path = join(out, "artifacts", doc.id, "records.json");
    expect(ArtifactRecords.parse(JSON.parse(await readFile(path, "utf8"))).approvalReview).toEqual({
      skipped: "rate_limited",
    });
    expect((await h.invoke("export", out)).code).toBe(0);
    expect(
      ArtifactRecords.parse(JSON.parse(await readFile(path, "utf8"))).approvalReview,
    ).toMatchObject({ artifactId: doc.id });
  });

  it("refuses two paths one file system would store as one, before writing either", async () => {
    h.signIn();
    const doc = server.api.seed({ type: "site", currentVersionId: null, versions: 0 });
    server.api.seedVersion(
      doc,
      {
        published: {
          "index.html": "i",
          "stra\u00dfe.html": "one",
          "strasse.html": "two",
        },
      },
      { entrypoint: "index.html" },
    );
    server.api.audit.set("personal", []);
    const out = join(h.workspace, "export");
    const result = await h.invoke("export", out, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("server_error");
    expect(JSON.parse(result.stdout).error.message).toContain("collides with another file");
    expect((await files(out)).some((file) => file.includes("stra"))).toBe(false);
  });

  it("prints no control or bidirectional characters from a server path", async () => {
    h.signIn();
    const doc = server.api.seed({ type: "site", currentVersionId: null, versions: 0 });
    server.api.seedVersion(
      doc,
      { published: { "index.html": "i", "../\u009b31m\u202etxt.exe": "evil" } },
      { entrypoint: "index.html" },
    );
    server.api.audit.set("personal", []);
    const result = await h.invoke("export", join(h.workspace, "export"));
    expect(result.code).toBe(1);
    expect(result.stderr).not.toMatch(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(result.stderr).toContain("cannot be written safely here");
  });

  it("streams an access log of many pages to disk, every entry once", async () => {
    h.signIn();
    const { doc } = space();
    server.api.accessLogs.set(
      doc.id,
      Array.from({ length: 250 }, (_, i) => ({
        email: `reader${i}@example.com`,
        openedAt: new Date(Date.UTC(2026, 10, 1) + i * MINUTE).toISOString(),
      })),
    );
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    const lines = (await readFile(join(out, "artifacts", doc.id, "access-log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(250);
    expect(new Set(lines).size).toBe(250);
  });

  const posix = process.platform !== "win32";

  it.skipIf(!posix)(
    "X1: refuses a link at a parent folder instead of trusting the files behind it",
    async () => {
      h.signIn();
      await mkdir(h.workspace, { recursive: true });
      const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(doc, { published: { "index.md": "content" } });
      server.api.audit.set("personal", []);
      const out = join(h.workspace, "export");
      expect((await h.invoke("export", out)).code).toBe(0);
      const outside = join(h.workspace, "outside-v1");
      await cp(join(out, "artifacts", doc.id, "v1"), outside, { recursive: true });
      await rm(join(out, "artifacts", doc.id, "v1"), { recursive: true });
      await symlink(outside, join(out, "artifacts", doc.id, "v1"));
      const second = await h.invoke("export", out, "--json");
      expect(second.code).toBe(2);
      expect(JSON.parse(second.stdout).error.message).toContain("is a link or not a folder");
      // The earlier manifest is gone: nothing claims files that are not in the folder.
      await expect(lstat(join(out, "manifest.json"))).rejects.toThrow();
    },
  );

  it("X2: prints no escape sequence or invisible character a server error carries", async () => {
    h.signIn();
    await mkdir(h.workspace, { recursive: true });
    const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(doc, { published: { "index.md": "x" } });
    const evil =
      "\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 \u001b[2J\u202eolleh\u200b\u009b";
    for (const json of [false, true]) {
      server.faults.push({
        method: "GET",
        path: new RegExp(`^/api/v1/artifacts/${doc.id}/versions`),
        reply: {
          status: 403,
          body: Buffer.from(JSON.stringify({ error: { code: "forbidden", message: evil } })),
        },
      });
      const result = await h.invoke(
        "export",
        join(h.workspace, `export-${json}`),
        ...(json ? ["--json"] : []),
      );
      const printed = result.stderr + result.stdout;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
      expect(printed).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u202e]/);
      expect(printed).not.toContain("\\u001b");
      expect(printed).toContain("olleh");
    }
  });

  it("X3: a hard failure leaves no manifest, so the folder does not claim a finished export", async () => {
    h.signIn();
    space();
    const out = join(h.workspace, "export");
    expect((await h.invoke("export", out)).code).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      server.faults.push({
        method: "GET",
        path: /^\/(?!api\/)/,
        reply: { status: 500, body: Buffer.from("") },
      });
    }
    server.api.seedVersion(
      server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 }),
      {
        published: { "new.md": "new" },
      },
    );
    const result = await h.invoke("export", out, "--json");
    expect(result.code).toBe(1);
    await expect(lstat(join(out, "manifest.json"))).rejects.toThrow();
    await expect(lstat(join(out, ".portifact-export.lock"))).rejects.toThrow();
  });

  it.skipIf(!posix || process.getuid?.() === 0)(
    "X5: a disk error stops at once as write_failed, without retries",
    async () => {
      h.signIn();
      await mkdir(h.workspace, { recursive: true });
      const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(doc, { published: { "index.md": "x" } });
      server.api.audit.set("personal", []);
      const out = join(h.workspace, "export");
      expect((await h.invoke("export", out)).code).toBe(0);
      server.api.seedVersion(doc, { published: { "index.md": "y" } });
      const published = join(out, "artifacts", doc.id, "v2", "published");
      await mkdir(published, { recursive: true });
      await chmod(published, 0o500);
      const sleepsBefore = h.sleeps.length;
      const result = await h.invoke("export", out, "--json");
      await chmod(published, 0o700);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("write_failed");
      expect(JSON.parse(result.stdout).error.message).toContain("EACCES");
      expect(h.sleeps.length).toBe(sleepsBefore);
    },
  );

  it("stops a body larger than its size before writing more", async () => {
    h.signIn();
    const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
    server.api.seedVersion(doc, { published: { "index.md": "small" } });
    server.api.audit.set("personal", []);
    server.faults.push({
      method: "GET",
      path: /^\/r2\/objects\//,
      reply: { status: 200, body: Buffer.from("X".repeat(100_000)) },
    });
    const out = join(h.workspace, "export");
    const result = await h.invoke("export", out, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.message).toContain("sent more than its");
    expect((await readdir(join(out, ".portifact-tmp"))).length).toBe(0);
  });

  it.skipIf(!posix)(
    "X6: replaces a hard link at a file's name instead of writing through it",
    async () => {
      h.signIn();
      await mkdir(h.workspace, { recursive: true });
      const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(doc, { published: { "index.md": "SERVER" } });
      server.api.audit.set("personal", []);
      const out = join(h.workspace, "export");
      await mkdir(join(out, "artifacts", doc.id, "v1", "published"), { recursive: true });
      await writeFile(join(out, ".portifact-export"), JSON.stringify({ ownerId: "u_fake_owner" }));
      const victim = join(h.workspace, "victim.txt");
      await writeFile(victim, "precious");
      await link(victim, join(out, "artifacts", doc.id, "v1", "published", "index.md"));
      expect((await h.invoke("export", out)).code).toBe(0);
      expect(await readFile(victim, "utf8")).toBe("precious");
      expect(
        await readFile(join(out, "artifacts", doc.id, "v1", "published", "index.md"), "utf8"),
      ).toBe("SERVER");
    },
  );

  it.skipIf(!posix)(
    "X7: links at the temporary folder, the lock, the manifest and the audit file harm nothing",
    async () => {
      h.signIn();
      await mkdir(h.workspace, { recursive: true });
      const doc = server.api.seed({ type: "markdown", currentVersionId: null, versions: 0 });
      server.api.seedVersion(doc, { published: { "index.md": "x" } });
      server.api.audit.set("personal", []);
      const victim = join(h.workspace, "victim");
      await mkdir(victim);
      await writeFile(join(victim, "keep.txt"), "precious");
      for (const name of [
        ".portifact-tmp",
        ".portifact-export.lock",
        "manifest.json",
        "audit.jsonl",
      ]) {
        const out = join(h.workspace, `export-${name}`);
        await mkdir(out, { recursive: true });
        await writeFile(
          join(out, ".portifact-export"),
          JSON.stringify({ ownerId: "u_fake_owner" }),
        );
        await symlink(
          name === ".portifact-tmp" ? victim : join(victim, "keep.txt"),
          join(out, name),
        );
        const result = await h.invoke("export", out, "--json");
        expect(await readFile(join(victim, "keep.txt"), "utf8"), name).toBe("precious");
        if (name === ".portifact-export.lock") {
          // A link at the lock's name is never taken over or deleted.
          expect(result.code, name).toBe(6);
          expect((await lstat(join(out, name))).isSymbolicLink(), name).toBe(true);
        }
      }
    },
  );

  describe("the folder's lock", () => {
    const lockOf = (out: string) => join(out, ".portifact-export.lock");
    async function claimed() {
      h.signIn();
      space();
      const out = join(h.workspace, "export");
      expect((await h.invoke("export", out)).code).toBe(0);
      return out;
    }

    it("takes over a lock whose process no longer runs on this host", async () => {
      await h.cleanup();
      h = await createHarness({ server, processAlive: () => false });
      const out = await claimed();
      await writeFile(
        lockOf(out),
        JSON.stringify({ pid: 999_999, host: hostname(), token: "dead" }),
      );
      expect((await h.invoke("export", out)).code).toBe(0);
      await expect(lstat(lockOf(out))).rejects.toThrow();
    });

    it("refuses a live lock, another host's lock and an unreadable one, and keeps them", async () => {
      await h.cleanup();
      h = await createHarness({ server, processAlive: (pid) => pid === 4242 });
      const out = await claimed();
      for (const content of [
        JSON.stringify({ pid: 4242, host: hostname(), token: "live" }),
        JSON.stringify({ pid: 1, host: "another-host", token: "far" }),
        "not a lock",
      ]) {
        await writeFile(lockOf(out), content);
        const result = await h.invoke("export", out, "--json");
        expect(result.code, content).toBe(6);
        expect(JSON.parse(result.stdout).error.code).toBe("folder_in_use");
        expect(await readFile(lockOf(out), "utf8")).toBe(content);
      }
    });

    it("is taken before the folder is read: a refused folder gets no lock and no temporary folder", async () => {
      h.signIn();
      const other = await h.files("unrelated", { "notes.txt": "mine" });
      const refused = await h.invoke("export", other);
      expect(refused.code).toBe(2);
      expect((await readdir(other)).sort()).toEqual(
        [".portifact-tmp", "notes.txt"].filter((n) => n === "notes.txt"),
      );
    });

    it("is removed on Ctrl-C or kill, with the shell's codes, so the next run resumes", async () => {
      for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        await h.cleanup();
        let fired = false;
        let lockDuringStop: boolean | null = null;
        const out = join(tmpdirOf(), `stop-${signal}`);
        h = await createHarness({
          server,
          beforeFetch: (url) => {
            if (fired || !url.includes("/r2/objects/")) return;
            fired = true;
            h.signal(signal);
            lockDuringStop = existsSync(join(out, ".portifact-export.lock"));
          },
        });
        h.signIn();
        server.api.artifacts.clear();
        space();
        await h.invoke("export", out);
        expect(h.exits).toEqual([code]);
        expect(lockDuringStop).toBe(false);
        expect((await h.invoke("export", out)).code).toBe(0);
      }
    });
  });

  it("strips invisible format characters from what it prints", () => {
    for (const character of [
      "\u200e",
      "\u200f",
      "\u061c",
      "\u200b",
      "\u200c",
      "\u200d",
      "\ufeff",
      "\u00ad",
      "\u{E0041}",
      "\u202e",
      "\u2067",
      "\u001b",
      "\u009b",
      "\u007f",
    ]) {
      expect(oneLine(`a${character}b`), JSON.stringify(character)).toBe("ab");
    }
    expect(plain("line one\n\tline two")).toBe("line one\n\tline two");
  });
});
