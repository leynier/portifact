// A workspace's sign-in policies (decision 0021) through every interface of the app Worker: the
// API with the CLI's token, MCP with a registered client's token, the dashboard's session and the
// entry to protected artifacts. The facts come only from the server's own rows: the session's
// `created_at`, the token's client and `auth_time`, never from a header.
import { env } from "cloudflare:workers";
import { DEFAULT_POLICY, type WorkspacePolicy } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { POLICY_MESSAGES } from "@portifact/domain";
import { createWorkspace } from "@portifact/services";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { approveDevice, pollDeviceToken, requestDeviceCode, type TokenResponse } from "./flows.ts";
import { createHarness, form, ORIGIN } from "./harness.ts";
import { api, callTool, connect, mcpGrant } from "./mcp-helpers.ts";

const HOUR = 3_600_000;
const SCOPES =
  "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read offline_access";

const regions = () => regionsFromEnv(env);

/** What the dashboard's fetch sends. */
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

/** The CLI's `portifact login` (the device flow), with its refresh token. */
async function cliLogin(h: ReturnType<typeof createHarness>, cookie: string) {
  const device = await requestDeviceCode(h, CLI_CLIENT_ID, SCOPES);
  await approveDevice(h, cookie, device.user_code);
  const response = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
  if (response.status !== 200) throw new Error(`device token failed with ${response.status}`);
  return response.json<TokenResponse>();
}

async function person(prefix: string, role: string) {
  const h = createHarness();
  const email = `${prefix}-${role}@example.test`;
  const cookie = await h.signIn(email);
  const cli = await cliLogin(h, cookie);
  const mcpGranted = await mcpGrant(h, email, SCOPES);
  const mcp = await connect(h, mcpGranted.token);
  const { userId } = await (await api(h, cli.access_token, "/api/v1/me")).json<{
    userId: string;
  }>();
  return {
    userId,
    email,
    h,
    cookie,
    cli,
    mcpToken: mcpGranted.token,
    call: (path: string, token = cli.access_token) => api(h, token, path),
    tool: (name: string, args: Record<string, unknown>) => callTool(mcp, name, args),
  };
}
type Person = Awaited<ReturnType<typeof person>>;

async function team(prefix: string) {
  const [admin, member] = [await person(prefix, "admin"), await person(prefix, "editor")];
  const slug = `${prefix}-team`;
  const now = Date.now();
  const created = await createWorkspace(regions().global, {
    slug,
    name: "Team",
    adminUserId: admin.userId,
    now,
  });
  if (!created.ok) throw new Error(created.message);
  await regions().global.insert(schema.workspaceMembers).values({
    workspaceId: created.value.id,
    userId: member.userId,
    role: "editor",
    updatedAt: now,
  });
  await regions().global.insert(schema.ownerPlans).values({
    ownerId: created.value.id,
    plan: "enterprise",
    seats: 10,
    grantedBy: "test",
    updatedAt: now,
  });
  return { id: created.value.id, slug, admin, member };
}

async function setPolicy(admin: Person, slug: string, next: WorkspacePolicy) {
  const base = `/api/v1/workspaces/${slug}/policies`;
  const current = await (await admin.h.request(base, dashboard(admin.cookie))).json<{
    revision: number;
  }>();
  return admin.h.request(
    base,
    dashboard(admin.cookie, "PUT", { policy: next, revision: current.revision }),
  );
}

/** Makes every sign-in of `who` look `hours` old: their sessions and the tokens from them. */
async function ageSignIns(who: Person, hours: number) {
  const at = new Date(Date.now() - hours * HOUR);
  const global = regions().global;
  await global
    .update(schema.sessions)
    .set({ createdAt: at })
    .where(eq(schema.sessions.userId, who.userId));
  await global
    .update(schema.oauthAccessTokens)
    .set({ authTime: at })
    .where(eq(schema.oauthAccessTokens.userId, who.userId));
  await global
    .update(schema.oauthRefreshTokens)
    .set({ authTime: at })
    .where(eq(schema.oauthRefreshTokens.userId, who.userId));
}

const refused = (message: string) => ({ error: { code: "policy_refused", message } });

describe("the maximum session age through the app Worker", () => {
  it("refuses an old sign-in on the API, MCP and the dashboard alike, naming each fix", async () => {
    const t = await team("spa");
    expect(
      (await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, sessionMaxHours: 8 })).status,
    ).toBe(200);
    const path = `/api/v1/artifacts?workspace=${t.slug}`;
    expect((await t.member.call(path)).status).toBe(200);
    expect((await t.member.tool("list_artifacts", { workspace: t.slug })).isError).toBeFalsy();

    await ageSignIns(t.member, 9);
    const viaCli = await t.member.call(path);
    expect(viaCli.status).toBe(403);
    const cliBody = await viaCli.json<{ error: { message: string } }>();
    expect(cliBody.error.message).toContain("portifact login");
    const viaMcp = await t.member.tool("list_artifacts", { workspace: t.slug });
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.structuredContent)).toContain("reconnect this app");
    const viaDashboard = await t.member.h.request(
      `/api/v1/workspaces/${t.slug}/members`,
      dashboard(t.member.cookie),
    );
    expect(viaDashboard.status).toBe(403);
    expect(await viaDashboard.json()).toMatchObject({
      error: { code: "policy_refused", message: expect.stringContaining("Sign in again") },
    });
    // The admin, whose sign-in is recent, is not touched; the policy never ends a session.
    expect((await t.admin.call(path)).status).toBe(200);
    const sessions = await regions()
      .global.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, t.member.userId));
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("keeps the clock through a refresh, and a new `portifact login` resets it", async () => {
    const t = await team("spr");
    await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, sessionMaxHours: 8 });
    await ageSignIns(t.member, 9);
    const refreshed = await t.member.h.request(
      "/api/auth/oauth2/token",
      form({
        grant_type: "refresh_token",
        refresh_token: t.member.cli.refresh_token ?? "",
        client_id: CLI_CLIENT_ID,
      }),
    );
    expect(refreshed.status).toBe(200);
    const token = (await refreshed.json<TokenResponse>()).access_token;
    const path = `/api/v1/artifacts?workspace=${t.slug}`;
    expect(await (await t.member.call(path, token)).json()).toEqual(
      refused(
        POLICY_MESSAGES.sessionAge(8, {
          kind: "oauth",
          userId: t.member.userId,
          clientId: CLI_CLIENT_ID,
          client: "cli",
          signedInAt: 0,
        }),
      ),
    );
    // A fresh sign-in in the browser and a new device approval admit the CLI again.
    const cookie = await t.member.h.signIn(t.member.email);
    const again = await cliLogin(t.member.h, cookie);
    expect((await t.member.call(path, again.access_token)).status).toBe(200);
  });

  it("records the device flow's grant as the sign-in, and carries it to every refreshed token", async () => {
    const t = await team("spd");
    const rows = await regions()
      .global.select({ authTime: schema.oauthAccessTokens.authTime })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.userId, t.member.userId));
    expect(rows.every((row) => row.authTime instanceof Date)).toBe(true);
    const [first] = await regions()
      .global.select({ authTime: schema.oauthRefreshTokens.authTime })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.clientId, CLI_CLIENT_ID));
    expect(first?.authTime).toBeInstanceOf(Date);
    await ageSignIns(t.member, 30);
    const refreshed = await t.member.h.request(
      "/api/auth/oauth2/token",
      form({
        grant_type: "refresh_token",
        refresh_token: t.member.cli.refresh_token ?? "",
        client_id: CLI_CLIENT_ID,
      }),
    );
    const newest = await regions()
      .global.select({ authTime: schema.oauthRefreshTokens.authTime })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.userId, t.member.userId));
    expect(refreshed.status).toBe(200);
    const times = newest.map((row) => row.authTime?.getTime());
    expect(new Set(times).size).toBe(1);
    expect(times[0]).toBeLessThan(Date.now() - 29 * HOUR);
  });

  it("marks the workspace in the list with the reason, and leaves the personal space alone", async () => {
    const t = await team("spl");
    await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, sessionMaxHours: 8 });
    await ageSignIns(t.member, 9);
    const listed = await (
      await t.member.h.request("/api/v1/workspaces", dashboard(t.member.cookie))
    ).json<{ items: { slug: string; blocked: boolean; blockedBy: string | null }[] }>();
    expect(listed.items).toEqual([
      expect.objectContaining({ slug: t.slug, blocked: true, blockedBy: "session_age" }),
    ]);
    expect((await t.member.call("/api/v1/artifacts")).status).toBe(200);
  });

  it("refuses a save the admin's own sign-in already exceeds", async () => {
    const t = await team("spk");
    await ageSignIns(t.admin, 9);
    const lockOut = await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, sessionMaxHours: 8 });
    expect(lockOut.status).toBe(400);
    expect(await lockOut.json()).toEqual({
      error: { code: "invalid_input", message: POLICY_MESSAGES.sessionLocksOut(8) },
    });
    expect(
      (await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, sessionMaxHours: 12 })).status,
    ).toBe(200);
  });

  it("sends a refused reader to sign in again and back to the artifact", async () => {
    const t = await team("spe");
    const id = "sp7d2qm4xa";
    await regions()
      .get("default")
      .db.insert(schema.artifacts)
      .values({
        id,
        ownerId: t.id,
        type: "site",
        name: "Plan",
        state: "active",
        accessMode: "workspace",
        currentVersionId: "v1",
        expiresAt: Date.now() + 10 * 24 * HOUR,
      });
    await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, sessionMaxHours: 8 });
    await ageSignIns(t.member, 9);
    const state = "s".repeat(43);
    const entry = await t.member.h.request(`/read/${id}?state=${state}`, {
      headers: { cookie: t.member.cookie },
      redirect: "manual",
    });
    expect(entry.status).toBe(303);
    const location = new URL(entry.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("reauth")).toBe("session_age");
    expect(location.searchParams.get("next")).toBe(`/read/${id}?state=${state}`);
  });
});

describe("the allowed clients through the app Worker", () => {
  it("lets the CLI act and refuses other OAuth apps, while the dashboard always may", async () => {
    const t = await team("spc");
    await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, allowedClients: ["cli"] });
    const path = `/api/v1/artifacts?workspace=${t.slug}`;
    expect((await t.member.call(path)).status).toBe(200);
    const viaMcp = await t.member.tool("list_artifacts", { workspace: t.slug });
    expect(viaMcp.structuredContent).toEqual(refused(POLICY_MESSAGES.client("oauth_apps")));
    // The same app token at the API gets the same answer: the client is the token's, not the route's.
    const viaApi = await t.member.call(path, t.member.mcpToken);
    expect([401, 403]).toContain(viaApi.status);
    expect(
      (await t.member.h.request(`/api/v1/workspaces/${t.slug}/members`, dashboard(t.member.cookie)))
        .status,
    ).toBe(200);

    await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, allowedClients: [] });
    expect(await (await t.member.call(path)).json()).toEqual(
      refused(POLICY_MESSAGES.client("cli")),
    );
    const listed = await (await t.member.call("/api/v1/workspaces")).json<{
      items: { blockedBy: string | null; policy: { allowedClients: unknown } }[];
    }>();
    expect(listed.items[0]).toMatchObject({ blockedBy: "client", policy: { allowedClients: [] } });
  });

  it("never binds someone with no role: a non-member gets the missing workspace", async () => {
    const t = await team("spn");
    await setPolicy(t.admin, t.slug, { ...DEFAULT_POLICY, allowedClients: [] });
    const outsider = await person("spn", "outsider");
    const answer = await outsider.call(`/api/v1/artifacts?workspace=${t.slug}`);
    expect(answer.status).toBe(404);
  });
});
