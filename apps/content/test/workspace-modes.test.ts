// Delivery of `workspace` and `domain` artifacts (decision 0010) on the artifact origin: members
// and domain readers get read sessions through the same entry flow, an outsider never does,
// delivery reads nothing more from D1 than for a restricted artifact, and removing a member or a
// domain ends a session when its claims next need renewing.
import { env } from "cloudflare:test";
import { READ_SESSION } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { createShareLink, issueReadHandoff, openShareLink } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { READ_COOKIE, TRANSACTION_COOKIE_PREFIX } from "../src/cookies.ts";
import { handle } from "../src/index.ts";
import { SHARE_COOKIE } from "../src/share-session.ts";

const ID = "w7d2qm4xab";
const ORIGIN = `https://${ID}.portifact.dev`;
const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;
const CLAIMS_MS = READ_SESSION.claimsTtlSeconds * 1000;
const PAGE = "<h1>Team plan</h1>";
const WS = "ws_0123456789abcdef0123456789abcdef";
const DOMAIN = "acme-content.com";
const db = () => regionsFromEnv(env).get("default").db;

const ADMIN = "u_admin";
const MEMBER = "u_member";
const COLLEAGUE = "u_colleague";
const OUTSIDER = "u_outsider";
const appSession = (userId: string) => `as_${userId}`;

async function seed(mode: "restricted" | "workspace" | "domain") {
  // A deletion row first, as a workspace deletion writes it, so the last-admin trigger lets go.
  await env.DB.exec("INSERT OR IGNORE INTO workspace_deletions SELECT id, 0 FROM workspaces");
  for (const table of [
    "traffic_counters",
    "read_sessions",
    "read_handoffs",
    "artifact_readers",
    "version_files",
    "versions",
    "objects",
    "artifacts",
    "workspace_domains",
    "owner_plans",
    "workspace_members",
    "workspaces",
    "workspace_deletions",
    "sessions",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const at = new Date(NOW - 30 * DAY);
  await db()
    .insert(schema.users)
    .values(
      [
        { id: ADMIN, email: "admin@example.org" },
        { id: MEMBER, email: "member@example.org" },
        { id: COLLEAGUE, email: `dana@${DOMAIN}` },
        { id: OUTSIDER, email: "out@example.org" },
      ].map((user) => ({
        ...user,
        name: user.id,
        emailVerified: true,
        createdAt: at,
        updatedAt: at,
      })),
    );
  await db()
    .insert(schema.sessions)
    .values(
      [ADMIN, MEMBER, COLLEAGUE, OUTSIDER].map((userId) => ({
        id: appSession(userId),
        token: `token-${userId}`,
        userId,
        expiresAt: new Date(NOW + 7 * DAY),
        createdAt: at,
        updatedAt: at,
      })),
    );
  await db()
    .insert(schema.workspaces)
    .values({ id: WS, slug: "acme", name: "Acme", createdBy: ADMIN, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: WS, userId: ADMIN, role: "admin", updatedAt: NOW },
      { workspaceId: WS, userId: MEMBER, role: "member", updatedAt: NOW },
    ]);
  await db()
    .insert(schema.ownerPlans)
    .values({ ownerId: WS, plan: "team", seats: 5, grantedBy: "test", updatedAt: NOW });
  await db()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${"1".repeat(32)}`,
      workspaceId: WS,
      domain: DOMAIN,
      token: "f".repeat(32),
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW,
      verifiedAt: NOW,
      checkedAt: NOW,
    });
  const hash = "b".repeat(64);
  await env.ARTIFACTS.put(`objects/${WS}/${hash}`, PAGE);
  await db()
    .insert(schema.objects)
    .values({
      ownerId: WS,
      sha256: hash,
      size: PAGE.length,
      r2Key: `objects/${WS}/${hash}`,
      state: "verified",
    });
  await db()
    .insert(schema.artifacts)
    .values({
      id: ID,
      ownerId: WS,
      type: "site",
      name: "Plan",
      state: "active",
      accessMode: mode,
      currentVersionId: `${ID}-v1`,
      expiresAt: NOW + 10 * DAY,
      bar: false,
    });
  await db()
    .insert(schema.versions)
    .values({
      id: `${ID}-v1`,
      artifactId: ID,
      number: 1,
      authorId: ADMIN,
      entrypoint: "index.html",
      publishedBytes: PAGE.length,
    });
  await db()
    .insert(schema.versionFiles)
    .values({
      versionId: `${ID}-v1`,
      kind: "published",
      path: "index.html",
      ownerId: WS,
      sha256: hash,
      size: PAGE.length,
      contentType: "text/html; charset=utf-8",
    });
}

const NAVIGATE = {
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const FROM_APP = {
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

/** Counts the D1 statements a request prepares, through a wrapper of the binding. */
function counting() {
  const counter = { statements: 0 };
  const DB = new Proxy(env.DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "prepare") {
        return (query: string) => {
          counter.statements++;
          return target.prepare(query);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { counter, env: { ...env, DB } };
}

function send(path: string, cookie?: string, now = NOW, headers = NAVIGATE, testEnv = env) {
  const h = new Headers(headers);
  if (cookie) h.set("Cookie", cookie);
  return handle(new Request(`${ORIGIN}${path}`, { headers: h }), testEnv, now);
}

const pairOf = (response: Response, prefix: string) =>
  (response.headers.getSetCookie().find((c) => c.startsWith(prefix)) ?? "").split(";")[0] ?? "";

async function signIn(userId: string): Promise<string> {
  const started = await send("/");
  expect(started.status).toBe(303);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const tx = pairOf(started, TRANSACTION_COOKIE_PREFIX);
  const issued = await issueReadHandoff(db(), {
    artifactId: ID,
    userId,
    authSessionId: appSession(userId),
    state,
    now: NOW,
    customDomains: true,
    confirmed: false,
    requestedHost: null,
    contentDomain: "portifact.dev",
  });
  if (!issued.ok) throw new Error(issued.code);
  const back = await send(`/__portifact/callback?code=${issued.value.code}`, tx, NOW, FROM_APP);
  expect(back.status).toBe(303);
  return pairOf(back, `${READ_COOKIE}=`);
}

describe("workspace and domain artifacts on the artifact origin", () => {
  it("serves members in workspace mode and refuses an outsider and a domain reader the handoff", async () => {
    await seed("workspace");
    const cookie = await signIn(MEMBER);
    const page = await send("/", cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    for (const userId of [OUTSIDER, COLLEAGUE]) {
      expect(
        await issueReadHandoff(db(), {
          artifactId: ID,
          userId,
          authSessionId: appSession(userId),
          state: "s".repeat(43),
          now: NOW,
          customDomains: true,
          confirmed: false,
          requestedHost: null,
          contentDomain: "portifact.dev",
        }),
      ).toMatchObject({ ok: false, code: "not_found" });
    }
  });

  it("serves a verified address at the domain in domain mode", async () => {
    await seed("domain");
    const page = await send("/", await signIn(COLLEAGUE));
    expect(page.status).toBe(200);
  });

  it("reads no more from D1 to deliver a page than a restricted artifact does", async () => {
    const statements: Record<string, number> = {};
    for (const mode of ["restricted", "workspace", "domain"] as const) {
      await seed(mode);
      if (mode === "restricted") {
        await db()
          .insert(schema.artifactReaders)
          .values({ artifactId: ID, email: "member@example.org" });
      }
      const cookie = await signIn(MEMBER);
      const { counter, env: countedEnv } = counting();
      const page = await send("/", cookie, NOW + 1_000, NAVIGATE, countedEnv);
      expect(page.status).toBe(200);
      statements[mode] = counter.statements;
    }
    expect(statements.workspace).toBe(statements.restricted);
    expect(statements.domain).toBe(statements.restricted);
  });

  it("ends a member's and a domain reader's sessions when their claims next renew", async () => {
    await seed("domain");
    const member = await signIn(MEMBER);
    const colleague = await signIn(COLLEAGUE);
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id = ?").bind(MEMBER).run();
    await env.DB.prepare("DELETE FROM workspace_domains WHERE workspace_id = ?").bind(WS).run();
    // Within the claims' lifetime the page is still served, as for any revocation.
    expect((await send("/", member, NOW + 1_000)).status).toBe(200);
    expect((await send("/", colleague, NOW + 1_000)).status).toBe(200);
    // Past it, the renewal checks the membership and the domain again.
    for (const cookie of [member, colleague]) {
      const after = await send("/", cookie, NOW + CLAIMS_MS + 1_000);
      expect(after.status).toBe(303);
      expect(after.headers.get("location")).toContain("/read/");
    }
  });

  it("stops serving a domain reader when the plan lapses, and keeps serving members", async () => {
    await seed("domain");
    const member = await signIn(MEMBER);
    const colleague = await signIn(COLLEAGUE);
    await env.DB.prepare("DELETE FROM owner_plans WHERE owner_id = ?").bind(WS).run();
    const later = NOW + CLAIMS_MS + 1_000;
    expect((await send("/", member, later)).status).toBe(200);
    expect((await send("/", colleague, later)).status).toBe(303);
  });
});

describe("a workspace's network allowlist on the artifact origin (decision 0020)", () => {
  const OFFICE = "192.0.2.10";
  const HOME = "198.51.100.20";
  const allowOnly = (ranges: string[]) =>
    env.DB.prepare(
      "UPDATE workspaces SET policy = ?, policy_revision = policy_revision + 1 WHERE id = ?",
    )
      .bind(
        JSON.stringify({
          publicAccess: "allowed",
          defaultAccess: "restricted",
          readerDomains: null,
          shareLinks: "allowed",
          shareLinkMaxDays: null,
          ipAllowlist: ranges,
          tokenIpAllowlist: null,
        }),
        WS,
      )
      .run();
  const at = (ip: string | null, cookie: string, now = NOW + 1_000, testEnv = env) => {
    const headers = new Headers(NAVIGATE);
    headers.set("Cookie", cookie);
    if (ip !== null) headers.set("CF-Connecting-IP", ip);
    return handle(new Request(`${ORIGIN}/`, { headers }), testEnv, now);
  };

  it("serves a workspace artifact's members only from the allowed networks, on every request", async () => {
    await seed("workspace");
    const cookie = await signIn(MEMBER);
    await allowOnly(["192.0.2.0/24", "2001:db8::/32"]);
    expect((await at(OFFICE, cookie)).status).toBe(200);
    expect((await at("2001:db8::7", cookie)).status).toBe(200);
    expect((await at("::ffff:192.0.2.44", cookie)).status).toBe(200);
    for (const ip of [HOME, "2001:db9::1", null]) {
      const refused = await at(ip, cookie);
      expect(refused.status).toBe(403);
      const body = await refused.text();
      // Nothing of the artifact: neither its content nor its name.
      expect(body).toContain("approved networks");
      expect(body).not.toContain("Team plan");
      expect(body).not.toContain("Plan<");
    }
    // Lifting the allowlist serves the member again at once (one database: no cache).
    await env.DB.prepare("UPDATE workspaces SET policy = NULL WHERE id = ?").bind(WS).run();
    expect((await at(HOME, cookie)).status).toBe(200);
  });

  it("adds no D1 read to a warm request", async () => {
    await seed("workspace");
    const cookie = await signIn(MEMBER);
    const before = counting();
    expect((await at(HOME, cookie, NOW + 1_000, before.env)).status).toBe(200);
    await allowOnly(["198.51.100.0/24"]);
    const after = counting();
    expect((await at(HOME, cookie, NOW + 1_000, after.env)).status).toBe(200);
    expect(after.counter.statements).toBe(before.counter.statements);
  });

  it("binds members reading other modes when their session renews, never the outsiders named", async () => {
    await seed("restricted");
    await db()
      .insert(schema.artifactReaders)
      .values([
        { artifactId: ID, email: "out@example.org" },
        { artifactId: ID, email: "member@example.org" },
      ]);
    const outsider = await signIn(OUTSIDER);
    const admin = await signIn(ADMIN);
    await allowOnly(["192.0.2.0/24"]);
    // Within the claims' lifetime both are served: the content Worker cannot tell a member here.
    expect((await at(HOME, outsider)).status).toBe(200);
    expect((await at(HOME, admin)).status).toBe(200);
    const later = NOW + CLAIMS_MS + 1_000;
    // At renewal the admin's role is decided again with this request's address: sign in again,
    // where the app explains the network policy.
    const renewed = await at(HOME, admin, later);
    expect(renewed.status).toBe(303);
    expect(renewed.headers.get("location")).toContain("/read/");
    // The same session renews from an allowed network.
    expect((await at(OFFICE, admin, later)).status).toBe(200);
    // A listed outsider is someone the workspace chose to reach outside it: not bound.
    expect((await at(HOME, outsider, later)).status).toBe(200);
  });

  it("never binds a share link's visitors", async () => {
    await seed("workspace");
    const created = await createShareLink(db(), {
      userId: ADMIN,
      artifactId: ID,
      label: "Board",
      expiresAt: null,
      password: undefined,
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);
    const opened = await openShareLink([db()], {
      customDomains: true,
      token: created.value.token,
      password: undefined,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    const entered = await send(`/__portifact/link?code=${opened.code}`, undefined, NOW, FROM_APP);
    const cookie = pairOf(entered, `${SHARE_COOKIE}=`);
    await allowOnly(["192.0.2.0/24"]);
    expect((await at(HOME, cookie)).status).toBe(200);
  });
});
