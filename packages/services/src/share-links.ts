// Share links (premium plan P4, decision 0008): the owner's side (create, list, revoke) and the
// visitor's (open a link on the app, redeem its one-use code on the artifact origin, renew the
// link session's claims). A link grants reading one artifact and nothing else; it never names
// a visitor, never touches the access policy and does not bump the policy generation.
import { type AuditDetail, SHARE_LINKS } from "@portifact/contracts";
import { type Db, type RegionalDb, schema } from "@portifact/db";
import {
  checkShareExpiry,
  devHost,
  type Entitlements,
  effectiveState,
  entitlements,
  fail,
  hasFeature,
  ok,
  type Result,
  SHARE_MESSAGES,
  shareLinkOpens,
  shareLinkStatus,
  shareSessionExpiry,
  shareUsedDay,
} from "@portifact/domain";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { authorizeOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { activeCustomHost } from "./custom-domains.ts";
import { ownerEntitlements, requireOwnerFeature } from "./plans.ts";
import { hashSecret, randomToken } from "./read-access.ts";

const SECOND_MS = 1000;
const DAY_MS = 86_400_000;
/** Rows each prune deletes per run, like the other maintenance jobs. */
const PRUNE_BATCH = 500;

const missing = () => fail<never>("not_found", "Artifact not found.");
const linkMissing = () => fail<never>("not_found", "Share link not found.");

export interface ShareLinkRow {
  id: string;
  label: string;
  hasPassword: boolean;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  state: "active" | "expired";
}

/** `sl_` and 32 hex characters from the platform's CSPRNG. */
function newLinkId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `sl_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

const encoder = new TextEncoder();

/** PBKDF2-HMAC-SHA-256 of a password, 256 bits, through WebCrypto. */
async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256),
  );
}

/** Compares two byte strings in time that depends only on their lengths. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

/** Hashes a link password with a fresh salt. */
export async function hashSharePassword(
  password: string,
  iterations: number = SHARE_LINKS.passwordIterations,
): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SHARE_LINKS.passwordSaltBytes));
  return {
    hash: toBase64(await derive(password, salt, iterations)),
    salt: toBase64(salt),
    iterations,
  };
}

/** A fixed salt and hash for links that do not exist, so a missing link costs one derivation too. */
const DUMMY: PasswordHash = {
  hash: toBase64(new Uint8Array(32)),
  salt: toBase64(new Uint8Array(SHARE_LINKS.passwordSaltBytes)),
  iterations: SHARE_LINKS.passwordIterations,
};

/**
 * Whether `password` matches `stored`. Without a stored hash it derives against a fixed dummy and
 * answers false, so every attempt does the same work whether or not the link has a password.
 */
export async function verifySharePassword(
  password: string,
  stored: PasswordHash | null,
): Promise<boolean> {
  const against = stored ?? DUMMY;
  const derived = await derive(password, fromBase64(against.salt), against.iterations);
  return constantTimeEqual(derived, fromBase64(against.hash)) && stored !== null;
}

function view(row: typeof schema.shareLinks.$inferSelect, now: number): ShareLinkRow {
  return {
    id: row.id,
    label: row.label,
    hasPassword: row.passwordHash !== null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    state: shareLinkStatus(row, now) === "expired" ? "expired" : "active",
  };
}

/** The artifact, and the actor managing its sharing: an admin or editor of its owner. */
async function loadManaged(db: RegionalDb, userId: string, artifactId: string) {
  const [artifact] = await db
    .select({
      id: schema.artifacts.id,
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifact || artifact.state === "deleted" || artifact.state === "purging") return missing();
  const actor = await authorizeOn(db, userId, artifact.ownerId, "access", missing);
  if (!actor.ok) return actor;
  return ok(artifact);
}

/**
 * The artifact still belongs to the owner the request was authorized on; a transfer in between
 * makes the write a no-op.
 */
function stillOwned(artifact: { id: string; ownerId: string }): SQL {
  const a = schema.artifacts;
  return sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.ownerId} = ${artifact.ownerId})`;
}

/** Active links of an artifact: neither revoked nor expired at `now`. */
function activeLinks(artifactId: string, now: number) {
  const l = schema.shareLinks;
  return sql`(select count(*) from ${l} where ${l.artifactId} = ${artifactId} and ${l.revokedAt} is null and (${l.expiresAt} is null or ${l.expiresAt} > ${now}))`;
}

/** The audit event of a share link change, in its batch on `condition`. */
function shareLinkEvent<K extends "share_link.created" | "share_link.revoked">(
  db: Db,
  kind: K,
  input: {
    ownerId: string;
    artifactId: string;
    linkId: string;
    userId: string;
    detail: AuditDetail<K>;
    now: number;
    condition: SQL;
  },
) {
  return auditEvent(
    db,
    {
      ownerId: input.ownerId,
      kind,
      actor: { type: "user", id: input.userId },
      targetId: input.linkId,
      artifactId: input.artifactId,
      detail: input.detail,
      now: input.now,
    },
    input.condition,
  );
}

export interface CreateShareLinkInput {
  userId: string;
  artifactId: string;
  label: string;
  expiresAt: number | null;
  password?: string | undefined;
  now: number;
}

/**
 * Creates a link for an admin or editor of the artifact's owner, when the owner's plan includes
 * share links. Returns the token once; only its hash is stored. The insert itself refuses a
 * 21st active link, so concurrent creates cannot pass the cap.
 */
export async function createShareLink(
  db: RegionalDb,
  input: CreateShareLinkInput,
): Promise<Result<{ link: ShareLinkRow; token: string }>> {
  const artifact = await loadManaged(db, input.userId, input.artifactId);
  if (!artifact.ok) return artifact;
  const gate = await requireOwnerFeature(db, artifact.value, "shareLinks", input.now);
  if (!gate.ok) return gate;
  const expiry = checkShareExpiry(input.expiresAt, input.now);
  if (!expiry.ok) return expiry;

  const token = randomToken();
  const id = newLinkId();
  const password = input.password === undefined ? null : await hashSharePassword(input.password);
  const l = schema.shareLinks;
  const [inserted] = await db.batch([
    db
      .insert(l)
      .select(
        sql`select ${id}, ${input.artifactId}, ${await hashSecret(token)}, ${input.label}, ${expiry.value}, ${password?.hash ?? null}, ${password?.salt ?? null}, ${password?.iterations ?? null}, ${input.userId}, ${input.now}, null, null where ${activeLinks(input.artifactId, input.now)} < ${SHARE_LINKS.activePerArtifact} and ${stillOwned(artifact.value)}`,
      )
      .returning(),
    // After the insert, on the link it created: the ID is new to this request.
    shareLinkEvent(db, "share_link.created", {
      ownerId: artifact.value.ownerId,
      artifactId: input.artifactId,
      linkId: id,
      userId: input.userId,
      detail: { password: password !== null, expires: expiry.value !== null },
      now: input.now,
      condition: sql`exists (select 1 from ${l} where ${l.id} = ${id})`,
    }),
  ]);
  const row = inserted[0];
  if (!row) {
    const [now] = await db
      .select({ ownerId: schema.artifacts.ownerId })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, input.artifactId))
      .limit(1);
    if (now?.ownerId !== artifact.value.ownerId) {
      return fail("version_conflict", "The artifact moved meanwhile. Try again.");
    }
    return fail(
      "quota_exceeded",
      `An artifact can have at most ${SHARE_LINKS.activePerArtifact} active share links. Revoke one first.`,
    );
  }
  return ok({ link: view(row, input.now), token });
}

export interface ShareLinkListing {
  artifactId: string;
  /** Whether the owner's plan includes share links now; without it, links do not open. */
  enabled: boolean;
  links: ShareLinkRow[];
}

/**
 * The artifact's links that are not revoked, newest first, never with a token. Listing is never
 * behind the plan: an owner whose plan lapsed still sees and revokes their links.
 */
export async function listShareLinks(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
): Promise<Result<ShareLinkListing>> {
  const artifact = await loadManaged(db, input.userId, input.artifactId);
  if (!artifact.ok) return artifact;
  const rows = await db
    .select()
    .from(schema.shareLinks)
    .where(
      and(eq(schema.shareLinks.artifactId, input.artifactId), isNull(schema.shareLinks.revokedAt)),
    )
    .orderBy(desc(schema.shareLinks.createdAt), desc(schema.shareLinks.id));
  const [plan] = await db
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
    })
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, artifact.value.ownerId))
    .limit(1);
  return ok({
    artifactId: input.artifactId,
    enabled: hasFeature(entitlements(plan ?? null, input.now), "shareLinks"),
    links: rows.map((row) => view(row, input.now)),
  });
}

/**
 * Revokes a link and ends its sessions in one batch. Open link sessions stop at their next
 * renewal, within 60 seconds. Never behind the plan. A revoked or unknown link answers
 * `not_found`.
 */
export async function revokeShareLink(
  db: RegionalDb,
  input: { userId: string; artifactId: string; linkId: string; now: number },
): Promise<Result<{ id: string }>> {
  const artifact = await loadManaged(db, input.userId, input.artifactId);
  if (!artifact.ok) return artifact;
  const l = schema.shareLinks;
  const owned = stillOwned(artifact.value);
  const live = and(
    eq(l.id, input.linkId),
    eq(l.artifactId, input.artifactId),
    isNull(l.revokedAt),
    owned,
  );
  // Sessions of an already revoked link ended with it, so deleting them again changes nothing.
  const [, , revoked] = await db.batch([
    // Before the revocation, on the link still being live.
    shareLinkEvent(db, "share_link.revoked", {
      ownerId: artifact.value.ownerId,
      artifactId: input.artifactId,
      linkId: input.linkId,
      userId: input.userId,
      detail: {},
      now: input.now,
      condition: sql`exists (select 1 from ${l} where ${live})`,
    }),
    db
      .delete(schema.shareSessions)
      .where(
        and(
          eq(schema.shareSessions.linkId, input.linkId),
          eq(schema.shareSessions.artifactId, input.artifactId),
          owned,
        ),
      ),
    db.update(l).set({ revokedAt: input.now }).where(live).returning({ id: l.id }),
  ]);
  if (revoked.length === 0) return linkMissing();
  return ok({ id: input.linkId });
}

export type ShareOpenOutcome =
  /** The link opened: the code goes to the artifact origin's `/__portifact/link`. */
  | { kind: "opened"; artifactId: string; code: string; host: string }
  /** A live link that needs a password, asked without one. */
  | { kind: "password_required" }
  /** No password was sent and the link does not open (unknown, expired, revoked or paused). */
  | { kind: "unavailable" }
  /** A password was sent and it is wrong, or the link does not open: the same answer. */
  | { kind: "refused" };

/**
 * Opens a link for a visitor. The token cannot name its region, so its hash is looked up in each
 * region's database (`regions`; one read with one region), then the owner's plan in the global
 * database. When a password was sent, exactly one PBKDF2 derivation runs whatever the link (a
 * dummy when it is missing or has none). On success it stores a one-use handoff code in the
 * region that holds the link, where the artifact origin redeems it, and records the day the link
 * was used, in one batch.
 */
export async function openShareLink(
  regions: readonly RegionalDb[],
  input: {
    token: string;
    password?: string | undefined;
    now: number;
    /** The deployment's content domain, for the artifact's `.dev` host. */
    contentDomain: string;
    /** Whether this Worker serves custom hosts (`customDomainsServing`). */
    customDomains: boolean;
  },
): Promise<ShareOpenOutcome> {
  const l = schema.shareLinks;
  const a = schema.artifacts;
  const tokenHash = await hashSecret(input.token);
  let db: RegionalDb | undefined;
  let found:
    | {
        id: string;
        artifactId: string;
        ownerId: string;
        expiresAt: number | null;
        revokedAt: number | null;
        passwordHash: string | null;
        passwordSalt: string | null;
        passwordIterations: number | null;
        state: (typeof schema.artifacts.$inferSelect)["state"];
        currentVersionId: string | null;
        artifactExpiresAt: number | null;
        archivedAt: number | null;
      }
    | undefined;
  for (const region of regions) {
    [found] = await region
      .select({
        id: l.id,
        artifactId: l.artifactId,
        ownerId: a.ownerId,
        expiresAt: l.expiresAt,
        revokedAt: l.revokedAt,
        passwordHash: l.passwordHash,
        passwordSalt: l.passwordSalt,
        passwordIterations: l.passwordIterations,
        state: a.state,
        currentVersionId: a.currentVersionId,
        artifactExpiresAt: a.expiresAt,
        archivedAt: a.archivedAt,
      })
      .from(l)
      .innerJoin(a, eq(a.id, l.artifactId))
      .where(eq(l.tokenHash, tokenHash))
      .limit(1);
    if (found) {
      db = region;
      break;
    }
  }
  const owner =
    found && db ? await ownerEntitlements(db.global, found.ownerId, input.now) : undefined;

  const stored =
    found?.passwordHash && found.passwordSalt && found.passwordIterations
      ? { hash: found.passwordHash, salt: found.passwordSalt, iterations: found.passwordIterations }
      : null;
  const passwordOk =
    input.password === undefined ? null : await verifySharePassword(input.password, stored);
  const opens =
    found !== undefined &&
    shareLinkOpens(
      {
        link: found,
        servable:
          found.currentVersionId !== null &&
          effectiveState(
            {
              state: found.state,
              expiresAt:
                found.artifactExpiresAt === null ? null : new Date(found.artifactExpiresAt),
              archivedAt: found.archivedAt === null ? null : new Date(found.archivedAt),
            },
            new Date(input.now),
          ) === "active",
        owner: owner as Entitlements,
      },
      input.now,
    );

  if (input.password !== undefined) {
    // A link without a password opens with any password; one with a password needs the right one.
    if (!found || !opens || (stored !== null && !passwordOk)) return { kind: "refused" };
  } else {
    if (!found || !opens) return { kind: "unavailable" };
    if (stored !== null) return { kind: "password_required" };
  }

  const code = randomToken();
  const target = db as RegionalDb;
  // The link opens the artifact on its active custom host when it has one, from the tables; the
  // code works only on the host it is sent to.
  const host =
    (await activeCustomHost(target, found.artifactId, input.customDomains)) ??
    devHost(found.artifactId, input.contentDomain);
  await target.batch([
    target.insert(schema.shareHandoffs).values({
      codeHash: await hashSecret(code),
      linkId: found.id,
      artifactId: found.artifactId,
      expiresAt: input.now + SHARE_LINKS.handoffTtlSeconds * SECOND_MS,
      createdAt: input.now,
      host,
    }),
    target
      .update(l)
      .set({ lastUsedAt: shareUsedDay(input.now) })
      .where(eq(l.id, found.id)),
  ]);
  return { kind: "opened", artifactId: found.artifactId, code, host };
}

/** A link's condition for SQL: not revoked and not expired at `now`. */
function liveLink(now: number) {
  const l = schema.shareLinks;
  return and(isNull(l.revokedAt), or(isNull(l.expiresAt), gt(l.expiresAt, now)));
}

export interface ShareSessionGrant {
  sessionId: string;
  linkId: string;
  /** End of the link session, in milliseconds. */
  expiresAt: number;
}

/**
 * Redeems a handoff code on the artifact origin it was issued for. One guarded update marks the
 * code used while it is unexpired and its link still live; the session row is inserted only if
 * that update happened, so a replayed, expired or cross-artifact code creates nothing.
 */
export async function redeemShareHandoff(
  db: Db,
  input: {
    code: string;
    artifactId: string;
    /** The host the request came on, and the artifact's `.dev` host (codes without a host). */
    host: string;
    devHost: string;
    now: number;
  },
): Promise<Result<ShareSessionGrant>> {
  const expired = fail<never>("invalid_input", "This link has expired or was already used.");
  const codeHash = await hashSecret(input.code);
  const sessionId = randomToken();
  const longest = input.now + SHARE_LINKS.sessionTtlSeconds * SECOND_MS;
  const h = schema.shareHandoffs;
  const l = schema.shareLinks;
  const [claimed, sessions] = await db.batch([
    db
      .update(h)
      .set({ usedAt: input.now, sessionId })
      .where(
        and(
          eq(h.codeHash, codeHash),
          eq(h.artifactId, input.artifactId),
          sql`coalesce(${h.host}, ${input.devHost}) = ${input.host}`,
          isNull(h.usedAt),
          gt(h.expiresAt, input.now),
          sql`exists (select 1 from ${l} where ${l.id} = ${h.linkId} and ${liveLink(input.now)})`,
        ),
      )
      .returning({ linkId: h.linkId }),
    db
      .insert(schema.shareSessions)
      .select(
        sql`select ${sessionId}, ${h.linkId}, ${h.artifactId}, min(${longest}, coalesce(${l.expiresAt}, ${longest})), ${input.now} from ${h} inner join ${l} on ${l.id} = ${h.linkId} where ${h.codeHash} = ${codeHash} and ${h.sessionId} = ${sessionId}`,
      )
      .returning({ expiresAt: schema.shareSessions.expiresAt }),
  ]);
  const row = claimed[0];
  const session = sessions[0];
  if (!row || !session) return expired;
  return ok({ sessionId, linkId: row.linkId, expiresAt: session.expiresAt });
}

/**
 * Renews a link session's claims: the session must exist for this artifact and link and be
 * unexpired, and the link must still be live. Servability and the owner's plan are checked by the
 * content Worker on every request, from its artifact lookup.
 */
export async function refreshShareSession(
  db: Db,
  input: { sessionId: string; artifactId: string; linkId: string; now: number },
): Promise<Result<{ expiresAt: number }>> {
  const s = schema.shareSessions;
  const l = schema.shareLinks;
  const [session] = await db
    .select({ expiresAt: s.expiresAt })
    .from(s)
    .innerJoin(l, eq(l.id, s.linkId))
    .where(
      and(
        eq(s.id, input.sessionId),
        eq(s.artifactId, input.artifactId),
        eq(s.linkId, input.linkId),
        gt(s.expiresAt, input.now),
        liveLink(input.now),
      ),
    )
    .limit(1);
  if (!session) return fail("not_found", SHARE_MESSAGES.unavailable);
  return ok({ expiresAt: session.expiresAt });
}

/** Labels of links, for the access log; links already pruned are missing. */
export async function shareLinkLabels(
  db: Db,
  artifactId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 80) {
    const rows = await db
      .select({ id: schema.shareLinks.id, label: schema.shareLinks.label })
      .from(schema.shareLinks)
      .where(
        and(
          eq(schema.shareLinks.artifactId, artifactId),
          inArray(schema.shareLinks.id, ids.slice(i, i + 80)),
        ),
      );
    for (const row of rows) labels.set(row.id, row.label);
  }
  return labels;
}

/**
 * Maintenance: deletes up to `limit` expired handoffs and link sessions, and links revoked or
 * expired more than 30 days ago (the access log's retention, so no entry still names them). A
 * revoked link gets its `share_link` tombstone first, so a restore can never revive it once its
 * row is gone. Idempotent; the next run picks up the rest.
 */
export async function pruneShareLinks(
  db: RegionalDb,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ processed: number }> {
  const h = schema.shareHandoffs;
  const s = schema.shareSessions;
  const l = schema.shareLinks;
  const cutoff = now - 30 * DAY_MS;
  const old = await db
    .select({ id: l.id, revokedAt: l.revokedAt })
    .from(l)
    .where(
      or(
        and(isNotNull(l.revokedAt), lte(l.revokedAt, cutoff)),
        and(isNull(l.revokedAt), isNotNull(l.expiresAt), lte(l.expiresAt, cutoff)),
      ),
    )
    .limit(limit);
  const revoked = old.flatMap((row) =>
    row.revokedAt === null
      ? []
      : [{ kind: "share_link" as const, id: row.id, deletedAt: row.revokedAt }],
  );
  for (let i = 0; i < revoked.length; i += 25) {
    await db.global
      .insert(schema.tombstones)
      .values(revoked.slice(i, i + 25))
      .onConflictDoNothing();
  }
  const [handoffs, sessions] = await db.batch([
    db
      .delete(h)
      .where(
        inArray(
          h.codeHash,
          db.select({ id: h.codeHash }).from(h).where(lte(h.expiresAt, now)).limit(limit),
        ),
      )
      .returning({ id: h.codeHash }),
    db
      .delete(s)
      .where(
        inArray(s.id, db.select({ id: s.id }).from(s).where(lte(s.expiresAt, now)).limit(limit)),
      )
      .returning({ id: s.id }),
  ]);
  const links =
    old.length === 0
      ? []
      : await db
          .delete(l)
          .where(
            inArray(
              l.id,
              old.map((row) => row.id),
            ),
          )
          .returning({ id: l.id });
  return { processed: handoffs.length + sessions.length + links.length };
}

/** Every revoked link still in the database, as tombstone markers (`exportTombstones`). */
export async function revokedShareLinks(db: Db) {
  const rows = await db
    .select({ id: schema.shareLinks.id, revokedAt: schema.shareLinks.revokedAt })
    .from(schema.shareLinks)
    .where(isNotNull(schema.shareLinks.revokedAt));
  return rows.map((row) => ({
    kind: "share_link" as const,
    id: row.id,
    deletedAt: row.revokedAt as number,
  }));
}
