// Read sessions across databases. Today `read_sessions` has foreign keys to Better Auth's
// `users` and `sessions`, so signing out deletes them by cascade. In a regional database those
// rows do not exist, so the keys go and the liveness check, which `redeemReadHandoff` and
// `refreshReadSession` already run, becomes a read of the global database. Signing out still
// ends the read session at the next claims renewal (at most 60 seconds, the existing SLA); the
// regional row is left to the expiry prune and to account deletion.
import { isRegion, type Region, type Regions } from "./regions.ts";

export async function appSessionLive(
  global: D1Database,
  authSessionId: string,
  now: number,
): Promise<{ userId: string } | null> {
  return global
    .prepare("select user_id as userId from sessions where id = ? and expires_at > ?")
    .bind(authSessionId, now)
    .first<{ userId: string }>();
}

export async function openReadSession(
  regions: Regions,
  input: { artifactId: string; authSessionId: string; sessionId: string; now: number },
): Promise<boolean> {
  const live = await appSessionLive(regions.global, input.authSessionId, input.now);
  if (!live) return false;
  const region = await regions.global
    .prepare("select region from artifact_directory where id = ?")
    .bind(input.artifactId)
    .first<{ region: string }>();
  if (!region || !isRegion(region.region)) return false;
  const inserted = await regions
    .get(region.region)
    .db.prepare(
      `insert into read_sessions (id, artifact_id, user_id, auth_session_id, expires_at)
       select ?1, ?2, ?3, ?4, ?5 where exists (select 1 from artifacts where id = ?2)`,
    )
    .bind(
      input.sessionId,
      input.artifactId,
      live.userId,
      input.authSessionId,
      input.now + 3_600_000,
    )
    .run();
  return inserted.meta.changes === 1;
}

/** Renews claims only while the regional row and the global app session both stand. */
export async function refreshReadSession(
  regions: Regions,
  region: Region,
  input: { sessionId: string; now: number },
): Promise<boolean> {
  const session = await regions
    .get(region)
    .db.prepare(
      "select auth_session_id as authSessionId from read_sessions where id = ? and expires_at > ?",
    )
    .bind(input.sessionId, input.now)
    .first<{ authSessionId: string }>();
  if (!session) return false;
  return (await appSessionLive(regions.global, session.authSessionId, input.now)) !== null;
}
