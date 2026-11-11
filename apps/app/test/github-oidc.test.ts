// GitHub Actions OIDC federation at the app (decision 0024): the dashboard-only trust rule
// routes, the exchange and its one refusal for every way a token can be wrong, the key set's
// cache, refresh and limit, the rate limits, and what the issued credential can and cannot reach
// through the API. GitHub is FakeGitHubIssuer; nothing calls real GitHub.
import { env } from "cloudflare:workers";
import { GITHUB_EXCHANGE_REFUSED, githubAudience } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { FakeGitHubIssuer, type FakeGitHubTokenOptions } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authUrls } from "../src/auth/config.ts";
import { clearGitHubKeyCache, gitHubKeyFetches } from "../src/auth/github-oidc.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken, rpc } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-11T09:00:00Z");
const SCOPES = "artifacts:read artifacts:write artifacts:share artifacts:delete offline_access";
const REPO = { repositoryId: "123456", repositoryOwnerId: "777", repository: "acme/site" };
const REFUSED = { error: { code: "unauthenticated", message: GITHUB_EXCHANGE_REFUSED } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearGitHubKeyCache();
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;
const audience = (slug: string) => githubAudience(authUrls(env.APP_ORIGIN).origin, slug);

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
  issuer: FakeGitHubIssuer;
  adminEmail: string;
  adminCookie: string;
}

let counter = 0;

async function team(plan: "team" | "pro" = "team", options: { enabled?: boolean } = {}) {
  counter += 1;
  const prefix = `gho${counter}`;
  const issuer = new FakeGitHubIssuer();
  const h = createHarness({
    githubOidcFetch: issuer.fetch,
    ...(options.enabled === false ? { env: { GITHUB_OIDC_ENABLED: undefined } } : {}),
  });
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
  return { id: created.value.id, slug, h, issuer, adminEmail, adminCookie } satisfies Team;
}

const RULE = {
  ...REPO,
  events: ["pull_request", "push"],
  scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
};

async function trust(t: Team, body: object = RULE) {
  const response = await t.h.request(
    `/api/v1/workspaces/${t.slug}/github-trust`,
    dashboard(t.adminCookie, "POST", body),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<{ id: string; revision: number }>();
}

function exchange(t: Team, token: string, workspace = t.slug, ip = "198.51.100.7") {
  return t.h.request("/api/v1/github/token", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ workspace, token }),
  });
}

const mint = (t: Team, options: Partial<FakeGitHubTokenOptions> = {}, run = {}) =>
  t.issuer.token({ ...REPO, ...run }, { audience: audience(t.slug), ...options });

async function credential(t: Team, run = {}) {
  const response = await exchange(t, await mint(t, {}, run));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<{ token: string; keyPrefix: string; expiresAt: string; scopes: string[] }>();
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function publishWith(h: Harness, secret: string, ownerId: string, key?: string) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepare = await h.request(
    "/api/v1/publishes",
    bearer(secret, {
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
        ...(key === undefined ? {} : { key }),
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
    bearer(secret, { method: "POST" }),
  );
  return { status: commit.status, body: await commit.json<{ artifactId: string }>() };
}

describe("trust rules from the dashboard", () => {
  it("adds, lists and removes, with the audience a workflow asks for", async () => {
    const t = await team();
    const created = await trust(t);
    const list = await t.h.request(
      `/api/v1/workspaces/${t.slug}/github-trust`,
      dashboard(t.adminCookie),
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toMatchObject({
      items: [{ id: created.id, repository: "acme/site", keyPrefix: "gh-123456/" }],
      available: true,
      enabled: true,
      limit: 20,
      audience: audience(t.slug),
    });
    const changed = await t.h.request(
      `/api/v1/workspaces/${t.slug}/github-trust/${created.id}`,
      dashboard(t.adminCookie, "PATCH", { ...RULE, events: ["push"], revision: 0 }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ events: ["push"], revision: 1 });
    const removed = await t.h.request(
      `/api/v1/workspaces/${t.slug}/github-trust/${created.id}`,
      dashboard(t.adminCookie, "DELETE"),
    );
    expect(removed.status).toBe(204);
  });

  it("refuses every bearer token, a service token or a run's credential included", async () => {
    const t = await team();
    await trust(t);
    const run = await credential(t);
    const oauth = await apiToken(t.h, t.adminEmail, SCOPES);
    for (const secret of [run.token, oauth]) {
      for (const [method, body] of [
        ["GET", undefined],
        ["POST", { ...RULE, repositoryId: "999" }],
      ] as const) {
        const response = await t.h.request(
          `/api/v1/workspaces/${t.slug}/github-trust`,
          bearer(secret, {
            method,
            ...(body
              ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
              : {}),
          }),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: {
            code: "forbidden",
            message: "GitHub trust rules are managed from the dashboard.",
          },
        });
      }
    }
  });

  it("answers bad input, unknown rules and stale revisions without changing anything", async () => {
    const t = await team();
    const created = await trust(t);
    const base = `/api/v1/workspaces/${t.slug}/github-trust`;
    const cases: [string, string, unknown, number][] = [
      ["POST", base, { ...RULE, repositoryId: "abc" }, 400],
      ["PATCH", `${base}/not-a-rule`, { ...RULE, revision: 0 }, 404],
      ["DELETE", `${base}/not-a-rule`, undefined, 404],
      ["DELETE", `${base}/gtr_${"0".repeat(32)}`, undefined, 404],
      ["PATCH", `${base}/${created.id}`, { ...RULE, events: ["push"], revision: 5 }, 409],
      ["PATCH", `${base}/${created.id}`, { ...RULE, repositoryId: "x", revision: 0 }, 400],
    ];
    for (const [method, path, body, status] of cases) {
      const response = await t.h.request(path, dashboard(t.adminCookie, method, body));
      expect(response.status, `${method} ${path}`).toBe(status);
    }
    const off = createHarness({
      githubOidcFetch: t.issuer.fetch,
      env: { GITHUB_OIDC_ENABLED: undefined },
    });
    const patched = await off.request(
      `${base}/${created.id}`,
      dashboard(t.adminCookie, "PATCH", { ...RULE, revision: 0 }),
    );
    expect(patched.status).toBe(503);
  });

  it("is gated on the plan for adding, never for removing", async () => {
    const t = await team("pro");
    const response = await t.h.request(
      `/api/v1/workspaces/${t.slug}/github-trust`,
      dashboard(t.adminCookie, "POST", RULE),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "plan_required" } });
  });

  it("ships switched off: no exchange, no new rules, but listing and removing still work", async () => {
    const on = await team();
    const created = await trust(on);
    const off = createHarness({
      githubOidcFetch: on.issuer.fetch,
      env: { GITHUB_OIDC_ENABLED: undefined },
    });
    const token = await mint(on);
    const exchanged = await off.request("/api/v1/github/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: on.slug, token }),
    });
    expect(exchanged.status).toBe(404);
    const add = await off.request(
      `/api/v1/workspaces/${on.slug}/github-trust`,
      dashboard(on.adminCookie, "POST", { ...RULE, repositoryId: "42" }),
    );
    expect(add.status).toBe(503);
    expect(await add.json()).toMatchObject({ error: { code: "capacity_unavailable" } });
    const list = await off.request(
      `/api/v1/workspaces/${on.slug}/github-trust`,
      dashboard(on.adminCookie),
    );
    expect(await list.json()).toMatchObject({ enabled: false, items: [{ id: created.id }] });
    const removed = await off.request(
      `/api/v1/workspaces/${on.slug}/github-trust/${created.id}`,
      dashboard(on.adminCookie, "DELETE"),
    );
    expect(removed.status).toBe(204);
    expect(on.issuer.calls).toEqual([]);
  });
});

describe("the exchange", () => {
  it("answers a short-lived credential for the trusted repository", async () => {
    const t = await team();
    await trust(t);
    const issued = await credential(t);
    expect(issued).toEqual({
      token: expect.stringMatching(/^pfst_[A-Za-z0-9_-]{43}$/),
      expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
      workspace: t.slug,
      keyPrefix: "gh-123456/",
      scopes: ["artifacts:read", "artifacts:write", "artifacts:delete"],
    });
  });

  it("answers the same refusal for every way a token or a rule can be wrong", async () => {
    const t = await team();
    const other = await team();
    await trust(t);
    await trust(t, {
      ...RULE,
      repositoryId: "555",
      repository: "acme/env",
      environment: "preview",
    });
    const now = Math.floor(NOW / 1000);
    const replayed = await mint(t);
    expect((await exchange(t, replayed)).status).toBe(200);
    const cases: [string, Promise<string> | string][] = [
      ["not a JWT", "not-a-token"],
      ["a replayed token", replayed],
      ["another workspace's audience", mint(t, { audience: audience(other.slug) })],
      ["another service's audience", mint(t, { audience: "sts.amazonaws.com" })],
      ["the default audience", mint(t, { audience: "https://github.com/acme" })],
      ["several audiences", mint(t, { audience: [audience(t.slug), "sts.amazonaws.com"] })],
      [
        "another deployment",
        mint(t, { audience: githubAudience("https://app.staging.example", t.slug) }),
      ],
      ["expired", mint(t, { claims: { iat: now - 600, nbf: now - 600, exp: now - 120 } })],
      ["not valid yet", mint(t, { claims: { nbf: now + 600 } })],
      ["issued in the future", mint(t, { claims: { iat: now + 600 } })],
      ["issued over an hour ago", mint(t, { claims: { iat: now - 7200, exp: now + 60 } })],
      ["living longer than an hour", mint(t, { claims: { exp: now + 7200 } })],
      ["no jti", mint(t, { claims: { jti: undefined } })],
      ["another issuer", mint(t, { claims: { iss: "https://token.actions.example.com" } })],
      [
        "an enterprise issuer",
        mint(t, { claims: { iss: "https://token.actions.githubusercontent.com/acme-enterprise" } }),
      ],
      [
        "GitHub Enterprise Server",
        mint(t, { claims: { iss: "https://ghes.example.com/_services/token" } }),
      ],
      ["a key not GitHub's", mint(t, { signing: "stray" })],
      ["no signature", mint(t, { signing: "none", header: { alg: "none" } })],
      ["HMAC", mint(t, { header: { alg: "HS256" } })],
      ["no kid", mint(t, { header: { kid: undefined } })],
      ["a repository the workspace does not trust", mint(t, {}, { repositoryId: "999" })],
      ["the trusted name with another ID", mint(t, {}, { repositoryId: "998" })],
      ["another owner", mint(t, {}, { repositoryOwnerId: "778" })],
      ["a privileged event", mint(t, {}, { eventName: "pull_request_target" })],
      ["an untrusted event", mint(t, {}, { eventName: "workflow_dispatch" })],
      [
        "no environment where one is required",
        mint(t, {}, { repositoryId: "555", repository: "acme/env" }),
      ],
      ["a workspace that does not exist", mint(t, { audience: audience("nope") })],
    ];
    for (const [name, pending] of cases) {
      const token = await pending;
      const workspace = name === "a workspace that does not exist" ? "nope" : t.slug;
      const response = await exchange(t, token, workspace);
      expect(response.status, name).toBe(401);
      expect(await response.json(), name).toEqual(REFUSED);
    }
  });

  it("refuses a body that is not the exchange's, or a token that only looks like one", async () => {
    const t = await team();
    await trust(t);
    const notJson = await t.h.request("/api/v1/github/token", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "token",
    });
    expect(notJson.status).toBe(401);
    expect(await notJson.json()).toEqual(REFUSED);
    const good = await mint(t);
    const [head, , signature] = good.split(".");
    const encode = (text: string) =>
      btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    for (const token of [
      `${head}.${encode("not json")}.${signature}`,
      `${head}.${encode(JSON.stringify({ iss: "x" }))}.${signature}`,
      `${good.slice(0, -4)}AAAA`,
      "a.b.c",
    ]) {
      const response = await exchange(t, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(REFUSED);
    }
  });

  it("accepts the audience alone in a list, and refuses claims of another shape", async () => {
    const t = await team();
    await trust(t);
    expect((await exchange(t, await mint(t, { audience: [audience(t.slug)] }))).status).toBe(200);
    for (const claims of [
      { repository_id: 123456 },
      { run_attempt: "0" },
      { event_name: undefined },
    ]) {
      const response = await exchange(t, await mint(t, { claims }));
      expect(response.status, JSON.stringify(claims)).toBe(401);
    }
  });

  it("refuses once the plan lapses, with the same answer", async () => {
    const t = await team();
    await trust(t);
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "pro" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const response = await exchange(t, await mint(t));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(REFUSED);
  });

  it("limits attempts per IP and verified tokens per repository", async () => {
    const t = await team();
    await trust(t);
    await db()
      .insert(schema.rateLimits)
      .values({ key: "github-oidc:ip:203.0.113.9", windowStart: NOW, count: 300 });
    const byIp = await exchange(t, await mint(t), t.slug, "203.0.113.9");
    expect(byIp.status).toBe(429);
    expect(byIp.headers.get("retry-after")).toBe("600");
    // A refusal before the signature never reaches GitHub's key set.
    expect(t.issuer.calls).toEqual([]);
    await db()
      .insert(schema.rateLimits)
      .values({ key: "github-oidc:repo:123456", windowStart: NOW, count: 60 });
    const byRepository = await exchange(t, await mint(t));
    expect(byRepository.status).toBe(429);
  });
});

describe("GitHub's key set", () => {
  it("is fetched once per isolate and reused", async () => {
    const t = await team();
    await trust(t);
    await credential(t);
    await credential(t);
    await credential(t);
    expect(gitHubKeyFetches()).toBe(1);
    expect(t.issuer.calls).toEqual([
      "https://token.actions.githubusercontent.com/.well-known/jwks",
    ]);
  });

  it("is fetched again for a rotated key, at most once a minute for unknown keys", async () => {
    const t = await team();
    await trust(t);
    await credential(t);
    await t.issuer.rotate();
    await credential(t);
    expect(gitHubKeyFetches()).toBe(2);
    // Made-up keys cannot make every exchange call GitHub.
    for (let i = 0; i < 3; i += 1) {
      expect((await exchange(t, await mint(t, { signing: "stray" }))).status).toBe(401);
    }
    expect(gitHubKeyFetches()).toBe(2);
    vi.setSystemTime(NOW + 61_000);
    expect((await exchange(t, await mint(t, { signing: "stray" }))).status).toBe(401);
    expect(gitHubKeyFetches()).toBe(3);
  });

  it("refuses while GitHub is unreachable or answers with a redirect", async () => {
    const t = await team();
    await trust(t);
    t.issuer.override = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/jwks" } });
    expect((await exchange(t, await mint(t))).status).toBe(401);
    clearGitHubKeyCache();
    t.issuer.override = () => new Response("x".repeat(70 * 1024));
    expect((await exchange(t, await mint(t))).status).toBe(401);
    clearGitHubKeyCache();
    t.issuer.override = null;
    expect((await exchange(t, await mint(t))).status).toBe(200);
  });
});

describe("the credential", () => {
  it("publishes only under its repository's key namespace", async () => {
    const t = await team();
    await trust(t);
    const run = await credential(t);
    const own = await publishWith(t.h, run.token, t.id, "gh-123456/pr-7");
    expect(own.status).toBe(200);
    expect((await publishWith(t.h, run.token, t.id)).status).toBe(403);
    expect((await publishWith(t.h, run.token, t.id, "pr-7")).status).toBe(403);
    expect((await publishWith(t.h, run.token, t.id, "gh-1234567/pr-7")).status).toBe(403);
    const listed = await t.h.request("/api/v1/artifacts", bearer(run.token));
    expect(listed.status).toBe(200);
  });

  it("is refused at MCP, account endpoints, annotations and access changes", async () => {
    const t = await team();
    await trust(t);
    const run = await credential(t);
    expect((await rpc(t.h, run.token, "tools/list")).status).toBe(401);
    expect((await t.h.request("/api/v1/account/sessions", bearer(run.token))).status).toBe(403);
    expect((await t.h.request("/api/v1/tokens", bearer(run.token))).status).toBe(401);
    expect(
      (await t.h.request("/api/v1/artifacts/abcdefghij/annotations", bearer(run.token))).status,
    ).toBe(403);
    const access = await t.h.request(
      "/api/v1/artifacts/abcdefghij/access",
      bearer(run.token, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ mode: "public" }),
      }),
    );
    expect(access.status).toBe(403);
  });

  it("stops at once when the rule is removed, and when it expires", async () => {
    const t = await team();
    const created = await trust(t);
    const run = await credential(t);
    expect((await t.h.request("/api/v1/artifacts", bearer(run.token))).status).toBe(200);
    vi.setSystemTime(NOW + 15 * 60_000);
    expect((await t.h.request("/api/v1/artifacts", bearer(run.token))).status).toBe(401);
    vi.setSystemTime(NOW);
    const next = await credential(t);
    await t.h.request(
      `/api/v1/workspaces/${t.slug}/github-trust/${created.id}`,
      dashboard(t.adminCookie, "DELETE"),
    );
    expect((await t.h.request("/api/v1/artifacts", bearer(next.token))).status).toBe(401);
  });
});
