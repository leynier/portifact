// The recommended design: Portifact-owned workspace tables changed in D1 batches, the SSO plugin
// without the organization plugin, and sessions ended through Better Auth's internal adapter.
import { env } from "cloudflare:test";
import { createDb } from "@portifact/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN } from "./config.ts";
import { createHarness, get, json, newAccountCookies, uniqueEmail } from "./test/harness.ts";
import { type FakeIdp, ISSUER, startFakeIdp } from "./test/oidc-idp.ts";
import { addMember, countMembers, createWorkspace, resolveWorkspaceActor } from "./workspaces.ts";

const CLIENT_ID = "portifact-own";
const DOMAIN = "own.example";
const ended: string[] = [];
const h = createHarness({ workspaces: "own", onSessionDeleted: (s) => ended.push(s.userId) });
const db = createDb(env.DB);
let idp: FakeIdp;
let workspaceId: string;
let providerId: string;

async function userId(cookie: string): Promise<string> {
  return ((await (await h.raw("/get-session", get({ cookie }))).json()) as { user: { id: string } })
    .user.id;
}

beforeAll(async () => {
  idp = await startFakeIdp(CLIENT_ID);
  const admin = await h.signIn(uniqueEmail("admin", DOMAIN));
  workspaceId = await createWorkspace(db, {
    userId: await userId(admin),
    name: "Own",
    slug: `own-${crypto.randomUUID().slice(0, 6)}`,
    now: new Date(),
  });
  providerId = `own-oidc-${crypto.randomUUID().slice(0, 6)}`;
  // Without the organization plugin the SSO plugin cannot check workspace roles, so the
  // provider is registered without organizationId; the service (after its own admin check)
  // binds it to the workspace and marks the domain verified.
  await h.auth.api.registerSSOProvider({
    headers: new Headers({ cookie: admin }),
    body: {
      providerId,
      issuer: ISSUER,
      domain: DOMAIN,
      oidcConfig: {
        clientId: CLIENT_ID,
        clientSecret: "spike-client-secret",
        skipDiscovery: true,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        jwksEndpoint: `${ISSUER}/jwks`,
      },
    },
  });
  await env.DB.prepare(
    "UPDATE sso_providers SET organization_id = ?, domain_verified = 1 WHERE provider_id = ?",
  )
    .bind(workspaceId, providerId)
    .run();
});

afterAll(() => idp.restore());

async function ssoSignIn(email: string, cookies: string): Promise<string> {
  const started = await h.gated(
    "/sign-in/sso",
    json({ providerId, callbackURL: `${ORIGIN}/` }, { cookie: cookies }),
  );
  expect(started.status).toBe(200);
  const authorize = new URL(((await started.json()) as { url: string }).url);
  const code = crypto.randomUUID();
  idp.codes.set(code, { sub: `sub-${email}`, email, name: "Lin" });
  idp.bindNonce(code, authorize.searchParams.get("nonce"));
  const stateCookies = started.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const callback = await h.gated(
    `/sso/callback/${providerId}?code=${code}&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
    get({ cookie: [cookies, stateCookies].filter(Boolean).join("; ") }),
  );
  expect(callback.status).toBe(302);
  return (
    callback.headers.getSetCookie().find((c) => /^__Host-pf\.session_token=[^;]/.test(c)) ?? ""
  );
}

describe("Portifact-owned workspace tables", () => {
  it("creates a workspace and its admin atomically", async () => {
    const owner = await userId(await h.signIn(uniqueEmail("owner")));
    await expect(
      createWorkspace(db, {
        userId: owner,
        name: "Spike fault",
        slug: `fault-${crypto.randomUUID().slice(0, 6)}`,
        now: new Date(),
      }),
    ).rejects.toThrow();
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM workspaces WHERE name = 'Spike fault'",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("keeps one membership under concurrent adds", async () => {
    const target = await userId(await h.signIn(uniqueEmail("target")));
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        addMember(db, { workspaceId, userId: target, role: "member", now: new Date() }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await resolveWorkspaceActor(db, target, workspaceId))?.role).toBe("member");
  });

  it("refuses a role outside Portifact's three in the database itself", async () => {
    const target = await userId(await h.signIn(uniqueEmail("owner-role")));
    await expect(
      env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)",
      )
        .bind(workspaceId, target)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("resolves personal spaces and strangers like the plugin variant", async () => {
    expect(await resolveWorkspaceActor(db, "u1", "u1")).toEqual({
      userId: "u1",
      ownerId: "u1",
      role: "admin",
    });
    expect(await resolveWorkspaceActor(db, "u1", "u2")).toBeNull();
    expect(await resolveWorkspaceActor(db, "stranger", workspaceId)).toBeNull();
  });
});

describe("SSO plugin without the organization plugin", () => {
  it("creates the account through the real hooks and adds it to the owned workspace", async () => {
    const email = uniqueEmail("new", DOMAIN);
    const before = await countMembers(db, workspaceId);
    expect(await ssoSignIn(email, await newAccountCookies())).not.toBe("");
    const user = await env.DB.prepare("SELECT id, terms_version AS v FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string; v: string | null }>();
    expect(user?.v).not.toBeNull();
    expect((await resolveWorkspaceActor(db, user?.id ?? "", workspaceId))?.role).toBe("member");
    expect(await countMembers(db, workspaceId)).toBe(before + 1);
  });

  it("joins an existing account in the domain and makes it a member once", async () => {
    const email = uniqueEmail("existing", DOMAIN);
    const id = await userId(await h.signIn(email));
    expect(await ssoSignIn(email, "")).not.toBe("");
    expect(await ssoSignIn(email, "")).not.toBe("");
    expect((await resolveWorkspaceActor(db, id, workspaceId))?.role).toBe("member");
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    )
      .bind(workspaceId, id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("still refuses a new account without the terms", async () => {
    const email = uniqueEmail("noterms", DOMAIN);
    expect(await ssoSignIn(email, await newAccountCookies({ terms: false }))).toBe("");
  });
});

describe("ending sessions for deprovisioning", () => {
  it("runs the session delete hooks through Better Auth's internal adapter", async () => {
    const email = uniqueEmail("leaver");
    const cookie = await h.signIn(email);
    await h.signIn(email);
    const id = await userId(cookie);
    const context = await h.auth.$context;
    await context.internalAdapter.deleteUserSessions(id);
    expect(ended.filter((u) => u === id)).toHaveLength(2);
    expect((await h.raw("/get-session", get({ cookie }))).status).toBe(200);
    expect(await (await h.raw("/get-session", get({ cookie }))).json()).toBeNull();
  });
});
