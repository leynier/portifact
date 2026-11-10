// Single sign-on with OpenID Connect for workspaces (premium plan E1, decision 0016) through the
// Worker: the provider routes (admins, dashboard session only), the login page's lookup, the
// whole sign-in against a fake identity provider (terms, human check, existing accounts, the
// domain rule, every way an ID token or a flow can be wrong), joining the workspace, the switch
// and the route inventory. No test reaches a real identity provider.
import { env } from "cloudflare:workers";
import { TERMS_VERSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { clearSsoDiscoveryCache, createWorkspace, SSO_CACHE_ENTRIES } from "@portifact/services";
import { FakeIdentityProvider } from "@portifact/services/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEndpoint } from "../src/auth/routes.ts";
import { clearSsoKeyCache, ssoKeyCacheSize, verifyIdToken } from "../src/auth/sso.ts";
import {
  cookieHeader,
  createHarness,
  type Harness,
  json,
  ORIGIN,
  SESSION_COOKIE,
} from "./harness.ts";

const global = () => regionsFromEnv(env).global;
const hex = () => crypto.randomUUID().replaceAll("-", "");

beforeEach(async () => {
  clearSsoDiscoveryCache();
  clearSsoKeyCache();
  await env.DB.exec("DELETE FROM rate_limits");
});

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

interface Setup {
  h: Harness;
  idp: FakeIdentityProvider;
  workspaceId: string;
  slug: string;
  domain: string;
  adminCookie: string;
  providerId: string;
}

async function verifyDomain(workspaceId: string, domain: string, state = "verified" as const) {
  await global()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${hex()}`,
      workspaceId,
      domain,
      token: hex(),
      state,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      verifiedAt: Date.now(),
    });
}

async function onPlan(ownerId: string, plan: "enterprise" | "team", seats = 10) {
  await global()
    .insert(schema.ownerPlans)
    .values({ ownerId, plan, seats, grantedBy: "test", updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.ownerPlans.ownerId, set: { plan, seats } });
}

/** A workspace on Enterprise with a verified domain and a provider set up through the route. */
async function setUp(
  options: { seats?: number; env?: Partial<Cloudflare.Env>; issuer?: string } = {},
) {
  const domain = `corp${hex().slice(0, 10)}.com`;
  const idp = new FakeIdentityProvider(options.issuer ?? `https://login.${domain}`);
  const h = createHarness({ ssoFetch: idp.fetch, ...(options.env ? { env: options.env } : {}) });
  const adminCookie = await h.signIn(`admin@${domain}`);
  const admin = await userByEmail(`admin@${domain}`);
  const slug = `s${hex().slice(0, 16)}`;
  const created = await createWorkspace(global(), {
    slug,
    name: "Corp",
    adminUserId: admin?.id ?? "",
    now: Date.now(),
  });
  if (!created.ok) throw new Error(created.message);
  const workspaceId = created.value.id;
  await onPlan(workspaceId, "enterprise", options.seats ?? 10);
  await verifyDomain(workspaceId, domain);
  const saved = await h.request(
    `/api/v1/workspaces/${slug}/sso`,
    dashboard(adminCookie, "PUT", {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      domains: [domain],
    }),
  );
  expect(saved.status).toBe(200);
  const body = await saved.json<{ provider: { id: string } }>();
  return {
    h,
    idp,
    workspaceId,
    slug,
    domain,
    adminCookie,
    providerId: body.provider.id,
  } satisfies Setup;
}

async function userByEmail(email: string) {
  const [row] = await global()
    .select({ id: schema.users.id, termsVersion: schema.users.termsVersion })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  return row ?? null;
}

async function roleOf(workspaceId: string, userId: string | undefined) {
  const [row] = await global()
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId ?? ""),
      ),
    );
  return row?.role ?? null;
}

interface Started {
  url: string;
  cookies: string;
}

async function start(s: Setup, email: string, cookies = ""): Promise<Started> {
  const started = await s.h.request(
    "/api/auth/sign-in/sso",
    json({ email, callbackURL: `${ORIGIN}/` }, cookies ? { cookie: cookies } : {}),
  );
  expect(started.status).toBe(200);
  const { url } = await started.json<{ url: string }>();
  return { url, cookies: [cookies, cookieHeader(started)].filter(Boolean).join("; ") };
}

async function finish(s: Setup, callbackUrl: string, cookies: string) {
  const response = await s.h.request(callbackUrl, { headers: { cookie: cookies } });
  const location = response.headers.get("location") ?? "";
  const session =
    response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`)) ??
    "";
  return { status: response.status, location, session, error: errorOf(location) };
}

function errorOf(location: string): string | null {
  if (!location) return null;
  return new URL(location, ORIGIN).searchParams.get("error");
}

/** The whole browser flow: start, the provider's redirect back with a code, the callback. */
async function signIn(
  s: Setup,
  email: string,
  cookies = "",
  claims: Record<string, unknown> = {},
  sub = `sub-${email}`,
) {
  const started = await start(s, email, cookies);
  const back = s.idp.authorize(started.url, { sub, email }, claims);
  return finish(s, back, started.cookies);
}

describe("the provider routes", () => {
  it("shows an admin the settings and the redirect URI, never the secret", async () => {
    const s = await setUp();
    const response = await s.h.request(
      `/api/v1/workspaces/${s.slug}/sso`,
      dashboard(s.adminCookie),
    );
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      state: "on",
      available: true,
      verifiedDomains: [s.domain],
      provider: {
        id: s.providerId,
        issuer: s.idp.issuer,
        clientId: s.idp.clientId,
        domains: [s.domain],
        lapsedDomains: [],
        hasClientSecret: true,
        redirectUri: `${ORIGIN}/api/auth/sso/callback/${s.providerId}`,
      },
    });
    expect(JSON.stringify(body)).not.toContain(s.idp.clientSecret);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("tests discovery and reports what failed", async () => {
    const s = await setUp();
    const test = (issuer: string) =>
      s.h.request(
        `/api/v1/workspaces/${s.slug}/sso/test`,
        dashboard(s.adminCookie, "POST", { issuer }),
      );
    expect(await (await test(s.idp.issuer)).json()).toEqual({
      ok: true,
      hosts: {
        authorization: `login.${s.domain}`,
        token: `login.${s.domain}`,
        keys: `login.${s.domain}`,
      },
    });
    s.idp.discovery = { token_endpoint: "https://10.0.0.7/token" };
    expect(await (await test(s.idp.issuer)).json()).toEqual({
      ok: false,
      problem: "invalid_endpoint",
    });
    expect((await test("x".repeat(400))).status).toBe(400);
  });

  it("refuses editors, people outside the workspace, bearer tokens and other origins", async () => {
    const s = await setUp();
    const editorCookie = await s.h.signIn(`editor@${s.domain}`);
    const editor = await userByEmail(`editor@${s.domain}`);
    await global()
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: s.workspaceId,
        userId: editor?.id ?? "",
        role: "editor",
        updatedAt: Date.now(),
      });
    const outsiderCookie = await s.h.signIn(`out-${hex().slice(0, 6)}@example.test`);
    const path = `/api/v1/workspaces/${s.slug}/sso`;
    expect((await s.h.request(path, dashboard(editorCookie))).status).toBe(403);
    expect((await s.h.request(path, dashboard(editorCookie, "DELETE"))).status).toBe(403);
    expect((await s.h.request(path, dashboard(outsiderCookie))).status).toBe(404);
    expect(
      (await s.h.request("/api/v1/workspaces/Bad!/sso", dashboard(s.adminCookie))).status,
    ).toBe(404);
    const bearer = await s.h.request(path, {
      headers: { authorization: "Bearer anything", "sec-fetch-site": "same-origin" },
    });
    expect(bearer.status).toBe(403);
    expect((await s.h.request(path, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(
      401,
    );
    const foreign = await s.h.request(path, {
      method: "DELETE",
      headers: {
        cookie: s.adminCookie,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    });
    expect(foreign.status).toBe(403);
    const invalid = await s.h.request(path, dashboard(s.adminCookie, "PUT", { issuer: 3 }));
    expect(invalid.status).toBe(400);
  });

  it("changes and removes the provider; removing works on any plan", async () => {
    const s = await setUp();
    const path = `/api/v1/workspaces/${s.slug}/sso`;
    const changed = await s.h.request(
      path,
      dashboard(s.adminCookie, "PUT", {
        issuer: s.idp.issuer,
        clientId: "new-client",
        domains: [s.domain],
      }),
    );
    expect(changed.status).toBe(200);
    expect((await changed.json<{ provider: { clientId: string } }>()).provider.clientId).toBe(
      "new-client",
    );
    const refused = await s.h.request(
      path,
      dashboard(s.adminCookie, "PUT", {
        issuer: "https://other.example.org",
        clientId: "c",
        domains: [s.domain],
      }),
    );
    expect(refused.status).toBe(400);
    await global().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, s.workspaceId));
    const state = await (await s.h.request(path, dashboard(s.adminCookie))).json<{
      state: string;
    }>();
    expect(state.state).toBe("plan");
    const removed = await s.h.request(path, dashboard(s.adminCookie, "DELETE"));
    expect(await removed.json()).toEqual({ removed: true });
    expect((await s.h.request(path, dashboard(s.adminCookie, "DELETE"))).status).toBe(404);
    const off = await (await s.h.request(path, dashboard(s.adminCookie))).json<{ state: string }>();
    expect(off.state).toBe("off");
  });

  it("refuses saving without SSO_KEY", async () => {
    const s = await setUp();
    const keyless = createHarness({ ssoFetch: s.idp.fetch, env: { SSO_KEY: undefined } });
    const response = await keyless.request(
      `/api/v1/workspaces/${s.slug}/sso`,
      dashboard(s.adminCookie, "PUT", {
        issuer: s.idp.issuer,
        clientId: "c",
        clientSecret: "rotated",
        domains: [s.domain],
      }),
    );
    expect(response.status).toBe(503);
  });
});

describe("the login page's lookup", () => {
  it("says only whether the address's domain signs in with single sign-on", async () => {
    const s = await setUp();
    const lookup = (email: string) => s.h.request("/api/auth/sso/lookup", json({ email }));
    const yes = await lookup(`Someone@${s.domain}`);
    expect(await yes.json()).toEqual({ sso: true });
    expect(yes.headers.get("cache-control")).toBe("no-store");
    expect(await (await lookup("someone@gmail.com")).json()).toEqual({ sso: false });
    expect(await (await lookup(`someone@eng.${s.domain}`)).json()).toEqual({ sso: false });
    expect((await s.h.request("/api/auth/sso/lookup", json({ email: 3 }))).status).toBe(400);
    const crossOrigin = await s.h.request(
      "/api/auth/sso/lookup",
      json({ email: `a@${s.domain}` }, { origin: "https://evil.example" }),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("is rate limited per IP", async () => {
    const s = await setUp();
    const lookup = () =>
      s.h.request(
        "/api/auth/sso/lookup",
        json({ email: `a@${s.domain}` }, { "cf-connecting-ip": "203.0.113.9" }),
      );
    for (let i = 0; i < 60; i += 1) expect((await lookup()).status).toBe(200);
    const limited = await lookup();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

describe("signing in", () => {
  it("creates the account with the terms recorded and adds the person to the workspace", async () => {
    const s = await setUp();
    const email = `new@${s.domain}`;
    const started = await start(s, email, await s.h.beforeSignIn());
    const authorize = new URL(started.url);
    expect(authorize.origin + authorize.pathname).toBe(`${s.idp.issuer}/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toMatch(/^[\w-]{40,}$/);
    expect(authorize.searchParams.get("login_hint")).toBe(email);
    expect(authorize.searchParams.get("scope")).toBe("openid email profile");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/sso/callback/${s.providerId}`,
    );
    const result = await finish(
      s,
      s.idp.authorize(started.url, { sub: "ada", email }),
      started.cookies,
    );
    expect(result.location).toBe(`${ORIGIN}/`);
    expect(result.session).not.toBe("");
    const user = await userByEmail(email);
    expect(user?.termsVersion).toBe(TERMS_VERSION);
    expect(await roleOf(s.workspaceId, user?.id)).toBe("member");
    const [event] = await global()
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.ownerId, s.workspaceId),
          eq(schema.auditEvents.kind, "member.joined"),
          eq(schema.auditEvents.targetId, user?.id ?? ""),
        ),
      );
    expect(typeof event?.detail === "string" ? JSON.parse(event.detail) : event?.detail).toEqual({
      role: "member",
      via: "sso",
    });
    // Better Auth keeps no token of the provider.
    const [account] = await global()
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.providerId, `sso:${s.providerId}`));
    expect(account).toMatchObject({
      accountId: "ada",
      accessToken: null,
      idToken: null,
      refreshToken: null,
    });
    // A returning person signs in without any cookie and stays a member once.
    const again = await signIn(s, email, "", {}, "ada");
    expect(again.session).not.toBe("");
    expect(await roleOf(s.workspaceId, user?.id)).toBe("member");
  });

  it("refuses a new account without the terms accepted or without the human check", async () => {
    const s = await setUp();
    const noTerms = await signIn(s, `noterms@${s.domain}`, await s.h.verifyHuman());
    expect(noTerms.error).toBe("terms_not_accepted");
    expect(noTerms.session).toBe("");
    expect(await userByEmail(`noterms@${s.domain}`)).toBeNull();
    const noHuman = await signIn(s, `nohuman@${s.domain}`, await s.h.acceptTerms());
    expect(noHuman.error).toBe("human_verification_required");
    expect(await userByEmail(`nohuman@${s.domain}`)).toBeNull();
  });

  it("refuses an account on an old terms version until it accepts", async () => {
    const s = await setUp();
    const email = `stale@${s.domain}`;
    await signIn(s, email, await s.h.beforeSignIn());
    await global()
      .update(schema.users)
      .set({ termsVersion: "2020-01-01" })
      .where(eq(schema.users.email, email));
    const refused = await signIn(s, email);
    expect(refused.error).toBe("terms_not_accepted");
    expect(refused.session).toBe("");
    const accepted = await signIn(s, email, await s.h.acceptTerms());
    expect(accepted.session).not.toBe("");
  });

  it("joins an existing account with the same address in the domain, keeping its role", async () => {
    const s = await setUp();
    const email = `editor@${s.domain}`;
    await s.h.signIn(email);
    const before = await userByEmail(email);
    await global()
      .insert(schema.workspaceMembers)
      .values({
        workspaceId: s.workspaceId,
        userId: before?.id ?? "",
        role: "editor",
        updatedAt: Date.now(),
      });
    // The provider asserts the address for an identity it names however it likes: the
    // workspace's own domain, so it is linked to the account, not duplicated.
    const result = await signIn(s, email, "", {}, "any-subject");
    expect(result.session).not.toBe("");
    const users = await global().select().from(schema.users).where(eq(schema.users.email, email));
    expect(users).toHaveLength(1);
    expect(await roleOf(s.workspaceId, before?.id)).toBe("editor");
  });

  it("refuses an address outside the workspace's domains, even with email_verified", async () => {
    const s = await setUp();
    const victim = `victim-${hex().slice(0, 6)}@gmail.example`;
    await s.h.signIn(victim);
    const result = await signIn(s, `x@${s.domain}`, await s.h.beforeSignIn(), {
      email: victim,
      email_verified: true,
    });
    expect(result.error).toBe("sso_email_outside_domain");
    expect(result.session).toBe("");
    const owner = await userByEmail(victim);
    const linked = await global()
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, owner?.id ?? ""),
          eq(schema.accounts.providerId, `sso:${s.providerId}`),
        ),
      );
    expect(linked).toEqual([]);
    // A subdomain is another domain.
    const sub = await signIn(s, `x@${s.domain}`, await s.h.beforeSignIn(), {
      email: `x@eng.${s.domain}`,
    });
    expect(sub.error).toBe("sso_email_outside_domain");
  });

  it("is not offered for an unverified domain, a lapsed plan or a removed provider", async () => {
    const s = await setUp();
    const email = `p@${s.domain}`;
    const attempt = () =>
      s.h.request("/api/auth/sign-in/sso", json({ email, callbackURL: `${ORIGIN}/` }));
    await global()
      .update(schema.workspaceDomains)
      .set({ state: "pending" })
      .where(eq(schema.workspaceDomains.workspaceId, s.workspaceId));
    const pending = await attempt();
    expect(pending.status).toBe(404);
    expect(await pending.json()).toMatchObject({ code: "sso_unavailable" });
    await global()
      .update(schema.workspaceDomains)
      .set({ state: "verified" })
      .where(eq(schema.workspaceDomains.workspaceId, s.workspaceId));
    expect((await attempt()).status).toBe(200);
    await onPlan(s.workspaceId, "team");
    expect((await attempt()).status).toBe(404);
  });

  it("stops a sign-in in flight when the domain lapses, the plan lapses, the provider changes or goes", async () => {
    for (const change of ["domain", "plan", "changed", "removed"] as const) {
      const s = await setUp();
      const email = `flight@${s.domain}`;
      const started = await start(s, email, await s.h.beforeSignIn());
      const back = s.idp.authorize(started.url, { sub: "f", email });
      if (change === "domain") {
        await global()
          .delete(schema.workspaceDomains)
          .where(eq(schema.workspaceDomains.workspaceId, s.workspaceId));
      } else if (change === "plan") {
        await global()
          .delete(schema.ownerPlans)
          .where(eq(schema.ownerPlans.ownerId, s.workspaceId));
      } else if (change === "changed") {
        await s.h.request(
          `/api/v1/workspaces/${s.slug}/sso`,
          dashboard(s.adminCookie, "PUT", {
            issuer: s.idp.issuer,
            clientId: "other",
            domains: [s.domain],
          }),
        );
      } else {
        await s.h.request(`/api/v1/workspaces/${s.slug}/sso`, dashboard(s.adminCookie, "DELETE"));
      }
      const result = await finish(s, back, started.cookies);
      expect(result.error, change).toBe("sso_unavailable");
      expect(result.session, change).toBe("");
      expect(await userByEmail(email), change).toBeNull();
    }
  });

  it("refuses a wrong or missing state, a provider error, a replayed state and a replayed code", async () => {
    const s = await setUp();
    const email = `state@${s.domain}`;
    const cookies = await s.h.beforeSignIn();
    const started = await start(s, email, cookies);
    const back = new URL(s.idp.authorize(started.url, { sub: "st", email }));
    const wrong = new URL(back);
    wrong.searchParams.set("state", "forged");
    expect((await finish(s, wrong.toString(), started.cookies)).session).toBe("");
    // The state cookie belongs to this browser: another browser's callback is refused.
    const elsewhere = await finish(s, back.toString(), cookies);
    expect(elsewhere.session).toBe("");
    const denied = new URL(back);
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    const fresh = await start(s, email, cookies);
    const deniedBack = new URL(s.idp.authorize(fresh.url, { sub: "st", email }));
    deniedBack.searchParams.delete("code");
    deniedBack.searchParams.set("error", "access_denied");
    expect((await finish(s, deniedBack.toString(), fresh.cookies)).error).toBe("sso_failed");

    const ok = await finish(s, back.toString(), started.cookies);
    expect(ok.session).not.toBe("");
    const replayed = await finish(s, back.toString(), started.cookies);
    expect(replayed.session).toBe("");
    // An old code with a new state: the provider refuses it, a code is good once.
    const next = await start(s, email, "");
    const reused = new URL(s.idp.authorize(next.url, { sub: "st", email }));
    reused.searchParams.set("code", back.searchParams.get("code") ?? "");
    expect((await finish(s, reused.toString(), next.cookies)).error).toBe("sso_failed");
  });

  it("refuses a callback for another provider than the one the state names", async () => {
    const s = await setUp();
    const started = await start(s, `x@${s.domain}`, await s.h.beforeSignIn());
    const back = new URL(s.idp.authorize(started.url, { sub: "x", email: `x@${s.domain}` }));
    back.pathname = `/api/auth/sso/callback/sso_${hex()}`;
    expect((await finish(s, back.toString(), started.cookies)).error).toBe("sso_failed");
  });

  it.each([
    ["a wrong nonce", { nonce: "not-the-one" }],
    ["no nonce", { nonce: undefined }],
    ["another audience", { aud: "someone-else" }],
    ["several audiences without azp", { aud: ["portifact-client", "other"] }],
    ["an azp for another client", { azp: "other" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 600 }],
    ["a token issued long ago", { iat: Math.floor(Date.now() / 1000) - 7200 }],
    ["a token not valid yet", { nbf: Math.floor(Date.now() / 1000) + 600 }],
    ["another issuer than discovery's", { iss: "https://evil.example.org" }],
    ["no email", { email: undefined }],
  ])("refuses an ID token with %s", async (_name, claims) => {
    const s = await setUp();
    const email = `t@${s.domain}`;
    const result = await signIn(s, email, await s.h.beforeSignIn(), claims);
    expect(result.error).toBe("sso_failed");
    expect(result.session).toBe("");
    expect(await userByEmail(email)).toBeNull();
  });

  it("accepts a token within the clock skew", async () => {
    const s = await setUp();
    const result = await signIn(s, `skew@${s.domain}`, await s.h.beforeSignIn(), {
      iat: Math.floor(Date.now() / 1000) + 30,
      exp: Math.floor(Date.now() / 1000) - 30,
    });
    expect(result.session).not.toBe("");
  });

  it("refuses an unsigned token (alg none) and one signed with a key not in the provider's set", async () => {
    const s = await setUp();
    s.idp.signing = "none";
    expect((await signIn(s, `none@${s.domain}`, await s.h.beforeSignIn())).error).toBe(
      "sso_failed",
    );
    s.idp.signing = "unknown";
    expect((await signIn(s, `stray@${s.domain}`, await s.h.beforeSignIn())).error).toBe(
      "sso_failed",
    );
  });

  it("follows a key rotation at once, fetching the new key set once", async () => {
    const s = await setUp();
    expect((await signIn(s, `r1@${s.domain}`, await s.h.beforeSignIn())).session).not.toBe("");
    await s.idp.rotate();
    const before = s.idp.calls.filter((call) => call.path === "/keys").length;
    expect((await signIn(s, `r2@${s.domain}`, await s.h.beforeSignIn())).session).not.toBe("");
    expect(s.idp.calls.filter((call) => call.path === "/keys").length).toBe(before + 1);
    // The cached set serves the next sign-in without a fetch.
    expect((await signIn(s, `r3@${s.domain}`, await s.h.beforeSignIn())).session).not.toBe("");
    expect(s.idp.calls.filter((call) => call.path === "/keys").length).toBe(before + 1);
  });

  it("does not start when discovery names another issuer or a private endpoint", async () => {
    for (const discovery of [
      { issuer: "https://evil.example.org" },
      { token_endpoint: "https://192.168.1.1/token" },
      { authorization_endpoint: "https://localhost/authorize" },
    ]) {
      const s = await setUp();
      clearSsoDiscoveryCache();
      s.idp.discovery = discovery;
      const started = await s.h.request(
        "/api/auth/sign-in/sso",
        json({ email: `d@${s.domain}`, callbackURL: `${ORIGIN}/` }),
      );
      expect(started.status, JSON.stringify(discovery)).toBe(503);
      expect(await started.json()).toMatchObject({ code: "sso_failed" });
    }
  });

  it("gives up on oversized, redirected and failing token answers", async () => {
    for (const answer of [
      () => new Response("x".repeat(70 * 1024)),
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      () => Response.json({ error: "server_error" }, { status: 500 }),
      () => Response.json({ access_token: "no id token" }),
    ]) {
      const s = await setUp();
      s.idp.override = (url) => (url.endsWith("/token") ? answer() : undefined);
      const result = await signIn(s, `o@${s.domain}`, await s.h.beforeSignIn());
      expect(result.error).toBe("sso_failed");
      expect(result.session).toBe("");
    }
  });

  it("gives up on a slow key set", async () => {
    const s = await setUp();
    s.idp.override = (url, init) =>
      url.endsWith("/keys")
        ? new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
        : undefined;
    const result = await signIn(s, `slow@${s.domain}`, await s.h.beforeSignIn());
    expect(result.error).toBe("sso_failed");
  }, 20_000);

  it("refuses to join a full workspace with a clear error and hands over no session", async () => {
    const s = await setUp({ seats: 1 });
    const email = `late@${s.domain}`;
    const result = await signIn(s, email, await s.h.beforeSignIn());
    expect(result.error).toBe("sso_workspace_full");
    expect(result.session).toBe("");
    const user = await userByEmail(email);
    // The account exists (its terms are accepted) but holds no session and no membership.
    expect(user).not.toBeNull();
    expect(await roleOf(s.workspaceId, user?.id)).toBeNull();
    const sessions = await global()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user?.id ?? ""));
    expect(sessions).toEqual([]);
  });

  it("consumes a pending invitation with its role", async () => {
    const s = await setUp();
    const email = `invited@${s.domain}`;
    await global()
      .insert(schema.workspaceInvitations)
      .values({
        id: `inv_${hex()}`,
        workspaceId: s.workspaceId,
        email,
        role: "editor",
        tokenHash: hex(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      });
    const result = await signIn(s, email, await s.h.beforeSignIn());
    expect(result.session).not.toBe("");
    expect(await roleOf(s.workspaceId, (await userByEmail(email))?.id)).toBe("editor");
    const left = await global()
      .select()
      .from(schema.workspaceInvitations)
      .where(eq(schema.workspaceInvitations.workspaceId, s.workspaceId));
    expect(left).toEqual([]);
  });

  it("removes the linked identity with the account", async () => {
    const s = await setUp();
    const email = `gone@${s.domain}`;
    await signIn(s, email, await s.h.beforeSignIn());
    const user = await userByEmail(email);
    await global()
      .delete(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, user?.id ?? ""));
    await global()
      .delete(schema.users)
      .where(eq(schema.users.id, user?.id ?? ""));
    const linked = await global()
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.providerId, `sso:${s.providerId}`));
    expect(linked).toEqual([]);
  });
});

describe("switched off", () => {
  it("answers 404 for every sign-in endpoint and capacity_unavailable for the provider routes", async () => {
    const s = await setUp();
    const off = createHarness({ ssoFetch: s.idp.fetch, env: { SSO_ENABLED: undefined } });
    expect(
      (await off.request("/api/auth/sso/lookup", json({ email: `a@${s.domain}` }))).status,
    ).toBe(404);
    expect(
      (
        await off.request(
          "/api/auth/sign-in/sso",
          json({ email: `a@${s.domain}`, callbackURL: `${ORIGIN}/` }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await off.request(`/api/auth/sso/callback/${s.providerId}?code=x&state=y`)).status,
    ).toBe(404);
    for (const [method, path] of [
      ["GET", ""],
      ["PUT", ""],
      ["DELETE", ""],
      ["POST", "/test"],
    ] as const) {
      const response = await off.request(
        `/api/v1/workspaces/${s.slug}/sso${path}`,
        dashboard(s.adminCookie, method, method === "GET" || method === "DELETE" ? undefined : {}),
      );
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "capacity_unavailable" } });
    }
    expect(s.idp.calls.filter((call) => call.path !== "/.well-known/openid-configuration")).toEqual(
      [],
    );
  });
});

describe("route inventory", () => {
  it("opens exactly the OIDC endpoints, and only while switched on", () => {
    expect(authEndpoint("/sso/lookup", true)).toEqual({ method: "POST", kind: "browser" });
    expect(authEndpoint("/sign-in/sso", true)).toEqual({ method: "POST", kind: "browser" });
    expect(authEndpoint(`/sso/callback/sso_${"a".repeat(32)}`, true)).toEqual({
      method: "GET",
      kind: "browser",
    });
    for (const path of ["/sso/lookup", "/sign-in/sso", `/sso/callback/sso_${"a".repeat(32)}`]) {
      expect(authEndpoint(path, false), path).toBeUndefined();
    }
    for (const path of [
      "/sso/callback/not-an-id",
      `/sso/callback/sso_${"a".repeat(32)}/x`,
      "/sso/callback",
      "/sso/register",
      "/sso/providers",
      "/sso/saml2/sp/metadata",
      "/sso/saml2/sp/acs/x",
      "/sso/saml2/callback/x",
      "/sso/saml2/sp/slo/x",
      "/sso/request-domain-verification",
      "/sso/verify-domain",
    ]) {
      expect(authEndpoint(path, true), path).toBeUndefined();
    }
  });

  it("answers 404 for every SAML and provider administration path, switched on", async () => {
    const h = createHarness();
    for (const [method, path] of [
      ["POST", "/api/auth/sso/saml2/sp/acs/sso_x"],
      ["GET", "/api/auth/sso/saml2/sp/acs/sso_x"],
      ["GET", "/api/auth/sso/saml2/sp/metadata"],
      ["POST", "/api/auth/sso/saml2/callback/x"],
      ["POST", "/api/auth/sso/register"],
      ["GET", "/api/auth/sso/callback"],
      ["GET", "/api/auth/sso/callback/not-an-id"],
    ] as const) {
      const response = await h.request(path, method === "POST" ? json({}) : {});
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("registers the plugin's two endpoints in Better Auth and nothing else for SSO", () => {
    const h = createHarness();
    const paths = (Object.values(h.auth.api) as { path?: unknown }[])
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === "string" && /sso/.test(path))
      .sort();
    expect(paths).toEqual(["/sign-in/sso", "/sso/callback/:providerId"]);
  });
});

describe("edges of the flow", () => {
  it("refuses an off-site callback URL before anything starts", async () => {
    const s = await setUp();
    const response = await s.h.request(
      "/api/auth/sign-in/sso",
      json({ email: `a@${s.domain}`, callbackURL: "https://evil.example.org/" }),
    );
    expect(response.status).toBe(403);
    expect(s.idp.calls.filter((call) => call.path === "/authorize")).toEqual([]);
  });

  it("fails when discovery breaks between the start and the callback", async () => {
    const s = await setUp();
    const email = `between@${s.domain}`;
    const started = await start(s, email, await s.h.beforeSignIn());
    const back = s.idp.authorize(started.url, { sub: "b", email });
    clearSsoDiscoveryCache();
    s.idp.discovery = { issuer: "https://evil.example.org" };
    expect((await finish(s, back, started.cookies)).error).toBe("sso_failed");
  });

  it("refuses a key set that is not one", async () => {
    const s = await setUp();
    s.idp.override = (url) => (url.endsWith("/keys") ? Response.json({ nope: true }) : undefined);
    expect((await signIn(s, `k@${s.domain}`, await s.h.beforeSignIn())).error).toBe("sso_failed");
  });

  it("creates the account without a name when the token has none", async () => {
    const s = await setUp();
    const result = await signIn(s, `noname@${s.domain}`, await s.h.beforeSignIn(), {
      name: undefined,
    });
    expect(result.session).not.toBe("");
  });

  it("verifies nothing without an accepted algorithm", async () => {
    expect(
      await verifyIdToken(async () => Response.json({ keys: [] }), "a.b.c", {
        issuer: "https://login.example.com",
        clientId: "c",
        nonce: "n",
        jwksUrl: "https://login.example.com/keys",
        algorithms: ["HS256", "none"],
        now: Date.now(),
      }),
    ).toBeNull();
  });
});

async function accountsOf(userId: string | undefined, providerId: string) {
  return global()
    .select({ accountId: schema.accounts.accountId })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId ?? ""),
        eq(schema.accounts.providerId, `sso:${providerId}`),
      ),
    );
}

describe("an address the provider has not verified (review finding 1)", () => {
  it("is refused when the token says email_verified is false, even for a new account", async () => {
    const s = await setUp();
    const admin = await userByEmail(`admin@${s.domain}`);
    const takeover = await signIn(
      s,
      `admin@${s.domain}`,
      "",
      { email_verified: false },
      "attacker",
    );
    expect(takeover.error).toBe("sso_email_unverified");
    expect(takeover.session).toBe("");
    expect(await accountsOf(admin?.id, s.providerId)).toEqual([]);
    const fresh = await signIn(s, `new@${s.domain}`, await s.h.beforeSignIn(), {
      email_verified: false,
    });
    expect(fresh.error).toBe("sso_email_unverified");
    expect(await userByEmail(`new@${s.domain}`)).toBeNull();
  });

  it("does not link an existing account without the claim, but creates a new one", async () => {
    const s = await setUp();
    const admin = await userByEmail(`admin@${s.domain}`);
    const refused = await signIn(
      s,
      `admin@${s.domain}`,
      "",
      { email_verified: undefined },
      "new-sub",
    );
    expect(refused.error).toBe("sso_link_required");
    expect(refused.session).toBe("");
    expect(await accountsOf(admin?.id, s.providerId)).toEqual([]);
    const created = await signIn(s, `fresh@${s.domain}`, await s.h.beforeSignIn(), {
      email_verified: undefined,
    });
    expect(created.session).not.toBe("");
  });

  it("links once from the account's own session, never to another account", async () => {
    const s = await setUp();
    const admin = await userByEmail(`admin@${s.domain}`);
    const started = await start(s, `admin@${s.domain}`, s.adminCookie);
    const back = s.idp.authorize(
      started.url,
      { sub: "admin-sub", email: `admin@${s.domain}` },
      { email_verified: undefined },
    );
    const linked = await finish(s, back, started.cookies);
    expect(linked.session).not.toBe("");
    expect(await accountsOf(admin?.id, s.providerId)).toEqual([{ accountId: "admin-sub" }]);
    // The next sign-in uses the linked identity, without any session.
    const again = await signIn(
      s,
      `admin@${s.domain}`,
      "",
      { email_verified: undefined },
      "admin-sub",
    );
    expect(again.session).not.toBe("");

    // Another account's session cannot link this address, nor can a session the flow lost.
    const editorCookie = await s.h.signIn(`editor@${s.domain}`);
    const other = await start(s, `admin@${s.domain}`, editorCookie);
    const otherBack = s.idp.authorize(
      other.url,
      { sub: "second-sub", email: `admin@${s.domain}` },
      { email_verified: undefined },
    );
    expect((await finish(s, otherBack, other.cookies)).error).toBe("sso_link_required");
    const lost = await start(s, `admin@${s.domain}`, s.adminCookie);
    const lostBack = s.idp.authorize(
      lost.url,
      { sub: "third-sub", email: `admin@${s.domain}` },
      { email_verified: undefined },
    );
    const withoutSession = lost.cookies
      .split("; ")
      .filter((cookie) => !cookie.startsWith(`${SESSION_COOKIE}=`))
      .join("; ");
    expect((await finish(s, lostBack, withoutSession)).error).toBe("sso_link_required");
    expect(await accountsOf(admin?.id, s.providerId)).toEqual([{ accountId: "admin-sub" }]);
  });

  it("refuses an issuer that signs in the public", async () => {
    const s = await setUp();
    for (const issuer of [
      "https://login.microsoftonline.com/common/v2.0",
      "https://login.microsoftonline.com/organizations/v2.0",
      "https://appleid.apple.com",
    ]) {
      const response = await s.h.request(
        `/api/v1/workspaces/${s.slug}/sso`,
        dashboard(s.adminCookie, "PUT", {
          issuer,
          clientId: "c",
          clientSecret: "s",
          domains: [s.domain],
        }),
      );
      expect(response.status, issuer).toBe(400);
    }
  });

  it("checks Google's hd against the verified domain on every sign-in", async () => {
    const s = await setUp({ issuer: "https://accounts.google.com" });
    const ok = await signIn(s, `g@${s.domain}`, await s.h.beforeSignIn(), { hd: s.domain });
    expect(ok.session).not.toBe("");
    for (const claims of [{}, { hd: "gmail.com" }]) {
      const refused = await signIn(s, `h@${s.domain}`, await s.h.beforeSignIn(), claims);
      expect(refused.error).toBe("sso_email_outside_domain");
    }
  });

  it("takes Entra's address only with xms_edov", async () => {
    const s = await setUp({
      issuer: "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0",
    });
    expect(
      (await signIn(s, `e@${s.domain}`, await s.h.beforeSignIn(), { xms_edov: true })).session,
    ).not.toBe("");
    expect((await signIn(s, `f@${s.domain}`, await s.h.beforeSignIn())).error).toBe(
      "sso_email_unverified",
    );
  });
});

describe("a removal holds (review finding 2)", () => {
  it("refuses to bring back someone an admin removed, with no session", async () => {
    const s = await setUp();
    const email = `back@${s.domain}`;
    await signIn(s, email, await s.h.beforeSignIn());
    const user = await userByEmail(email);
    const removed = await s.h.request(
      `/api/v1/workspaces/${s.slug}/members/${user?.id}`,
      dashboard(s.adminCookie, "DELETE"),
    );
    expect(removed.status).toBeLessThan(300);
    const again = await signIn(s, email);
    expect(again.error).toBe("sso_removed");
    expect(again.session).toBe("");
    expect(await roleOf(s.workspaceId, user?.id)).toBeNull();
  });
});

describe("the key set refetch (review finding 4)", () => {
  afterEach(() => vi.useRealTimers());

  it("fetches a key set again for an unknown key at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const s = await setUp();
    s.idp.signing = "unknown";
    const keys = () => s.idp.calls.filter((call) => call.path === "/keys").length;
    await signIn(s, `k1@${s.domain}`, await s.h.beforeSignIn());
    expect(keys()).toBe(2);
    await signIn(s, `k2@${s.domain}`, await s.h.beforeSignIn());
    await signIn(s, `k3@${s.domain}`, await s.h.beforeSignIn());
    expect(keys()).toBe(2);
    vi.setSystemTime(Date.now() + 61_000);
    await signIn(s, `k4@${s.domain}`, await s.h.beforeSignIn());
    expect(keys()).toBe(3);
  });

  it("keeps at most SSO_CACHE_ENTRIES key sets", async () => {
    for (let i = 0; i < SSO_CACHE_ENTRIES + 10; i += 1) {
      await verifyIdToken(async () => Response.json({ keys: [] }), "a.b.c", {
        issuer: "https://login.example.com",
        clientId: "c",
        nonce: "n",
        jwksUrl: `https://login${i}.example.com/keys`,
        algorithms: ["RS256"],
        now: Date.now(),
      });
    }
    expect(ssoKeyCacheSize()).toBe(SSO_CACHE_ENTRIES);
  });
});

describe("the lookup budget (review finding 6)", () => {
  it("is one bucket per IP for the lookup and the start", async () => {
    const s = await setUp();
    const ip = { "cf-connecting-ip": "203.0.113.77" };
    for (let i = 0; i < 60; i += 1) {
      const answer = await s.h.request(
        "/api/auth/sso/lookup",
        json({ email: `a@${s.domain}` }, ip),
      );
      expect(answer.status).toBe(200);
    }
    const started = await s.h.request(
      "/api/auth/sign-in/sso",
      json({ email: `a@${s.domain}`, callbackURL: `${ORIGIN}/` }, ip),
    );
    expect(started.status).toBe(429);
  });
});
