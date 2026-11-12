// The cleanup of expired sign-in records (docs/operations.md, "Expired sign-in records"): Better
// Auth reads none of them once expired and deletes one only when something touches it again, so
// the maintenance run deletes them, bounded per run, a day after they expired, and app
// registrations made without an account that nothing uses any more (never approved, or
// disconnected by everyone). Global tables only.
import { type GlobalDb, schema } from "@portifact/db";
import { daysBefore, EXPIRED_AUTH_GRACE_MS, UNUSED_APP_REGISTRATION_DAYS } from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";

/** Rows each statement deletes at most per run. */
export const AUTH_CLEANUP_LIMIT = 500;

/** Clients seeded by migrations, which are never registrations to clean up. */
export const SEEDED_CLIENTS = ["portifact-cli"] as const;

export interface AuthCleanup {
  sessions: number;
  verifications: number;
  accessTokens: number;
  refreshTokens: number;
  deviceCodes: number;
  clientAssertions: number;
  clients: number;
}

/**
 * Whether a session can be deleted directly, without Better Auth's session hooks: deleting a
 * session through Better Auth (`oauth-provider`'s `session.delete` hooks) revokes the access tokens
 * and the refresh tokens without `offline_access` bound to it that are not revoked yet, and sends
 * back-channel logouts to clients that registered a URI for them. A session qualifies only when
 * none of that has anything to do: every such token bound to it is revoked or expired, and no
 * token of a client with a back-channel logout URI is bound to it. A direct delete otherwise only
 * sets the tokens' `session_id` to null, which is exactly what the hook leaves on revoked ones.
 */
export function sessionHooksHaveNothingToDo(session: SQL, now: number): SQL {
  const at = schema.oauthAccessTokens;
  const rt = schema.oauthRefreshTokens;
  const c = schema.oauthClients;
  const live = (table: typeof at | typeof rt) =>
    sql`${table.revoked} is null and (${table.expiresAt} is null or ${table.expiresAt} > ${now})`;
  return sql`not exists (select 1 from ${at} where ${at.sessionId} = ${session} and ${live(at)})
    and not exists (select 1 from ${rt} where ${rt.sessionId} = ${session} and ${live(rt)} and ${rt.scopes} not like '%offline_access%')
    and not exists (select 1 from ${at} join ${c} on ${c.clientId} = ${at.clientId} where ${at.sessionId} = ${session} and ${c.backchannelLogoutUri} is not null)
    and not exists (select 1 from ${rt} join ${c} on ${c.clientId} = ${rt.clientId} where ${rt.sessionId} = ${session} and ${c.backchannelLogoutUri} is not null)`;
}

/**
 * Deletes, at most `limit` rows per kind: sessions, sign-in code and other verification records,
 * OAuth access and refresh tokens, device codes and client assertions that expired more than
 * `EXPIRED_AUTH_GRACE_MS` ago (sessions only when `sessionHooksHaveNothingToDo`), and app
 * registrations made without an account more than `UNUSED_APP_REGISTRATION_DAYS` ago that no
 * consent, token or device code refers to. One batch.
 */
export async function pruneAuthRecords(
  global: GlobalDb,
  now: number,
  limit: number = AUTH_CLEANUP_LIMIT,
): Promise<AuthCleanup> {
  const expired = now - EXPIRED_AUTH_GRACE_MS;
  const s = schema.sessions;
  const v = schema.verifications;
  const at = schema.oauthAccessTokens;
  const rt = schema.oauthRefreshTokens;
  const dc = schema.deviceCodes;
  const ca = schema.oauthClientAssertions;
  const c = schema.oauthClients;
  const co = schema.oauthConsents;
  const seeded = sql.join(
    SEEDED_CLIENTS.map((id) => sql`${id}`),
    sql`, `,
  );
  const results = (await global.batch([
    global
      .delete(s)
      .where(
        sql`${s.id} in (select ${s.id} from ${s} where ${s.expiresAt} < ${expired} and ${sessionHooksHaveNothingToDo(sql`${s.id}`, now)} limit ${limit})`,
      )
      .returning({ id: s.id }),
    global
      .delete(v)
      .where(
        sql`${v.id} in (select ${v.id} from ${v} where ${v.expiresAt} < ${expired} limit ${limit})`,
      )
      .returning({ id: v.id }),
    // Access tokens before refresh tokens: the cascade from an expired refresh token only reaches
    // access tokens that expired long before it.
    global
      .delete(at)
      .where(
        sql`${at.id} in (select ${at.id} from ${at} where ${at.expiresAt} < ${expired} limit ${limit})`,
      )
      .returning({ id: at.id }),
    global
      .delete(rt)
      .where(
        sql`${rt.id} in (select ${rt.id} from ${rt} where ${rt.expiresAt} < ${expired} limit ${limit})`,
      )
      .returning({ id: rt.id }),
    global
      .delete(dc)
      .where(
        sql`${dc.id} in (select ${dc.id} from ${dc} where ${dc.expiresAt} < ${expired} limit ${limit})`,
      )
      .returning({ id: dc.id }),
    global
      .delete(ca)
      .where(
        sql`${ca.id} in (select ${ca.id} from ${ca} where ${ca.expiresAt} < ${expired} limit ${limit})`,
      )
      .returning({ id: ca.id }),
    global
      .delete(c)
      .where(
        sql`${c.id} in (select ${c.id} from ${c} where ${c.userId} is null and ${c.clientId} not in (${seeded}) and ${c.createdAt} is not null and ${c.createdAt} < ${daysBefore(now, UNUSED_APP_REGISTRATION_DAYS)}
          and not exists (select 1 from ${co} where ${co.clientId} = ${c.clientId})
          and not exists (select 1 from ${at} where ${at.clientId} = ${c.clientId})
          and not exists (select 1 from ${rt} where ${rt.clientId} = ${c.clientId})
          and not exists (select 1 from ${dc} where ${dc.clientId} = ${c.clientId} or ${dc.oauthClientId} = ${c.clientId})
          limit ${limit})`,
      )
      .returning({ id: c.id }),
  ])) as unknown[][];
  const count = (i: number) => results[i]?.length ?? 0;
  return {
    sessions: count(0),
    verifications: count(1),
    accessTokens: count(2),
    refreshTokens: count(3),
    deviceCodes: count(4),
    clientAssertions: count(5),
    clients: count(6),
  };
}
