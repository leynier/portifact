// Rendering of Markdown and text artifacts at commit, and the security re-render job. These run
// inside workerd against local D1 and R2, so they also prove the renderer works in the runtime.
import { env } from "cloudflare:test";
import { LIMITS } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { RENDERER_VERSION } from "@portifact/render";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { rerenderDocuments } from "../src/maintenance.ts";
import {
  commitPublish,
  type ManifestEntry,
  type PrepareInput,
  preparePublish,
  uploadProgress,
} from "../src/publish.ts";

const OWNER = "u_owner";
const NOW = Date.UTC(2026, 10, 8, 12);
const db = () => createDb(env.DB);
const encode = (text: string) => new TextEncoder().encode(text);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Body = string | Uint8Array;
const bytesOf = (body: Body) => (typeof body === "string" ? encode(body) : body);

async function entry(path: string, body: Body, contentType = "text/plain"): Promise<ManifestEntry> {
  const bytes = bytesOf(body);
  return {
    path,
    kind: "published",
    sha256: await sha256(bytes),
    size: bytes.byteLength,
    contentType,
  };
}

async function put(body: Body) {
  const bytes = bytesOf(body);
  const hash = await sha256(bytes);
  await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, bytes, { sha256: hash });
}

function input(
  type: PrepareInput["type"],
  files: ManifestEntry[],
  overrides: Partial<PrepareInput> = {},
): PrepareInput {
  return {
    ownerId: OWNER,
    type,
    name: "Release <notes>",
    entrypoint: files[0]?.path ?? "",
    baseVersionId: null,
    files,
    now: NOW,
    ...overrides,
  };
}

async function prepared(...args: Parameters<typeof input>) {
  const result = await preparePublish(db(), input(...args));
  if (!result.ok) throw new Error(`prepare failed: ${result.code} ${result.message}`);
  return result.value;
}

const commit = (sessionId: string, now = NOW) =>
  commitPublish(db(), env.ARTIFACTS, { ownerId: OWNER, sessionId, now });

/** Prepares, uploads and commits a single document. */
async function publish(
  type: PrepareInput["type"],
  path: string,
  body: Body,
  overrides: Partial<PrepareInput> = {},
) {
  const upload = await prepared(type, [await entry(path, body)], overrides);
  await put(body);
  const result = await commit(upload.sessionId);
  if (!result.ok) throw new Error(`commit failed: ${result.code} ${result.message}`);
  return result.value;
}

async function renderedFiles(versionId: string) {
  return db()
    .select()
    .from(schema.versionFiles)
    .where(eq(schema.versionFiles.versionId, versionId))
    .orderBy(schema.versionFiles.kind);
}

async function file(versionId: string, kind: "rendered" | "block_map") {
  const [row] = await db()
    .select()
    .from(schema.versionFiles)
    .where(and(eq(schema.versionFiles.versionId, versionId), eq(schema.versionFiles.kind, kind)));
  return row;
}

async function text(sha: string) {
  return (await env.ARTIFACTS.get(`objects/${OWNER}/${sha}`))?.text();
}

async function usage() {
  const [row] = await db()
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, OWNER));
  return row;
}

async function version(id: string) {
  const [row] = await db().select().from(schema.versions).where(eq(schema.versions.id, id));
  return row;
}

async function objectSizes(): Promise<number> {
  const rows = await db().select().from(schema.objects).where(eq(schema.objects.state, "verified"));
  return rows.reduce((sum, row) => sum + row.size, 0);
}

const MARKDOWN = "# Release\n\nShips **today**. <script>alert(1)</script>\n\n- one\n- two\n";

beforeEach(async () => {
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

describe("prepare a document", () => {
  it("stores the original with the document's MIME type whatever the client sent", async () => {
    const upload = await prepared("markdown", [await entry("plan.md", MARKDOWN, "text/html")], {
      entrypoint: "./plan.md",
    });
    const [original] = await db()
      .select()
      .from(schema.versionFiles)
      .where(eq(schema.versionFiles.versionId, upload.versionId));
    expect(original).toMatchObject({
      kind: "published",
      path: "plan.md",
      contentType: "text/markdown; charset=utf-8",
    });
    expect((await version(upload.versionId))?.entrypoint).toBe("plan.md");
  });

  it("keeps the content type of Markdown assets", async () => {
    const image = await entry("images/a.png", "png", "image/png");
    const upload = await prepared("markdown", [await entry("plan.md", MARKDOWN), image]);
    const rows = await renderedFiles(upload.versionId);
    expect(rows.find((row) => row.path === "images/a.png")?.contentType).toBe("image/png");
  });

  it("refuses a document over the size limit and a text artifact with two files", async () => {
    const big = { ...(await entry("big.md", "x")), size: LIMITS.documentBytes + 1 };
    expect(await preparePublish(db(), input("markdown", [big]))).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const two = [await entry("a.txt", "a"), await entry("b.txt", "b")];
    expect(await preparePublish(db(), input("text", two))).toEqual({
      ok: false,
      code: "invalid_input",
      message: "A text artifact publishes a single file.",
    });
    expect(await usage()).toBeUndefined();
  });
});

describe("commit a document", () => {
  it("renders Markdown once and stores the page and its block map with the version", async () => {
    const result = await publish("markdown", "plan.md", MARKDOWN);
    const sourceSha = await sha256(encode(MARKDOWN));

    expect((await version(result.versionId))?.rendererVersion).toBe(RENDERER_VERSION);
    const page = await file(result.versionId, "rendered");
    const map = await file(result.versionId, "block_map");
    expect(page).toMatchObject({ path: "plan.md", contentType: "text/html; charset=utf-8" });
    expect(map).toMatchObject({ path: "plan.md", contentType: "application/json" });

    const html = (await text(page?.sha256 ?? "")) ?? "";
    expect(html).toContain("<title>Release &lt;notes&gt;</title>");
    expect(html).toContain('<h1 data-pf-block="b1" id="release">Release</h1>');
    expect(html).toContain("<strong>today</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(encode(html).byteLength).toBe(page?.size);

    const blocks = JSON.parse((await text(map?.sha256 ?? "")) ?? "{}");
    expect(blocks).toMatchObject({ rendererVersion: RENDERER_VERSION, sourceSha256: sourceSha });
    expect(blocks.headings).toEqual([{ id: "release", level: 1, text: "Release" }]);
    expect(blocks.blocks[0]).toMatchObject({ tag: "h1", startLine: 1, endLine: 1, start: 0 });
  });

  it("renders text literally, with no block map", async () => {
    const body = "<b>not bold</b>\n& more";
    const result = await publish("text", "notes.txt", body);
    const page = await file(result.versionId, "rendered");
    const html = (await text(page?.sha256 ?? "")) ?? "";
    expect(html).toContain('<pre class="pf-text">\n&lt;b&gt;not bold&lt;/b&gt;\n&amp; more</pre>');
    expect(await file(result.versionId, "block_map")).toBeUndefined();
    expect((await version(result.versionId))?.rendererVersion).toBe(RENDERER_VERSION);
  });

  it("counts the rendered bytes in storage, once", async () => {
    const result = await publish("markdown", "plan.md", MARKDOWN);
    const page = await file(result.versionId, "rendered");
    const map = await file(result.versionId, "block_map");
    const expected = encode(MARKDOWN).byteLength + (page?.size ?? 0) + (map?.size ?? 0);
    expect(await usage()).toMatchObject({ storedBytes: expected, reservedBytes: 0 });
    expect(await objectSizes()).toBe(expected);

    // The same document again renders to the same objects, which the account already stores.
    await publish("markdown", "plan.md", MARKDOWN, {
      artifactId: result.artifactId,
      baseVersionId: result.versionId,
    });
    expect(await usage()).toMatchObject({ storedBytes: expected });
  });

  it("counts renderings shared by two racing commits once", async () => {
    await publish("markdown", "plan.md", MARKDOWN, { name: "First" });
    // The source is stored now, so both uploads reserve nothing and render the same new page.
    const a = await prepared("markdown", [await entry("plan.md", MARKDOWN)], { name: "Same" });
    const b = await prepared("markdown", [await entry("plan.md", MARKDOWN)], { name: "Same" });
    expect([a.uploads, b.uploads]).toEqual([[], []]);

    const results = await Promise.all([commit(a.sessionId), commit(b.sessionId)]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(await usage()).toMatchObject({ reservedBytes: 0, storedBytes: await objectSizes() });
  });

  it("does not render sites", async () => {
    const result = await publish("site", "index.html", "<h1>Site</h1>");
    expect((await version(result.versionId))?.rendererVersion).toBeNull();
    expect((await renderedFiles(result.versionId)).map((row) => row.kind)).toEqual(["published"]);
  });

  it.each([
    ["invalid UTF-8", new Uint8Array([0x23, 0x20, 0xc3, 0x28])],
    ["binary data", new Uint8Array([0x23, 0x00, 0x41])],
  ])("refuses %s and releases the upload", async (_, body) => {
    const upload = await prepared("markdown", [await entry("plan.md", body)]);
    await put(body);
    expect(await commit(upload.sessionId)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await usage()).toMatchObject({ openUploads: 0, reservedBytes: 0, activeArtifacts: 0 });
    const [session] = await db().select().from(schema.uploadSessions);
    expect(session?.state).toBe("failed");
    expect(await file(upload.versionId, "rendered")).toBeUndefined();
  });

  it("refuses a rendering that would pass the account's storage", async () => {
    const upload = await prepared("markdown", [await entry("plan.md", MARKDOWN)]);
    await put(MARKDOWN);
    // Leave room for the source the reservation holds, but not for its rendering.
    await env.DB.prepare("UPDATE account_usage SET stored_bytes = ? - reserved_bytes - 10")
      .bind(LIMITS.accountBytes)
      .run();

    expect(await commit(upload.sessionId)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "With its rendered page, this publish exceeds your storage.",
    });
    expect(await usage()).toMatchObject({
      storedBytes: LIMITS.accountBytes - encode(MARKDOWN).byteLength - 10,
      reservedBytes: 0,
      openUploads: 0,
      activeArtifacts: 0,
    });
    const [artifact] = await db().select().from(schema.artifacts);
    expect(artifact?.currentVersionId ?? null).toBeNull();
  });

  it("refuses a version whose rendering takes it past the version size", async () => {
    const upload = await prepared("markdown", [await entry("plan.md", MARKDOWN)]);
    await put(MARKDOWN);
    await db()
      .update(schema.versions)
      .set({ publishedBytes: LIMITS.artifactBytes - 10 })
      .where(eq(schema.versions.id, upload.versionId));
    expect(await commit(upload.sessionId)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(await usage()).toMatchObject({ openUploads: 0, reservedBytes: 0 });
  });

  it("finishes a commit that stopped after recording its rendering", async () => {
    const upload = await prepared("markdown", [await entry("plan.md", MARKDOWN)]);
    await put(MARKDOWN);
    // A rendering recorded by an interrupted attempt, whose bytes never reached R2.
    const stale = "f".repeat(64);
    await db()
      .insert(schema.objects)
      .values({
        ownerId: OWNER,
        sha256: stale,
        size: 5,
        r2Key: `objects/${OWNER}/${stale}`,
      });
    await db().insert(schema.versionFiles).values({
      versionId: upload.versionId,
      kind: "rendered",
      path: "plan.md",
      ownerId: OWNER,
      sha256: stale,
      size: 5,
      contentType: "text/html; charset=utf-8",
    });
    const progress = await uploadProgress(db(), {
      ownerId: OWNER,
      sessionId: upload.sessionId,
      now: NOW,
    });
    expect(progress.ok && progress.value.uploads.map((u) => u.sha256)).toEqual([
      await sha256(encode(MARKDOWN)),
    ]);

    expect((await commit(upload.sessionId)).ok).toBe(true);
    const page = await file(upload.versionId, "rendered");
    expect(page?.sha256).not.toBe(stale);
    expect(await text(page?.sha256 ?? "")).toContain("<strong>today</strong>");
  });

  it("refuses a version whose document source is not stored", async () => {
    const upload = await prepared("text", [await entry("notes.txt", "hello")]);
    await put("hello");
    await env.DB.exec("DELETE FROM version_files");
    expect(await commit(upload.sessionId)).toMatchObject({
      ok: false,
      code: "upload_incomplete",
      message: "The document's source is missing.",
    });
  });
});

describe("security re-render", () => {
  /** Turns the current rendering into one from an older renderer, stored as its own object. */
  async function makeOutdated(versionId: string, recorded: string | null) {
    const page = await file(versionId, "rendered");
    const oldPage = encode(`<p>old rendering of ${versionId}</p>`);
    const oldSha = await sha256(oldPage);
    await env.ARTIFACTS.put(`objects/${OWNER}/${oldSha}`, oldPage);
    await env.ARTIFACTS.delete(`objects/${OWNER}/${page?.sha256}`);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM objects WHERE sha256 = ?").bind(page?.sha256),
      env.DB.prepare(
        "INSERT INTO objects (owner_id, sha256, size, r2_key, state) VALUES (?, ?, ?, ?, 'verified')",
      ).bind(OWNER, oldSha, oldPage.byteLength, `objects/${OWNER}/${oldSha}`),
      env.DB.prepare(
        "UPDATE version_files SET sha256 = ?, size = ? WHERE version_id = ? AND kind = 'rendered'",
      ).bind(oldSha, oldPage.byteLength, versionId),
      env.DB.prepare("UPDATE account_usage SET stored_bytes = stored_bytes - ? + ?").bind(
        page?.size,
        oldPage.byteLength,
      ),
      env.DB.prepare("UPDATE versions SET renderer_version = ? WHERE id = ?").bind(
        recorded,
        versionId,
      ),
    ]);
    return { oldSha, oldSize: oldPage.byteLength, newSha: page?.sha256 ?? "" };
  }

  it("leaves current renderings alone", async () => {
    await publish("markdown", "plan.md", MARKDOWN);
    expect(await rerenderDocuments(db(), env.ARTIFACTS, NOW)).toEqual({ processed: 0 });
  });

  it.each([
    ["older", "0"],
    ["missing", null],
    ["malformed", "x"],
  ])("replaces an %s rendering and frees the old one", async (_, recorded) => {
    const result = await publish("markdown", "plan.md", MARKDOWN);
    const { oldSha, newSha } = await makeOutdated(result.versionId, recorded);

    expect(await rerenderDocuments(db(), env.ARTIFACTS, NOW)).toEqual({ processed: 1 });

    expect((await version(result.versionId))?.rendererVersion).toBe(RENDERER_VERSION);
    expect((await file(result.versionId, "rendered"))?.sha256).toBe(newSha);
    expect(await text(newSha)).toContain("<strong>today</strong>");
    expect(await env.ARTIFACTS.head(`objects/${OWNER}/${oldSha}`)).toBeNull();
    expect((await usage())?.storedBytes).toBe(await objectSizes());
    expect(await rerenderDocuments(db(), env.ARTIFACTS, NOW)).toEqual({ processed: 0 });
  });

  it("applies once when two runs race", async () => {
    const result = await publish("text", "notes.txt", "hello");
    await makeOutdated(result.versionId, "0");
    await Promise.all([
      rerenderDocuments(db(), env.ARTIFACTS, NOW),
      rerenderDocuments(db(), env.ARTIFACTS, NOW),
    ]);
    expect((await version(result.versionId))?.rendererVersion).toBe(RENDERER_VERSION);
    expect((await usage())?.storedBytes).toBe(await objectSizes());
  });

  it("applies a fix to an account at its storage limit, counting up to the limit", async () => {
    const result = await publish("markdown", "plan.md", MARKDOWN);
    const { oldSize } = await makeOutdated(result.versionId, "0");
    await env.DB.prepare("UPDATE account_usage SET stored_bytes = ?")
      .bind(LIMITS.accountBytes)
      .run();

    expect(await rerenderDocuments(db(), env.ARTIFACTS, NOW)).toEqual({ processed: 1 });
    const page = await file(result.versionId, "rendered");
    expect(await text(page?.sha256 ?? "")).toContain("<strong>today</strong>");
    // The old page was freed after the new one was counted at the limit.
    expect((await usage())?.storedBytes).toBe(LIMITS.accountBytes - oldSize);
  });

  it("re-renders archived documents but not sites, deleted artifacts or lost sources", async () => {
    const archived = await publish("text", "a.txt", "archived");
    await makeOutdated(archived.versionId, "0");
    await db()
      .update(schema.artifacts)
      .set({ state: "archived" })
      .where(eq(schema.artifacts.id, archived.artifactId));
    const deleted = await publish("text", "b.txt", "deleted");
    await makeOutdated(deleted.versionId, "0");
    await db()
      .update(schema.artifacts)
      .set({ state: "deleted" })
      .where(eq(schema.artifacts.id, deleted.artifactId));
    const lost = await publish("text", "c.txt", "lost");
    await makeOutdated(lost.versionId, "0");
    await env.ARTIFACTS.delete(`objects/${OWNER}/${await sha256(encode("lost"))}`);
    const site = await publish("site", "index.html", "<p>site</p>");
    await db()
      .update(schema.versions)
      .set({ rendererVersion: "0" })
      .where(eq(schema.versions.id, site.versionId));

    expect(await rerenderDocuments(db(), env.ARTIFACTS, NOW)).toEqual({ processed: 1 });
    expect((await version(archived.versionId))?.rendererVersion).toBe(RENDERER_VERSION);
    expect((await version(deleted.versionId))?.rendererVersion).toBe("0");
    expect((await version(lost.versionId))?.rendererVersion).toBe("0");
  });
});
