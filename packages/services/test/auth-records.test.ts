// The cleanup of expired sign-in records (docs/operations.md, "Expired sign-in records"): what is
// deleted, a day after it expired, and the sessions it leaves to Better Auth because its session
// hooks would still have something to do.
import { schema } from "@portifact/db";
import { EXPIRED_AUTH_GRACE_MS, UNUSED_APP_REGISTRATION_DAYS } from "@portifact/domain";
import { eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneAuthRecords } from "../src/auth-records.ts";
import { DAY, db, NOW, user } from "./fixtures.ts";

const global = () => db().global;
const LATER = NOW + 30 * DAY;
const EXPIRED = new Date(LATER - EXPIRED_AUTH_GRACE_MS - 1);
const LIVE = new Date(LATER + DAY);

async function sessionRow(userId: string, expiresAt: Date) {
  const id = `s_${crypto.randomUUID()}`;
  await global()
    .insert(schema.sessions)
    .values({
      id,
      token: `t_${crypto.randomUUID()}`,
      userId,
      ipAddress: "203.0.113.7",
      userAgent: "Browser",
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      expiresAt,
    });
  return id;
}

async function client(options: { userId?: string; createdAt?: Date; backchannel?: string } = {}) {
  const clientId = `c_${crypto.randomUUID()}`;
  await global()
    .insert(schema.oauthClients)
    .values({
      id: clientId,
      clientId,
      redirectUris: '["http://127.0.0.1/callback"]',
      userId: options.userId ?? null,
      createdAt: options.createdAt ?? new Date(NOW),
      backchannelLogoutUri: options.backchannel ?? null,
    });
  return clientId;
}

async function accessToken(
  clientId: string,
  userId: string,
  sessionId: string | null,
  expiresAt: Date,
  revoked: Date | null = null,
) {
  const id = `at_${crypto.randomUUID()}`;
  await global()
    .insert(schema.oauthAccessTokens)
    .values({
      id,
      token: id,
      clientId,
      userId,
      sessionId,
      expiresAt,
      revoked,
      scopes: "[]",
      createdAt: new Date(NOW),
    });
  return id;
}

async function refreshToken(
  clientId: string,
  userId: string,
  sessionId: string | null,
  expiresAt: Date,
  scopes = "[]",
) {
  const id = `rt_${crypto.randomUUID()}`;
  await global()
    .insert(schema.oauthRefreshTokens)
    .values({
      id,
      token: id,
      clientId,
      userId,
      sessionId,
      expiresAt,
      scopes,
      createdAt: new Date(NOW),
    });
  return id;
}

const exists = async (
  table:
    | typeof schema.sessions
    | typeof schema.oauthAccessTokens
    | typeof schema.oauthRefreshTokens
    | typeof schema.verifications,
  id: string,
) => (await global().select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;

async function prune() {
  for (let run = 0; run < 20; run++) {
    const done = await pruneAuthRecords(global(), LATER);
    if (Object.values(done).every((count) => count === 0)) return;
  }
  throw new Error("the cleanup never finished");
}

describe("expired sign-in records", () => {
  it("deletes expired sessions, codes and tokens a day after they expired, and keeps live ones", async () => {
    const person = await user();
    const expiredSession = await sessionRow(person.id, EXPIRED);
    const recentSession = await sessionRow(person.id, new Date(LATER - 1));
    const liveSession = await sessionRow(person.id, LIVE);
    const code = `v_${crypto.randomUUID()}`;
    const liveCode = `v_${crypto.randomUUID()}`;
    await global()
      .insert(schema.verifications)
      .values([
        {
          id: code,
          identifier: `sign-in-otp-${person.email}`,
          value: "hash",
          expiresAt: EXPIRED,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        },
        {
          id: liveCode,
          identifier: `sign-in-otp-${person.email}`,
          value: "hash",
          expiresAt: LIVE,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        },
      ]);
    const app = await client({ userId: person.id });
    const oldAccess = await accessToken(app, person.id, null, EXPIRED);
    const oldRefresh = await refreshToken(app, person.id, null, EXPIRED);
    const liveRefresh = await refreshToken(app, person.id, null, LIVE);

    await prune();
    expect(await exists(schema.sessions, expiredSession)).toBe(false);
    expect(await exists(schema.sessions, recentSession)).toBe(true);
    expect(await exists(schema.sessions, liveSession)).toBe(true);
    expect(await exists(schema.verifications, code)).toBe(false);
    expect(await exists(schema.verifications, liveCode)).toBe(true);
    expect(await exists(schema.oauthAccessTokens, oldAccess)).toBe(false);
    expect(await exists(schema.oauthRefreshTokens, oldRefresh)).toBe(false);
    expect(await exists(schema.oauthRefreshTokens, liveRefresh)).toBe(true);
  });

  it("leaves to Better Auth an expired session whose sign-out hooks would still revoke a token", async () => {
    const person = await user();
    const app = await client({ userId: person.id });
    const withAccess = await sessionRow(person.id, EXPIRED);
    const access = await accessToken(app, person.id, withAccess, LIVE);
    const withRefresh = await sessionRow(person.id, EXPIRED);
    await refreshToken(app, person.id, withRefresh, LIVE);
    const withOffline = await sessionRow(person.id, EXPIRED);
    await refreshToken(app, person.id, withOffline, LIVE, '["offline_access"]');
    const withRevoked = await sessionRow(person.id, EXPIRED);
    await accessToken(app, person.id, withRevoked, LIVE, new Date(NOW));
    const logoutApp = await client({
      userId: person.id,
      backchannel: "https://example.test/logout",
    });
    const withLogout = await sessionRow(person.id, EXPIRED);
    await accessToken(logoutApp, person.id, withLogout, LIVE, new Date(NOW));

    await prune();
    // A live access token or a live refresh token without offline_access: the hook would revoke it.
    expect(await exists(schema.sessions, withAccess)).toBe(true);
    expect(await exists(schema.sessions, withRefresh)).toBe(true);
    // A back-channel logout client: the hook would notify it.
    expect(await exists(schema.sessions, withLogout)).toBe(true);
    // Nothing for the hook to do: an offline refresh token, which it keeps, or a revoked token.
    expect(await exists(schema.sessions, withOffline)).toBe(false);
    expect(await exists(schema.sessions, withRevoked)).toBe(false);
    // Once the token expires too, the session goes.
    await global()
      .update(schema.oauthAccessTokens)
      .set({ expiresAt: EXPIRED })
      .where(eq(schema.oauthAccessTokens.id, access));
    await prune();
    expect(await exists(schema.sessions, withAccess)).toBe(false);
  });

  it("deletes app registrations made without an account that nobody authorized, and keeps the rest", async () => {
    const person = await user();
    const old = new Date(LATER - (UNUSED_APP_REGISTRATION_DAYS + 1) * DAY);
    const unused = await client({ createdAt: old });
    const recent = await client({ createdAt: new Date(LATER - DAY) });
    const consented = await client({ createdAt: old });
    await global()
      .insert(schema.oauthConsents)
      .values({
        id: `co_${crypto.randomUUID()}`,
        clientId: consented,
        userId: person.id,
        scopes: "[]",
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
    const withToken = await client({ createdAt: old });
    await refreshToken(withToken, person.id, null, LIVE);
    const owned = await client({ userId: person.id, createdAt: old });

    await prune();
    const left = await global()
      .select({ clientId: schema.oauthClients.clientId })
      .from(schema.oauthClients)
      .where(like(schema.oauthClients.clientId, "c_%"));
    const ids = left.map((row) => row.clientId);
    expect(ids).not.toContain(unused);
    for (const kept of [recent, consented, withToken, owned]) expect(ids).toContain(kept);
    // The seeded CLI client is never a registration to clean up.
    const [cli] = await global()
      .select({ clientId: schema.oauthClients.clientId })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, "portifact-cli"));
    expect(cli).toBeDefined();
  });

  it("deletes at most the limit per kind in one run", async () => {
    const person = await user();
    for (let i = 0; i < 3; i++) await sessionRow(person.id, EXPIRED);
    const first = await pruneAuthRecords(global(), LATER, 2);
    expect(first.sessions).toBe(2);
  });
});

describe("the cleanup's query plans", () => {
  const plan = async (query: string) =>
    (
      await db().global.$client.prepare(`explain query plan ${query}`).all<{ detail: string }>()
    ).results.map((row) => row.detail);

  it.each([
    ["sessions", "select id from sessions where expires_at < 1 limit 500"],
    ["verifications", "select id from verifications where expires_at < 1 limit 500"],
    ["oauth_access_tokens", "select id from oauth_access_tokens where expires_at < 1 limit 500"],
    ["oauth_refresh_tokens", "select id from oauth_refresh_tokens where expires_at < 1 limit 500"],
    ["device_codes", "select id from device_codes where expires_at < 1 limit 500"],
    [
      "oauth_client_assertions",
      "select id from oauth_client_assertions where expires_at < 1 limit 500",
    ],
    [
      "oauth_clients",
      "select id from oauth_clients where user_id is null and created_at is not null and created_at < 1 limit 500",
    ],
  ])("reads %s through an index, never a full scan", async (table, query) => {
    const details = await plan(query);
    expect(details.join(" | ")).toMatch(new RegExp(`SEARCH ${table} USING (COVERING )?INDEX`));
  });
});
