import { env } from "cloudflare:test";
import { LIMITS } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abortPublish,
  commitPublish,
  type ManifestEntry,
  type PrepareInput,
  preparePublish,
  uploadProgress,
  validateManifest,
} from "../src/publish.ts";
import { racing } from "./fixtures.ts";

const OWNER = "u_owner";
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const db = () => createDb(env.DB);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function entry(
  path: string,
  body: string,
  kind: ManifestEntry["kind"] = "published",
): Promise<ManifestEntry> {
  return { path, kind, sha256: await sha256(body), size: body.length, contentType: "text/html" };
}

async function site(bodies: Record<string, string>): Promise<ManifestEntry[]> {
  return Promise.all(Object.entries(bodies).map(([path, body]) => entry(path, body)));
}

function input(files: ManifestEntry[], overrides: Partial<PrepareInput> = {}): PrepareInput {
  return {
    ownerId: OWNER,
    type: "site",
    name: "Migration plan",
    entrypoint: "index.html",
    baseVersionId: null,
    files,
    now: NOW,
    ...overrides,
  };
}

async function upload(bodies: Record<string, string>, ownerId = OWNER, withChecksum = true) {
  for (const body of Object.values(bodies)) {
    const hash = await sha256(body);
    await env.ARTIFACTS.put(
      `objects/${ownerId}/${hash}`,
      body,
      withChecksum ? { sha256: hash } : {},
    );
  }
}

async function usage() {
  const [row] = await db()
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, OWNER));
  return row;
}

async function prepared(files: ManifestEntry[], overrides: Partial<PrepareInput> = {}) {
  const result = await preparePublish(db(), input(files, overrides));
  if (!result.ok) throw new Error(`prepare failed: ${result.code} ${result.message}`);
  return result.value;
}

async function committed(sessionId: string, now = NOW) {
  const result = await commitPublish(db(), env.ARTIFACTS, { ownerId: OWNER, sessionId, now });
  if (!result.ok) throw new Error(`commit failed: ${result.code} ${result.message}`);
  return result.value;
}

const v1 = { "index.html": "<h1>Plan v1</h1>", "app.js": "console.log(1)" };
const v2 = { "index.html": "<h1>Plan v2</h1>", "app.js": "console.log(1)" };

beforeEach(async () => {
  // R2 storage persists between tests in the same file; start every test from an empty bucket.
  const listed = await env.ARTIFACTS.list();
  if (listed.objects.length > 0) await env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
  for (const table of [
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "upload_sessions",
    "account_usage",
    "usage_events",
    "lifecycle_events",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("prepare", () => {
  it("creates a draft artifact, an uploading version and reserves capacity", async () => {
    const files = await site(v1);
    const result = await prepared(files);

    expect(result.artifactId).toMatch(/^[a-z2-7]{10}$/);
    expect(result.versionNumber).toBe(1);
    expect(result.expiresAt).toBe(NOW + DAY);
    expect(result.uploads.map((u) => u.sha256).sort()).toEqual(files.map((f) => f.sha256).sort());
    expect(result.uploads[0]?.r2Key).toBe(`objects/${OWNER}/${result.uploads[0]?.sha256}`);

    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact).toMatchObject({
      state: "draft",
      accessMode: "restricted",
      currentVersionId: null,
    });
    expect(await usage()).toMatchObject({
      activeArtifacts: 1,
      openUploads: 1,
      reservedBytes: files.reduce((sum, f) => sum + f.size, 0),
      storedBytes: 0,
    });
  });

  it.each<[string, (files: ManifestEntry[]) => Partial<PrepareInput>, string]>([
    ["an entrypoint that is not published", () => ({ entrypoint: "missing.html" }), "entrypoint"],
    ["an empty manifest", () => ({ files: [] }), "no files"],
    [
      "a path that escapes the root",
      (f) => ({ files: [{ ...(f[0] as ManifestEntry), path: "../x.html" }] }),
      "`..`",
    ],
    [
      "an invalid hash",
      (f) => ({ files: [{ ...(f[0] as ManifestEntry), sha256: "abc" }] }),
      "SHA-256",
    ],
    ["a negative size", (f) => ({ files: [{ ...(f[0] as ManifestEntry), size: -1 }] }), "size"],
    [
      "an empty content type",
      (f) => ({ files: [{ ...(f[0] as ManifestEntry), contentType: "" }] }),
      "content type",
    ],
    ["an empty name", () => ({ name: "   " }), "Name"],
    [
      "a source path inside a .git folder",
      (f) => ({
        files: [...f, { ...(f[0] as ManifestEntry), kind: "source", path: "src/.GIT/config" }],
      }),
      ".git folder",
    ],
  ])("rejects %s", async (_, change, message) => {
    const files = await site(v1);
    const result = await preparePublish(db(), input(files, change(files)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });

  it("validates published files and sources separately", async () => {
    const files = [await entry("index.html", "a"), await entry("index.html", "b", "source")];
    expect(validateManifest({ files, entrypoint: "index.html" }).ok).toBe(true);
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({
      ...(files[0] as ManifestEntry),
      path: `f${i}`,
    }));
    expect(validateManifest({ files: tooMany, entrypoint: "f0" })).toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("counts private sources in storage but not in the published size", async () => {
    const files = [
      await entry("index.html", "<h1>x</h1>"),
      await entry("src/main.ts", "export {}", "source"),
    ];
    const result = await prepared(files);
    const [version] = await db()
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, result.versionId));
    expect(version).toMatchObject({ publishedBytes: 10, sourceBytes: 9 });
    expect(await usage()).toMatchObject({ reservedBytes: 19 });
  });

  it("lets only one of two racing updates claim the next version number", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);
    const base = { artifactId: first.artifactId, baseVersionId: first.versionId };
    const [a, b] = await Promise.all([
      preparePublish(db(), input(await site(v2), base)),
      preparePublish(db(), input(await site(v2), base)),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "version_conflict" });
  });

  it("lets the database stop racing admissions that would exceed the slot limit", async () => {
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: OWNER, activeArtifacts: 49, monthStartedAt: NOW });
    const results = await Promise.all([
      preparePublish(db(), input(await site(v1))),
      preparePublish(db(), input(await site(v2))),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "quota_exceeded" });
    expect(await usage()).toMatchObject({ activeArtifacts: 50 });
  });

  // Promise.all does not interleave D1 queries in the test runtime, so these races let the
  // competing prepare commit between the checks and the write batch of the other one.
  it("lets only one of two uploads that both passed the check take the last active slot", async () => {
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: OWNER, activeArtifacts: 49, monthStartedAt: NOW });
    const files1 = await site(v1);
    const files2 = await site(v2);
    let rival: Awaited<ReturnType<typeof preparePublish>> | undefined;
    const lost = await preparePublish(
      racing(async () => {
        rival = await preparePublish(db(), input(files2));
      }),
      input(files1),
    );
    expect(rival).toMatchObject({ ok: true });
    expect(lost).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(await usage()).toMatchObject({ activeArtifacts: 50, openUploads: 1 });
    expect(await db().select().from(schema.artifacts)).toHaveLength(1);
    expect(await db().select().from(schema.uploadSessions)).toHaveLength(1);
  });

  it("lets only one of two uploads that both passed the check take the last stored bytes", async () => {
    const big = { "index.html": "x".repeat(600) };
    const other = { "index.html": "y".repeat(600) };
    await db()
      .insert(schema.accountUsage)
      .values({
        ownerId: OWNER,
        storedBytes: LIMITS.accountBytes - 1_000,
        monthStartedAt: NOW,
      });
    let rival: Awaited<ReturnType<typeof preparePublish>> | undefined;
    const lost = await preparePublish(
      racing(async () => {
        rival = await preparePublish(db(), input(await site(other)));
      }),
      input(await site(big)),
    );
    expect(rival).toMatchObject({ ok: true });
    expect(lost).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(await usage()).toMatchObject({
      storedBytes: LIMITS.accountBytes - 1_000,
      reservedBytes: 600,
      openUploads: 1,
    });
  });

  it("never lets racing prepares open more uploads than the account may have at once", async () => {
    const first = await prepared(await site(v1));
    expect(await usage()).toMatchObject({ openUploads: 1 });
    let rival: Awaited<ReturnType<typeof preparePublish>> | undefined;
    const lost = await preparePublish(
      racing(async () => {
        rival = await preparePublish(db(), input(await site({ "index.html": "<h1>B</h1>" })));
      }),
      input(await site({ "index.html": "<h1>C</h1>" })),
    );
    expect(rival).toMatchObject({ ok: true });
    expect(lost).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(await usage()).toMatchObject({ openUploads: LIMITS.concurrentUploads });
    const open = await db()
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.state, "uploading"));
    expect(open.map((row) => row.id)).toContain(first.sessionId);
    expect(open).toHaveLength(LIMITS.concurrentUploads);
  });

  it("refuses a new artifact when all 50 active slots are used", async () => {
    await db()
      .insert(schema.accountUsage)
      .values({ ownerId: OWNER, activeArtifacts: 50, monthStartedAt: NOW });
    const result = await preparePublish(db(), input(await site(v1)));
    expect(result).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("hides other accounts' artifacts and protects the artifact type and state", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);

    const update = (overrides: Partial<PrepareInput>) =>
      site(v2).then((files) =>
        preparePublish(
          db(),
          input(files, {
            artifactId: first.artifactId,
            baseVersionId: first.versionId,
            ...overrides,
          }),
        ),
      );
    expect(await update({ ownerId: "u_other" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await update({ type: "markdown" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await update({ baseVersionId: "ver_stale" })).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    await db().update(schema.artifacts).set({ state: "archived" });
    expect(await update({})).toMatchObject({ ok: false, code: "artifact_archived" });
  });
});

describe("commit", () => {
  it("verifies uploads, makes the version current and moves the reservation to stored", async () => {
    const files = await site(v1);
    const first = await prepared(files);
    await upload(v1);

    const result = await committed(first.sessionId);

    expect(result).toEqual({
      artifactId: first.artifactId,
      versionId: first.versionId,
      versionNumber: 1,
      expiresAt: NOW + 30 * DAY,
    });
    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact).toMatchObject({
      state: "active",
      currentVersionId: first.versionId,
      expiresAt: NOW + 30 * DAY,
    });
    const objects = await db().select().from(schema.objects);
    expect(objects.every((o) => o.state === "verified")).toBe(true);
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    expect(await usage()).toMatchObject({
      activeArtifacts: 1,
      openUploads: 0,
      reservedBytes: 0,
      storedBytes: bytes,
    });
    const events = await db().select().from(schema.usageEvents);
    expect(events.map((e) => [e.kind, e.amount])).toEqual(
      expect.arrayContaining([
        ["publish", 1],
        ["new_files", 2],
        ["new_bytes", bytes],
      ]),
    );
  });

  it("deduplicates content the account already stores", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);

    const second = await prepared(await site(v2), {
      artifactId: first.artifactId,
      baseVersionId: first.versionId,
    });

    expect(second.versionNumber).toBe(2);
    expect(second.uploads).toHaveLength(1);
    expect(second.uploads[0]?.sha256).toBe(await sha256(v2["index.html"]));
  });

  it("asks for content another open upload declared but never sent, and commits once it arrives", async () => {
    const abandoned = await prepared(await site(v1));
    const second = await prepared(await site(v1), { name: "Other" });
    expect(second.uploads.map((u) => u.sha256).sort()).toEqual(
      abandoned.uploads.map((u) => u.sha256).sort(),
    );
    await abortPublish(db(), { ownerId: OWNER, sessionId: abandoned.sessionId, now: NOW });
    await upload(v1);
    expect((await committed(second.sessionId)).versionNumber).toBe(1);
  });

  it("keeps the previous version for seven days after an update", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);
    const second = await prepared(await site(v2), {
      artifactId: first.artifactId,
      baseVersionId: first.versionId,
    });
    await upload(v2);

    await committed(second.sessionId, NOW + 2 * 3_600_000);

    const [previous] = await db()
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, first.versionId));
    expect(previous?.expiresAt).toBe(NOW + 2 * 3_600_000 + 7 * DAY);
  });

  it("renews the artifact for 30 days from an update and keeps its URL and access", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "authenticated" })
      .where(eq(schema.artifacts.id, first.artifactId));
    const later = NOW + 10 * DAY;
    const second = await prepared(await site(v2), {
      artifactId: first.artifactId,
      baseVersionId: first.versionId,
      now: later,
    });
    await upload(v2);

    const result = await committed(second.sessionId, later);

    expect(result).toMatchObject({ artifactId: first.artifactId, expiresAt: later + 30 * DAY });
    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact).toMatchObject({
      id: first.artifactId,
      accessMode: "authenticated",
      currentVersionId: second.versionId,
      expiresAt: later + 30 * DAY,
    });
  });

  it.each<[string, () => Promise<void>, string]>([
    ["missing", async () => {}, "missing"],
    [
      "the wrong size",
      async () => {
        await env.ARTIFACTS.put(`objects/${OWNER}/${await sha256(v1["index.html"])}`, "short");
      },
      "bytes",
    ],
    [
      "different content",
      async () => {
        const fake = v1["index.html"].replace("1", "9");
        await env.ARTIFACTS.put(`objects/${OWNER}/${await sha256(v1["index.html"])}`, fake);
      },
      "hash",
    ],
  ])("refuses to commit when an object is %s", async (_, corrupt, message) => {
    const first = await prepared(await site({ "index.html": v1["index.html"] }));
    await corrupt();

    const result = await commitPublish(db(), env.ARTIFACTS, {
      ownerId: OWNER,
      sessionId: first.sessionId,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, code: "upload_incomplete" });
    if (!result.ok) expect(result.message).toContain(message);
    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact?.state).toBe("draft");
  });

  it("verifies uploads without a stored checksum by hashing the object", async () => {
    const first = await prepared(await site(v1));
    await upload(v1, OWNER, false);
    expect(
      (
        await commitPublish(db(), env.ARTIFACTS, {
          ownerId: OWNER,
          sessionId: first.sessionId,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("returns the same result when a successful commit is retried, without counting twice", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    const once = await committed(first.sessionId);
    const again = await committed(first.sessionId);

    expect(again).toEqual(once);
    expect(await usage()).toMatchObject({ openUploads: 0, reservedBytes: 0 });
    const publishes = (await db().select().from(schema.usageEvents)).filter(
      (e) => e.kind === "publish",
    );
    expect(publishes).toHaveLength(1);
  });

  it("turns a concurrent publish into a clean conflict and releases its reservation", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);
    const base = { artifactId: first.artifactId, baseVersionId: first.versionId };
    const a = await prepared(await site(v2), base);
    const b = await prepared(await site({ ...v2, "extra.html": "<p>b</p>" }), base);
    await upload({ ...v2, "extra.html": "<p>b</p>" });

    await committed(a.sessionId, NOW + 1);
    const loser = await commitPublish(db(), env.ARTIFACTS, {
      ownerId: OWNER,
      sessionId: b.sessionId,
      now: NOW + 2,
    });

    expect(loser).toMatchObject({ ok: false, code: "version_conflict" });
    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact?.currentVersionId).toBe(a.versionId);
    expect(await usage()).toMatchObject({ openUploads: 0, reservedBytes: 0 });
    const [session] = await db()
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, b.sessionId));
    expect(session?.state).toBe("failed");
  });

  it("refuses expired, foreign and closed uploads", async () => {
    const first = await prepared(await site(v1));
    const commit = (overrides: { ownerId?: string; now?: number }) =>
      commitPublish(db(), env.ARTIFACTS, {
        ownerId: OWNER,
        sessionId: first.sessionId,
        now: NOW,
        ...overrides,
      });

    expect(await commit({ ownerId: "u_other" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await commit({ now: NOW + DAY })).toMatchObject({
      ok: false,
      code: "upload_incomplete",
    });
    await abortPublish(db(), { ownerId: OWNER, sessionId: first.sessionId, now: NOW });
    expect(await commit({})).toMatchObject({ ok: false, code: "upload_incomplete" });
  });
});

describe("abort", () => {
  it("releases the reservation exactly once and removes the never-published artifact", async () => {
    const first = await prepared(await site(v1));
    const abort = () =>
      abortPublish(db(), { ownerId: OWNER, sessionId: first.sessionId, now: NOW });

    await Promise.all([abort(), abort()]);
    expect((await abort()).ok).toBe(true);

    expect(await usage()).toMatchObject({ activeArtifacts: 0, openUploads: 0, reservedBytes: 0 });
    expect(await db().select().from(schema.artifacts)).toHaveLength(0);
  });

  it("keeps a published artifact when an update is aborted", async () => {
    const first = await prepared(await site(v1));
    await upload(v1);
    await committed(first.sessionId);
    const update = await prepared(await site(v2), {
      artifactId: first.artifactId,
      baseVersionId: first.versionId,
    });

    await abortPublish(db(), { ownerId: OWNER, sessionId: update.sessionId, now: NOW });

    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact).toMatchObject({ state: "active", currentVersionId: first.versionId });
    expect(await usage()).toMatchObject({ activeArtifacts: 1, openUploads: 0, reservedBytes: 0 });
  });

  it("only lets the owner abort", async () => {
    const first = await prepared(await site(v1));
    expect(
      await abortPublish(db(), { ownerId: "u_other", sessionId: first.sessionId, now: NOW }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("upload progress", () => {
  it("lists the objects still pending of an open upload, and nothing once committed", async () => {
    const first = await prepared(await site(v1));
    const progress = await uploadProgress(db(), {
      ownerId: OWNER,
      sessionId: first.sessionId,
      now: NOW,
    });
    expect(progress.ok && progress.value.uploads.map((u) => u.sha256).sort()).toEqual(
      first.uploads.map((u) => u.sha256).sort(),
    );
    expect(progress.ok && progress.value.versionNumber).toBe(1);
    await upload(v1);
    await committed(first.sessionId);
    const after = await uploadProgress(db(), {
      ownerId: OWNER,
      sessionId: first.sessionId,
      now: NOW,
    });
    expect(after).toMatchObject({ ok: false, code: "upload_incomplete" });
  });

  it("hides another account's upload and refuses an expired one", async () => {
    const open = await prepared(await site(v1));
    expect(
      await uploadProgress(db(), { ownerId: "u_else", sessionId: open.sessionId, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await uploadProgress(db(), { ownerId: OWNER, sessionId: "upl_missing", now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await uploadProgress(db(), {
        ownerId: OWNER,
        sessionId: open.sessionId,
        now: open.expiresAt,
      }),
    ).toMatchObject({ ok: false, code: "upload_incomplete" });
  });
});
