// Review mode (plan section 4, "Modo revisión"). The viewer on app.portifact.com asks for a
// one-use code bound to the user, the artifact, its current version and the app session; the
// viewer's iframe redeems it on the artifact origin into a review session that reads only that
// version. Renewing the session's claims applies the same access check as read sessions, so a
// revocation or signing out of the app ends review within the claims' lifetime.
import { REVIEW_SESSION } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { checkReadAccess, hashSecret, liveAppSession, randomToken } from "./read-access.ts";

const SECOND_MS = 1000;
const PRUNE_BATCH = 500;

export interface ReviewGrant {
  userId: string;
  versionId: string;
  policyGeneration: number;
  sessionId: string;
  /** End of the review session, in milliseconds. */
  expiresAt: number;
}

export interface IssuedReviewHandoff {
  code: string;
  name: string;
  type: "site" | "markdown" | "text";
  expiresAt: number;
  versionId: string;
  entrypoint: string;
}

const unavailable = () =>
  fail<never>("not_found", "This artifact does not exist or your account cannot open it.");

/**
 * Checks that the user may read the artifact now and stores a one-use code for its current
 * version. Returns the code, which is shown once and stored only as a hash.
 */
export async function issueReviewHandoff(
  db: Db,
  input: { artifactId: string; userId: string; authSessionId: string; now: number },
): Promise<Result<IssuedReviewHandoff>> {
  const access = await checkReadAccess(db, input);
  if (!access.ok) return access;
  const [current] = await db
    .select({
      versionId: schema.versions.id,
      entrypoint: schema.versions.entrypoint,
      name: schema.artifacts.name,
      type: schema.artifacts.type,
    })
    .from(schema.artifacts)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.artifacts.currentVersionId))
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!current) return unavailable();
  const code = randomToken();
  const expiresAt = input.now + REVIEW_SESSION.handoffTtlSeconds * SECOND_MS;
  await db.insert(schema.reviewHandoffs).values({
    codeHash: await hashSecret(code),
    artifactId: input.artifactId,
    versionId: current.versionId,
    userId: input.userId,
    authSessionId: input.authSessionId,
    policyGeneration: access.value.policyGeneration,
    expiresAt,
    createdAt: input.now,
  });
  return ok({ code, expiresAt, ...current });
}

/**
 * Redeems a review code on the artifact origin it was issued for. One guarded update marks the
 * code used and names the new session, only while the app session that asked for it is live;
 * the session row is inserted only if that update happened, so a replayed or concurrent
 * redemption creates nothing.
 */
export async function redeemReviewHandoff(
  db: Db,
  input: { code: string; artifactId: string; now: number },
): Promise<Result<ReviewGrant>> {
  const codeHash = await hashSecret(input.code);
  const sessionId = randomToken();
  const expiresAt = input.now + REVIEW_SESSION.sessionTtlSeconds * SECOND_MS;
  const handoff = schema.reviewHandoffs;

  const [claimed] = await db.batch([
    db
      .update(handoff)
      .set({ usedAt: input.now, sessionId })
      .where(
        and(
          eq(handoff.codeHash, codeHash),
          eq(handoff.artifactId, input.artifactId),
          isNull(handoff.usedAt),
          gt(handoff.expiresAt, input.now),
          liveAppSession(db, handoff.authSessionId, input.now),
        ),
      )
      .returning({
        userId: handoff.userId,
        versionId: handoff.versionId,
        policyGeneration: handoff.policyGeneration,
      }),
    db.insert(schema.reviewSessions).select(
      db
        .select({
          id: sql<string>`${sessionId}`.as("id"),
          artifactId: handoff.artifactId,
          versionId: handoff.versionId,
          userId: handoff.userId,
          authSessionId: handoff.authSessionId,
          expiresAt: sql<number>`${expiresAt}`.as("expires_at"),
          createdAt: sql<number>`${input.now}`.as("created_at"),
        })
        .from(handoff)
        .where(and(eq(handoff.codeHash, codeHash), eq(handoff.sessionId, sessionId))),
    ),
  ]);
  const row = claimed[0];
  if (!row) return fail("invalid_input", "This review link has expired or was already used.");
  return ok({ ...row, sessionId, expiresAt });
}

/**
 * Renews a review session's claims: the session must exist for this artifact and be unexpired,
 * the app session it came from must still be live, and the account must still pass the
 * artifact's current access policy.
 */
export async function refreshReviewSession(
  db: Db,
  input: { sessionId: string; artifactId: string; now: number },
): Promise<Result<ReviewGrant>> {
  const sessions = schema.reviewSessions;
  const [session] = await db
    .select({
      userId: sessions.userId,
      versionId: sessions.versionId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, input.sessionId),
        eq(sessions.artifactId, input.artifactId),
        gt(sessions.expiresAt, input.now),
        liveAppSession(db, sessions.authSessionId, input.now),
      ),
    )
    .limit(1);
  if (!session) return unavailable();
  const access = await checkReadAccess(db, { ...input, userId: session.userId });
  if (!access.ok) return access;
  return ok({
    ...session,
    policyGeneration: access.value.policyGeneration,
    sessionId: input.sessionId,
  });
}

/** Deletes up to `limit` expired review codes and `limit` expired review sessions. Idempotent. */
export async function pruneReviewSessions(
  db: Db,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ processed: number }> {
  const handoff = schema.reviewHandoffs;
  const session = schema.reviewSessions;
  const [handoffs, sessions] = await db.batch([
    db
      .delete(handoff)
      .where(
        inArray(
          handoff.codeHash,
          db
            .select({ id: handoff.codeHash })
            .from(handoff)
            .where(lte(handoff.expiresAt, now))
            .limit(limit),
        ),
      )
      .returning({ id: handoff.codeHash }),
    db
      .delete(session)
      .where(
        inArray(
          session.id,
          db
            .select({ id: session.id })
            .from(session)
            .where(lte(session.expiresAt, now))
            .limit(limit),
        ),
      )
      .returning({ id: session.id }),
  ]);
  return { processed: handoffs.length + sessions.length };
}
