// Entry to protected artifacts (plan section 4, "Entrada a un artifact protegido"). The app
// issues a one-use handoff after checking access; the artifact origin redeems it into a read
// session and later renews the session's claims through the same access check. A missing
// artifact and a forbidden one give the same answer.
import { READ_SESSION } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { canRead, effectiveState, fail, ok, type Result } from "@portifact/domain";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

const SECOND_MS = 1000;

export interface ReadGrant {
  userId: string;
  policyGeneration: number;
}

export interface ReadSessionGrant extends ReadGrant {
  sessionId: string;
  /** End of the read session, in milliseconds. Claims are renewed until then. */
  expiresAt: number;
}

const unavailable = () =>
  fail<never>("not_found", "This artifact does not exist or your account cannot open it.");

/** SHA-256 of a code or nonce, in hex. Only hashes of one-use secrets are stored. */
export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes in unpadded base64url, the shape of `OpaqueToken`. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Whether `userId` may read the artifact now: it must be servable (active, not expired, with a
 * current version) and the access policy must admit the account and its verified email.
 */
export async function checkReadAccess(
  db: Db,
  input: { artifactId: string; userId: string; now: number },
): Promise<Result<ReadGrant>> {
  const [artifact] = await db
    .select({
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
      accessMode: schema.artifacts.accessMode,
      policyGeneration: schema.artifacts.policyGeneration,
      currentVersionId: schema.artifacts.currentVersionId,
      expiresAt: schema.artifacts.expiresAt,
      archivedAt: schema.artifacts.archivedAt,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact?.currentVersionId) return unavailable();
  const state = effectiveState(
    {
      state: artifact.state,
      expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
      archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
    },
    new Date(input.now),
  );
  if (state !== "active") return unavailable();

  const [user] = await db
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  if (!user) return unavailable();

  const readers =
    artifact.accessMode === "restricted"
      ? (
          await db
            .select({ email: schema.artifactReaders.email })
            .from(schema.artifactReaders)
            .where(eq(schema.artifactReaders.artifactId, input.artifactId))
        ).map((row) => row.email)
      : [];
  const decision = canRead(
    { mode: artifact.accessMode, ownerId: artifact.ownerId, readers },
    {
      userId: input.userId,
      verifiedEmails: user.emailVerified ? [user.email.toLowerCase()] : [],
    },
  );
  if (!decision.ok) return unavailable();
  return ok({ userId: input.userId, policyGeneration: artifact.policyGeneration });
}

/**
 * Checks access and stores a one-use code bound to the artifact, the user, the policy
 * generation and the artifact origin's transaction nonce (`state`). Returns the code, which is
 * shown once and stored only as a hash.
 */
export async function issueReadHandoff(
  db: Db,
  input: { artifactId: string; userId: string; state: string; now: number },
): Promise<Result<{ code: string; expiresAt: number }>> {
  const access = await checkReadAccess(db, input);
  if (!access.ok) return access;
  const code = randomToken();
  const expiresAt = input.now + READ_SESSION.handoffTtlSeconds * SECOND_MS;
  await db.insert(schema.readHandoffs).values({
    codeHash: await hashSecret(code),
    artifactId: input.artifactId,
    userId: input.userId,
    stateHash: await hashSecret(input.state),
    policyGeneration: access.value.policyGeneration,
    expiresAt,
    createdAt: input.now,
  });
  return ok({ code, expiresAt });
}

/**
 * Redeems a handoff code on the artifact origin it was issued for, with the nonce of that
 * browser's transaction. The guarded update marks the code used and names the new session;
 * the session row is inserted only if that update happened, so a replayed or concurrent
 * redemption creates nothing.
 */
export async function redeemReadHandoff(
  db: Db,
  input: { code: string; artifactId: string; state: string; now: number },
): Promise<Result<ReadSessionGrant>> {
  const codeHash = await hashSecret(input.code);
  const stateHash = await hashSecret(input.state);
  const sessionId = randomToken();
  const expiresAt = input.now + READ_SESSION.sessionTtlSeconds * SECOND_MS;
  const handoff = schema.readHandoffs;

  const [claimed] = await db.batch([
    db
      .update(handoff)
      .set({ usedAt: input.now, sessionId })
      .where(
        and(
          eq(handoff.codeHash, codeHash),
          eq(handoff.artifactId, input.artifactId),
          eq(handoff.stateHash, stateHash),
          isNull(handoff.usedAt),
          gt(handoff.expiresAt, input.now),
        ),
      )
      .returning({ userId: handoff.userId, policyGeneration: handoff.policyGeneration }),
    db.insert(schema.readSessions).select(
      db
        .select({
          id: sql<string>`${sessionId}`.as("id"),
          artifactId: handoff.artifactId,
          userId: handoff.userId,
          expiresAt: sql<number>`${expiresAt}`.as("expires_at"),
          createdAt: sql<number>`${input.now}`.as("created_at"),
        })
        .from(handoff)
        .where(and(eq(handoff.codeHash, codeHash), eq(handoff.sessionId, sessionId))),
    ),
  ]);
  const row = claimed[0];
  if (!row) {
    return fail("invalid_input", "This sign-in link has expired or was already used.");
  }
  return ok({ sessionId, expiresAt, ...row });
}

/**
 * Renews a read session's claims: the session must exist for this artifact and be unexpired,
 * and the account must still pass the current access policy.
 */
export async function refreshReadSession(
  db: Db,
  input: { sessionId: string; artifactId: string; now: number },
): Promise<Result<ReadSessionGrant>> {
  const [session] = await db
    .select({ userId: schema.readSessions.userId, expiresAt: schema.readSessions.expiresAt })
    .from(schema.readSessions)
    .where(
      and(
        eq(schema.readSessions.id, input.sessionId),
        eq(schema.readSessions.artifactId, input.artifactId),
        gt(schema.readSessions.expiresAt, input.now),
      ),
    )
    .limit(1);
  if (!session) return unavailable();
  const access = await checkReadAccess(db, { ...input, userId: session.userId });
  if (!access.ok) return access;
  return ok({ ...access.value, sessionId: input.sessionId, expiresAt: session.expiresAt });
}

/** Deletes expired handoffs and read sessions. Idempotent; called by the maintenance job. */
export async function pruneReadSessions(db: Db, now: number): Promise<{ processed: number }> {
  const [handoffs, sessions] = await db.batch([
    db
      .delete(schema.readHandoffs)
      .where(sql`${schema.readHandoffs.expiresAt} <= ${now}`)
      .returning({ id: schema.readHandoffs.codeHash }),
    db
      .delete(schema.readSessions)
      .where(sql`${schema.readSessions.expiresAt} <= ${now}`)
      .returning({ id: schema.readSessions.id }),
  ]);
  return { processed: handoffs.length + sessions.length };
}
