// The signed-in user's own browser sessions and connected apps (plan section 5, "Cuenta" in
// section 6). Every query is keyed by the user ID from the session, so a user can only see and
// end their own grants. Better Auth owns these tables: ending sessions goes through Better Auth
// (apps/app), so its session hooks revoke the tokens bound to them; tokens are never exposed.
import { type Db, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

/** Upper bound of sessions listed; older ones still end with "sign out other sessions". */
const SESSION_LIST_LIMIT = 100;

export interface BrowserSessionRow {
  current: boolean;
  userAgent: string | null;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

export async function listBrowserSessions(
  db: Db,
  input: { userId: string; currentSessionId: string; now: number },
): Promise<BrowserSessionRow[]> {
  const rows = await db
    .select({
      id: schema.sessions.id,
      userAgent: schema.sessions.userAgent,
      createdAt: schema.sessions.createdAt,
      updatedAt: schema.sessions.updatedAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, input.userId),
        gt(schema.sessions.expiresAt, new Date(input.now)),
      ),
    )
    .orderBy(desc(schema.sessions.updatedAt), desc(schema.sessions.id))
    .limit(SESSION_LIST_LIMIT);
  const sessions = rows.map((row) => ({
    current: row.id === input.currentSessionId,
    userAgent: row.userAgent,
    createdAt: row.createdAt.getTime(),
    lastActiveAt: row.updatedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  }));
  // The browser asking always comes first.
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
}

export interface ConnectedAppRow {
  clientId: string;
  name: string | null;
  /** Resource indicators the live tokens were issued for. */
  resources: string[];
  scopes: string[];
  approvedAt: number;
  lastIssuedAt: number;
  /** Null when some live token never expires. */
  expiresAt: number | null;
}

interface TokenGroup {
  clientId: string;
  name: string | null;
  scopes: string;
  resources: string | null;
  approvedAt: number;
  lastIssuedAt: number;
  expiresAt: number | null;
  neverExpires: number;
}

/**
 * Apps holding live tokens for the user: an unrevoked, unexpired access token, or a refresh
 * token that is neither revoked nor rotated away. One entry per client, newest activity first.
 */
export async function listConnectedApps(
  db: Db,
  input: { userId: string; now: number },
): Promise<ConnectedAppRow[]> {
  const now = new Date(input.now);
  const refresh = schema.oauthRefreshTokens;
  const access = schema.oauthAccessTokens;
  const clients = schema.oauthClients;

  const refreshGroups: TokenGroup[] = await db
    .select({
      clientId: refresh.clientId,
      name: clients.name,
      scopes: refresh.scopes,
      resources: refresh.resources,
      approvedAt: sql<number>`min(coalesce(${refresh.authTime}, ${refresh.createdAt}))`,
      lastIssuedAt: sql<number>`max(${refresh.createdAt})`,
      expiresAt: sql<number | null>`max(${refresh.expiresAt})`,
      neverExpires: sql<number>`max(${refresh.expiresAt} is null)`,
    })
    .from(refresh)
    .innerJoin(clients, eq(clients.clientId, refresh.clientId))
    .where(
      and(
        eq(refresh.userId, input.userId),
        isNull(refresh.revoked),
        isNull(refresh.rotatedAt),
        or(isNull(refresh.expiresAt), gt(refresh.expiresAt, now)),
      ),
    )
    .groupBy(refresh.clientId, refresh.scopes, refresh.resources);

  const accessGroups: TokenGroup[] = await db
    .select({
      clientId: access.clientId,
      name: clients.name,
      scopes: access.scopes,
      resources: access.resources,
      approvedAt: sql<number>`min(${access.createdAt})`,
      lastIssuedAt: sql<number>`max(${access.createdAt})`,
      expiresAt: sql<number | null>`max(${access.expiresAt})`,
      neverExpires: sql<number>`0`,
    })
    .from(access)
    .innerJoin(clients, eq(clients.clientId, access.clientId))
    .where(
      and(
        eq(access.userId, input.userId),
        isNull(access.revoked),
        // Better Auth treats an access token without an expiry as inactive.
        gt(access.expiresAt, now),
      ),
    )
    .groupBy(access.clientId, access.scopes, access.resources);

  const apps = new Map<string, ConnectedAppRow & { neverExpires: boolean }>();
  for (const group of [...refreshGroups, ...accessGroups]) {
    const app = apps.get(group.clientId) ?? {
      clientId: group.clientId,
      name: group.name,
      resources: [],
      scopes: [],
      approvedAt: group.approvedAt,
      lastIssuedAt: group.lastIssuedAt,
      expiresAt: group.expiresAt,
      neverExpires: false,
    };
    app.resources = union(app.resources, parseList(group.resources));
    app.scopes = union(app.scopes, parseList(group.scopes));
    app.approvedAt = Math.min(app.approvedAt, group.approvedAt);
    app.lastIssuedAt = Math.max(app.lastIssuedAt, group.lastIssuedAt);
    app.expiresAt = Math.max(app.expiresAt ?? 0, group.expiresAt ?? 0);
    app.neverExpires ||= group.neverExpires === 1;
    apps.set(group.clientId, app);
  }
  return [...apps.values()]
    .map(({ neverExpires, ...app }) => ({ ...app, expiresAt: neverExpires ? null : app.expiresAt }))
    .sort((a, b) => b.lastIssuedAt - a.lastIssuedAt || a.clientId.localeCompare(b.clientId));
}

/**
 * Disconnects one app from the user's account: deletes its access and refresh tokens and the
 * consent, in one transaction, so it stops working on the next request and has to ask again.
 * Only the user's own grants are touched; another user's grants for the same client stay.
 */
export async function disconnectApp(
  db: Db,
  input: { userId: string; clientId: string },
): Promise<Result<{ clientId: string }>> {
  const [accessTokens, refreshTokens, consents] = await db.batch([
    db
      .delete(schema.oauthAccessTokens)
      .where(
        and(
          eq(schema.oauthAccessTokens.userId, input.userId),
          eq(schema.oauthAccessTokens.clientId, input.clientId),
        ),
      )
      .returning({ id: schema.oauthAccessTokens.id }),
    db
      .delete(schema.oauthRefreshTokens)
      .where(
        and(
          eq(schema.oauthRefreshTokens.userId, input.userId),
          eq(schema.oauthRefreshTokens.clientId, input.clientId),
        ),
      )
      .returning({ id: schema.oauthRefreshTokens.id }),
    db
      .delete(schema.oauthConsents)
      .where(
        and(
          eq(schema.oauthConsents.userId, input.userId),
          eq(schema.oauthConsents.clientId, input.clientId),
        ),
      )
      .returning({ id: schema.oauthConsents.id }),
  ]);
  if (accessTokens.length + refreshTokens.length + consents.length === 0) {
    return fail("not_found", "No app with that ID is connected to this account.");
  }
  return ok({ clientId: input.clientId });
}

/** Better Auth stores array fields as JSON text; tolerate space-separated values too. */
function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // Not JSON: fall through to the space-separated form.
  }
  return value.split(" ").filter(Boolean);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}
