import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { disconnectApp, listBrowserSessions, listConnectedApps } from "../src/account.ts";

const db = () => createDb(env.DB);
const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const API = "https://app.portifact.com/api/v1";
const MCP = "https://app.portifact.com/mcp";

async function user(): Promise<string> {
  const id = `u_${crypto.randomUUID()}`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: "",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return id;
}

async function session(
  userId: string,
  options: { lastActive?: number; expiresIn?: number; userAgent?: string | null } = {},
): Promise<string> {
  const id = `s_${crypto.randomUUID()}`;
  await db()
    .insert(schema.sessions)
    .values({
      id,
      userId,
      token: `t_${crypto.randomUUID()}`,
      createdAt: new Date(NOW - DAY),
      updatedAt: new Date(options.lastActive ?? NOW - HOUR),
      expiresAt: new Date(NOW + (options.expiresIn ?? 6 * DAY)),
      userAgent: options.userAgent === undefined ? "Mozilla/5.0 Firefox/140.0" : options.userAgent,
      ipAddress: "203.0.113.9",
    });
  return id;
}

async function client(name: string | null = "Example MCP client"): Promise<string> {
  const clientId = `c_${crypto.randomUUID()}`;
  await db()
    .insert(schema.oauthClients)
    .values({
      id: clientId,
      clientId,
      name,
      redirectUris: JSON.stringify(["http://127.0.0.1/callback"]),
      createdAt: new Date(NOW - DAY),
      updatedAt: new Date(NOW - DAY),
    });
  return clientId;
}

interface TokenOptions {
  scopes?: string;
  resources?: string | null;
  createdAt?: number;
  expiresAt?: number | null;
  revoked?: boolean;
  rotated?: boolean;
  authTime?: number | null;
}

async function refreshToken(userId: string, clientId: string, o: TokenOptions = {}) {
  const id = `r_${crypto.randomUUID()}`;
  await db()
    .insert(schema.oauthRefreshTokens)
    .values({
      id,
      token: `hash_${id}`,
      userId,
      clientId,
      scopes: o.scopes ?? JSON.stringify(["artifacts:read", "offline_access"]),
      resources: o.resources === undefined ? JSON.stringify([MCP]) : o.resources,
      createdAt: new Date(o.createdAt ?? NOW - 2 * HOUR),
      expiresAt: o.expiresAt === null ? null : new Date(o.expiresAt ?? NOW + 20 * DAY),
      authTime: o.authTime === null ? null : new Date(o.authTime ?? NOW - 3 * DAY),
      revoked: o.revoked ? new Date(NOW - HOUR) : null,
      rotatedAt: o.rotated ? new Date(NOW - HOUR) : null,
    });
  return id;
}

async function accessToken(userId: string, clientId: string, o: TokenOptions = {}) {
  const id = `a_${crypto.randomUUID()}`;
  await db()
    .insert(schema.oauthAccessTokens)
    .values({
      id,
      token: `hash_${id}`,
      userId,
      clientId,
      scopes: o.scopes ?? JSON.stringify(["artifacts:read"]),
      resources: o.resources === undefined ? JSON.stringify([MCP]) : o.resources,
      createdAt: new Date(o.createdAt ?? NOW - HOUR / 2),
      expiresAt: o.expiresAt === null ? null : new Date(o.expiresAt ?? NOW + HOUR / 2),
      revoked: o.revoked ? new Date(NOW - HOUR) : null,
    });
  return id;
}

async function consent(userId: string, clientId: string) {
  await db()
    .insert(schema.oauthConsents)
    .values({
      id: `k_${crypto.randomUUID()}`,
      userId,
      clientId,
      scopes: JSON.stringify(["artifacts:read"]),
      createdAt: new Date(NOW - 3 * DAY),
      updatedAt: new Date(NOW - 3 * DAY),
    });
}

describe("browser sessions", () => {
  it("lists the user's live sessions, the current one first, without tokens or addresses", async () => {
    const userId = await user();
    const older = await session(userId, { lastActive: NOW - 5 * HOUR, userAgent: null });
    const current = await session(userId, { lastActive: NOW - 3 * HOUR });
    await session(userId, { lastActive: NOW - 2 * HOUR });
    await session(userId, { expiresIn: -HOUR });
    await session(await user());

    const sessions = await listBrowserSessions(db(), {
      userId,
      currentSessionId: current,
      now: NOW,
    });
    expect(sessions.map((s) => [s.current, s.lastActiveAt])).toEqual([
      [true, NOW - 3 * HOUR],
      [false, NOW - 2 * HOUR],
      [false, NOW - 5 * HOUR],
    ]);
    expect(sessions[0]).toEqual({
      current: true,
      userAgent: "Mozilla/5.0 Firefox/140.0",
      createdAt: NOW - DAY,
      lastActiveAt: NOW - 3 * HOUR,
      expiresAt: NOW + 6 * DAY,
    });
    expect(sessions[2]?.userAgent).toBeNull();
    expect(older).toBeTruthy();
  });
});

describe("connected apps", () => {
  it("groups live tokens by client with their scopes, resources and dates", async () => {
    const userId = await user();
    const mcp = await client("Example MCP client");
    await refreshToken(userId, mcp, { authTime: NOW - 3 * DAY });
    await accessToken(userId, mcp, {
      scopes: JSON.stringify(["artifacts:read", "artifacts:write"]),
      createdAt: NOW - HOUR / 4,
    });
    const cli = await client("Portifact CLI");
    await accessToken(userId, cli, {
      scopes: "artifacts:read artifacts:share",
      resources: JSON.stringify([API]),
      createdAt: NOW - 2 * DAY,
      expiresAt: NOW + HOUR,
    });

    const apps = await listConnectedApps(db(), { userId, now: NOW });
    expect(apps).toEqual([
      {
        clientId: mcp,
        name: "Example MCP client",
        resources: [MCP],
        scopes: ["artifacts:read", "offline_access", "artifacts:write"],
        approvedAt: NOW - 3 * DAY,
        lastIssuedAt: NOW - HOUR / 4,
        expiresAt: NOW + 20 * DAY,
      },
      {
        clientId: cli,
        name: "Portifact CLI",
        resources: [API],
        scopes: ["artifacts:read", "artifacts:share"],
        approvedAt: NOW - 2 * DAY,
        lastIssuedAt: NOW - 2 * DAY,
        expiresAt: NOW + HOUR,
      },
    ]);
  });

  it("leaves out revoked, rotated and expired tokens and other users' grants", async () => {
    const userId = await user();
    const gone = await client();
    await refreshToken(userId, gone, { revoked: true });
    await refreshToken(userId, gone, { rotated: true });
    await refreshToken(userId, gone, { expiresAt: NOW - 1 });
    await accessToken(userId, gone, { revoked: true });
    await accessToken(userId, gone, { expiresAt: NOW - 1 });
    await accessToken(userId, gone, { expiresAt: null });
    await accessToken(await user(), gone);
    expect(await listConnectedApps(db(), { userId, now: NOW })).toEqual([]);
  });

  it("says when a refresh token never expires and falls back to its creation date", async () => {
    const userId = await user();
    const forever = await client(null);
    await refreshToken(userId, forever, {
      expiresAt: null,
      authTime: null,
      createdAt: NOW - DAY,
      resources: null,
    });
    const [app] = await listConnectedApps(db(), { userId, now: NOW });
    expect(app).toMatchObject({
      name: null,
      resources: [],
      approvedAt: NOW - DAY,
      expiresAt: null,
    });
  });

  it("orders apps with the same activity by client and reads plain-text lists", async () => {
    const userId = await user();
    const [first, second] = [await client("B"), await client("A")].sort();
    for (const clientId of [second, first] as string[]) {
      await accessToken(userId, clientId, { scopes: "42", createdAt: NOW - HOUR });
    }
    const apps = await listConnectedApps(db(), { userId, now: NOW });
    expect(apps.map((a) => a.clientId)).toEqual([first, second]);
    expect(apps[0]?.scopes).toEqual(["42"]);
  });

  it("disconnects one app of the user: tokens and consent go, other apps and users stay", async () => {
    const userId = await user();
    const mcp = await client();
    const access = await accessToken(userId, mcp);
    await refreshToken(userId, mcp);
    await consent(userId, mcp);
    const keep = await client();
    await accessToken(userId, keep);
    const otherUser = await user();
    const othersToken = await accessToken(otherUser, mcp);

    expect(await disconnectApp(db(), { userId, clientId: mcp })).toEqual({
      ok: true,
      value: { clientId: mcp },
    });
    expect((await listConnectedApps(db(), { userId, now: NOW })).map((a) => a.clientId)).toEqual([
      keep,
    ]);
    const stillThere = await db()
      .select({ id: schema.oauthAccessTokens.id })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.clientId, mcp));
    expect(stillThere).toEqual([{ id: othersToken }]);
    expect(
      await db().select().from(schema.oauthConsents).where(eq(schema.oauthConsents.userId, userId)),
    ).toEqual([]);
    expect(access).toBeTruthy();
  });

  it("answers a client the user never connected like a missing one", async () => {
    const userId = await user();
    const someoneElses = await client();
    await accessToken(await user(), someoneElses);
    for (const clientId of [someoneElses, "no-such-client"]) {
      const result = await disconnectApp(db(), { userId, clientId });
      expect(result).toMatchObject({ ok: false, code: "not_found" });
    }
  });

  it("disconnects an app that only holds a consent", async () => {
    const userId = await user();
    const consentOnly = await client();
    await consent(userId, consentOnly);
    expect((await disconnectApp(db(), { userId, clientId: consentOnly })).ok).toBe(true);
  });
});
