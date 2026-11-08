import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { artifactIdFromHost, byteSpan, handle, requestedPath } from "../src/index.ts";

const ID = "k7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const sha = (c: string) => c.repeat(64);

const files = {
  "index.html": { body: "<h1>Plan</h1>", type: "text/html; charset=utf-8", hash: sha("a") },
  "docs/index.html": { body: "<h1>Docs</h1>", type: "text/html; charset=utf-8", hash: sha("b") },
  "assets/app.js": { body: "console.log('hi')", type: "text/javascript", hash: sha("c") },
  "data.txt": { body: "0123456789", type: "text/plain; charset=utf-8", hash: sha("d") },
} as const;

async function seed(overrides: Partial<typeof schema.artifacts.$inferInsert> = {}) {
  const db = createDb(env.DB);
  for (const table of ["version_files", "versions", "objects", "artifacts"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await db.insert(schema.artifacts).values({
    id: ID,
    ownerId: "u_owner",
    type: "site",
    name: "Plan",
    state: "active",
    accessMode: "public",
    currentVersionId: "v1",
    expiresAt: NOW + 10 * DAY,
    ...overrides,
  });
  await db.insert(schema.versions).values({
    id: "v1",
    artifactId: ID,
    number: 1,
    authorId: "u_owner",
    entrypoint: "index.html",
    publishedBytes: 60,
  });
  for (const [path, file] of Object.entries(files)) {
    const key = `objects/u_owner/${file.hash}`;
    await env.ARTIFACTS.put(key, file.body);
    await db.insert(schema.objects).values({
      ownerId: "u_owner",
      sha256: file.hash,
      size: file.body.length,
      r2Key: key,
      state: "verified",
    });
    await db.insert(schema.versionFiles).values({
      versionId: "v1",
      kind: "published",
      path,
      ownerId: "u_owner",
      sha256: file.hash,
      size: file.body.length,
      contentType: file.type,
    });
  }
  // A private source file shares an object with a published file but must never be served.
  await db.insert(schema.versionFiles).values({
    versionId: "v1",
    kind: "source",
    path: "src/secret.ts",
    ownerId: "u_owner",
    sha256: sha("a"),
    size: 13,
    contentType: "text/plain",
  });
}

function get(path: string, init: RequestInit = {}, origin = ORIGIN) {
  return handle(new Request(`${origin}${path}`, init), env, NOW);
}

describe("artifact delivery", () => {
  beforeEach(() => seed());

  it("serves the entrypoint at the root with security headers", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>Plan</h1>");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "cache-control": "no-cache",
      "cross-origin-resource-policy": "same-site",
      "content-security-policy": "frame-ancestors 'self' https://app.portifact.com",
      etag: `"${sha("a")}"`,
      "content-length": "13",
    });
  });

  it("serves files and directory indexes", async () => {
    expect(await (await get("/assets/app.js")).text()).toBe("console.log('hi')");
    expect(await (await get("/docs/")).text()).toBe("<h1>Docs</h1>");
    expect(await (await get("/docs")).text()).toBe("<h1>Docs</h1>");
  });

  it("returns 404 for missing files and private sources", async () => {
    expect((await get("/missing.css")).status).toBe(404);
    expect((await get("/src/secret.ts")).status).toBe(404);
  });

  it("refuses traversal, reserved and malformed paths", async () => {
    expect((await get("/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
    expect((await get("/__portifact/anything")).status).toBe(404);
    expect((await get("/%E0%A4%A")).status).toBe(404);
  });

  it("only serves hosts that are artifact origins", async () => {
    expect((await get("/", {}, "https://portifact.dev")).status).toBe(404);
    expect((await get("/", {}, `https://a.${ID}.portifact.dev`)).status).toBe(404);
    expect((await get("/", {}, `https://${ID}.example.com`)).status).toBe(404);
  });

  it("answers revalidation with 304 when the ETag matches", async () => {
    const response = await get("/", { headers: { "If-None-Match": `"${sha("a")}"` } });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(`"${sha("a")}"`);
    expect(await response.text()).toBe("");
  });

  it("answers HEAD without a body", async () => {
    const response = await get("/data.txt", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  it("serves byte ranges", async () => {
    const response = await get("/data.txt", { headers: { Range: "bytes=2-5" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
    const open = await get("/data.txt", { headers: { Range: "bytes=7-" } });
    expect(open.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await open.text()).toBe("789");
  });

  it("serves suffix ranges", async () => {
    const response = await get("/data.txt", { headers: { Range: "bytes=-3" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await response.text()).toBe("789");
  });

  it("serves artifacts without an expiry date", async () => {
    await seed({ expiresAt: null });
    expect((await get("/")).status).toBe(200);
  });

  it("handles requests through the Worker entry point", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/`), env);
    expect(response.status).toBe(200);
  });

  it("rejects other methods and service worker registration", async () => {
    const post = await get("/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await get("/assets/app.js", { headers: { "Service-Worker": "script" } })).status).toBe(
      403,
    );
  });

  it("does not serve artifacts that are not active and answers them like unknown ones", async () => {
    const unknown = await get("/", {}, "https://zzzzzzzzzz.portifact.dev");
    const unknownText = await unknown.text();
    for (const overrides of [
      { expiresAt: NOW - 1 },
      { state: "draft" as const },
      { state: "suspended" as const },
      { state: "archived" as const, archivedAt: NOW - DAY },
      { currentVersionId: null },
    ]) {
      await seed(overrides);
      const response = await get("/");
      expect(response.status).toBe(unknown.status);
      expect(await response.text()).toBe(unknownText);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("keeps protected artifacts closed until sign-in exists", async () => {
    for (const accessMode of ["authenticated", "restricted"] as const) {
      await seed({ accessMode });
      const response = await get("/");
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("<h1>Plan</h1>");
    }
  });

  it("lets owners opt into indexing and embedding", async () => {
    await seed({ indexable: true, embeddable: true });
    const response = await get("/");
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors *");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("reports a missing object as temporarily unavailable", async () => {
    await env.ARTIFACTS.delete(`objects/u_owner/${sha("d")}`);
    expect((await get("/data.txt")).status).toBe(503);
  });
});

describe("routing helpers", () => {
  it("resolves every R2 range shape to a byte span", () => {
    expect(byteSpan({ offset: 2, length: 4 }, 10)).toEqual({ start: 2, length: 4 });
    expect(byteSpan({ offset: 7 }, 10)).toEqual({ start: 7, length: 3 });
    expect(byteSpan({ length: 4 }, 10)).toEqual({ start: 0, length: 4 });
    expect(byteSpan({ suffix: 3 }, 10)).toEqual({ start: 7, length: 3 });
  });

  it("extracts artifact ids from hostnames", () => {
    expect(artifactIdFromHost(`${ID}.portifact.dev`, "portifact.dev")).toBe(ID);
    expect(artifactIdFromHost("UPPERCASE1.portifact.dev", "portifact.dev")).toBeNull();
    expect(artifactIdFromHost("portifact.dev", "portifact.dev")).toBeNull();
  });

  it("maps URL paths to canonical artifact paths", () => {
    expect(requestedPath("/")).toBe("index.html");
    expect(requestedPath("/a//b/")).toBe("a/b/index.html");
    expect(requestedPath("/caf%C3%A9.html")).toBe("café.html");
    expect(requestedPath("/%2e%2e/x")).toBeNull();
    expect(requestedPath("/%zz")).toBeNull();
  });
});
