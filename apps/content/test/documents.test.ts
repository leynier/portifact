// Delivery of Markdown and text artifacts. Each test publishes through the real publish
// services, so the document is rendered inside workerd exactly as a commit renders it.
import { env } from "cloudflare:test";
import { READ_SESSION } from "@portifact/contracts";
import { createDb } from "@portifact/db";
import { commitPublish, preparePublish } from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import { READ_COOKIE, seal } from "../src/cookies.ts";
import { attachment, handle } from "../src/index.ts";

const OWNER = "u_owner";
const NOW = Date.UTC(2026, 10, 8, 12);
const db = () => createDb(env.DB);
const encode = (text: string) => new TextEncoder().encode(text);

const NAVIGATE = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Doc {
  type: "markdown" | "text";
  files: Record<string, string>;
  accessMode?: "public" | "authenticated" | "restricted";
}

/** Publishes a document with its first file as the entrypoint and returns its artifact ID. */
async function publish({ type, files, accessMode = "public" }: Doc): Promise<string> {
  const manifest = await Promise.all(
    Object.entries(files).map(async ([path, body]) => ({
      path,
      kind: "published" as const,
      sha256: await sha256(encode(body)),
      size: encode(body).byteLength,
      contentType: path.endsWith(".png") ? "image/png" : "text/html",
    })),
  );
  const prepared = await preparePublish(db(), {
    ownerId: OWNER,
    type,
    name: "Release notes",
    entrypoint: Object.keys(files)[0] ?? "",
    baseVersionId: null,
    files: manifest,
    now: NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  for (const body of Object.values(files)) {
    const hash = await sha256(encode(body));
    await env.ARTIFACTS.put(`objects/${OWNER}/${hash}`, body, { sha256: hash });
  }
  const committed = await commitPublish(db(), env.ARTIFACTS, {
    ownerId: OWNER,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  await env.DB.prepare("UPDATE artifacts SET access_mode = ? WHERE id = ?")
    .bind(accessMode, committed.value.artifactId)
    .run();
  return committed.value.artifactId;
}

function get(id: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(NAVIGATE)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return handle(new Request(`https://${id}.portifact.dev${path}`, { ...init, headers }), env, NOW);
}

/** SHA-256 of the rendered page of the artifact's current version. */
async function renderedSha(id: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT f.sha256 FROM version_files f JOIN artifacts a ON a.current_version_id = f.version_id WHERE a.id = ? AND f.kind = 'rendered'",
  )
    .bind(id)
    .first<{ sha256: string }>();
  return row?.sha256 ?? "";
}

const MARKDOWN = "# Release\n\n![Diagram](images/diagram.png)\n\n<script>alert(1)</script>\n";
const DOCUMENT_POLICY =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

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

describe("markdown delivery", () => {
  const files = { "notes/plan.md": MARKDOWN, "notes/images/diagram.png": "png-bytes" };

  it("serves the rendered page at the root with the document policy", async () => {
    const id = await publish({ type: "markdown", files });
    const response = await get(id, "/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h1 data-pf-block="b1" id="release">Release</h1>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `${DOCUMENT_POLICY}; frame-ancestors 'self' https://app.portifact.com`,
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "cache-control": "no-cache",
      "cross-origin-resource-policy": "same-site",
      etag: `"${await renderedSha(id)}"`,
      "content-length": String(encode(html).byteLength),
    });
    expect(response.headers.has("content-disposition")).toBe(false);
  });

  it("revalidates, answers HEAD and serves ranges of the rendered page", async () => {
    const id = await publish({ type: "markdown", files });
    const etag = `"${await renderedSha(id)}"`;
    expect((await get(id, "/", { headers: { "If-None-Match": etag } })).status).toBe(304);
    const head = await get(id, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const range = await get(id, "/", { headers: { Range: "bytes=0-14" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("<!doctype html>");
  });

  it("serves the original as a download with the Markdown MIME type", async () => {
    const id = await publish({ type: "markdown", files });
    const response = await get(id, "/notes/plan.md");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MARKDOWN);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="plan.md"; filename*=UTF-8''plan.md`,
      "content-security-policy": "frame-ancestors 'self' https://app.portifact.com",
      "x-content-type-options": "nosniff",
    });
  });

  it("serves assets as files and nothing at a site's index path", async () => {
    const id = await publish({ type: "markdown", files });
    const image = await get(id, "/notes/images/diagram.png");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.has("content-disposition")).toBe(false);
    expect((await get(id, "/index.html")).status).toBe(404);
    expect((await get(id, "/notes/")).status).toBe(404);
  });

  it("answers 503 for a document that has no rendering yet", async () => {
    const id = await publish({ type: "markdown", files });
    await env.DB.exec("DELETE FROM version_files WHERE kind = 'rendered'");
    const response = await get(id, "/");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("This file is temporarily unavailable");
    expect((await get(id, "/notes/plan.md")).status).toBe(200);
  });
});

describe("text delivery", () => {
  it("serves the escaped page at the root and the original as a download", async () => {
    const body = "<b>literal</b>\n";
    const id = await publish({ type: "text", files: { "notes.txt": body } });

    const page = await get(id, "/");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain(
      '<pre class="pf-text">\n&lt;b&gt;literal&lt;/b&gt;\n</pre>',
    );

    const original = await get(id, "/notes.txt");
    expect(await original.text()).toBe(body);
    expect(original.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(original.headers.get("content-disposition")).toContain('filename="notes.txt"');
  });
});

describe("protected documents", () => {
  async function readerCookie(id: string, uid: string) {
    const value = await seal(env.READ_SESSION_SECRET, "pf_read", {
      v: 1,
      sid: "s".repeat(43),
      aid: id,
      uid,
      gen: 1,
      exp: NOW + READ_SESSION.claimsTtlSeconds * 1000,
      sexp: NOW + READ_SESSION.sessionTtlSeconds * 1000,
    });
    return `${READ_COOKIE}=${value}`;
  }

  it("sends anonymous visitors of the page and the original to sign in", async () => {
    const id = await publish({
      type: "markdown",
      files: { "plan.md": MARKDOWN },
      accessMode: "restricted",
    });
    for (const path of ["/", "/plan.md"]) {
      const response = await get(id, path);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain(`/read/${id}`);
    }
  });

  it("serves an authorized reader the page and the original, private and same-origin only", async () => {
    const id = await publish({
      type: "markdown",
      files: { "plan.md": MARKDOWN },
      accessMode: "restricted",
    });
    const cookie = await readerCookie(id, "u_reader");
    for (const path of ["/", "/plan.md"]) {
      const response = await get(id, path, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
    // A read session for another artifact opens nothing here.
    const other = await readerCookie("p3n5wq7yzc", "u_reader");
    expect((await get(id, "/", { headers: { Cookie: other } })).status).toBe(303);
  });
});

describe("attachment", () => {
  it("keeps ASCII names and gives others a safe fallback and the exact UTF-8 name", () => {
    expect(attachment("docs/plan.md")).toBe(
      `attachment; filename="plan.md"; filename*=UTF-8''plan.md`,
    );
    expect(attachment(`plán "v2"'s (draft).md`)).toBe(
      `attachment; filename="pl_n _v2_'s (draft).md"; filename*=UTF-8''pl%C3%A1n%20%22v2%22%27s%20%28draft%29.md`,
    );
  });
});
