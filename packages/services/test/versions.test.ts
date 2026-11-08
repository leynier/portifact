import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { archiveArtifact } from "../src/lifecycle.ts";
import { pruneVersions } from "../src/maintenance.ts";
import { commitPublish, type ManifestEntry, preparePublish } from "../src/publish.ts";
import {
  getVersionDownload,
  getVersionManifest,
  listVersions,
  rollbackArtifact,
} from "../src/versions.ts";

const OWNER = "u_owner";
const READER = "u_reader";
const STRANGER = "u_stranger";
const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = () => createDb(env.DB);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Files {
  published: Record<string, string>;
  source?: Record<string, string>;
}

async function manifest(files: Files): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const kind of ["published", "source"] as const) {
    for (const [path, body] of Object.entries(files[kind] ?? {})) {
      entries.push({
        path,
        kind,
        sha256: await sha256(body),
        size: body.length,
        contentType: path.endsWith(".md") ? "text/markdown" : "text/plain",
      });
    }
  }
  return entries;
}

interface Published {
  artifactId: string;
  versionId: string;
  versionNumber: number;
}

/** Prepare, upload and commit one version, as a client does. */
async function publish(
  files: Files,
  options: {
    artifactId?: string;
    base?: string | null;
    now?: number;
    type?: "markdown" | "site";
  } = {},
): Promise<Published> {
  const now = options.now ?? NOW;
  const entrypoint = Object.keys(files.published)[0] as string;
  const prepared = await preparePublish(db(), {
    ownerId: OWNER,
    ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    type: options.type ?? "markdown",
    name: "Plan",
    entrypoint,
    baseVersionId: options.base ?? null,
    files: await manifest(files),
    now,
  });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.message}`);
  for (const body of [...Object.values(files.published), ...Object.values(files.source ?? {})]) {
    const hash = await sha256(body);
    await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, body, { sha256: hash });
  }
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    ownerId: OWNER,
    sessionId: prepared.value.sessionId,
    now,
  });
  if (!committed.ok) throw new Error(`commit failed: ${committed.message}`);
  return committed.value;
}

/** Three versions one hour apart; v3 is current. */
async function threeVersions() {
  const v1 = await publish({
    published: { "index.md": "# One" },
    source: { "src/one.md": "one source" },
  });
  const v2 = await publish(
    { published: { "index.md": "# Two" } },
    { artifactId: v1.artifactId, base: v1.versionId, now: NOW + HOUR },
  );
  const v3 = await publish(
    { published: { "index.md": "# Three", "notes.md": "notes" } },
    { artifactId: v1.artifactId, base: v2.versionId, now: NOW + 2 * HOUR },
  );
  return { id: v1.artifactId, v1, v2, v3 };
}

async function artifactRow(id: string) {
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  if (!row) throw new Error("artifact missing");
  return row;
}

async function count(table: string, where = "1 = 1", ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table} where ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  const listed = await env.ARTIFACTS.list();
  if (listed.objects.length > 0) await env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
  for (const table of [
    "version_files",
    "versions",
    "objects",
    "artifact_readers",
    "artifacts",
    "upload_sessions",
    "account_usage",
    "usage_events",
    "lifecycle_events",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [
        { id: OWNER, name: "Owner", email: "owner@example.com", emailVerified: true },
        { id: READER, name: "Reader", email: "reader@example.com", emailVerified: true },
        { id: STRANGER, name: "Stranger", email: "stranger@example.com", emailVerified: true },
      ].map((user) => ({ ...user, createdAt: at, updatedAt: at })),
    );
});

describe("listVersions", () => {
  it("lists retained versions newest first, with the current one marked and no expiry", async () => {
    const { id, v1, v2, v3 } = await threeVersions();
    const page = await listVersions(db(), {
      ownerId: OWNER,
      artifactId: id,
      now: NOW + 3 * HOUR,
      limit: 50,
    });
    if (!page.ok) throw new Error(page.message);
    expect(page.value.nextCursor).toBeNull();
    expect(page.value.items.map((item) => [item.id, item.number, item.current])).toEqual([
      [v3.versionId, 3, true],
      [v2.versionId, 2, false],
      [v1.versionId, 1, false],
    ]);
    const [current, second, first] = page.value.items;
    expect(current).toMatchObject({
      entrypoint: "index.md",
      publishedFiles: 2,
      sourceFiles: 0,
      publishedBytes: "# Three".length + "notes".length,
      committedAt: NOW + 2 * HOUR,
      expiresAt: null,
    });
    // A previous version is retained for seven days after it stops being current.
    expect(second?.expiresAt).toBe(NOW + 2 * HOUR + 7 * DAY);
    expect(first).toMatchObject({
      publishedFiles: 1,
      sourceFiles: 1,
      sourceBytes: "one source".length,
      expiresAt: NOW + HOUR + 7 * DAY,
    });
  });

  it("pages with a cursor and refuses a forged one", async () => {
    const { id, v1, v2, v3 } = await threeVersions();
    const first = await listVersions(db(), { ownerId: OWNER, artifactId: id, now: NOW, limit: 2 });
    if (!first.ok) throw new Error(first.message);
    expect(first.value.items.map((item) => item.id)).toEqual([v3.versionId, v2.versionId]);
    expect(first.value.nextCursor).toBe("2");
    const second = await listVersions(db(), {
      ownerId: OWNER,
      artifactId: id,
      now: NOW,
      limit: 2,
      cursor: first.value.nextCursor ?? "",
    });
    expect(second).toMatchObject({ ok: true, value: { nextCursor: null } });
    if (second.ok) expect(second.value.items.map((item) => item.id)).toEqual([v1.versionId]);
    for (const cursor of ["0", "x", "-1", "1234567890", ""]) {
      expect(
        await listVersions(db(), { ownerId: OWNER, artifactId: id, now: NOW, limit: 2, cursor }),
      ).toMatchObject({ ok: false, code: "invalid_input" });
    }
  });

  it("leaves out versions past their retention and uploads that never committed", async () => {
    const { id, v1, v2, v3 } = await threeVersions();
    // An upload prepared on top of v3 and never committed.
    await preparePublish(db(), {
      ownerId: OWNER,
      artifactId: id,
      type: "markdown",
      name: "Plan",
      entrypoint: "index.md",
      baseVersionId: v3.versionId,
      files: await manifest({ published: { "index.md": "# Four" } }),
      now: NOW + 3 * HOUR,
    });
    // v1 stopped being current at NOW + 1h, so at exactly 7 days later it is gone.
    const later = await listVersions(db(), {
      ownerId: OWNER,
      artifactId: id,
      now: NOW + HOUR + 7 * DAY,
      limit: 50,
    });
    if (!later.ok) throw new Error(later.message);
    expect(later.value.items.map((item) => item.id)).toEqual([v3.versionId, v2.versionId]);
    expect(v1.versionId).not.toBe(v2.versionId);
  });

  it("keeps the versions of an archived artifact visible to its owner", async () => {
    const { id, v3 } = await threeVersions();
    await archiveArtifact(db(), { ownerId: OWNER, artifactId: id, now: NOW + 3 * HOUR });
    const page = await listVersions(db(), {
      ownerId: OWNER,
      artifactId: id,
      now: NOW + 3 * HOUR,
      limit: 1,
    });
    expect(page).toMatchObject({ ok: true, value: { nextCursor: "3" } });
    if (page.ok) expect(page.value.items[0]?.id).toBe(v3.versionId);
  });

  it("answers not_found for another account's artifact, a missing one and a deleted one", async () => {
    const { id } = await threeVersions();
    for (const [ownerId, artifactId] of [
      [STRANGER, id],
      [OWNER, "abcdefghij"],
    ] as const) {
      expect(await listVersions(db(), { ownerId, artifactId, now: NOW, limit: 10 })).toMatchObject({
        ok: false,
        code: "not_found",
      });
    }
    await env.DB.prepare("update artifacts set state = 'deleted' where id = ?").bind(id).run();
    expect(
      await listVersions(db(), { ownerId: OWNER, artifactId: id, now: NOW, limit: 10 }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("getVersionManifest", () => {
  it("returns every file of a version, published and source, and resolves current", async () => {
    const { id, v1, v3 } = await threeVersions();
    const old = await getVersionManifest(db(), {
      ownerId: OWNER,
      artifactId: id,
      versionId: v1.versionId,
      now: NOW + 3 * HOUR,
    });
    if (!old.ok) throw new Error(old.message);
    expect(old.value.artifactId).toBe(id);
    expect(old.value.version).toMatchObject({ id: v1.versionId, number: 1, current: false });
    expect(old.value.files).toEqual([
      {
        path: "index.md",
        kind: "published",
        sha256: await sha256("# One"),
        size: 5,
        contentType: "text/markdown; charset=utf-8",
      },
      {
        path: "src/one.md",
        kind: "source",
        sha256: await sha256("one source"),
        size: 10,
        contentType: "text/markdown",
      },
    ]);
    const current = await getVersionManifest(db(), {
      ownerId: OWNER,
      artifactId: id,
      versionId: "current",
      now: NOW,
    });
    expect(current).toMatchObject({
      ok: true,
      value: { version: { id: v3.versionId, current: true } },
    });
  });

  it("answers not_found for a stranger, an expired version and another artifact's version", async () => {
    const { id, v1 } = await threeVersions();
    const other = await publish({ published: { "index.md": "# Other" } });
    const missing = { ok: false, code: "not_found" };
    expect(
      await getVersionManifest(db(), {
        ownerId: STRANGER,
        artifactId: id,
        versionId: v1.versionId,
        now: NOW,
      }),
    ).toMatchObject(missing);
    expect(
      await getVersionManifest(db(), {
        ownerId: OWNER,
        artifactId: id,
        versionId: v1.versionId,
        now: NOW + HOUR + 7 * DAY,
      }),
    ).toMatchObject(missing);
    expect(
      await getVersionManifest(db(), {
        ownerId: OWNER,
        artifactId: id,
        versionId: other.versionId,
        now: NOW,
      }),
    ).toMatchObject(missing);
  });
});

describe("getVersionDownload", () => {
  async function readable(type: "markdown" | "site" = "markdown") {
    const v1 = await publish(
      {
        published: { "index.md": "# Doc", "img/a.txt": "a" },
        source: { "draft.md": "secret draft" },
      },
      { type },
    );
    const v2 = await publish(
      { published: { "index.md": "# Doc 2" } },
      { artifactId: v1.artifactId, base: v1.versionId, now: NOW + HOUR, type },
    );
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: v1.artifactId, email: "reader@example.com" });
    return { id: v1.artifactId, v1, v2 };
  }

  const download = (
    userId: string,
    artifactId: string,
    versionId: string,
    kind: "published" | "source" = "published",
    path?: string,
  ) => getVersionDownload(db(), { userId, artifactId, versionId, kind, path, now: NOW + 2 * HOUR });

  it("lets the owner download published files and sources of any retained version", async () => {
    const { id, v1 } = await readable();
    const published = await download(OWNER, id, v1.versionId);
    if (!published.ok) throw new Error(published.message);
    expect(published.value).toMatchObject({
      artifactId: id,
      versionId: v1.versionId,
      versionNumber: 1,
      kind: "published",
      entrypoint: "index.md",
    });
    expect(published.value.files.map((file) => file.path)).toEqual(["img/a.txt", "index.md"]);
    const hash = await sha256("# Doc");
    expect(published.value.files[1]).toEqual({
      path: "index.md",
      sha256: hash,
      size: 5,
      contentType: "text/markdown; charset=utf-8",
      r2Key: `objects/${OWNER}/${hash}`,
    });
    const sources = await download(OWNER, id, v1.versionId, "source");
    expect(sources).toMatchObject({ ok: true, value: { kind: "source" } });
    if (sources.ok) expect(sources.value.files.map((file) => file.path)).toEqual(["draft.md"]);
  });

  it("downloads one file by path, normalized, and refuses unknown or invalid paths", async () => {
    const { id } = await readable();
    const one = await download(OWNER, id, "current", "published", "./index.md");
    expect(one).toMatchObject({ ok: true });
    if (one.ok) expect(one.value.files.map((file) => file.path)).toEqual(["index.md"]);
    expect(await download(OWNER, id, "current", "published", "nope.md")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await download(OWNER, id, "current", "published", "../index.md")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("lets an authorized reader download only the published files of the current document", async () => {
    const { id, v1, v2 } = await readable();
    const current = await download(READER, id, "current");
    expect(current).toMatchObject({ ok: true, value: { versionId: v2.versionId } });
    expect(await download(READER, id, v2.versionId)).toMatchObject({ ok: true });

    const refused = { ok: false, code: "not_found" };
    // Sources are the owner's, and previous versions stay in the owner's history.
    expect(await download(READER, id, "current", "source")).toMatchObject(refused);
    expect(await download(READER, id, v1.versionId)).toMatchObject(refused);
    // Someone the policy does not admit gets the same answer as for a missing artifact.
    expect(await download(STRANGER, id, "current")).toMatchObject(refused);
    expect(await download(READER, "abcdefghij", "current")).toMatchObject(refused);
  });

  it("stops a reader's downloads once access is revoked or the artifact is archived", async () => {
    const { id } = await readable();
    await updateAccess(db(), {
      ownerId: OWNER,
      artifactId: id,
      change: { removeReaders: ["reader@example.com"] },
      now: NOW + HOUR,
    });
    expect(await download(READER, id, "current")).toMatchObject({ ok: false, code: "not_found" });

    const other = await readable();
    await archiveArtifact(db(), { ownerId: OWNER, artifactId: other.id, now: NOW + HOUR });
    expect(await download(READER, other.id, "current")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    // The owner can still take the files out of an archived artifact.
    expect(await download(OWNER, other.id, "current", "source")).toMatchObject({ ok: true });
  });

  it("does not let readers download the files of a site", async () => {
    const { id } = await readable("site");
    expect(await download(READER, id, "current")).toMatchObject({ ok: false, code: "not_found" });
    expect(await download(OWNER, id, "current")).toMatchObject({ ok: true });
  });

  it("refuses a version past its retention, also to the owner", async () => {
    const { id, v1 } = await readable();
    const late = await getVersionDownload(db(), {
      userId: OWNER,
      artifactId: id,
      versionId: v1.versionId,
      kind: "published",
      now: NOW + HOUR + 7 * DAY,
    });
    expect(late).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("rollbackArtifact", () => {
  const rollback = (
    artifactId: string,
    versionId: string,
    baseVersionId: string,
    now = NOW + 3 * HOUR,
  ) => rollbackArtifact(db(), { ownerId: OWNER, artifactId, versionId, baseVersionId, now });

  it("publishes the files of a retained version as a new current version", async () => {
    const { id, v1, v3 } = await threeVersions();
    const objectsBefore = await count("objects");
    const [usageBefore] = await db().select().from(schema.accountUsage);
    const at = NOW + 3 * HOUR;

    const result = await rollback(id, v1.versionId, v3.versionId, at);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toMatchObject({
      artifactId: id,
      versionNumber: 4,
      fromVersionId: v1.versionId,
      fromVersionNumber: 1,
      expiresAt: at + 30 * DAY,
    });
    expect(result.value.versionId).toMatch(/^ver_[0-9a-f]{32}$/);

    const artifact = await artifactRow(id);
    expect(artifact).toMatchObject({
      currentVersionId: result.value.versionId,
      state: "active",
      expiresAt: at + 30 * DAY,
      updatedAt: at,
    });
    const manifestOf = async (versionId: string) => {
      const m = await getVersionManifest(db(), {
        ownerId: OWNER,
        artifactId: id,
        versionId,
        now: at,
      });
      if (!m.ok) throw new Error(m.message);
      return m.value;
    };
    const restored = await manifestOf(result.value.versionId);
    expect(restored.files).toEqual((await manifestOf(v1.versionId)).files);
    expect(restored.version).toMatchObject({
      number: 4,
      current: true,
      committedAt: at,
      entrypoint: "index.md",
    });

    // Nothing was uploaded or stored again: the new version references the same objects.
    expect(await count("objects")).toBe(objectsBefore);
    const [usageAfter] = await db().select().from(schema.accountUsage);
    expect(usageAfter?.storedBytes).toBe(usageBefore?.storedBytes);
    // The version it replaced is retained for seven days; the target keeps its own retention.
    const [base] = await db()
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, v3.versionId));
    expect(base?.expiresAt).toBe(at + 7 * DAY);
    const [target] = await db()
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, v1.versionId));
    expect(target?.expiresAt).toBe(NOW + HOUR + 7 * DAY);
    // It counts as a publish and is recorded.
    expect(await count("usage_events", "kind = 'publish' and at = ?", at)).toBe(1);
    const event = await env.DB.prepare(
      "select event, details from lifecycle_events where artifact_id = ? and event = 'rolled_back'",
    )
      .bind(id)
      .first<{ event: string; details: string }>();
    expect(JSON.parse(event?.details ?? "{}")).toEqual({
      fromVersionId: v1.versionId,
      versionId: result.value.versionId,
    });
  });

  it("never brings back access that was removed after the target version", async () => {
    const { id, v1, v3 } = await threeVersions();
    await db()
      .insert(schema.artifactReaders)
      .values({ artifactId: id, email: "reader@example.com" });
    const removed = await updateAccess(db(), {
      ownerId: OWNER,
      artifactId: id,
      change: { removeReaders: ["reader@example.com"], mode: "restricted" },
      now: NOW + 2 * HOUR,
    });
    if (!removed.ok) throw new Error(removed.message);
    expect(await rollback(id, v1.versionId, v3.versionId)).toMatchObject({ ok: true });
    const artifact = await artifactRow(id);
    expect(artifact.accessMode).toBe("restricted");
    expect(artifact.policyGeneration).toBe(removed.value.policyGeneration);
    expect(await count("artifact_readers", "artifact_id = ?", id)).toBe(0);
  });

  it("keeps the objects alive after the target version is pruned", async () => {
    const { id, v1, v3 } = await threeVersions();
    const rolled = await rollback(id, v1.versionId, v3.versionId);
    if (!rolled.ok) throw new Error(rolled.message);
    await pruneVersions(db(), env.ARTIFACTS, NOW + 30 * DAY);
    expect(await count("versions", "id = ?", v1.versionId)).toBe(0);
    const files = await getVersionDownload(db(), {
      userId: OWNER,
      artifactId: id,
      versionId: "current",
      kind: "source",
      now: NOW + 30 * DAY,
    });
    if (!files.ok) throw new Error(files.message);
    for (const file of files.value.files) {
      expect(await env.ARTIFACTS.head(file.r2Key), file.path).not.toBeNull();
    }
  });

  it("refuses a stale base, the current version and versions that are not retained", async () => {
    const { id, v1, v2, v3 } = await threeVersions();
    const other = await publish({ published: { "index.md": "# Other" } });
    expect(await rollback(id, v1.versionId, v2.versionId)).toMatchObject({
      ok: false,
      code: "version_conflict",
    });
    expect(await rollback(id, v3.versionId, v3.versionId)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await rollback(id, "current", v3.versionId)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await rollback(id, other.versionId, v3.versionId)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await rollback(id, v1.versionId, v3.versionId, NOW + HOUR + 7 * DAY)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect((await artifactRow(id)).currentVersionId).toBe(v3.versionId);
    expect(await count("versions", "artifact_id = ?", id)).toBe(3);
  });

  it("refuses another account, archived, suspended and unpublished artifacts", async () => {
    const { id, v1, v3 } = await threeVersions();
    expect(
      await rollbackArtifact(db(), {
        ownerId: STRANGER,
        artifactId: id,
        versionId: v1.versionId,
        baseVersionId: v3.versionId,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });

    await env.DB.prepare("update artifacts set state = 'suspended' where id = ?").bind(id).run();
    expect(await rollback(id, v1.versionId, v3.versionId)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    await env.DB.prepare("update artifacts set state = 'archived' where id = ?").bind(id).run();
    expect(await rollback(id, v1.versionId, v3.versionId)).toMatchObject({
      ok: false,
      code: "artifact_archived",
    });

    await env.DB.prepare(
      "update artifacts set state = 'draft', current_version_id = null where id = ?",
    )
      .bind(id)
      .run();
    expect(await rollback(id, v1.versionId, v3.versionId)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("counts against the publishes per 24 hours", async () => {
    const { id, v1, v3 } = await threeVersions();
    await env.DB.prepare(
      "insert into usage_events (owner_id, kind, amount, at) values (?, 'publish', 97, ?)",
    )
      .bind(OWNER, NOW + 2 * HOUR)
      .run();
    expect(await rollback(id, v1.versionId, v3.versionId)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    // A day later the window has moved on.
    expect(await rollback(id, v1.versionId, v3.versionId, NOW + 2 * HOUR + DAY + 1)).toMatchObject({
      ok: true,
    });
  });

  it("lets exactly one of two concurrent rollbacks on the same base apply", async () => {
    const { id, v1, v2, v3 } = await threeVersions();
    const results = await Promise.all([
      rollback(id, v1.versionId, v3.versionId),
      rollback(id, v2.versionId, v3.versionId),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ code: "version_conflict" }]);
    expect(await count("versions", "artifact_id = ?", id)).toBe(4);
    expect(await count("usage_events", "kind = 'publish' and at = ?", NOW + 3 * HOUR)).toBe(1);
    expect(await count("lifecycle_events", "event = 'rolled_back'")).toBe(1);
  });

  it("wins against a publish prepared on the same base, which then conflicts", async () => {
    const { id, v1, v3 } = await threeVersions();
    const body = "# Four";
    const prepared = await preparePublish(db(), {
      ownerId: OWNER,
      artifactId: id,
      type: "markdown",
      name: "Plan",
      entrypoint: "index.md",
      baseVersionId: v3.versionId,
      files: await manifest({ published: { "index.md": body } }),
      now: NOW + 3 * HOUR,
    });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.value.versionNumber).toBe(4);

    const rolled = await rollback(id, v1.versionId, v3.versionId);
    // The open upload holds number 4, so the rollback takes the next one.
    expect(rolled).toMatchObject({ ok: true, value: { versionNumber: 5 } });

    const hash = await sha256(body);
    await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, body, { sha256: hash });
    const commit = await commitPublish(db(), env.ARTIFACTS, {
      ownerId: OWNER,
      sessionId: prepared.value.sessionId,
      now: NOW + 3 * HOUR,
    });
    expect(commit).toMatchObject({ ok: false, code: "version_conflict" });
    if (rolled.ok) expect((await artifactRow(id)).currentVersionId).toBe(rolled.value.versionId);
  });
});
