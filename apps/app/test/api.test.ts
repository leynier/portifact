import { env } from "cloudflare:workers";
import { PublishRequest } from "@portifact/contracts";
import { hashRequest } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { checksumHeader, UPLOAD_URL_TTL_SECONDS } from "../src/api/presign.ts";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { publishSite, tokenClient } from "./api-client.ts";
import { approveDevice, pollDeviceToken, requestDeviceCode } from "./flows.ts";
import { createHarness, type Harness } from "./harness.ts";

const ALL = "artifacts:read artifacts:write artifacts:delete offline_access";

interface Client {
  token: string;
  userId: string;
  call(path: string, init?: RequestInit): Promise<Response>;
}

/** Signs a user in and gets an API token for the CLI client with the given scopes. */
async function client(h: Harness, email: string, scope = ALL): Promise<Client> {
  const cookie = await h.signIn(email);
  const device = await requestDeviceCode(h, CLI_CLIENT_ID, scope);
  await approveDevice(h, cookie, device.user_code);
  const tokens = await (await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code)).json<{
    access_token: string;
  }>();
  const call = (path: string, init: RequestInit = {}) =>
    h.request(path, {
      ...init,
      headers: { authorization: `Bearer ${tokens.access_token}`, ...(init.headers ?? {}) },
    });
  const me = await (await call("/api/v1/me")).json<{ userId: string }>();
  return { token: tokens.access_token, userId: me.userId, call };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function manifest(files: Record<string, string>) {
  return Promise.all(
    Object.entries(files).map(async ([path, body]) => ({
      path,
      sha256: await sha256(body),
      size: new TextEncoder().encode(body).length,
      contentType: path.endsWith(".js") ? "text/javascript" : "text/html",
    })),
  );
}

function post(body: unknown, key?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  };
}

const SITE = { "index.html": "<h1>Plan</h1>", "app.js": "console.log(1)" };

/** What a client does after prepare: PUT each object. Here it lands in the R2 binding. */
async function uploadAll(owner: string, files: Record<string, string>) {
  for (const body of Object.values(files)) {
    const hash = await sha256(body);
    await env.ARTIFACTS.put(`objects/${owner}/${hash}`, body, { sha256: hash });
  }
}

interface Prepared {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  uploadId: string;
  expiresAt: string;
  uploads: {
    sha256: string;
    size: number;
    method: string;
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  }[];
}

async function prepare(c: Client, files: Record<string, string>, extra: object = {}) {
  const response = await c.call(
    "/api/v1/publishes",
    post(
      {
        type: "site",
        name: "Plan",
        entrypoint: "index.html",
        files: await manifest(files),
        ...extra,
      },
      crypto.randomUUID(),
    ),
  );
  expect(response.status).toBe(201);
  return response.json<Prepared>();
}

async function publish(c: Client, files: Record<string, string> = SITE) {
  const prepared = await prepare(c, files);
  await uploadAll(c.userId, files);
  const commit = await c.call(`/api/v1/publishes/${prepared.uploadId}/commit`, { method: "POST" });
  expect(commit.status).toBe(200);
  return { prepared, committed: await commit.json<{ artifactId: string; url: string }>() };
}

describe("publishing through the API", () => {
  it("prepares, uploads to presigned URLs, commits and lists the artifact", async () => {
    const h = createHarness();
    const c = await client(h, "publisher@example.test");
    const prepared = await prepare(c, SITE);
    expect(prepared.versionNumber).toBe(1);
    expect(prepared.artifactId).toMatch(/^[a-z2-7]{10}$/);
    expect(prepared.uploads).toHaveLength(2);

    await uploadAll(c.userId, SITE);
    const commit = await c.call(`/api/v1/publishes/${prepared.uploadId}/commit`, {
      method: "POST",
    });
    expect(commit.status).toBe(200);
    expect(commit.headers.get("cache-control")).toBe("no-store");
    const committed = await commit.json<{ url: string; versionId: string }>();
    expect(committed.url).toBe(`https://${prepared.artifactId}.portifact.dev/`);
    expect(committed.versionId).toBe(prepared.versionId);

    const info = await (await c.call(`/api/v1/artifacts/${prepared.artifactId}`)).json<{
      state: string;
      accessMode: string;
      currentVersionId: string;
    }>();
    expect(info).toMatchObject({
      state: "active",
      accessMode: "restricted",
      currentVersionId: prepared.versionId,
    });
    const list = await (await c.call("/api/v1/artifacts")).json<{ items: { id: string }[] }>();
    expect(list.items.map((item) => item.id)).toEqual([prepared.artifactId]);
  });

  it("signs each upload URL for the exact object, size and checksum, without secrets", async () => {
    const h = createHarness();
    const c = await client(h, "presign@example.test");
    const prepared = await prepare(c, { "index.html": "<p>one</p>" });
    const [upload] = prepared.uploads;
    if (!upload) throw new Error("no upload");
    const url = new URL(upload.url);
    expect(url.origin).toBe(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/portifact-artifacts/objects/${c.userId}/${upload.sha256}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^test-r2-access-key-id\//);
    expect(upload.url).not.toContain(env.R2_SECRET_ACCESS_KEY);
    expect(upload).toMatchObject({
      method: "PUT",
      size: 10,
      headers: { "content-length": "10", "x-amz-checksum-sha256": checksumHeader(upload.sha256) },
    });
    expect(Date.parse(upload.expiresAt) - Date.now()).toBeLessThanOrEqual(
      UPLOAD_URL_TTL_SECONDS * 1000,
    );
  });

  it("encodes the SHA-256 checksum header as base64 of the digest", () => {
    // SHA-256 of the empty string, from the S3 documentation.
    expect(checksumHeader("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(
      "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
  });

  it("replays a retried prepare and refuses a reused key with another body", async () => {
    const h = createHarness();
    const c = await client(h, "retry@example.test");
    const body = {
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      files: await manifest(SITE),
    };
    const first = await c.call("/api/v1/publishes", post(body, "retry-key-0001"));
    const second = await c.call("/api/v1/publishes", post(body, "retry-key-0001"));
    expect(second.status).toBe(201);
    const a = await first.json<Prepared>();
    const b = await second.json<Prepared>();
    expect(b.uploadId).toBe(a.uploadId);
    expect(b.artifactId).toBe(a.artifactId);

    const other = await c.call(
      "/api/v1/publishes",
      post({ ...body, name: "Else" }, "retry-key-0001"),
    );
    expect(other.status).toBe(400);
    expect((await other.json<{ error: { code: string } }>()).error.code).toBe("invalid_input");
  });

  it("requires an idempotency key and a valid JSON manifest", async () => {
    const h = createHarness();
    const c = await client(h, "invalid@example.test");
    const valid = {
      type: "site",
      name: "x",
      entrypoint: "index.html",
      files: await manifest(SITE),
    };
    const noKey = await c.call("/api/v1/publishes", post(valid));
    expect(noKey.status).toBe(400);

    const badPath = await c.call(
      "/api/v1/publishes",
      post({ ...valid, files: [{ ...valid.files[0], sha256: "nope" }] }, "invalid-key-01"),
    );
    expect(badPath.status).toBe(400);
    expect((await badPath.json<{ error: { message: string } }>()).error.message).toMatch(
      /^files\.0\.sha256: /,
    );

    const notJson = await c.call("/api/v1/publishes", {
      method: "POST",
      headers: { "content-type": "text/plain", "idempotency-key": "invalid-key-02" },
      body: "hello",
    });
    expect(notJson.status).toBe(400);
    const broken = await c.call("/api/v1/publishes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "invalid-key-03" },
      body: "{",
    });
    expect(broken.status).toBe(400);

    const traversal = await c.call(
      "/api/v1/publishes",
      post({ ...valid, entrypoint: "../index.html" }, "invalid-key-04"),
    );
    expect(traversal.status).toBe(400);
  });

  it("refuses a commit before every object arrived, and resumes with fresh URLs", async () => {
    const h = createHarness();
    const c = await client(h, "partial@example.test");
    const prepared = await prepare(c, SITE);
    const early = await c.call(`/api/v1/publishes/${prepared.uploadId}/commit`, { method: "POST" });
    expect(early.status).toBe(409);
    expect((await early.json<{ error: { code: string } }>()).error.code).toBe("upload_incomplete");

    const progress = await c.call(`/api/v1/publishes/${prepared.uploadId}`);
    expect(progress.status).toBe(200);
    const resumed = await progress.json<Prepared>();
    expect(resumed.uploads.map((u) => u.sha256).sort()).toEqual(
      prepared.uploads.map((u) => u.sha256).sort(),
    );
    await uploadAll(c.userId, SITE);
    const late = await c.call(`/api/v1/publishes/${prepared.uploadId}/commit`, { method: "POST" });
    expect(late.status).toBe(200);
    expect((await c.call(`/api/v1/publishes/${prepared.uploadId}`)).status).toBe(409);
  });

  it("aborts an upload and refuses to commit it afterwards", async () => {
    const h = createHarness();
    const c = await client(h, "abort@example.test");
    const prepared = await prepare(c, SITE);
    const abort = await c.call(`/api/v1/publishes/${prepared.uploadId}`, { method: "DELETE" });
    expect(abort.status).toBe(204);
    await uploadAll(c.userId, SITE);
    const commit = await c.call(`/api/v1/publishes/${prepared.uploadId}/commit`, {
      method: "POST",
    });
    expect(commit.status).toBe(409);
    expect((await c.call(`/api/v1/artifacts/${prepared.artifactId}`)).status).toBe(404);
  });

  it("publishes a new version on the current base and refuses a stale base", async () => {
    const h = createHarness();
    const c = await client(h, "versions@example.test");
    const { prepared } = await publish(c);
    const next = await prepare(
      c,
      { ...SITE, "index.html": "<h1>v2</h1>" },
      {
        artifactId: prepared.artifactId,
        baseVersionId: prepared.versionId,
      },
    );
    expect(next.versionNumber).toBe(2);
    expect(next.uploads).toHaveLength(1);

    const stale = await c.call(
      "/api/v1/publishes",
      post(
        {
          artifactId: prepared.artifactId,
          baseVersionId: null,
          type: "site",
          name: "Plan",
          entrypoint: "index.html",
          files: await manifest(SITE),
        },
        "stale-base-01",
      ),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("version_conflict");
  });
});

describe("artifact lifecycle through the API", () => {
  it("archives, restores, renews and deletes an artifact", async () => {
    const h = createHarness();
    const c = await client(h, "lifecycle@example.test");
    const { prepared } = await publish(c);
    const path = `/api/v1/artifacts/${prepared.artifactId}`;

    const archived = await c.call(`${path}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json<{ state: string; purgeAt: string | null }>();
    expect(archivedBody.state).toBe("archived");
    expect(Date.parse(archivedBody.purgeAt ?? "")).toBeGreaterThan(Date.now());
    const restored = await c.call(`${path}/restore`, { method: "POST" });
    expect(await restored.json()).toMatchObject({ state: "active", purgeAt: null });
    const renewed = await c.call(`${path}/renew`, { method: "POST" });
    expect(renewed.status).toBe(200);
    const deleted = await c.call(path, { method: "DELETE" });
    expect(await deleted.json()).toMatchObject({ state: "deleted" });
    expect((await c.call(path)).status).toBe(404);
  });

  it("reports archiving an archived artifact as a conflict", async () => {
    const h = createHarness();
    const c = await client(h, "twice@example.test");
    const { prepared } = await publish(c);
    await c.call(`/api/v1/artifacts/${prepared.artifactId}/archive`, { method: "POST" });
    const again = await c.call(`/api/v1/artifacts/${prepared.artifactId}/archive`, {
      method: "POST",
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
  });
});

describe("API permissions", () => {
  it("requires a token, and the scope of each operation", async () => {
    const h = createHarness();
    expect((await h.request("/api/v1/artifacts")).status).toBe(401);
    const reader = await client(h, "reader-only@example.test", "artifacts:read");
    expect((await reader.call("/api/v1/artifacts")).status).toBe(200);
    const write = await reader.call(
      "/api/v1/publishes",
      post({ type: "site", name: "x", entrypoint: "index.html", files: [] }, "scope-key-01"),
    );
    expect(write.status).toBe(403);
    expect(write.headers.get("www-authenticate")).toContain("insufficient_scope");

    const writer = await client(h, "writer@example.test", "artifacts:read artifacts:write");
    const { prepared } = await publish(writer);
    const remove = await writer.call(`/api/v1/artifacts/${prepared.artifactId}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(403);
  });

  it("hides one account's artifacts and uploads from another", async () => {
    const h = createHarness();
    const owner = await client(h, "owner@example.test");
    const other = await client(h, "other@example.test");
    const { prepared } = await publish(owner);
    const open = await prepare(owner, { "index.html": "<p>open</p>" });

    expect((await other.call(`/api/v1/artifacts/${prepared.artifactId}`)).status).toBe(404);
    expect(
      (await other.call(`/api/v1/artifacts/${prepared.artifactId}/archive`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await other.call(`/api/v1/artifacts/${prepared.artifactId}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await other.call(`/api/v1/publishes/${open.uploadId}`)).status).toBe(404);
    expect(
      (await other.call(`/api/v1/publishes/${open.uploadId}/commit`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (await other.call(`/api/v1/publishes/${open.uploadId}`, { method: "DELETE" })).status,
    ).toBe(404);
    const list = await (await other.call("/api/v1/artifacts")).json<{ items: unknown[] }>();
    expect(list.items).toEqual([]);

    // Updating someone else's artifact looks like a missing one too.
    const takeover = await other.call(
      "/api/v1/publishes",
      post(
        {
          artifactId: prepared.artifactId,
          baseVersionId: prepared.versionId,
          type: "site",
          name: "Mine",
          entrypoint: "index.html",
          files: await manifest(SITE),
        },
        "takeover-01",
      ),
    );
    expect(takeover.status).toBe(404);
  });
});

describe("listing artifacts", () => {
  it("pages with a cursor and rejects an invalid one or limit", async () => {
    const h = createHarness();
    const c = await client(h, "pages@example.test");
    for (let i = 0; i < 3; i += 1) await publish(c, { "index.html": `<p>${i}</p>` });
    const first = await (await c.call("/api/v1/artifacts?limit=2")).json<{
      items: { id: string }[];
      nextCursor: string;
    }>();
    expect(first.items).toHaveLength(2);
    const second = await (
      await c.call(`/api/v1/artifacts?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(3);

    expect((await c.call("/api/v1/artifacts?cursor=forged")).status).toBe(400);
    expect((await c.call("/api/v1/artifacts?limit=0")).status).toBe(400);
    expect((await c.call("/api/v1/artifacts?limit=1000")).status).toBe(400);
  });

  it("searches and filters only the caller's artifacts", async () => {
    const h = createHarness();
    const c = await tokenClient(h, "filters@example.test");
    const other = await tokenClient(h, "filters-other@example.test");
    const plan = await publishSite(c, "Launch PLAN");
    const notes = await publishSite(c, "Notes");
    await publishSite(other, "Launch plan of someone else");
    await c.call(`/api/v1/artifacts/${notes}/archive`, { method: "POST" });
    const ids = async (query: string) => {
      const response = await c.call(`/api/v1/artifacts?${query}`);
      expect(response.status, query).toBe(200);
      return (await response.json<{ items: { id: string }[] }>()).items.map((item) => item.id);
    };

    expect(await ids("search=launch")).toEqual([plan]);
    expect(await ids(`search=${plan.slice(3, 9).toUpperCase()}`)).toEqual([plan]);
    expect(await ids("state=archived")).toEqual([notes]);
    expect(await ids("state=active&type=site&access=restricted&annotations=off")).toEqual([plan]);
    expect(await ids("type=markdown")).toEqual([]);
    // Empty parameters are no filter, as an empty search box sends them.
    expect(await ids("search=&state=&type=&access=&annotations=")).toEqual([notes, plan]);

    for (const query of [
      "state=deleted",
      "state=draft",
      "type=pdf",
      "access=private",
      "annotations=on",
      `search=${"x".repeat(201)}`,
      "search=%20%20",
    ]) {
      const refused = await c.call(`/api/v1/artifacts?${query}`);
      expect(refused.status, query).toBe(400);
      expect(await refused.json(), query).toMatchObject({ error: { code: "invalid_input" } });
    }
  });
});

describe("API edge cases", () => {
  it("tells a client its earlier request with the same key is still running", async () => {
    const h = createHarness();
    const c = await client(h, "running@example.test");
    const body = {
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      files: await manifest(SITE),
    };
    const parsed = PublishRequest.parse(body);
    await env.DB.prepare(
      "insert into operations (actor_id, idempotency_key, operation, request_hash, created_at) values (?, ?, 'publish.prepare', ?, ?)",
    )
      .bind(c.userId, "running-key-01", await hashRequest(parsed), Date.now())
      .run();
    const response = await c.call("/api/v1/publishes", post(body, "running-key-01"));
    expect(response.status).toBe(409);
    expect((await response.json<{ error: { message: string } }>()).error.message).toMatch(
      /still running/,
    );
  });

  it("refuses a body without a JSON content type or with the wrong shape at the root", async () => {
    const h = createHarness();
    const c = await client(h, "shape@example.test");
    const noType = await c.call("/api/v1/publishes", {
      method: "POST",
      headers: { "idempotency-key": "shape-key-01" },
      body: "{}",
    });
    expect(noType.status).toBe(400);
    const array = await c.call("/api/v1/publishes", post([], "shape-key-02"));
    expect(array.status).toBe(400);
    expect((await array.json<{ error: { message: string } }>()).error.message).not.toMatch(/^: /);
  });

  it("shows archive and purge dates, and null dates as null", async () => {
    const h = createHarness();
    const c = await client(h, "dates@example.test");
    const { prepared } = await publish(c);
    await c.call(`/api/v1/artifacts/${prepared.artifactId}/archive`, { method: "POST" });
    const archived = await (await c.call(`/api/v1/artifacts/${prepared.artifactId}`)).json<{
      archivedAt: string | null;
      purgeAt: string | null;
    }>();
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.purgeAt).not.toBeNull();

    await env.DB.prepare("update artifacts set expires_at = null, state = 'suspended' where id = ?")
      .bind(prepared.artifactId)
      .run();
    const suspended = await (await c.call(`/api/v1/artifacts/${prepared.artifactId}`)).json<{
      state: string;
      expiresAt: string | null;
    }>();
    expect(suspended).toMatchObject({ state: "suspended", expiresAt: null });
  });
});

describe("access control through the API", () => {
  function patch(body: unknown): RequestInit {
    return {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  it("reads the private default, adds readers and switches to signed-in access", async () => {
    const h = createHarness();
    const c = await client(h, "sharer@example.test", `${ALL} artifacts:share`);
    const { prepared } = await publish(c);
    const path = `/api/v1/artifacts/${prepared.artifactId}/access`;
    expect(await (await c.call(path)).json()).toEqual({
      mode: "restricted",
      readers: [],
      indexable: false,
      embeddable: false,
      bar: true,
      policyGeneration: 1,
    });
    const added = await c.call(path, patch({ addReaders: ["Ana@Example.test"] }));
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      readers: ["ana@example.test"],
      policyGeneration: 2,
    });
    const opened = await c.call(
      path,
      patch({ mode: "authenticated", removeReaders: ["ana@example.test"] }),
    );
    expect(await opened.json()).toMatchObject({
      mode: "authenticated",
      readers: [],
      policyGeneration: 3,
    });
  });

  it("keeps a new account from making an artifact public", async () => {
    const h = createHarness();
    const c = await client(h, "newbie@example.test", `${ALL} artifacts:share`);
    const { prepared } = await publish(c);
    const response = await c.call(
      `/api/v1/artifacts/${prepared.artifactId}/access`,
      patch({ mode: "public" }),
    );
    expect(response.status).toBe(403);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "account_too_new_for_public",
    );
  });

  it("requires the share scope to change access and refuses empty or invalid changes", async () => {
    const h = createHarness();
    const c = await client(h, "noshare@example.test");
    const { prepared } = await publish(c);
    const path = `/api/v1/artifacts/${prepared.artifactId}/access`;
    expect((await c.call(path)).status).toBe(200);
    expect((await c.call(path, patch({ mode: "authenticated" }))).status).toBe(403);

    const sharer = await client(h, "sharer2@example.test", `${ALL} artifacts:share`);
    const own = await publish(sharer);
    const ownPath = `/api/v1/artifacts/${own.prepared.artifactId}/access`;
    expect((await sharer.call(ownPath, patch({}))).status).toBe(400);
    expect((await sharer.call(ownPath, patch({ addReaders: ["not-an-email"] }))).status).toBe(400);
    expect((await sharer.call(ownPath, patch({ mode: "everyone" }))).status).toBe(400);
    // Another account's artifact looks missing for reading and for changing.
    expect((await sharer.call(path)).status).toBe(404);
    expect((await sharer.call(path, patch({ mode: "authenticated" }))).status).toBe(404);
  });
});
