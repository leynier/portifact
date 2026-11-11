// "SSO required" (decision 0021) through the app Worker: the method recorded on each session as
// it is created (an email code, the workspace's provider), carried onto OAuth tokens (an MCP
// client's authorization code grant, the CLI's device login, refreshed), the setting saved only
// by an admin whose own session went through the provider, and refusals with the same message on
// the API and MCP, naming each client's fix. Every sign-in goes through `FakeIdentityProvider`.
import { env } from "cloudflare:workers";
import { DEFAULT_POLICY } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { POLICY_MESSAGES } from "@portifact/domain";
import { clearSsoDiscoveryCache, createWorkspace } from "@portifact/services";
import { FakeIdentityProvider } from "@portifact/services/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { sessionSignInMethod, signInMethodForPath } from "../src/auth/sign-in-method.ts";
import { clearSsoKeyCache } from "../src/auth/sso.ts";
import {
  approveDevice,
  authorizeWithPkce,
  exchangeCode,
  pollDeviceToken,
  requestDeviceCode,
  type TokenResponse,
} from "./flows.ts";
import { cookieHeader, createHarness, form, json, ORIGIN, SESSION_COOKIE } from "./harness.ts";
import { api, callTool, connect, registerClient } from "./mcp-helpers.ts";

const global = () => regionsFromEnv(env).global;
const hex = () => crypto.randomUUID().replaceAll("-", "");
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read offline_access";

beforeEach(async () => {
  clearSsoDiscoveryCache();
  clearSsoKeyCache();
  await env.DB.exec("DELETE FROM rate_limits");
});

const dashboard = (cookie: string, method = "GET", body?: unknown): RequestInit => ({
  method,
  headers: {
    cookie,
    "sec-fetch-site": "same-origin",
    origin: ORIGIN,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A workspace on Enterprise with a verified domain and a provider, and its admin's code session. */
async function setUp() {
  const domain = `corp${hex().slice(0, 10)}.com`;
  const idp = new FakeIdentityProvider(`https://login.${domain}`);
  const h = createHarness({ ssoFetch: idp.fetch });
  const adminEmail = `admin@${domain}`;
  const adminCode = await h.signIn(adminEmail);
  const admin = await userId(adminEmail);
  const slug = `r${hex().slice(0, 16)}`;
  const created = await createWorkspace(global(), {
    slug,
    name: "Corp",
    adminUserId: admin,
    now: Date.now(),
  });
  if (!created.ok) throw new Error(created.message);
  const workspaceId = created.value.id;
  await global().insert(schema.ownerPlans).values({
    ownerId: workspaceId,
    plan: "enterprise",
    seats: 10,
    grantedBy: "test",
    updatedAt: Date.now(),
  });
  await global()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${hex()}`,
      workspaceId,
      domain,
      token: hex(),
      state: "verified",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      verifiedAt: Date.now(),
    });
  const saved = await h.request(
    `/api/v1/workspaces/${slug}/sso`,
    dashboard(adminCode, "PUT", {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      domains: [domain],
    }),
  );
  expect(saved.status).toBe(200);
  const providerId = (await saved.json<{ provider: { id: string } }>()).provider.id;
  return { h, idp, slug, domain, workspaceId, providerId, adminEmail, adminCode };
}
type Setup = Awaited<ReturnType<typeof setUp>>;

async function userId(email: string): Promise<string> {
  const [row] = await global()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

/**
 * Signs in through the provider from a browser that already holds `cookies` (the account's own
 * code session, so the identity links to it), as the blocked page's action does. Returns the new
 * session's cookie.
 */
async function ssoSignIn(s: Setup, email: string, cookies: string): Promise<string> {
  const started = await s.h.request(
    "/api/auth/sign-in/sso",
    json({ email, callbackURL: `${ORIGIN}/` }, { cookie: cookies }),
  );
  expect(started.status).toBe(200);
  const { url } = await started.json<{ url: string }>();
  const back = s.idp.authorize(url, { sub: `sub-${email}`, email });
  const response = await s.h.request(back, {
    headers: { cookie: [cookies, cookieHeader(started)].join("; ") },
  });
  const session = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
  expect(
    new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("error"),
  ).toBeNull();
  return (session ?? "").split(";")[0] as string;
}

async function methodsOf(userIdValue: string) {
  const rows = await global()
    .select({ method: schema.sessions.signInMethod })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, userIdValue));
  return rows.map((row) => row.method).sort();
}

async function deviceLogin(s: Setup, cookie: string) {
  const device = await requestDeviceCode(s.h, CLI_CLIENT_ID, SCOPES);
  await approveDevice(s.h, cookie, device.user_code);
  const response = await pollDeviceToken(s.h, CLI_CLIENT_ID, device.device_code);
  expect(response.status).toBe(200);
  return response.json<TokenResponse>();
}

async function mcpLogin(s: Setup, cookie: string) {
  const clientId = await registerClient(s.h);
  const callback = await authorizeWithPkce(s.h, { clientId, cookie, scope: SCOPES });
  const response = await exchangeCode(s.h, { clientId, ...callback });
  expect(response.status).toBe(200);
  const tokens = await response.json<TokenResponse>();
  return { clientId, tokens, mcp: await connect(s.h, tokens.access_token) };
}

async function requireSso(s: Setup, cookie: string, confirmedOutsideProvider?: number) {
  const base = `/api/v1/workspaces/${s.slug}/policies`;
  const current = await (await s.h.request(base, dashboard(cookie))).json<{ revision: number }>();
  return s.h.request(
    base,
    dashboard(cookie, "PUT", {
      policy: { ...DEFAULT_POLICY, ssoRequired: true },
      revision: current.revision,
      ...(confirmedOutsideProvider === undefined ? {} : { confirmedOutsideProvider }),
    }),
  );
}

const refused = (message: string) => ({ error: { code: "policy_refused", message } });

describe("the method a session signed in with", () => {
  it("is decided by the endpoint creating the session, and nothing else", () => {
    const id = `sso_${"a".repeat(32)}`;
    expect(signInMethodForPath("/sign-in/email-otp")).toEqual({ kind: "code" });
    expect(signInMethodForPath("/callback/google")).toEqual({ kind: "social", provider: "google" });
    expect(signInMethodForPath("/callback/github")).toEqual({ kind: "social", provider: "github" });
    expect(signInMethodForPath(`/sso/callback/${id}`)).toEqual({ kind: "sso", providerId: id });
    for (const path of [
      "/sso/callback/sso_1",
      "/callback/apple",
      "/sign-in/social",
      "/device/approve",
      "/oauth2/token",
    ]) {
      expect(signInMethodForPath(path)).toBeNull();
    }
  });

  it("is stored only for a request Better Auth answers under its base path", () => {
    const at = (path: string) => ({ request: new Request(`${ORIGIN}${path}`) });
    expect(sessionSignInMethod(at("/api/auth/sign-in/email-otp"))).toBe("code");
    expect(sessionSignInMethod(at("/api/auth/callback/github"))).toBe("github");
    expect(sessionSignInMethod(at(`/api/auth/sso/callback/sso_${"b".repeat(32)}`))).toBe(
      `sso:sso_${"b".repeat(32)}`,
    );
    // A server-side call has no request; another path or an unknown endpoint records nothing.
    expect(sessionSignInMethod(null)).toBeNull();
    expect(sessionSignInMethod({})).toBeNull();
    expect(sessionSignInMethod(at("/sign-in/email-otp"))).toBeNull();
    expect(sessionSignInMethod(at("/api/auth/sign-in/social"))).toBeNull();
  });

  it("is recorded on the row for an email code and for the workspace's provider, and signing in through it ends nothing", async () => {
    const s = await setUp();
    const admin = await userId(s.adminEmail);
    expect(await methodsOf(admin)).toEqual(["code"]);
    const ssoCookie = await ssoSignIn(s, s.adminEmail, s.adminCode);
    // A second session: the code session stays (not ended), and the browser now holds the new one.
    expect(await methodsOf(admin)).toEqual(["code", `sso:${s.providerId}`]);
    const sessions = await (
      await s.h.request("/api/v1/account/sessions", dashboard(ssoCookie))
    ).json<{ items: { current: boolean; signInMethod: string }[] }>();
    expect(sessions.items.map((i) => [i.current, i.signInMethod])).toEqual([
      [true, "sso"],
      [false, "code"],
    ]);
    // The personal space keeps working with the new session.
    expect((await s.h.request("/api/v1/artifacts", dashboard(ssoCookie))).status).toBe(200);
  });
});

describe("requiring single sign-on through the app Worker", () => {
  it("is saved only from the admin's own SSO session, and binds the API, MCP and the dashboard alike", async () => {
    const s = await setUp();
    // From the admin's code session it would lock them out: refused.
    expect(await (await requireSso(s, s.adminCode, 0)).json()).toEqual({
      error: { code: "invalid_input", message: POLICY_MESSAGES.ssoLocksOut },
    });
    const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
    // A member with a code session, their CLI and an MCP client from it.
    const memberEmail = `member@${s.domain}`;
    const memberCode = await s.h.signIn(memberEmail);
    const member = await userId(memberEmail);
    await global().insert(schema.workspaceMembers).values({
      workspaceId: s.workspaceId,
      userId: member,
      role: "editor",
      updatedAt: Date.now(),
    });
    const cliFromCode = await deviceLogin(s, memberCode);
    const mcpFromCode = await mcpLogin(s, memberCode);
    const saved = await requireSso(s, adminSso);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      policy: { ssoRequired: true },
      sso: { usable: true, yourSession: true },
    });

    const path = `/api/v1/artifacts?workspace=${s.slug}`;
    const viaCli = await api(s.h, cliFromCode.access_token, path);
    expect(viaCli.status).toBe(403);
    const cliMessage = (await viaCli.json<{ error: { message: string } }>()).error.message;
    expect(cliMessage).toContain("then run `portifact login` and approve it from that browser");
    const viaMcp = await callTool(mcpFromCode.mcp, "list_artifacts", { workspace: s.slug });
    expect(viaMcp.isError).toBe(true);
    const mcpBody = viaMcp.structuredContent as { error: { code: string; message: string } };
    expect(mcpBody.error.code).toBe("policy_refused");
    expect(mcpBody.error.message).toContain("Ask the user to sign in to Portifact");
    const viaDashboard = await s.h.request(path, dashboard(memberCode));
    expect(await viaDashboard.json()).toEqual(
      refused(
        POLICY_MESSAGES.ssoRequired({
          kind: "session",
          userId: member,
          signedInAt: 0,
          method: { kind: "code" },
        }),
      ),
    );
    // The workspace list keeps it, blocked, with the reason.
    const list = await (await s.h.request("/api/v1/workspaces", dashboard(memberCode))).json<{
      items: { slug: string; blocked: boolean; blockedBy: string | null }[];
    }>();
    expect(list.items.find((w) => w.slug === s.slug)).toMatchObject({
      blocked: true,
      blockedBy: "sso",
    });

    // Signing in through the provider fixes the dashboard; a CLI approved from that session and
    // an MCP client authorized from it work, and keep working after a refresh.
    const memberSso = await ssoSignIn(s, memberEmail, memberCode);
    expect((await s.h.request(path, dashboard(memberSso))).status).toBe(200);
    const cliFromSso = await deviceLogin(s, memberSso);
    expect((await api(s.h, cliFromSso.access_token, path)).status).toBe(200);
    const refreshed = await s.h.request(
      "/api/auth/oauth2/token",
      form({
        grant_type: "refresh_token",
        refresh_token: cliFromSso.refresh_token ?? "",
        client_id: CLI_CLIENT_ID,
      }),
    );
    expect(refreshed.status).toBe(200);
    const again = (await refreshed.json<TokenResponse>()).access_token;
    expect((await api(s.h, again, path)).status).toBe(200);
    const mcpFromSso = await mcpLogin(s, memberSso);
    expect(
      (await callTool(mcpFromSso.mcp, "list_artifacts", { workspace: s.slug })).isError,
    ).toBeFalsy();
    const mcpRefreshed = await s.h.request(
      "/api/auth/oauth2/token",
      form({
        grant_type: "refresh_token",
        refresh_token: mcpFromSso.tokens.refresh_token ?? "",
        client_id: mcpFromSso.clientId,
      }),
    );
    expect(mcpRefreshed.status).toBe(200);
    // The refreshed token itself acts on the workspace, and every token row of the grant, the
    // refreshed one included, carries the provider's method.
    const refreshedToken = (await mcpRefreshed.json<TokenResponse>()).access_token;
    const afterRefresh = await connect(s.h, refreshedToken);
    expect(
      (await callTool(afterRefresh, "list_artifacts", { workspace: s.slug })).isError,
    ).toBeFalsy();
    const rows = await global()
      .select({ method: schema.oauthAccessTokens.signInMethod })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.clientId, mcpFromSso.clientId));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((row) => row.method))).toEqual(new Set([`sso:${s.providerId}`]));
    // The old code CLI stays refused: approving it from a code session never counted.
    expect((await api(s.h, cliFromCode.access_token, path)).status).toBe(403);
    // The personal space works for everyone, whatever their sign-in.
    expect((await api(s.h, cliFromCode.access_token, "/api/v1/artifacts")).status).toBe(200);
  });

  it("a device code keeps the method of the session that approved it: a later SSO approval cannot upgrade it", async () => {
    const s = await setUp();
    const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
    const device = await requestDeviceCode(s.h, CLI_CLIENT_ID, SCOPES);
    // Approved from the code session; the SSO session cannot approve it again.
    await approveDevice(s.h, s.adminCode, device.user_code);
    await approveDevice(s.h, adminSso, device.user_code);
    const [code] = await global()
      .select({ method: schema.deviceCodes.approverSignInMethod })
      .from(schema.deviceCodes)
      .where(eq(schema.deviceCodes.deviceCode, device.device_code));
    expect(code?.method).toBe("code");
    expect((await requireSso(s, adminSso)).status).toBe(200);
    const response = await pollDeviceToken(s.h, CLI_CLIENT_ID, device.device_code);
    const tokens = await response.json<TokenResponse>();
    expect(
      (await api(s.h, tokens.access_token, `/api/v1/artifacts?workspace=${s.slug}`)).status,
    ).toBe(403);
  });
});

describe("sessions from before the method was recorded", () => {
  it("give their CLI login and its token no method, which the requirement refuses", async () => {
    const s = await setUp();
    const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
    const memberEmail = `old@${s.domain}`;
    const memberCode = await s.h.signIn(memberEmail);
    const member = await userId(memberEmail);
    await global().insert(schema.workspaceMembers).values({
      workspaceId: s.workspaceId,
      userId: member,
      role: "member",
      updatedAt: Date.now(),
    });
    // As a session created before migration 0060.
    await global()
      .update(schema.sessions)
      .set({ signInMethod: null })
      .where(eq(schema.sessions.userId, member));
    const cli = await deviceLogin(s, memberCode);
    const rows = await global()
      .select({ method: schema.oauthAccessTokens.signInMethod })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.userId, member));
    expect(rows.map((row) => row.method)).toEqual([null]);
    expect((await requireSso(s, adminSso)).status).toBe(200);
    const path = `/api/v1/artifacts?workspace=${s.slug}`;
    expect((await api(s.h, cli.access_token, path)).status).toBe(403);
    expect((await s.h.request(path, dashboard(memberCode))).status).toBe(403);
    // The personal space works for them all the same.
    expect((await api(s.h, cli.access_token, "/api/v1/artifacts")).status).toBe(200);
  });
});

async function refresh(s: Setup, token: string, clientId: string) {
  const response = await s.h.request(
    "/api/auth/oauth2/token",
    form({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }),
  );
  expect(response.status).toBe(200);
  return response.json<TokenResponse>();
}

describe("repeated refreshes (review of PR 210)", () => {
  it("a CLI grant from an SSO session keeps its method through six refreshes, some within one second", async () => {
    const s = await setUp();
    const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
    expect((await requireSso(s, adminSso)).status).toBe(200);
    const path = `/api/v1/artifacts?workspace=${s.slug}`;
    let tokens = await deviceLogin(s, adminSso);
    for (let i = 0; i < 6; i++) {
      tokens = await refresh(s, tokens.refresh_token ?? "", CLI_CLIENT_ID);
      expect((await api(s.h, tokens.access_token, path)).status, `refresh ${i}`).toBe(200);
      if (i === 2) await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const admin = await userId(s.adminEmail);
    const rows = await global()
      .select({ method: schema.oauthRefreshTokens.signInMethod })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.userId, admin));
    expect(rows.length).toBe(7);
    expect(new Set(rows.map((row) => row.method))).toEqual(new Set([`sso:${s.providerId}`]));
  });

  it("an MCP grant from an SSO session keeps its method through six refreshes", async () => {
    const s = await setUp();
    const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
    expect((await requireSso(s, adminSso)).status).toBe(200);
    const m = await mcpLogin(s, adminSso);
    let tokens = m.tokens;
    for (let i = 0; i < 6; i++) {
      tokens = await refresh(s, tokens.refresh_token ?? "", m.clientId);
      const rows = await global()
        .select({ method: schema.oauthAccessTokens.signInMethod })
        .from(schema.oauthAccessTokens)
        .where(eq(schema.oauthAccessTokens.clientId, m.clientId));
      expect(new Set(rows.map((row) => row.method)), `refresh ${i}`).toEqual(
        new Set([`sso:${s.providerId}`]),
      );
      const mcp = await connect(s.h, tokens.access_token);
      expect(
        (await callTool(mcp, "list_artifacts", { workspace: s.slug })).isError,
        `tool ${i}`,
      ).toBeFalsy();
      if (i === 3) await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  });

  it.each([
    ["the SSO grant first", true],
    ["the code grant first", false],
  ])(
    "two grants of one user and client rotated in the same second never upgrade the code grant (%s)",
    async (_name, ssoFirst) => {
      const s = await setUp();
      const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
      expect((await requireSso(s, adminSso)).status).toBe(200);
      const fromSso = await deviceLogin(s, adminSso);
      const fromCode = await deviceLogin(s, s.adminCode);
      // An equal sign-in time (both 0, or two sessions created in the same millisecond).
      await env.DB.prepare("UPDATE oauth_refresh_tokens SET auth_time = 0 WHERE client_id = ?")
        .bind(CLI_CLIENT_ID)
        .run();
      const path = `/api/v1/artifacts?workspace=${s.slug}`;
      const [first, second] = ssoFirst ? [fromSso, fromCode] : [fromCode, fromSso];
      const a = await refresh(s, first.refresh_token ?? "", CLI_CLIENT_ID);
      const b = await refresh(s, second.refresh_token ?? "", CLI_CLIENT_ID);
      const code = ssoFirst ? b : a;
      const viaSso = ssoFirst ? a : b;
      // The code grant is never upgraded. The SSO grant may drop to "not known" if both rotated
      // in the same second (decision 0021, "The one-second match"): refused with the fix.
      const refused = await api(s.h, code.access_token, path);
      expect(refused.status).toBe(403);
      const status = (await api(s.h, viaSso.access_token, path)).status;
      expect([200, 403]).toContain(status);
      if (status === 403) {
        const body = await (await api(s.h, viaSso.access_token, path)).json<{
          error: { message: string };
        }>();
        expect(body.error.message).toContain("then run `portifact login` and approve it");
      }
    },
  );
});

describe("the session payload the browser reads", () => {
  it("does not carry how the session signed in; the account's sessions endpoint does", async () => {
    const s = await setUp();
    const response = await s.h.request("/api/auth/get-session", dashboard(s.adminCode));
    expect(response.status).toBe(200);
    const body = await response.json<{ session: Record<string, unknown> }>();
    expect(body.session).toBeTruthy();
    expect(body.session).not.toHaveProperty("signInMethod");
    expect(JSON.stringify(body)).not.toContain('"code"');
    const sessions = await (
      await s.h.request("/api/v1/account/sessions", dashboard(s.adminCode))
    ).json<{ items: { signInMethod: string }[] }>();
    expect(sessions.items[0]?.signInMethod).toBe("code");
  });
});

describe("a provider change resuming the requirement", () => {
  it("records the transition in the save's batch", async () => {
    const s = await setUp();
    const adminSso = await ssoSignIn(s, s.adminEmail, s.adminCode);
    expect((await requireSso(s, adminSso)).status).toBe(200);
    const workspaceId = s.workspaceId;
    // As if suspended earlier; a save that serves a verified domain resumes it.
    await env.DB.prepare("UPDATE workspaces SET sso_suspended = 1 WHERE id = ?")
      .bind(workspaceId)
      .run();
    const saved = await s.h.request(
      `/api/v1/workspaces/${s.slug}/sso`,
      dashboard(adminSso, "PUT", {
        issuer: s.idp.issuer,
        clientId: "another-client",
        domains: [s.domain],
      }),
    );
    expect(saved.status).toBe(200);
    const events = await env.DB.prepare(
      "SELECT kind, detail FROM audit_events WHERE owner_id = ? AND kind IN ('policy.sso_suspended', 'policy.sso_resumed')",
    )
      .bind(workspaceId)
      .all<{ kind: string; detail: string }>();
    expect(events.results.map((e) => [e.kind, JSON.parse(e.detail).cause])).toEqual([
      ["policy.sso_resumed", "provider"],
    ]);
  });
});
