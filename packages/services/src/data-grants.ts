// Grants of artifact data (decision 0026, "The grant", delivery 6). A grant is one person's
// consent, in one browser, that an artifact's page may know them by an opaque per-artifact
// visitor ID and their display name and save what they enter. The app draws the control and
// issues a one-use code bound to the beginning browser's nonce and the artifact's host; the
// content Worker redeems it into a sealed cookie whose claims it renews here every 60 seconds.
// Revocation (the person, the viewer, sign-out, lost access) therefore applies within a minute.
import {
  DATA_GRANT,
  type DataGrantControl,
  type DataGrantView,
  isWorkspaceId,
  JournalEntry as JournalEntrySchema,
} from "@portifact/contracts";
import { bothSides, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  devHost,
  fail,
  handoffHost,
  needsTermsAcceptance,
  ok,
  type Result,
} from "@portifact/domain";
import { claimOutcome, journalKey } from "@portifact/domain/artifact-data";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { activeCustomHost } from "./custom-domains.ts";
import {
  appSessionSignIn,
  checkReadAccess,
  hashSecret,
  liveAppSession,
  randomToken,
  recordSessionRenewal,
} from "./read-access.ts";

const SECOND_MS = 1000;
const PRUNE_BATCH = 500;

const g = schema.dataGrants;
const c = schema.dataGrantCodes;

/** Whether this deployment serves artifact data to pages (decision 0026, "Switches"). */
export function artifactDataEnabled(env: { ARTIFACT_DATA_ENABLED?: string | undefined }): boolean {
  return env.ARTIFACT_DATA_ENABLED === "true";
}

const unavailable = () =>
  fail<never>("not_found", "This artifact does not exist or your account cannot open it.");

/** A new grant ID: `dg_` and 16 random bytes. */
function grantId(): string {
  return `dg_${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** A new visitor ID: `v_` and 18 random bytes, unrelated across artifacts. */
export function newVisitorId(): string {
  return `v_${base64Url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** SHA-256 of a nonce in unpadded base64url: what the artifact origin sends the app. */
export async function nonceDigest(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return base64Url(new Uint8Array(digest));
}

interface GrantTargetInput {
  artifactId: string;
  userId: string;
  /** The custom host the page runs on, or null for the `.dev` host. Untrusted input. */
  requestedHost: string | null;
  contentDomain: string;
  customDomains: boolean;
  now: number;
}

interface GrantTarget {
  host: string;
  artifactName: string;
  ownerId: string;
}

/**
 * Where a grant may go: an artifact the person can read now, that holds data (an `artifact_data`
 * row: the owner declared collections), on its `.dev` host or exactly its active custom host.
 * Anything else answers like a missing artifact.
 */
async function grantTarget(db: RegionalDb, input: GrantTargetInput): Promise<Result<GrantTarget>> {
  const access = await checkReadAccess(db, input);
  if (!access.ok) return unavailable();
  const [row] = await db
    .select({ name: schema.artifacts.name, ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .innerJoin(schema.artifactData, eq(schema.artifactData.artifactId, schema.artifacts.id))
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!row) return unavailable();
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
  return ok({ host, artifactName: row.name, ownerId: row.ownerId });
}

/**
 * What the consent control shows: the artifact's host and owner and the name the page will learn.
 * Reads only; the person decides after.
 */
export async function dataGrantControl(
  db: RegionalDb,
  input: GrantTargetInput,
): Promise<Result<DataGrantControl>> {
  const target = await grantTarget(db, input);
  if (!target.ok) return target;
  const { host, artifactName, ownerId } = target.value;
  const [[person], [ownerUser], [workspace]] = await db.global.batch([
    db.global
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1),
    db.global
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, ownerId))
      .limit(1),
    db.global
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ownerId))
      .limit(1),
  ]);
  if (!person) return unavailable();
  const workspaceOwner = isWorkspaceId(ownerId);
  return ok({
    artifactId: input.artifactId,
    artifactName,
    host,
    owner: {
      kind: workspaceOwner ? "workspace" : "user",
      name: (workspaceOwner ? workspace?.name : ownerUser?.name) ?? "",
    },
    displayName: person.name,
    grantDays: DATA_GRANT.grantTtlSeconds / 86_400,
  });
}

/**
 * Claims the person's visitor ID for the artifact in the author journal (decision 0026, "Author
 * erasure", step 1): a conditional put of a new entry; of two racing first grants one writes and
 * the other reads the winner's ID; a retired entry (the account is being deleted) refuses.
 */
export async function claimVisitorId(
  bucket: R2Bucket,
  userId: string,
  artifactId: string,
  now: number,
): Promise<Result<string>> {
  const key = journalKey(userId, artifactId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await bucket.get(key);
    if (found !== null) {
      const entry = JournalEntrySchema.safeParse(await found.json());
      if (!entry.success) return unavailable();
      const outcome = claimOutcome(entry.data, "");
      return outcome.ok ? ok(outcome.value) : unavailable();
    }
    const candidate = newVisitorId();
    const written = await bucket.put(
      key,
      JSON.stringify({ visitorId: candidate, firstGrantAt: now } satisfies JournalEntrySchema),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (written !== null) return ok(candidate);
  }
  throw new Error("journal entry kept changing while it was claimed");
}

export interface IssueGrantInput extends GrantTargetInput {
  /** Better Auth's session that asked: the grant ends with it. */
  authSessionId: string;
  /** SHA-256 (base64url) of the beginning browser's nonce. */
  nonceHash: string;
}

/**
 * The person allowed: checks the target again, limits codes per person and artifact, claims the
 * visitor ID in the journal (R2, before D1), then writes the grant and its one-use code in one
 * batch. The code is returned once and stored only as a hash.
 */
export async function issueDataGrantCode(
  db: RegionalDb,
  bucket: R2Bucket,
  input: IssueGrantInput,
): Promise<Result<{ code: string; host: string; expiresAt: number }>> {
  const target = await grantTarget(db, input);
  if (!target.ok) return target;
  const hits = await hitRateLimit(
    db.global.$client,
    `data_grant_code:${input.userId}:${input.artifactId}`,
    60 * SECOND_MS,
    input.now,
  );
  if (hits.count > DATA_GRANT.codesPerMinute) {
    return fail("rate_limited", "Too many requests. Try again in a minute.");
  }
  const visitor = await claimVisitorId(bucket, input.userId, input.artifactId, input.now);
  if (!visitor.ok) return visitor;
  const { host } = target.value;
  const id = grantId();
  const code = randomToken();
  const expiresAt = input.now + DATA_GRANT.codeTtlSeconds * SECOND_MS;
  await db.batch([
    db.insert(g).values({
      id,
      artifactId: input.artifactId,
      userId: input.userId,
      visitorId: visitor.value,
      authSessionId: input.authSessionId,
      host,
      expiresAt: input.now + DATA_GRANT.grantTtlSeconds * SECOND_MS,
      createdAt: input.now,
    }),
    db.insert(c).values({
      codeHash: await hashSecret(code),
      grantId: id,
      artifactId: input.artifactId,
      nonceHash: input.nonceHash,
      host,
      expiresAt,
      createdAt: input.now,
    }),
  ]);
  return ok({ code, host, expiresAt });
}

/** The person a grant names now, and whether the page may write as them. */
export interface LiveGrant {
  grantId: string;
  userId: string;
  visitorId: string;
  name: string;
  /** The account accepted the current terms: writes need it, reads and the person's own deletes and export do not. */
  write: boolean;
  /** End of the grant: never past its 30 days. */
  expiresAt: number;
}

/**
 * Redeems a code on the host it was issued for, with the nonce of the browser that began
 * (`nonceHash`): one guarded update marks it used, and the grant is marked redeemed only when that
 * update happened, so a replay or a concurrent redemption gets nothing. The app session that asked
 * must still be live, and the person must still read the artifact.
 */
export async function redeemDataGrantCode(
  db: RegionalDb,
  input: { code: string; artifactId: string; nonceHash: string | null; host: string; now: number },
): Promise<Result<LiveGrant>> {
  const refused = fail<never>("invalid_input", "This link has expired or was already used.");
  if (input.nonceHash === null) return refused;
  const codeHash = await hashSecret(input.code);
  const both = bothSides(db);
  const w = both ?? db;
  const [claimed] = await w.batch([
    w
      .update(c)
      .set({ usedAt: input.now })
      .where(
        and(
          eq(c.codeHash, codeHash),
          eq(c.artifactId, input.artifactId),
          eq(c.nonceHash, input.nonceHash),
          eq(c.host, input.host),
          isNull(c.usedAt),
          gt(c.expiresAt, input.now),
          sql`exists (select 1 from ${g} where ${g.id} = ${c.grantId} and ${g.revokedAt} is null and ${g.expiresAt} > ${input.now})`,
        ),
      )
      .returning({ grantId: c.grantId }),
    w
      .update(g)
      .set({ redeemedAt: input.now })
      .where(
        and(
          isNull(g.redeemedAt),
          sql`${g.id} in (select ${c.grantId} from ${c} where ${c.codeHash} = ${codeHash} and ${c.usedAt} = ${input.now})`,
        ),
      ),
  ]);
  const row = claimed[0];
  if (!row) return refused;
  const live = await renewDataGrant(db, {
    grantId: row.grantId,
    artifactId: input.artifactId,
    now: input.now,
  });
  return live.ok ? live : refused;
}

/**
 * Renews a grant's claims: the grant exists for this artifact, was redeemed, is neither revoked
 * nor expired, the app session that gave it is still live (signing out ends it), and the account
 * still reads the artifact. Read every 60 seconds by the content Worker; writes nothing.
 */
export async function renewDataGrant(
  db: RegionalDb,
  input: { grantId: string; artifactId: string; now: number },
): Promise<Result<LiveGrant>> {
  const both = bothSides(db);
  const [grant] = await (both ?? db)
    .select({
      userId: g.userId,
      visitorId: g.visitorId,
      authSessionId: g.authSessionId,
      expiresAt: g.expiresAt,
      // With one database the app session's sign-in comes with this read (decision 0021).
      signedInAt: both
        ? sql<
            number | null
          >`(select "s"."created_at" from "sessions" "s" where "s"."id" = "data_grants"."auth_session_id" and "s"."expires_at" > ${input.now})`
        : sql<null>`null`,
      method: both
        ? sql<
            string | null
          >`(select "s"."sign_in_method" from "sessions" "s" where "s"."id" = "data_grants"."auth_session_id" and "s"."expires_at" > ${input.now})`
        : sql<null>`null`,
    })
    .from(g)
    .where(
      and(
        eq(g.id, input.grantId),
        eq(g.artifactId, input.artifactId),
        isNull(g.revokedAt),
        isNotNull(g.redeemedAt),
        gt(g.expiresAt, input.now),
        both ? liveAppSession(both, g.authSessionId, input.now) : undefined,
      ),
    )
    .limit(1);
  if (!grant) return unavailable();
  const signIn = both
    ? grant.signedInAt === null
      ? null
      : { signedInAt: Number(grant.signedInAt), method: grant.method }
    : await appSessionSignIn(db.global, grant.authSessionId, input.now);
  if (signIn === null) return unavailable();
  // The workspace's sign-in policies apply to a renewal as to the app (decision 0021).
  recordSessionRenewal(db, grant.userId, signIn);
  const access = await checkReadAccess(db, {
    artifactId: input.artifactId,
    userId: grant.userId,
    now: input.now,
  });
  if (!access.ok) return unavailable();
  const [user] = await db.global
    .select({ name: schema.users.name, termsVersion: schema.users.termsVersion })
    .from(schema.users)
    .where(eq(schema.users.id, grant.userId))
    .limit(1);
  if (!user) return unavailable();
  return ok({
    grantId: input.grantId,
    userId: grant.userId,
    visitorId: grant.visitorId,
    name: user.name,
    write: !needsTermsAcceptance(user.termsVersion),
    expiresAt: grant.expiresAt,
  });
}

/**
 * Revokes every open grant of the person on an artifact (from "Data you shared" or the viewer).
 * The `data_grant` window tombstones are written first, in the global database, so a restore
 * never revives a revoked grant; then the regional rows, conditioned on being still open. With
 * one database both are one batch.
 */
export async function revokeDataGrants(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
): Promise<{ revoked: number }> {
  const open = and(
    eq(g.userId, input.userId),
    eq(g.artifactId, input.artifactId),
    isNull(g.revokedAt),
    gt(g.expiresAt, input.now),
  );
  const rows = await db.select({ id: g.id }).from(g).where(open);
  if (rows.length === 0) return { revoked: 0 };
  const ids = rows.map((row) => row.id);
  const markers = ids.map((id) => ({ kind: "data_grant" as const, id, deletedAt: input.now }));
  const both = bothSides(db);
  if (both) {
    const [, revoked] = await both.batch([
      both.insert(schema.tombstones).values(markers).onConflictDoNothing(),
      both
        .update(g)
        .set({ revokedAt: input.now })
        .where(and(open, inArray(g.id, ids)))
        .returning({ id: g.id }),
    ]);
    return { revoked: revoked.length };
  }
  await db.global.insert(schema.tombstones).values(markers).onConflictDoNothing();
  const revoked = await db
    .update(g)
    .set({ revokedAt: input.now })
    .where(and(open, inArray(g.id, ids)))
    .returning({ id: g.id });
  return { revoked: revoked.length };
}

/**
 * The artifacts the person shared data with in one region, newest first: one row per artifact,
 * with the grants still open, for "Data you shared".
 */
export async function listDataGrants(
  db: RegionalDb,
  input: { userId: string; contentDomain: string; now: number },
): Promise<DataGrantView[]> {
  const open = sql<number>`sum(case when ${g.revokedAt} is null and ${g.redeemedAt} is not null and ${g.expiresAt} > ${input.now} then 1 else 0 end)`;
  const rows = await db
    .select({
      artifactId: g.artifactId,
      name: schema.artifacts.name,
      host: sql<string>`max(${g.host})`,
      open,
      first: sql<number>`min(${g.createdAt})`,
      last: sql<number>`max(${g.createdAt})`,
      expiresAt: sql<
        number | null
      >`max(case when ${g.revokedAt} is null and ${g.redeemedAt} is not null and ${g.expiresAt} > ${input.now} then ${g.expiresAt} end)`,
    })
    .from(g)
    .leftJoin(schema.artifacts, eq(schema.artifacts.id, g.artifactId))
    .where(and(eq(g.userId, input.userId), isNotNull(g.redeemedAt)))
    .groupBy(g.artifactId)
    .orderBy(desc(sql`max(${g.createdAt})`))
    .limit(200);
  return rows.map((row) => ({
    artifactId: row.artifactId,
    artifactName: row.name ?? null,
    host: row.host ?? devHost(row.artifactId, input.contentDomain),
    openGrants: Number(row.open),
    firstGrantedAt: new Date(Number(row.first)).toISOString(),
    lastGrantedAt: new Date(Number(row.last)).toISOString(),
    expiresAt: row.expiresAt === null ? null : new Date(Number(row.expiresAt)).toISOString(),
  }));
}

/**
 * Deletes expired codes and grants that ended `DATA_GRANT.endedKeepMs` ago (revoked or expired),
 * at most `limit` of each per run. Called by the maintenance job.
 */
export async function pruneDataGrants(
  db: RegionalDb,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ processed: number }> {
  const before = now - DATA_GRANT.endedKeepMs;
  const [codes, grants] = await db.batch([
    db
      .delete(c)
      .where(
        inArray(
          c.codeHash,
          db.select({ id: c.codeHash }).from(c).where(lte(c.expiresAt, now)).limit(limit),
        ),
      )
      .returning({ id: c.codeHash }),
    db
      .delete(g)
      .where(
        inArray(
          g.id,
          db
            .select({ id: g.id })
            .from(g)
            .where(
              or(
                lte(g.expiresAt, before),
                and(isNotNull(g.revokedAt), lte(g.revokedAt, before)),
                // A grant whose code never redeemed gives nothing once its code expired.
                and(isNull(g.redeemedAt), lte(g.createdAt, now - DATA_GRANT.codeTtlSeconds * 2000)),
              ),
            )
            .limit(limit),
        ),
      )
      .returning({ id: g.id }),
  ]);
  return { processed: codes.length + grants.length };
}
