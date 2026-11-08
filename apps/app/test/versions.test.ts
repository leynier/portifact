// The version routes of /api/v1: list, manifest, download links and rollback, with their
// permission boundaries (owner, authorized reader, other account, scope) and idempotency.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_URL_TTL_SECONDS } from "../src/api/presign.ts";
import { createHarness, type Harness, ORIGIN, SESSION_COOKIE } from "./harness.ts";
import { api, apiToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

interface User {
  h: Harness;
  userId: string;
  call: (path: string, init?: RequestInit) => Promise<Response>;
}

async function user(h: Harness, email: string, scope?: string): Promise<User> {
  const token = await apiToken(h, email, scope);
  const call = (path: string, init?: RequestInit) => api(h, token, path, init);
  const me = await (await call("/api/v1/me")).json<{ userId: string }>();
  return { h, userId: me.userId, call };
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Committed {
  artifactId: string;
  versionId: string;
  versionNumber: number;
}

/** Prepare, upload and commit through the API, like the CLI. */
async function publish(
  u: User,
  files: { published: Record<string, string>; source?: Record<string, string> },
  extra: { artifactId?: string; baseVersionId?: string; type?: string } = {},
): Promise<Committed> {
  const entries = [];
  for (const kind of ["published", "source"] as const) {
    for (const [path, body] of Object.entries(files[kind] ?? {})) {
      entries.push({
        path,
        kind,
        sha256: await sha256(body),
        size: new TextEncoder().encode(body).byteLength,
        contentType: "text/markdown; charset=utf-8",
      });
    }
  }
  const prepared = await u.call("/api/v1/publishes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      type: extra.type ?? "markdown",
      name: "Notes",
      entrypoint: Object.keys(files.published)[0],
      files: entries,
      ...(extra.artifactId ? { artifactId: extra.artifactId } : {}),
      ...(extra.baseVersionId ? { baseVersionId: extra.baseVersionId } : {}),
    }),
  });
  expect(prepared.status).toBe(201);
  const { uploadId } = await prepared.json<{ uploadId: string }>();
  for (const entry of entries) {
    const body = { ...files.published, ...files.source }[entry.path] as string;
    await env.ARTIFACTS.put(`objects/${u.userId}/${entry.sha256}`, body, { sha256: entry.sha256 });
  }
  const commit = await u.call(`/api/v1/publishes/${uploadId}/commit`, { method: "POST" });
  expect(commit.status).toBe(200);
  return commit.json<Committed>();
}

async function twoVersions(u: User, type = "markdown") {
  const v1 = await publish(
    u,
    { published: { "index.md": "# First" }, source: { "notes/draft.md": "private draft" } },
    { type },
  );
  vi.setSystemTime(NOW + MINUTE);
  const v2 = await publish(
    u,
    { published: { "index.md": "# Second" } },
    { artifactId: v1.artifactId, baseVersionId: v1.versionId, type },
  );
  return { id: v1.artifactId, v1, v2 };
}

function rollback(u: User, id: string, body: unknown, key: string | null = crypto.randomUUID()) {
  return u.call(`/api/v1/artifacts/${id}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });
}

describe("version routes", () => {
  it("lists versions and returns a manifest with sources for the owner", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-owner@example.test");
    const { id, v1, v2 } = await twoVersions(owner);

    const list = await owner.call(`/api/v1/artifacts/${id}/versions`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const body = await list.json<{ artifactId: string; items: Record<string, unknown>[] }>();
    expect(body.artifactId).toBe(id);
    expect(body.items).toEqual([
      expect.objectContaining({ id: v2.versionId, number: 2, current: true, expiresAt: null }),
      expect.objectContaining({
        id: v1.versionId,
        number: 1,
        current: false,
        sourceFiles: 1,
        committedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + MINUTE + 7 * 24 * 60 * MINUTE).toISOString(),
      }),
    ]);

    const page = await (await owner.call(`/api/v1/artifacts/${id}/versions?limit=1`)).json<{
      nextCursor: string;
    }>();
    expect(page.nextCursor).toBe("2");

    const manifest = await owner.call(`/api/v1/artifacts/${id}/versions/${v1.versionId}`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      artifactId: id,
      id: v1.versionId,
      files: [
        { path: "index.md", kind: "published", sha256: await sha256("# First") },
        { path: "notes/draft.md", kind: "source", sha256: await sha256("private draft") },
      ],
    });
  });

  it("signs a short GET link for each file, bound to its object and without secrets", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-links@example.test");
    const { id, v1 } = await twoVersions(owner);

    const response = await owner.call(
      `/api/v1/artifacts/${id}/versions/${v1.versionId}/download?kind=source`,
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      versionNumber: number;
      kind: string;
      files: { path: string; sha256: string; method: string; url: string; expiresAt: string }[];
    }>();
    expect(body).toMatchObject({ versionNumber: 1, kind: "source" });
    const [file] = body.files;
    if (!file) throw new Error("no file");
    expect(file).toMatchObject({ path: "notes/draft.md", method: "GET" });
    const url = new URL(file.url);
    expect(url.origin).toBe(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/portifact-artifacts/objects/${owner.userId}/${file.sha256}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(DOWNLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(file.url).not.toContain(env.R2_SECRET_ACCESS_KEY);
    expect(Date.parse(file.expiresAt)).toBe(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000);
    // The link points at the exact bytes the manifest describes.
    const stored = await env.ARTIFACTS.get(`objects/${owner.userId}/${file.sha256}`);
    expect(await stored?.text()).toBe("private draft");

    const one = await owner.call(
      `/api/v1/artifacts/${id}/versions/current/download?path=${encodeURIComponent("index.md")}`,
    );
    expect((await one.json<{ files: { path: string }[] }>()).files.map((f) => f.path)).toEqual([
      "index.md",
    ]);
  });

  it("lets a reader download the current published document, and nothing else", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-share-owner@example.test");
    const reader = await user(h, "versions-reader@example.test");
    const stranger = await user(h, "versions-stranger@example.test");
    const doc = await twoVersions(owner);
    const site = await publish(
      owner,
      { published: { "index.html": "<p>site</p>" } },
      { type: "site" },
    );
    for (const artifactId of [doc.id, site.artifactId]) {
      await env.DB.prepare("insert into artifact_readers (artifact_id, email) values (?, ?)")
        .bind(artifactId, "versions-reader@example.test")
        .run();
    }

    const current = await reader.call(`/api/v1/artifacts/${doc.id}/versions/current/download`);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ versionId: doc.v2.versionId, kind: "published" });

    const notFound = async (u: User, path: string) => {
      const response = await u.call(path);
      expect(response.status, path).toBe(404);
      return response.json();
    };
    const sourceRefused = await notFound(
      reader,
      `/api/v1/artifacts/${doc.id}/versions/current/download?kind=source`,
    );
    // Refusals look exactly like a missing version, so they reveal nothing.
    expect(
      await notFound(reader, `/api/v1/artifacts/${doc.id}/versions/${doc.v1.versionId}/download`),
    ).toEqual(sourceRefused);
    expect(
      await notFound(stranger, `/api/v1/artifacts/${doc.id}/versions/current/download`),
    ).toEqual(sourceRefused);
    expect(
      await notFound(reader, `/api/v1/artifacts/${site.artifactId}/versions/current/download`),
    ).toEqual(sourceRefused);
    // The history and manifests stay with the owner.
    await notFound(reader, `/api/v1/artifacts/${doc.id}/versions`);
    await notFound(reader, `/api/v1/artifacts/${doc.id}/versions/current`);
  });

  it("rolls back as a new version, replays a retried request and refuses a reused key", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-rollback@example.test");
    const { id, v1, v2 } = await twoVersions(owner);
    vi.setSystemTime(NOW + 2 * MINUTE);

    const request = { versionId: v1.versionId, baseVersionId: v2.versionId };
    const first = await rollback(owner, id, request, "rollback-key-1");
    expect(first.status).toBe(200);
    const body = await first.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      artifactId: id,
      versionNumber: 3,
      fromVersionId: v1.versionId,
      fromVersionNumber: 1,
      url: `https://${id}.portifact.dev/`,
    });

    const retried = await rollback(owner, id, request, "rollback-key-1");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(body);
    const reused = await rollback(
      owner,
      id,
      { ...request, versionId: v2.versionId },
      "rollback-key-1",
    );
    expect(reused.status).toBe(400);

    // Without the key the same request is a conflict: the base moved on.
    const stale = await rollback(owner, id, request);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "version_conflict" } });

    const info = await (await owner.call(`/api/v1/artifacts/${id}`)).json<{
      currentVersionId: string;
      accessMode: string;
    }>();
    expect(info).toMatchObject({ currentVersionId: body.versionId, accessMode: "restricted" });
  });

  it("validates input before running", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-input@example.test");
    const { id, v1, v2 } = await twoVersions(owner);
    const status = async (response: Promise<Response>) => (await response).status;

    expect(
      await status(
        rollback(owner, id, { versionId: v1.versionId, baseVersionId: v2.versionId }, null),
      ),
    ).toBe(400);
    expect(await status(rollback(owner, id, { versionId: v1.versionId }))).toBe(400);
    expect(await status(owner.call(`/api/v1/artifacts/${id}/versions?cursor=forged`))).toBe(400);
    expect(await status(owner.call(`/api/v1/artifacts/${id}/versions?limit=0`))).toBe(400);
    expect(await status(owner.call(`/api/v1/artifacts/${id}/versions/ver%20x`))).toBe(400);
    expect(await status(owner.call(`/api/v1/artifacts/${id}/versions/ver%20x/download`))).toBe(400);
    expect(
      await status(owner.call(`/api/v1/artifacts/${id}/versions/current/download?kind=all`)),
    ).toBe(400);
    expect(await status(owner.call(`/api/v1/artifacts/abcdefghij/versions`))).toBe(404);
  });

  it("needs artifacts:read to read history and artifacts:write to roll back", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-scope@example.test");
    const { id, v1, v2 } = await twoVersions(owner);
    const readOnly = await user(h, "versions-scope@example.test", "artifacts:read offline_access");

    expect((await readOnly.call(`/api/v1/artifacts/${id}/versions`)).status).toBe(200);
    expect((await readOnly.call(`/api/v1/artifacts/${id}/versions/current/download`)).status).toBe(
      200,
    );
    const denied = await rollback(readOnly, id, {
      versionId: v1.versionId,
      baseVersionId: v2.versionId,
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="artifacts:write"');
    expect((await h.request(`/api/v1/artifacts/${id}/versions`)).status).toBe(401);
  });

  it("serves the dashboard's session from the app origin", async () => {
    const h = createHarness();
    const owner = await user(h, "versions-session@example.test");
    const { id, v1, v2 } = await twoVersions(owner);
    const cookie = await h.signIn("versions-session@example.test");
    expect(cookie).toContain(SESSION_COOKIE);
    const list = await h.request(`/api/v1/artifacts/${id}/versions`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(list.status).toBe(200);
    const crossSite = await h.request(`/api/v1/artifacts/${id}/rollback`, {
      method: "POST",
      headers: {
        cookie,
        "sec-fetch-site": "same-origin",
        origin: "https://evil.example",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ versionId: v1.versionId, baseVersionId: v2.versionId }),
    });
    expect(crossSite.status).toBe(403);
    const rolled = await h.request(`/api/v1/artifacts/${id}/rollback`, {
      method: "POST",
      headers: {
        cookie,
        "sec-fetch-site": "same-origin",
        origin: ORIGIN,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ versionId: v1.versionId, baseVersionId: v2.versionId }),
    });
    expect(rolled.status).toBe(200);
  });
});
