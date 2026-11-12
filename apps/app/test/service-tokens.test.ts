// Service tokens at the app (premium plan T4, decision 0011): the dashboard-only management
// routes, the third way to authenticate at /api/v1, what a token can never reach (MCP, account
// endpoints, credentials, members, webhooks, branding, domains), and keyed publishes (T5) through
// the API and MCP.
import { env } from "cloudflare:workers";
import { planRequiredMessage } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace, deleteWorkspace } from "@portifact/services";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, ORIGIN, SESSION_COOKIE } from "./harness.ts";
import { api, apiToken, callTool, connect, mcpToken, rpc } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const DAY = 86_400_000;
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read annotations:write offline_access";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;

function dashboard(cookie: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

const bearer = (secret: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${secret}`, ...(init.headers ?? {}) },
});

interface Team {
  id: string;
  slug: string;
  h: Harness;
  adminEmail: string;
  adminCookie: string;
  adminId: string;
}

async function team(prefix: string, plan: "team" | "pro" = "team"): Promise<Team> {
  const h = createHarness();
  const adminEmail = `${prefix}-admin@example.test`;
  const adminCookie = await h.signIn(adminEmail);
  const access = await apiToken(h, adminEmail, SCOPES);
  const { userId } = await (await api(h, access, "/api/v1/me")).json<{ userId: string }>();
  const slug = `${prefix}-team`;
  const created = await createWorkspace(regionsFromEnv(env).global, {
    slug,
    name: "Team",
    adminUserId: userId,
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: created.value.id, plan, seats: 5, grantedBy: "test", updatedAt: NOW });
  return { id: created.value.id, slug, h, adminEmail, adminCookie, adminId: userId };
}

const TOKEN = {
  label: "CI previews",
  role: "editor",
  scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
  expiresInDays: 30,
};

async function createToken(t: Team, body: object = TOKEN) {
  const response = await t.h.request(
    `/api/v1/workspaces/${t.slug}/service-tokens`,
    dashboard(t.adminCookie, "POST", body),
  );
  expect(response.status).toBe(201);
  return response.json<{ token: { id: string }; secret: string }>();
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Prepares, uploads and commits a one-page site through the API with `secret`. */
async function publishWith(
  h: Harness,
  credential: string,
  ownerId: string,
  extra: Record<string, unknown> = {},
  query = "",
) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepare = await h.request(
    `/api/v1/publishes${query}`,
    bearer(credential, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        type: "site",
        name: "Preview",
        entrypoint: "index.html",
        files: [
          {
            path: "index.html",
            kind: "published",
            sha256: await sha256(body),
            size: body.length,
            contentType: "text/html",
          },
        ],
        ...extra,
      }),
    }),
  );
  if (prepare.status !== 201)
    return { status: prepare.status, body: await prepare.json<unknown>() };
  const prepared = await prepare.json<{ uploadId: string; artifactId: string }>();
  const hash = await sha256(body);
  await env.ARTIFACTS.put(`objects/${ownerId}/${hash}`, body, { sha256: hash });
  const commit = await h.request(
    `/api/v1/publishes/${prepared.uploadId}/commit`,
    bearer(credential, { method: "POST" }),
  );
  return { status: commit.status, body: await commit.json<unknown>() };
}

describe("managing tokens from the dashboard", () => {
  it("creates, lists and revokes through the session, and the secret only once", async () => {
    const t = await team("stm");
    const created = await createToken(t);
    expect(created.secret).toMatch(/^pfst_[A-Za-z0-9_-]{43}$/);
    const list = await t.h.request(
      `/api/v1/workspaces/${t.slug}/service-tokens`,
      dashboard(t.adminCookie),
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const text = await list.text();
    expect(text).not.toContain(created.secret);
    expect(JSON.parse(text)).toMatchObject({
      items: [{ id: created.token.id, label: "CI previews", lastUsedAt: null }],
      available: true,
      limit: 20,
    });
    const revoked = await t.h.request(
      `/api/v1/workspaces/${t.slug}/service-tokens/${created.token.id}`,
      dashboard(t.adminCookie, "DELETE"),
    );
    expect(revoked.status).toBe(204);
  });

  it("refuses every bearer token, a service token included, so no token can mint tokens", async () => {
    const t = await team("stb");
    const created = await createToken(t);
    const oauth = await apiToken(t.h, t.adminEmail, SCOPES);
    const refused = {
      error: { code: "forbidden", message: "Service tokens are managed from the dashboard." },
    };
    for (const credential of [created.secret, oauth]) {
      for (const [method, path, body] of [
        ["GET", `/api/v1/workspaces/${t.slug}/service-tokens`, undefined],
        ["POST", `/api/v1/workspaces/${t.slug}/service-tokens`, TOKEN],
        ["DELETE", `/api/v1/workspaces/${t.slug}/service-tokens/${created.token.id}`, undefined],
      ] as const) {
        const response = await t.h.request(
          path,
          bearer(credential, {
            method,
            ...(body
              ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
              : {}),
          }),
        );
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.json()).toEqual(refused);
      }
    }
  });

  it("answers a malformed slug or token ID like a missing one", async () => {
    const t = await team("stx");
    const missing = { status: 404 };
    for (const [method, path, body] of [
      ["GET", "/api/v1/workspaces/Not_A_Slug/service-tokens", undefined],
      ["POST", "/api/v1/workspaces/Not_A_Slug/service-tokens", TOKEN],
      ["DELETE", `/api/v1/workspaces/Not_A_Slug/service-tokens/st_${"0".repeat(32)}`, undefined],
      ["DELETE", `/api/v1/workspaces/${t.slug}/service-tokens/not-a-token`, undefined],
      ["DELETE", `/api/v1/workspaces/${t.slug}/service-tokens/st_${"0".repeat(32)}`, undefined],
    ] as const) {
      const response = await t.h.request(path, dashboard(t.adminCookie, method, body));
      expect({ status: response.status }, `${method} ${path}`).toEqual(missing);
    }
  });

  it("refuses creating on a workspace without the feature with plan_required", async () => {
    const t = await team("stp", "pro");
    const response = await t.h.request(
      `/api/v1/workspaces/${t.slug}/service-tokens`,
      dashboard(t.adminCookie, "POST", TOKEN),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("serviceTokens") },
    });
  });

  it("refuses an admin role, annotation scopes and credentials:manage at the boundary", async () => {
    const t = await team("stv");
    for (const body of [
      { ...TOKEN, role: "admin" },
      { ...TOKEN, scopes: ["annotations:write"] },
      { ...TOKEN, scopes: ["credentials:manage"] },
      { ...TOKEN, expiresInDays: 400 },
      { label: "No expiry", role: "editor", scopes: ["artifacts:read"] },
    ]) {
      const response = await t.h.request(
        `/api/v1/workspaces/${t.slug}/service-tokens`,
        dashboard(t.adminCookie, "POST", body),
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("authenticating with a service token", () => {
  it("answers a table of credentials", async () => {
    const t = await team("sta");
    const valid = await createToken(t);
    const expired = await createToken(t, { ...TOKEN, label: "Old" });
    await db()
      .update(schema.serviceTokens)
      .set({ expiresAt: NOW - DAY })
      .where(eq(schema.serviceTokens.id, expired.token.id));
    const revoked = await createToken(t, { ...TOKEN, label: "Gone" });
    await t.h.request(
      `/api/v1/workspaces/${t.slug}/service-tokens/${revoked.token.id}`,
      dashboard(t.adminCookie, "DELETE"),
    );
    const other = await team("sto");

    const invalid = {
      error: {
        code: "unauthenticated",
        message: "This service token is not valid. It may have been revoked.",
      },
    };
    const cases: [string, Promise<Response>, number, unknown?][] = [
      ["valid", t.h.request("/api/v1/artifacts", bearer(valid.secret)), 200],
      [
        "expired",
        t.h.request("/api/v1/artifacts", bearer(expired.secret)),
        401,
        {
          error: {
            code: "unauthenticated",
            message:
              "This service token expired on 2026-11-09. Ask a workspace admin for a new one.",
          },
        },
      ],
      ["revoked", t.h.request("/api/v1/artifacts", bearer(revoked.secret)), 401, invalid],
      [
        "truncated",
        t.h.request("/api/v1/artifacts", bearer(valid.secret.slice(0, 20))),
        401,
        invalid,
      ],
      // Another prefix is not a service token: introspection does not know it either.
      [
        "wrong prefix",
        t.h.request("/api/v1/artifacts", bearer(`pfsx_${valid.secret.slice(5)}`)),
        401,
      ],
      [
        "another workspace by slug",
        t.h.request(`/api/v1/artifacts?workspace=${other.slug}`, bearer(valid.secret)),
        404,
        { error: { code: "not_found", message: "Workspace not found." } },
      ],
      [
        "as a session cookie",
        t.h.request("/api/v1/artifacts", {
          headers: { cookie: `${SESSION_COOKIE}=${valid.secret}`, "sec-fetch-site": "same-origin" },
        }),
        401,
      ],
      [
        "at an account endpoint",
        t.h.request("/api/v1/account/sessions", bearer(valid.secret)),
        403,
        { error: { code: "forbidden", message: "Account settings need a dashboard session." } },
      ],
      ["at the credentials API", t.h.request("/api/v1/tokens", bearer(valid.secret)), 401],
      [
        "managing webhooks",
        t.h.request(
          "/api/v1/webhooks",
          bearer(valid.secret, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: "https://hooks.example.com/x",
              format: "generic",
              events: ["artifact.published"],
            }),
          }),
        ),
        401,
      ],
      ["members", t.h.request(`/api/v1/workspaces/${t.slug}/members`, bearer(valid.secret)), 403],
      ["branding", t.h.request("/api/v1/account/branding", bearer(valid.secret)), 403],
      [
        "the annotations scope",
        t.h.request("/api/v1/artifacts/abcdefghij/annotations", bearer(valid.secret)),
        403,
      ],
      [
        "the comment action history",
        t.h.request("/api/v1/artifacts/abcdefghij/annotations/history", bearer(valid.secret)),
        403,
      ],
    ];
    for (const [name, pending, status, body] of cases) {
      const response = await pending;
      expect(response.status, name).toBe(status);
      if (body !== undefined) expect(await response.json(), name).toEqual(body);
    }
    const expiredAnswer = await t.h.request("/api/v1/artifacts", bearer(expired.secret));
    expect(expiredAnswer.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("is refused at MCP", async () => {
    const t = await team("stc");
    const created = await createToken(t);
    const response = await rpc(t.h, created.secret, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("stops at the next request after revocation, a plan lapse or the workspace's deletion", async () => {
    const t = await team("str");
    const created = await createToken(t);
    expect((await t.h.request("/api/v1/artifacts", bearer(created.secret))).status).toBe(200);
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "pro" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const lapsed = await t.h.request("/api/v1/artifacts", bearer(created.secret));
    expect(lapsed.status).toBe(403);
    expect(await lapsed.json()).toEqual({
      error: { code: "plan_required", message: planRequiredMessage("serviceTokens") },
    });
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "team" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect((await t.h.request("/api/v1/artifacts", bearer(created.secret))).status).toBe(200);
    await t.h.request(
      `/api/v1/workspaces/${t.slug}/service-tokens/${created.token.id}`,
      dashboard(t.adminCookie, "DELETE"),
    );
    expect((await t.h.request("/api/v1/artifacts", bearer(created.secret))).status).toBe(401);

    const second = await createToken(t, { ...TOKEN, label: "Second" });
    const deleted = await deleteWorkspace(regionsFromEnv(env), { workspaceId: t.id, now: NOW });
    expect(deleted.ok).toBe(true);
    expect((await t.h.request("/api/v1/artifacts", bearer(second.secret))).status).toBe(401);
  });

  it("holds the token to its scopes", async () => {
    const t = await team("sts");
    const readOnly = await createToken(t, { ...TOKEN, scopes: ["artifacts:read"] });
    const published = await publishWith(t.h, readOnly.secret, t.id);
    expect(published.status).toBe(403);
    expect(published.body).toEqual({
      error: {
        code: "forbidden",
        message: "This service token does not have the artifacts:write scope.",
      },
    });
  });
});

describe("keyed publishes through the API and MCP", () => {
  it("publishes twice with one key into one artifact, finds it and deletes it by ID", async () => {
    const t = await team("stk");
    const created = await createToken(t);
    const first = await publishWith(t.h, created.secret, t.id, { key: "pr-12" });
    expect(first.status).toBe(200);
    const second = await publishWith(t.h, created.secret, t.id, { key: "pr-12" });
    const a = first.body as { artifactId: string; versionNumber: number };
    const b = second.body as { artifactId: string; versionNumber: number };
    expect(b.artifactId).toBe(a.artifactId);
    expect(b.versionNumber).toBe(2);
    const found = await (
      await t.h.request("/api/v1/artifacts?key=pr-12", bearer(created.secret))
    ).json<{ items: { id: string; key: string; owner: unknown }[] }>();
    expect(found.items.map((item) => [item.id, item.key])).toEqual([[a.artifactId, "pr-12"]]);
    expect(found.items[0]?.owner).toEqual({ kind: "workspace", slug: t.slug, name: "Team" });
    const bad = await t.h.request("/api/v1/artifacts?key=bad%20key", bearer(created.secret));
    expect(bad.status).toBe(400);
    const deleted = await t.h.request(
      `/api/v1/artifacts/${a.artifactId}`,
      bearer(created.secret, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    const after = await (
      await t.h.request("/api/v1/artifacts?key=pr-12", bearer(created.secret))
    ).json<{ items: unknown[] }>();
    expect(after.items).toEqual([]);
  });

  it("gives a person the same keyed publish through MCP as through the API", async () => {
    const h = createHarness();
    const email = "stk-mcp@example.test";
    const access = await apiToken(h, email, SCOPES);
    const mcp = await connect(h, await mcpToken(h, email, SCOPES));
    const { userId } = await (await api(h, access, "/api/v1/me")).json<{ userId: string }>();
    const viaApi = await publishWith(h, access, userId, { key: "notes" });
    expect(viaApi.status).toBe(200);
    const { artifactId } = viaApi.body as { artifactId: string };
    const viaMcp = await callTool(mcp, "publish_document", {
      type: "site",
      name: "Notes",
      content: "<p>again</p>",
      key: "notes",
    });
    expect(viaMcp.isError).not.toBe(true);
    expect(viaMcp.structuredContent).toMatchObject({ artifactId, versionNumber: 2 });
    const listed = await callTool(mcp, "list_artifacts", { key: "notes" });
    expect(
      (listed.structuredContent as { items: { id: string; key: string }[] }).items.map((item) => [
        item.id,
        item.key,
      ]),
    ).toEqual([[artifactId, "notes"]]);
    const both = await callTool(mcp, "publish_document", {
      type: "site",
      name: "Notes",
      content: "<p>x</p>",
      key: "notes",
      artifactId,
      baseVersionId: "ver_x",
    });
    expect(both.structuredContent).toEqual({
      error: { code: "invalid_input", message: "Send an artifact ID or a key, not both." },
    });
  });
});

describe("what records the token", () => {
  it("names the token as the version's author and records its last use to the hour", async () => {
    const t = await team("stw");
    const created = await createToken(t);
    const published = await publishWith(t.h, created.secret, t.id);
    const { versionId } = published.body as { versionId: string };
    const [version] = await db()
      .select({ authorId: schema.versions.authorId })
      .from(schema.versions)
      .where(eq(schema.versions.id, versionId));
    expect(version?.authorId).toBe(created.token.id);
    const [row] = await db()
      .select({ lastUsedAt: schema.serviceTokens.lastUsedAt })
      .from(schema.serviceTokens)
      .where(eq(schema.serviceTokens.id, created.token.id));
    expect(row?.lastUsedAt).toBe(NOW);
  });
});
