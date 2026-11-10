// Review mode (plan section 4, "Modo revisión"). The viewer on app.portifact.com asks for a
// one-use code bound to the user, the artifact, its current version and the app session; the
// viewer's iframe redeems it on the artifact origin into a review session that reads only that
// version. Renewing the session's claims applies the same access check as read sessions, so a
// revocation or signing out of the app ends review within the claims' lifetime.
import { REVIEW_SESSION, type ReviewKind } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
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

/** A redeemed code: the grant and the tag of the new session (see `reviewSessionTag`). */
export interface RedeemedReview extends ReviewGrant {
  sessionTag: string;
}

export interface IssuedReviewHandoff {
  code: string;
  name: string;
  type: "site" | "markdown" | "text";
  expiresAt: number;
  versionId: string;
  entrypoint: string;
  sessionTag: string;
}

const unavailable = () =>
  fail<never>("not_found", "This artifact does not exist or your account cannot open it.");

/**
 * A public tag of the review session a code turns into: the first 16 bytes of a domain-separated
 * SHA-256 of the code, in base64url. The viewer gets it with the code and the bridge echoes the
 * tag of the session its page was served in, so the viewer notices a frame that runs a review
 * session it did not start (one planted through a cross-site redirect). It reveals neither the
 * code, which is used by then, nor the session ID, and differs from the stored code hash.
 */
export async function reviewSessionTag(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`portifact-review-session-tag\0${code}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest).slice(0, 16)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** How long a review session lasts, by where it runs. */
export function reviewSessionTtlMs(kind: ReviewKind): number {
  return (
    (kind === "tab" ? REVIEW_SESSION.tabSessionTtlSeconds : REVIEW_SESSION.sessionTtlSeconds) *
    SECOND_MS
  );
}

/**
 * Checks that the user may read the artifact now and stores a one-use code for its current
 * version, redeemable only where `kind` says (the viewer's frame by default, or a top-level
 * review tab). Returns the code, which is shown once and stored only as a hash.
 */
export async function issueReviewHandoff(
  db: RegionalDb,
  input: {
    artifactId: string;
    userId: string;
    authSessionId: string;
    now: number;
    kind?: ReviewKind;
  },
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
  const handoff = schema.reviewHandoffs;
  await db.batch([
    db.insert(handoff).values({
      codeHash: await hashSecret(code),
      artifactId: input.artifactId,
      versionId: current.versionId,
      userId: input.userId,
      authSessionId: input.authSessionId,
      policyGeneration: access.value.policyGeneration,
      kind: input.kind ?? "frame",
      expiresAt,
      createdAt: input.now,
    }),
    // Keeps the account's newest unredeemed codes only, the new one included; redeemed codes
    // stay until the maintenance job prunes them.
    db
      .delete(handoff)
      .where(
        sql`${handoff.codeHash} in (select code_hash from review_handoffs where user_id = ${input.userId} and used_at is null order by created_at desc, rowid desc limit -1 offset ${REVIEW_SESSION.openCodesPerUser})`,
      ),
  ]);
  return ok({ code, expiresAt, sessionTag: await reviewSessionTag(code), ...current });
}

/**
 * Redeems a review code on the artifact origin it was issued for, where it was issued to run
 * (`kind`): a frame code never opens a tab session, nor the reverse. One guarded update marks
 * the code used and names the new session, only while the app session that asked for it is
 * live; the session row is inserted only if that update happened, so a replayed or concurrent
 * redemption creates nothing.
 */
export async function redeemReviewHandoff(
  db: Db,
  input: { code: string; artifactId: string; kind: ReviewKind; now: number },
): Promise<Result<RedeemedReview>> {
  const codeHash = await hashSecret(input.code);
  const sessionId = randomToken();
  const expiresAt = input.now + reviewSessionTtlMs(input.kind);
  const handoff = schema.reviewHandoffs;

  const [claimed] = await db.batch([
    db
      .update(handoff)
      .set({ usedAt: input.now, sessionId })
      .where(
        and(
          eq(handoff.codeHash, codeHash),
          eq(handoff.artifactId, input.artifactId),
          eq(handoff.kind, input.kind),
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
  return ok({ ...row, sessionId, expiresAt, sessionTag: await reviewSessionTag(input.code) });
}

/**
 * Renews a review session's claims: the session must exist for this artifact and be unexpired,
 * the app session it came from must still be live, and the account must still pass the
 * artifact's current access policy.
 */
export async function refreshReviewSession(
  db: RegionalDb,
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

/**
 * Ends a review session at once, for the review tab's "End review". Idempotent: ending a session
 * that is already gone (or another artifact's) changes nothing.
 */
export async function endReviewSession(
  db: Db,
  input: { sessionId: string; artifactId: string },
): Promise<{ ended: boolean }> {
  const sessions = schema.reviewSessions;
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.artifactId, input.artifactId)))
    .returning({ id: sessions.id });
  return { ended: deleted.length > 0 };
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
