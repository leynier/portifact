// Entry to protected artifacts (plan section 4, "Entrada a un artifact protegido"). The app
// issues a one-use handoff after checking access; the artifact origin redeems it into a read
// session and later renews the session's claims through the same access check. A missing
// artifact and a forbidden one give the same answer.
import { type AccessMode, READ_SESSION } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  canRead,
  customHostWithoutClick,
  devHost,
  effectiveState,
  entitlements,
  fail,
  handoffHost,
  ok,
  type Result,
} from "@portifact/domain";
import { and, eq, exists, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { actorOn } from "./actors.ts";
import { activeCustomHost } from "./custom-domains.ts";
import { policyDomains } from "./workspace-domains.ts";
import { artifactGroupRows, viewerGroups } from "./workspace-groups.ts";

const SECOND_MS = 1000;
/** Rows each prune deletes per run, like the other maintenance jobs. */
const PRUNE_BATCH = 500;

export interface ReadGrant {
  userId: string;
  policyGeneration: number;
  accessMode: AccessMode;
}

export interface ReadSessionGrant {
  userId: string;
  policyGeneration: number;
  sessionId: string;
  /** End of the read session, in milliseconds. Claims are renewed until then. */
  expiresAt: number;
}

/** A new read session, with the transaction nonce its code was issued for. */
export interface RedeemedReadSession extends ReadSessionGrant {
  state: string;
}

/**
 * Whether the app.portifact.com session behind a code or read session still exists and has not
 * expired. Signing out, signing out everywhere and revoking a session all delete the row.
 */
export function liveAppSession(db: Db, authSessionId: SQLiteColumn, now: number) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(schema.sessions)
      .where(
        and(eq(schema.sessions.id, authSessionId), gt(schema.sessions.expiresAt, new Date(now))),
      ),
  );
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
 * current version) and the access policy must admit the account, its verified email or its role
 * on the owner (an admin or editor of a workspace reads every artifact of it; any member reads a
 * `workspace` or `domain` one, and a verified address at a verified domain a `domain` one while
 * the owner's plan includes `workspaces`, decision 0010; a member in a group a `restricted` one
 * lists, while the plan includes it, decision 0014). Read sessions renew through this every 60
 * seconds, so a removed member, domain or group membership stops reading within that time.
 */
export async function checkReadAccess(
  db: RegionalDb,
  input: { artifactId: string; userId: string; now: number },
): Promise<Result<ReadGrant>> {
  const p = schema.ownerPlans;
  const [artifact] = await db
    .select({
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
      accessMode: schema.artifacts.accessMode,
      policyGeneration: schema.artifacts.policyGeneration,
      currentVersionId: schema.artifacts.currentVersionId,
      expiresAt: schema.artifacts.expiresAt,
      archivedAt: schema.artifacts.archivedAt,
      // The owner's plan comes with the artifact: the `domain` mode depends on it.
      plan: { plan: p.plan, seats: p.seats, validUntil: p.validUntil, overrides: p.overrides },
    })
    .from(schema.artifacts)
    .leftJoin(p, eq(p.ownerId, schema.artifacts.ownerId))
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

  const [user] = await db.global
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
  const verifiedEmails = user.emailVerified ? [user.email.toLowerCase()] : [];
  const actor = await actorOn(db.global, input.userId, artifact.ownerId);
  const domains = await policyDomains(db.global, {
    mode: artifact.accessMode,
    ownerId: artifact.ownerId,
    actor,
    verifiedEmails,
    entitlements: entitlements(artifact.plan, input.now),
  });
  const viewer = { userId: input.userId, verifiedEmails };
  const policy = { mode: artifact.accessMode, ownerId: artifact.ownerId, readers, domains };
  let decision = canRead(policy, viewer, actor);
  // Groups are asked only when nothing else admitted a member of a `restricted` artifact's
  // workspace: one regional read of the listed groups and, when there are any, one global read
  // of the viewer's memberships among them (decision 0014).
  if (!decision.ok && artifact.accessMode === "restricted" && actor?.ownerId === artifact.ownerId) {
    const groups = await viewerGroups(db.global, {
      ownerId: artifact.ownerId,
      actor,
      listed: await artifactGroupRows(db, input.artifactId),
      entitlements: entitlements(artifact.plan, input.now),
    });
    decision = canRead({ ...policy, groups }, viewer, actor);
  }
  if (!decision.ok) return unavailable();
  return ok({
    userId: input.userId,
    policyGeneration: artifact.policyGeneration,
    accessMode: artifact.accessMode,
  });
}

/**
 * Checks access and stores a one-use code bound to the artifact, the user, the app session
 * (`authSessionId`, Better Auth's session ID), the policy generation and the artifact origin's
 * transaction nonce (`state`). Returns the code, which is shown once and stored only as a hash.
 */
interface ReadEntryInput {
  artifactId: string;
  userId: string;
  now: number;
  /** The custom host the visitor started on, or null for the `.dev` host. Untrusted input. */
  requestedHost: string | null;
  contentDomain: string;
  /** Whether this Worker serves custom hosts (`customDomainsServing`). */
  customDomains: boolean;
}

/**
 * Where the read entry sends the code: the `.dev` host, or the active custom host when exactly
 * that host was asked for. Only after the access check, and only the artifact's own hosts: a
 * requested host that is not its active custom host (or any while custom domains are off) answers
 * exactly like an artifact the visitor cannot open. `confirm` says the visitor must confirm on
 * the app first (`customHostWithoutClick`).
 */
async function readEntryTarget(
  db: RegionalDb,
  input: ReadEntryInput,
): Promise<Result<{ host: string; confirm: boolean; grant: ReadGrant }>> {
  const access = await checkReadAccess(db, input);
  if (!access.ok) return access;
  const host = handoffHost({
    artifactId: input.artifactId,
    contentDomain: input.contentDomain,
    requested: input.requestedHost,
    activeHost:
      input.requestedHost === null
        ? null
        : await activeCustomHost(db, input.artifactId, input.customDomains),
  });
  if (host === null) return unavailable();
  const confirm = input.requestedHost !== null && !customHostWithoutClick(access.value.accessMode);
  return ok({ host, confirm, grant: access.value });
}

/**
 * The custom host a visitor must confirm before the read entry sends their code there, or null
 * when the entry may go on at once (or will refuse anyway). Reads nothing for a `.dev` entry.
 */
export async function readEntryConfirmation(
  db: RegionalDb,
  input: ReadEntryInput,
): Promise<string | null> {
  if (input.requestedHost === null) return null;
  const target = await readEntryTarget(db, input);
  return target.ok && target.value.confirm ? target.value.host : null;
}

export async function issueReadHandoff(
  db: RegionalDb,
  input: ReadEntryInput & {
    authSessionId: string;
    state: string;
    /** The visitor confirmed on the app (a same-origin POST), as `readEntryConfirmation` asks. */
    confirmed: boolean;
  },
): Promise<Result<{ code: string; expiresAt: number; host: string }>> {
  const target = await readEntryTarget(db, input);
  if (!target.ok) return target;
  if (target.value.confirm && !input.confirmed) return unavailable();
  const { host, grant } = target.value;
  const code = randomToken();
  const expiresAt = input.now + READ_SESSION.handoffTtlSeconds * SECOND_MS;
  await db.insert(schema.readHandoffs).values({
    codeHash: await hashSecret(code),
    artifactId: input.artifactId,
    userId: input.userId,
    stateHash: await hashSecret(input.state),
    authSessionId: input.authSessionId,
    policyGeneration: grant.policyGeneration,
    expiresAt,
    createdAt: input.now,
    host,
  });
  return ok({ code, expiresAt, host });
}

/**
 * Redeems a handoff code on the artifact origin it was issued for, with the nonces of that
 * browser's open transactions (`states`); the code matches at most one. The app session that
 * asked for the code must still be live. The guarded update marks the code used and names the
 * new session; the session row is inserted only if that update happened, so a replayed or
 * concurrent redemption creates nothing.
 */
export async function redeemReadHandoff(
  db: Db,
  input: {
    code: string;
    artifactId: string;
    states: readonly string[];
    /** The host the request came on, and the artifact's `.dev` host (codes without a host). */
    host: string;
    devHost: string;
    now: number;
  },
): Promise<Result<RedeemedReadSession>> {
  const expired = fail<never>(
    "invalid_input",
    "This sign-in link has expired or was already used.",
  );
  if (input.states.length === 0) return expired;
  const codeHash = await hashSecret(input.code);
  const stateHashes = new Map<string, string>();
  for (const state of input.states) stateHashes.set(await hashSecret(state), state);
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
          inArray(handoff.stateHash, [...stateHashes.keys()]),
          sql`coalesce(${handoff.host}, ${input.devHost}) = ${input.host}`,
          isNull(handoff.usedAt),
          gt(handoff.expiresAt, input.now),
          liveAppSession(db, handoff.authSessionId, input.now),
        ),
      )
      .returning({
        userId: handoff.userId,
        policyGeneration: handoff.policyGeneration,
        stateHash: handoff.stateHash,
      }),
    db.insert(schema.readSessions).select(
      db
        .select({
          id: sql<string>`${sessionId}`.as("id"),
          artifactId: handoff.artifactId,
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
  const state = row && stateHashes.get(row.stateHash);
  if (!row || state === undefined) return expired;
  return ok({
    sessionId,
    expiresAt,
    userId: row.userId,
    policyGeneration: row.policyGeneration,
    state,
  });
}

/**
 * Renews a read session's claims: the session must exist for this artifact and be unexpired,
 * the app session it came from must still be live (so signing out of the app ends it), and the
 * account must still pass the current access policy.
 */
export async function refreshReadSession(
  db: RegionalDb,
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
        liveAppSession(db, schema.readSessions.authSessionId, input.now),
      ),
    )
    .limit(1);
  if (!session) return unavailable();
  const access = await checkReadAccess(db, { ...input, userId: session.userId });
  if (!access.ok) return access;
  return ok({
    userId: access.value.userId,
    policyGeneration: access.value.policyGeneration,
    sessionId: input.sessionId,
    expiresAt: session.expiresAt,
  });
}

/**
 * Deletes up to `limit` expired handoffs and `limit` expired read sessions. Idempotent; called
 * by the maintenance job, which picks up the rest on its next runs.
 */
export async function pruneReadSessions(
  db: Db,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ processed: number }> {
  const handoff = schema.readHandoffs;
  const session = schema.readSessions;
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
