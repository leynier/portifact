// SCIM 2.0 at the app (premium plan E2, decision 0017): the dashboard-only settings and token
// routes, the protocol endpoints at /scim/v2 (conformance with RFC 7644 and the request shapes
// Okta and Microsoft Entra ID document), authentication in both directions (a SCIM token never
// reaches /api/v1 or MCP, a service token or OAuth token never reaches /scim/v2), the plan, the
// switch, the body cap, sessions ended on deactivation and a sign-in claiming a pending
// membership. No test calls a real directory.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { createWorkspace } from "@portifact/services";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scimRoutes } from "../src/scim.ts";
import { createHarness, type Harness, ORIGIN } from "./harness.ts";
import { api, apiToken } from "./mcp-helpers.ts";

const NOW = Date.parse("2026-11-10T09:00:00Z");
const SCIM = "/scim/v2";
const TYPE = "application/scim+json";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const db = () => regionsFromEnv(env).get("default").db;
const global = () => regionsFromEnv(env).global;

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

const scim = (secret: string, method = "GET", body?: unknown, type = TYPE): RequestInit => ({
  method,
  headers: {
    authorization: `Bearer ${secret}`,
    ...(body === undefined ? {} : { "content-type": type }),
  },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

interface Team {
  id: string;
  slug: string;
  domain: string;
  h: Harness;
  adminCookie: string;
  secret: string;
}

let counter = 0;

async function team(plan: "enterprise" | "team" = "enterprise", seats = 5): Promise<Team> {
  counter += 1;
  const h = createHarness();
  const domain = `scim${counter}${crypto.randomUUID().slice(0, 6)}.example.com`;
  const adminEmail = `admin@${domain}`;
  const adminCookie = await h.signIn(adminEmail);
  const access = await apiToken(h, adminEmail, "artifacts:read offline_access");
  const { userId } = await (await api(h, access, "/api/v1/me")).json<{ userId: string }>();
  const slug = `scim-${counter}-${crypto.randomUUID().slice(0, 6)}`;
  const created = await createWorkspace(global(), {
    slug,
    name: "Directory team",
    adminUserId: userId,
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: created.value.id, plan, seats, grantedBy: "test", updatedAt: NOW });
  await global()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: created.value.id,
      domain,
      token: "t",
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW,
      verifiedAt: NOW,
    });
  let secret = "";
  if (plan === "enterprise") {
    const response = await h.request(
      `/api/v1/workspaces/${slug}/scim/tokens`,
      dashboard(adminCookie, "POST", { label: "Okta", expiresInDays: 365 }),
    );
    expect(response.status).toBe(201);
    secret = (await response.json<{ secret: string }>()).secret;
  }
  return { id: created.value.id, slug, domain, h, adminCookie, secret };
}

async function created(t: Team, body: unknown) {
  const response = await t.h.request(`${SCIM}/Users`, scim(t.secret, "POST", body));
  return { response, body: await response.json<Record<string, unknown>>() };
}

describe("the settings routes", () => {
  it("serve admins through the session only, with the base URL to paste", async () => {
    const t = await team();
    const overview = await t.h.request(
      `/api/v1/workspaces/${t.slug}/scim`,
      dashboard(t.adminCookie),
    );
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      baseUrl: `${ORIGIN}/scim/v2`,
      available: true,
      limit: 2,
      invitationEmails: false,
      pending: 0,
      tokens: [{ label: "Okta" }],
    });
    // A bearer token never reaches them, not even the directory's own.
    for (const authorization of [`Bearer ${t.secret}`, "Bearer pfst_x"]) {
      const refused = await t.h.request(`/api/v1/workspaces/${t.slug}/scim`, {
        headers: { authorization },
      });
      expect(refused.status).toBe(403);
    }
    const saved = await t.h.request(
      `/api/v1/workspaces/${t.slug}/scim`,
      dashboard(t.adminCookie, "PATCH", { invitationEmails: true }),
    );
    expect(await saved.json()).toMatchObject({ invitationEmails: true });
    const bad = await t.h.request(
      `/api/v1/workspaces/${t.slug}/scim`,
      dashboard(t.adminCookie, "PATCH", { invitationEmails: "yes" }),
    );
    expect(bad.status).toBe(400);
    const tokens = (
      await (
        await t.h.request(`/api/v1/workspaces/${t.slug}/scim`, dashboard(t.adminCookie))
      ).json<{ tokens: { id: string }[] }>()
    ).tokens;
    const revoke = (id: string) =>
      t.h.request(
        `/api/v1/workspaces/${t.slug}/scim/tokens/${id}`,
        dashboard(t.adminCookie, "DELETE"),
      );
    expect((await revoke("not-an-id")).status).toBe(404);
    expect((await revoke(tokens[0]?.id ?? "")).status).toBe(204);
    expect((await revoke(tokens[0]?.id ?? "")).status).toBe(404);
    const bodyless = await t.h.request(
      `/api/v1/workspaces/${t.slug}/scim/tokens`,
      dashboard(t.adminCookie, "POST", { label: "" }),
    );
    expect(bodyless.status).toBe(400);
    expect(
      (await t.h.request(`/api/v1/workspaces/NOT A SLUG/scim`, dashboard(t.adminCookie))).status,
    ).toBe(404);
  });

  it("answer capacity_unavailable while switched off, and the endpoints 404", async () => {
    const t = await team();
    const off = createHarness({ env: { SCIM_ENABLED: undefined } });
    const settings = await off.request(
      `/api/v1/workspaces/${t.slug}/scim`,
      dashboard(t.adminCookie),
    );
    expect(settings.status).toBe(503);
    expect(await settings.json()).toMatchObject({ error: { code: "capacity_unavailable" } });
    for (const path of ["/ServiceProviderConfig", "/Users", "/Groups"]) {
      const response = await off.request(`${SCIM}${path}`, scim(t.secret));
      expect(response.status).toBe(404);
    }
  });
});

describe("authentication", () => {
  it("takes only a SCIM token, and a SCIM token reaches nothing else", async () => {
    const t = await team();
    const ok = await t.h.request(`${SCIM}/ServiceProviderConfig`, scim(t.secret));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain(TYPE);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    // No header, a service token, an OAuth token, a cookie, a made-up SCIM secret.
    const access = await apiToken(t.h, `admin@${t.domain}`, "artifacts:read offline_access");
    const attempts: RequestInit[] = [
      {},
      scim(`pfst_${"a".repeat(43)}`),
      scim(access),
      { headers: { cookie: t.adminCookie } },
      scim(`pfsc_${"z".repeat(43)}`),
      { headers: { authorization: "Basic abc" } },
    ];
    for (const init of attempts) {
      const response = await t.h.request(`${SCIM}/Users`, init);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="SCIM"');
      expect(await response.json()).toMatchObject({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "401",
      });
    }
    // The SCIM token is not an API token, nor an MCP token.
    expect((await t.h.request("/api/v1/artifacts", scim(t.secret))).status).toBe(401);
    expect((await t.h.request("/api/v1/me", scim(t.secret))).status).toBe(401);
    expect(
      (
        await t.h.request("/mcp", {
          ...scim(
            t.secret,
            "POST",
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            "application/json",
          ),
          headers: {
            authorization: `Bearer ${t.secret}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a lapsed plan as forbidden and an expired token as unauthenticated", async () => {
    const t = await team();
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "team" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    const lapsed = await t.h.request(`${SCIM}/Users`, scim(t.secret));
    expect(lapsed.status).toBe(403);
    expect(await lapsed.json()).toMatchObject({ status: "403" });
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "enterprise" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    await global()
      .update(schema.scimTokens)
      .set({ expiresAt: NOW })
      .where(eq(schema.scimTokens.workspaceId, t.id));
    const expired = await t.h.request(`${SCIM}/Users`, scim(t.secret));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ detail: expect.stringContaining("expired") });
  });

  it("is rate limited per token", async () => {
    const t = await team();
    await env.DB.prepare(
      "insert into rate_limits (key, window_start, count) select 'scim:token:' || id, ?1, 300 from scim_tokens where workspace_id = ?2",
    )
      .bind(NOW, t.id)
      .run();
    const limited = await t.h.request(`${SCIM}/Users`, scim(t.secret));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});

describe("the protocol", () => {
  it("describes itself", async () => {
    const t = await team();
    const config = await (
      await t.h.request(`${SCIM}/ServiceProviderConfig`, scim(t.secret))
    ).json();
    expect(config).toMatchObject({ patch: { supported: true }, bulk: { supported: false } });
    const types = await (await t.h.request(`${SCIM}/ResourceTypes`, scim(t.secret))).json();
    expect(types).toMatchObject({
      totalResults: 1,
      Resources: [{ id: "User", endpoint: "/Users" }],
    });
    expect((await t.h.request(`${SCIM}/ResourceTypes/User`, scim(t.secret))).status).toBe(200);
    expect((await t.h.request(`${SCIM}/ResourceTypes/Group`, scim(t.secret))).status).toBe(404);
    const schemas = await (await t.h.request(`${SCIM}/Schemas`, scim(t.secret))).json();
    expect(schemas).toMatchObject({ totalResults: 1 });
    const userSchema = encodeURIComponent("urn:ietf:params:scim:schemas:core:2.0:User");
    expect((await t.h.request(`${SCIM}/Schemas/${userSchema}`, scim(t.secret))).status).toBe(200);
    expect((await t.h.request(`${SCIM}/Schemas/other`, scim(t.secret))).status).toBe(404);
    // Groups are not served in this delivery.
    const groups = await t.h.request(`${SCIM}/Groups`, scim(t.secret));
    expect(groups.status).toBe(404);
    expect(await groups.json()).toMatchObject({ status: "404" });
  });

  it("runs Okta's sequence: look up, create, read, deactivate", async () => {
    const t = await team();
    const email = `test.user@${t.domain}`;
    // Okta looks the user up first: an empty list answers "not there".
    const lookup = await t.h.request(
      `${SCIM}/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}&startIndex=1&count=100`,
      scim(t.secret),
    );
    expect(await lookup.json()).toMatchObject({ totalResults: 0, Resources: [], startIndex: 1 });
    // Okta's create request (developer.okta.com, "Create the User").
    const create = await created(t, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: email,
      name: { givenName: "Test", familyName: "User" },
      emails: [{ primary: true, value: email, type: "work" }],
      displayName: "Test User",
      locale: "en-US",
      externalId: "00ujl29u0le5T6Aj10h7",
      groups: [],
      password: "1mz050nq",
      active: true,
    });
    expect(create.response.status).toBe(201);
    expect(create.response.headers.get("location")).toBe(
      `${ORIGIN}${SCIM}/Users/${create.body.id}`,
    );
    expect(create.body).toMatchObject({
      userName: email,
      active: true,
      externalId: "00ujl29u0le5T6Aj10h7",
      name: { givenName: "Test", familyName: "User" },
      meta: { resourceType: "User" },
    });
    expect(create.body).not.toHaveProperty("password");
    const again = await created(t, { userName: email });
    expect(again.response.status).toBe(409);
    expect(again.body).toMatchObject({ scimType: "uniqueness", status: "409" });
    const read = await t.h.request(`${SCIM}/Users/${create.body.id}`, scim(t.secret));
    expect(await read.json()).toMatchObject({ id: create.body.id });
    // Okta's deactivation.
    const off = await t.h.request(
      `${SCIM}/Users/${create.body.id}`,
      scim(t.secret, "PATCH", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      }),
    );
    expect(await off.json()).toMatchObject({ active: false });
    // Okta's full update.
    const put = await t.h.request(
      `${SCIM}/Users/${create.body.id}`,
      scim(t.secret, "PUT", { userName: email, active: true, name: { givenName: "T" } }),
    );
    expect(await put.json()).toMatchObject({ active: true, name: { givenName: "T" } });
  });

  it("runs Entra's sequence with its dialect", async () => {
    const t = await team();
    const email = `entra@${t.domain}`;
    const lookup = await t.h.request(
      `${SCIM}/Users?filter=${encodeURIComponent('externalId eq "0a21f0f2"')}`,
      scim(t.secret),
    );
    expect(await lookup.json()).toMatchObject({ totalResults: 0 });
    // Entra's create request, with the enterprise extension it always sends.
    const create = await created(t, {
      schemas: [
        "urn:ietf:params:scim:schemas:core:2.0:User",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
      ],
      externalId: "0a21f0f2",
      userName: email,
      active: true,
      emails: [{ primary: true, type: "work", value: email }],
      meta: { resourceType: "User" },
      name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
      roles: [],
    });
    expect(create.response.status).toBe(201);
    const id = String(create.body.id);
    const patch = (Operations: unknown[]) =>
      t.h.request(
        `${SCIM}/Users/${id}`,
        scim(t.secret, "PATCH", {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations,
        }),
      );
    const updated = await patch([
      { op: "Replace", path: 'emails[type eq "work"].value', value: "x@elsewhere.com" },
      { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
    ]);
    expect(await updated.json()).toMatchObject({ name: { familyName: "updatedFamilyName" } });
    const off = await patch([{ op: "Replace", path: "active", value: "False" }]);
    expect(await off.json()).toMatchObject({ active: false });
    const bad = await patch([{ op: "Replace", path: "active", value: "Maybe" }]);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ scimType: "invalidValue" });
    const deleted = await t.h.request(`${SCIM}/Users/${id}`, scim(t.secret, "DELETE"));
    expect(deleted.status).toBe(204);
    expect((await t.h.request(`${SCIM}/Users/${id}`, scim(t.secret, "DELETE"))).status).toBe(404);
  });

  it("refuses what the RFC says to refuse", async () => {
    const t = await team();
    const cases: [string, RequestInit, number, string | undefined][] = [
      [
        `${SCIM}/Users?filter=${encodeURIComponent('displayName co "x"')}`,
        scim(t.secret),
        400,
        "invalidFilter",
      ],
      [`${SCIM}/Users?count=abc`, scim(t.secret), 400, "invalidValue"],
      [`${SCIM}/Users`, scim(t.secret, "POST", { userName: "x@gmail.com" }), 400, "invalidValue"],
      [`${SCIM}/Users`, scim(t.secret, "POST", "{not json"), 400, "invalidSyntax"],
      [
        `${SCIM}/Users`,
        scim(t.secret, "POST", { userName: "a" }, "text/plain"),
        400,
        "invalidSyntax",
      ],
      [`${SCIM}/Users`, scim(t.secret, "POST", { userName: "x".repeat(70_000) }), 413, undefined],
      [`${SCIM}/Users/not-an-id`, scim(t.secret), 404, undefined],
      [`${SCIM}/Users/not-an-id`, scim(t.secret, "PUT", { userName: "a@b.co" }), 404, undefined],
      [`${SCIM}/Users/not-an-id`, scim(t.secret, "PATCH", { Operations: [] }), 404, undefined],
      [`${SCIM}/Users/not-an-id`, scim(t.secret, "DELETE"), 404, undefined],
      [`${SCIM}/Users/su_${"0".repeat(32)}`, scim(t.secret), 404, undefined],
    ];
    for (const [path, init, status, scimType] of cases) {
      const response = await t.h.request(path, init);
      expect(response.status, path).toBe(status);
      const body = await response.json<Record<string, unknown>>();
      expect(body.status).toBe(String(status));
      if (scimType) expect(body.scimType).toBe(scimType);
    }
    const id = String((await created(t, { userName: `p@${t.domain}` })).body.id);
    for (const [method, body] of [
      ["PUT", "{bad"],
      ["PATCH", "{bad"],
      ["PUT", { userName: "nope" }],
    ] as const) {
      const response = await t.h.request(`${SCIM}/Users/${id}`, scim(t.secret, method, body));
      expect(response.status).toBe(400);
    }
  });

  it("refuses beyond the seats and keeps IDs to their workspace", async () => {
    const t = await team("enterprise", 1);
    const full = await created(t, { userName: `two@${t.domain}` });
    expect(full.response.status).toBe(403);
    const other = await team();
    const mine = await created(other, { userName: `mine@${other.domain}` });
    const foreign = await t.h.request(`${SCIM}/Users/${mine.body.id}`, scim(t.secret));
    expect(foreign.status).toBe(404);
  });
});

describe("people", () => {
  it("ends every session of a deactivated member and blocks their return through single sign-on", async () => {
    const t = await team();
    const email = `member@${t.domain}`;
    const cookie = await t.h.signIn(email);
    const create = await created(t, { userName: email });
    expect(create.response.status).toBe(201);
    const [account] = await global()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    const userId = account?.id ?? "";
    const membership = () =>
      global()
        .select()
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, t.id),
            eq(schema.workspaceMembers.userId, userId),
          ),
        );
    expect(await membership()).toHaveLength(1);
    expect((await t.h.request("/api/v1/workspaces", dashboard(cookie))).status).toBe(200);
    const off = await t.h.request(
      `${SCIM}/Users/${create.body.id}`,
      scim(t.secret, "PATCH", { Operations: [{ op: "replace", value: { active: false } }] }),
    );
    expect(off.status).toBe(200);
    expect(await membership()).toEqual([]);
    expect(
      await global().select().from(schema.sessions).where(eq(schema.sessions.userId, userId)),
    ).toEqual([]);
    expect((await t.h.request("/api/v1/workspaces", dashboard(cookie))).status).toBe(401);
    const removals = await global()
      .select()
      .from(schema.workspaceRemovals)
      .where(eq(schema.workspaceRemovals.userId, userId));
    expect(removals).toHaveLength(1);
    // The account stays: the person signs in again, outside the workspace.
    const again = await t.h.signIn(email);
    const listed = await (await t.h.request("/api/v1/workspaces", dashboard(again))).json<{
      items: unknown[];
    }>();
    expect(listed.items).toEqual([]);
  });

  it("asks the directory to retry when sessions could not be ended", async () => {
    const t = await team();
    const email = `stuck@${t.domain}`;
    await t.h.signIn(email);
    const create = await created(t, { userName: email });
    // The routes alone, with a Better Auth that cannot end sessions.
    const routes = scimRoutes({
      endSessions: () => async () => {
        throw new Error("down");
      },
      invitations: () => ({ send: async () => {} }),
      now: () => NOW,
    });
    const workerEnv = { ...env, SCIM_ENABLED: "true" } as Cloudflare.Env;
    for (const [method, body] of [
      ["PATCH", { Operations: [{ op: "replace", path: "active", value: false }] }],
      ["DELETE", undefined],
    ] as const) {
      const response = await routes.request(
        `${ORIGIN}${SCIM}/Users/${create.body.id}`,
        scim(t.secret, method, body),
        workerEnv,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "503" });
    }
    // The directory retries; the removal already holds and the next attempt ends the sessions.
    const retried = await t.h.request(`${SCIM}/Users/${create.body.id}`, scim(t.secret, "DELETE"));
    expect(retried.status).toBe(204);
    const [account] = await global()
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    expect(
      await global()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, account?.id ?? "")),
    ).toEqual([]);
  });

  it("makes a provisioned person a member at their first sign-in", async () => {
    const t = await team();
    const email = `first@${t.domain}`;
    const create = await created(t, { userName: email });
    expect(create.response.status).toBe(201);
    const overview = await (
      await t.h.request(`/api/v1/workspaces/${t.slug}/scim`, dashboard(t.adminCookie))
    ).json<{ pending: number }>();
    expect(overview.pending).toBe(1);
    const invitations = await (
      await t.h.request(`/api/v1/workspaces/${t.slug}/invitations`, dashboard(t.adminCookie))
    ).json<{ items: { email: string; source: string }[] }>();
    expect(invitations.items).toContainEqual(
      expect.objectContaining({ email, source: "directory" }),
    );
    const cookie = await t.h.signIn(email);
    const listed = await (await t.h.request("/api/v1/workspaces", dashboard(cookie))).json<{
      items: { slug: string; role: string }[];
    }>();
    expect(listed.items).toEqual([expect.objectContaining({ slug: t.slug, role: "member" })]);
  });

  it("claims nothing at sign-in while switched off", async () => {
    const t = await team();
    const email = `off@${t.domain}`;
    await created(t, { userName: email });
    const off = createHarness({ env: { SCIM_ENABLED: undefined } });
    const cookie = await off.signIn(email);
    const listed = await (await off.request("/api/v1/workspaces", dashboard(cookie))).json<{
      items: unknown[];
    }>();
    expect(listed.items).toEqual([]);
  });
});

describe("route inventory", () => {
  it("classifies every SCIM route: bearer-only protocol endpoints behind the switch and the token", () => {
    const routes = scimRoutes({
      endSessions: () => async () => {},
      invitations: () => ({ send: async () => {} }),
      now: () => NOW,
    });
    const served = routes.routes.map((route) => `${route.method} ${route.path}`).sort();
    expect(served).toEqual(
      [
        // The switch, the SCIM token and the rate limit, before anything else.
        `ALL ${SCIM}/*`,
        `GET ${SCIM}/ServiceProviderConfig`,
        `GET ${SCIM}/ResourceTypes`,
        `GET ${SCIM}/ResourceTypes/:id`,
        `GET ${SCIM}/Schemas`,
        `GET ${SCIM}/Schemas/:id`,
        `GET ${SCIM}/Users`,
        `GET ${SCIM}/Users/:id`,
        `POST ${SCIM}/Users`,
        `PUT ${SCIM}/Users/:id`,
        `PATCH ${SCIM}/Users/:id`,
        `DELETE ${SCIM}/Users/:id`,
        // Groups, Bulk, Me and the rest: 404 in this delivery.
        `ALL ${SCIM}/*`,
      ].sort(),
    );
  });

  it("never opens Better Auth's own SCIM plugin paths", async () => {
    const h = createHarness();
    for (const path of [
      "/api/auth/scim/v2/Users",
      "/api/auth/scim/generate-token",
      "/api/auth/scim/v2/ServiceProviderConfig",
    ]) {
      expect((await h.request(path)).status, path).toBe(404);
    }
  });
});
