// Grants of artifact data (decision 0026, "The grant", delivery 6). A grant is one person's
// consent, in one browser, that an artifact's page may know them by an opaque per-artifact
// visitor ID and their display name and save what they enter. The app draws the control and
// issues a one-use code bound to the beginning browser's nonce and the artifact's host; the
// content Worker redeems it into a sealed cookie whose claims it renews here every 60 seconds.
// Revocation (the person, the viewer, sign-out, lost access) therefore applies within a minute.
import {
  type AnonymousDataGrantControl,
  DATA_GRANT,
  type DataGrantControl,
  type DataGrantView,
  isWorkspaceId,
  JournalEntry as JournalEntrySchema,
} from "@portifact/contracts";
import { bothSides, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  anonymousGrantOpen,
  devHost,
  fail,
  handoffHost,
  needsTermsAcceptance,
  ok,
  type Result,
} from "@portifact/domain";
import { claimOutcome, journalKey } from "@portifact/domain/artifact-data";
import { and, eq, gt, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { cursorRead, resumeAt, savedCursorSql } from "./maintenance-cursors.ts";
import {
  appSessionSignIn,
  checkReadAccess,
  hashSecret,
  liveAppSession,
  randomToken,
  recordSessionRenewal,
} from "./read-access.ts";
import { ownerEntitlementsAndPolicy } from "./workspace-policies.ts";

const SECOND_MS = 1000;
const PRUNE_BATCH = 500;

const g = schema.dataGrants;
const c = schema.dataGrantCodes;
const ag = schema.dataAnonymousGrants;

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
  // A fixed plan, whatever the answer (decision 0026: a refusal reads like a missing artifact):
  // one regional read of the artifact's data row and custom host, the custom host's global row
  // when one was asked for, then the read access check, which takes the same reads for a missing
  // artifact as for a refused one. Only then is anything decided.
  const [row] = await db
    .select({
      name: schema.artifacts.name,
      ownerId: schema.artifacts.ownerId,
      customHost: schema.artifacts.customHost,
      hasData: sql<number>`${schema.artifactData.artifactId} is not null`,
    })
    .from(schema.artifacts)
    .leftJoin(schema.artifactData, eq(schema.artifactData.artifactId, schema.artifacts.id))
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  const askedHost = input.customDomains && input.requestedHost !== null;
  const [active] = askedHost
    ? await db.global
        .select({ hostname: schema.customDomains.hostname })
        .from(schema.customDomains)
        .where(
          and(
            eq(schema.customDomains.hostname, row?.customHost ?? input.requestedHost ?? ""),
            eq(schema.customDomains.state, "active"),
            eq(schema.customDomains.artifactId, input.artifactId),
          ),
        )
        .limit(1)
    : [];
  const access = await checkReadAccess(db, input);
  if (!access.ok || !row || !row.hasData) return unavailable();
  const host = handoffHost({
    artifactId: input.artifactId,
    contentDomain: input.contentDomain,
    requested: input.requestedHost,
    activeHost: active !== undefined && row.customHost !== null ? row.customHost : null,
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
 * Grants one revocation step handles: three bound parameters per tombstone, so a step stays well
 * under D1's 100 bound parameters a statement.
 */
const REVOKE_STEP = 30;
/** Steps one revocation takes at most: far above what the issue rate lets a person open. */
const REVOKE_STEPS = 200;

/**
 * Revokes every open grant of the person on an artifact (from "Data you shared" or the viewer),
 * in steps of `REVOKE_STEP`, until none is open. Each step writes its `data_grant` window
 * tombstones first, in the global database, so a restore never revives a revoked grant, then
 * revokes those rows, conditioned on being still open; with one database both are one batch.
 * Answers only once no open grant is left.
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
  const both = bothSides(db);
  let revoked = 0;
  for (let step = 0; step < REVOKE_STEPS; step++) {
    const rows = await db.select({ id: g.id }).from(g).where(open).limit(REVOKE_STEP);
    if (rows.length === 0) return { revoked };
    const ids = rows.map((row) => row.id);
    const markers = ids.map((id) => ({ kind: "data_grant" as const, id, deletedAt: input.now }));
    if (both) {
      const [, done] = await both.batch([
        both.insert(schema.tombstones).values(markers).onConflictDoNothing(),
        both
          .update(g)
          .set({ revokedAt: input.now })
          .where(and(open, inArray(g.id, ids)))
          .returning({ id: g.id }),
      ]);
      revoked += done.length;
      continue;
    }
    await db.global.insert(schema.tombstones).values(markers).onConflictDoNothing();
    const done = await db
      .update(g)
      .set({ revokedAt: input.now })
      .where(and(open, inArray(g.id, ids)))
      .returning({ id: g.id });
    revoked += done.length;
  }
  throw new Error("grants kept opening while they were revoked");
}

/**
 * How many grants of the person on one artifact are open now, for the viewer's "stop saving as
 * me": one read through the `(user_id, artifact_id)` index.
 */
export async function openDataGrants(
  db: RegionalDb,
  input: { userId: string; artifactId: string; now: number },
): Promise<number> {
  const [row] = await db
    .select({ open: sql<number>`count(*)` })
    .from(g)
    .where(
      and(
        eq(g.userId, input.userId),
        eq(g.artifactId, input.artifactId),
        isNull(g.revokedAt),
        isNotNull(g.redeemedAt),
        gt(g.expiresAt, input.now),
      ),
    );
  return Number(row?.open ?? 0);
}

/** Artifacts one page of "Data you shared" lists, per region. */
export const DATA_GRANT_PAGE = 50;

/**
 * One page of the artifacts the person shared data with in one region, by artifact ID after
 * `after`, through the `(user_id, artifact_id)` index: one row per artifact with the grants
 * still open. `next` names the last artifact when more may follow.
 */
export async function listDataGrants(
  db: RegionalDb,
  input: {
    userId: string;
    contentDomain: string;
    now: number;
    after?: string | null;
    limit?: number;
  },
): Promise<{ items: DataGrantView[]; next: string | null }> {
  const limit = Math.min(Math.max(1, input.limit ?? DATA_GRANT_PAGE), DATA_GRANT_PAGE);
  const live = sql`${g.revokedAt} is null and ${g.redeemedAt} is not null and ${g.expiresAt} > ${input.now}`;
  const rows = await db
    .select({
      artifactId: g.artifactId,
      name: sql<
        string | null
      >`(select ${schema.artifacts.name} from ${schema.artifacts} where ${schema.artifacts.id} = "data_grants"."artifact_id")`,
      host: sql<string>`max(${g.host})`,
      open: sql<number>`sum(case when ${live} then 1 else 0 end)`,
      first: sql<number>`min(${g.createdAt})`,
      last: sql<number>`max(${g.createdAt})`,
      expiresAt: sql<number | null>`max(case when ${live} then ${g.expiresAt} end)`,
    })
    .from(g)
    .where(
      and(
        eq(g.userId, input.userId),
        isNotNull(g.redeemedAt),
        input.after ? gt(g.artifactId, input.after) : undefined,
      ),
    )
    .groupBy(g.artifactId)
    .orderBy(g.artifactId)
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      artifactId: row.artifactId,
      artifactName: row.name ?? null,
      host: row.host ?? devHost(row.artifactId, input.contentDomain),
      openGrants: Number(row.open),
      firstGrantedAt: new Date(Number(row.first)).toISOString(),
      lastGrantedAt: new Date(Number(row.last)).toISOString(),
      expiresAt: row.expiresAt === null ? null : new Date(Number(row.expiresAt)).toISOString(),
    })),
    next: rows.length > limit ? (page.at(-1)?.artifactId ?? null) : null,
  };
}

/** Grants one page of `endSignedOutDataGrants` reads: three bound parameters per tombstone. */
const SIGNED_OUT_PAGE = 30;
/** Pages it reads per run. */
const SIGNED_OUT_PAGES = 5;
const SIGNED_OUT_CURSOR = "data_grants_signed_out";

/**
 * Records when grants ended by their app session ending (sign-out deletes the row; an expired
 * session counts once the expired-record cleanup deleted it, since a refresh can still extend a
 * row that has expired) as `revoked_at`, so the prune deletes them 30 days after that end rather than after their own
 * expiry. Renewal already refuses them; this only starts their pruning clock. Walks the grants by
 * ID from `maintenance_cursors`, reading at most `SIGNED_OUT_PAGE` rows a page, and for each one
 * it ends writes a `data_grant` window tombstone first, as every way to end a grant does: with
 * one database in the same batch, with a separate one in the global database before the regional
 * update. Both are held to the grant still open and its session row missing (with one database
 * in their own statements); a session never comes back under the same ID, so a separate
 * database cannot race.
 */
export async function endSignedOutDataGrants(
  db: RegionalDb,
  now: number,
  caps: { pageSize: number; maxPages: number } = {
    pageSize: SIGNED_OUT_PAGE,
    maxPages: SIGNED_OUT_PAGES,
  },
): Promise<{ ended: number }> {
  const pageSize = Math.min(caps.pageSize, SIGNED_OUT_PAGE);
  const both = bothSides(db);
  // By primary key only, filtered here: a page reads what it returns, whatever is revoked.
  const pageAfter = (after: SQL | string) =>
    db
      .select({
        id: g.id,
        authSessionId: g.authSessionId,
        revokedAt: g.revokedAt,
        expiresAt: g.expiresAt,
      })
      .from(g)
      .where(gt(g.id, after))
      .orderBy(g.id)
      .limit(pageSize);
  // The cursor is read in the first page's batch, so a run with nothing to do is one call.
  const [saved, first] = await db.batch([
    cursorRead(db, SIGNED_OUT_CURSOR),
    pageAfter(savedCursorSql(SIGNED_OUT_CURSOR)),
  ]);
  const started = saved[0]?.cursor ?? "";
  let cursor = started;
  let ended = 0;
  for (let page = 0; page < caps.maxPages; page++) {
    const rows = page === 0 ? first : await pageAfter(cursor);
    const open = rows.filter((row) => row.revokedAt === null && row.expiresAt > now);
    if (open.length > 0) ended += await endGrantsWithoutSession(db, both, open, now);
    if (rows.length < pageSize) {
      await resumeAt(db, SIGNED_OUT_CURSOR, started, null, now);
      return { ended };
    }
    cursor = rows.at(-1)?.id ?? cursor;
  }
  await resumeAt(db, SIGNED_OUT_CURSOR, started, cursor, now);
  return { ended };
}

/** True while the grant's app session row no longer exists (never merely expired). */
const sessionMissing = sql`not exists (select 1 from "sessions" "s" where "s"."id" = "data_grants"."auth_session_id")`;

async function endGrantsWithoutSession(
  db: RegionalDb,
  both: ReturnType<typeof bothSides>,
  open: { id: string; authSessionId: string }[],
  now: number,
): Promise<number> {
  const stillOpen = and(
    inArray(
      g.id,
      open.map((row) => row.id),
    ),
    isNull(g.revokedAt),
    gt(g.expiresAt, now),
  );
  if (both) {
    // The tombstone and the revocation hold to the same predicate in one batch, so a session that
    // exists (even one a refresh is extending) never gets either.
    const [, done] = await both.batch([
      both
        .insert(schema.tombstones)
        .select(
          sql`select 'data_grant', "data_grants"."id", ${now} from ${g} where ${and(stillOpen, sessionMissing)}`,
        )
        .onConflictDoNothing(),
      both
        .update(g)
        .set({ revokedAt: now })
        .where(and(stillOpen, sessionMissing))
        .returning({ id: g.id }),
    ]);
    return done.length;
  }
  const sessions = [...new Set(open.map((row) => row.authSessionId))];
  const present = await db.global
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(inArray(schema.sessions.id, sessions));
  const presentIds = new Set(present.map((row) => row.id));
  const gone = open.filter((row) => !presentIds.has(row.authSessionId));
  if (gone.length === 0) return 0;
  // A missing session never comes back under its ID, so what was read stays true; the tombstone
  // still repeats the predicate in its own statement.
  const pairs = JSON.stringify(gone.map((row) => ({ g: row.id, s: row.authSessionId })));
  await db.global
    .insert(schema.tombstones)
    .select(
      sql`select 'data_grant', json_extract(value, '$.g'), ${now} from json_each(${pairs}) where not exists (select 1 from "sessions" "s" where "s"."id" = json_extract(value, '$.s'))`,
    )
    .onConflictDoNothing();
  const done = await db
    .update(g)
    .set({ revokedAt: now })
    .where(
      and(
        stillOpen,
        inArray(
          g.id,
          gone.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: g.id });
  return done.length;
}

/**
 * Deletes, at most `limit` of each per run, expired codes and grants 30 days after they expired,
 * were revoked, or (never redeemed) after their code could no longer redeem. Each selection runs
 * through its own index leading with that time, so a run reads what it deletes and not the
 * table. Called by the maintenance job.
 */
export async function pruneDataGrants(
  db: RegionalDb,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ processed: number }> {
  const before = now - DATA_GRANT.endedKeepMs;
  const unredeemedBefore = now - DATA_GRANT.codeTtlSeconds * 2 * SECOND_MS;
  const grants = (select: SQL) =>
    db.delete(g).where(sql`${g.id} in (${select})`).returning({ id: g.id });
  const anonymous = (select: SQL) =>
    db.delete(ag).where(sql`${ag.id} in (${select})`).returning({ id: ag.id });
  const results = await db.batch([
    db
      .delete(c)
      .where(
        sql`${c.codeHash} in (select ${c.codeHash} from ${c} indexed by data_grant_codes_expires_idx where ${c.expiresAt} <= ${now} order by ${c.expiresAt} limit ${limit})`,
      )
      .returning({ id: c.codeHash }),
    grants(
      sql`select ${g.id} from ${g} indexed by data_grants_expires_idx where ${g.expiresAt} <= ${before} order by ${g.expiresAt} limit ${limit}`,
    ),
    grants(
      sql`select ${g.id} from ${g} indexed by data_grants_revoked_idx where ${g.revokedAt} is not null and ${g.revokedAt} <= ${before} order by ${g.revokedAt} limit ${limit}`,
    ),
    grants(
      sql`select ${g.id} from ${g} indexed by data_grants_unredeemed_idx where ${g.redeemedAt} is null and ${g.createdAt} <= ${unredeemedBefore} order by ${g.createdAt} limit ${limit}`,
    ),
    // Anonymous grants (delivery 9): 30 days after they expired, or once their code could no
    // longer redeem without having been used.
    anonymous(
      sql`select ${ag.id} from ${ag} indexed by data_anonymous_grants_expires_idx where ${ag.expiresAt} <= ${before} order by ${ag.expiresAt} limit ${limit}`,
    ),
    anonymous(
      sql`select ${ag.id} from ${ag} indexed by data_anonymous_grants_unused_idx where ${ag.usedAt} is null and ${ag.codeExpiresAt} <= ${unredeemedBefore + DATA_GRANT.codeTtlSeconds * SECOND_MS} order by ${ag.codeExpiresAt} limit ${limit}`,
    ),
  ]);
  return { processed: results.reduce((n, rows) => n + rows.length, 0) };
}

// Anonymous grants (decision 0026, delivery 9, "Anonymous writers"): the same consent and the
// same one-use, browser-bound code as a person's grant, for a visitor without an account on a
// public artifact whose owner opened its data to anyone. Nobody is behind one: its visitor ID is
// new for each grant, never claimed in the author journal, and nothing names the visitor. The
// human check and per-address and per-artifact issue limits stand where the account was.

/**
 * Whether this deployment issues and renews anonymous grants: `DATA_ANONYMOUS_ENABLED` exactly
 * `"true"`, with artifact data on. Off, no new anonymous grant, and existing ones stop renewing
 * within the claims' minute (decision 0026, "Switches").
 */
export function dataAnonymousEnabled(env: {
  ARTIFACT_DATA_ENABLED?: string | undefined;
  DATA_ANONYMOUS_ENABLED?: string | undefined;
}): boolean {
  return artifactDataEnabled(env) && env.DATA_ANONYMOUS_ENABLED === "true";
}

/** The artifact as anonymous writing reads it, with its owner's plan and policy. */
async function anonymousTarget(
  db: RegionalDb,
  input: { artifactId: string; enabled: boolean; now: number },
): Promise<{ name: string; ownerId: string; customHost: string | null } | null> {
  const [row] = await db
    .select({
      name: schema.artifacts.name,
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
      accessMode: schema.artifacts.accessMode,
      customHost: schema.artifacts.customHost,
      writers: schema.artifactData.writers,
    })
    .from(schema.artifacts)
    .leftJoin(schema.artifactData, eq(schema.artifactData.artifactId, schema.artifacts.id))
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!row || !input.enabled) return null;
  const { owner, policy } = await ownerEntitlementsAndPolicy(db.global, row.ownerId, input.now);
  const open = anonymousGrantOpen({
    enabled: input.enabled,
    artifact: { state: row.state, accessMode: row.accessMode, writers: row.writers },
    owner: { workspace: isWorkspaceId(row.ownerId), entitlements: owner, policy },
  });
  return open ? { name: row.name, ownerId: row.ownerId, customHost: row.customHost } : null;
}

interface AnonymousTargetInput {
  artifactId: string;
  /** The custom host the page runs on, or null for the `.dev` host. Untrusted input. */
  requestedHost: string | null;
  contentDomain: string;
  customDomains: boolean;
  enabled: boolean;
  now: number;
}

/**
 * Where an anonymous grant may go: an artifact open to anonymous writers now, on its `.dev` host
 * or exactly its active custom host. Anything else answers like a missing artifact.
 */
async function anonymousGrantTarget(
  db: RegionalDb,
  input: AnonymousTargetInput,
): Promise<Result<{ host: string; artifactName: string; ownerId: string }>> {
  const target = await anonymousTarget(db, input);
  if (target === null) return unavailable();
  const askedHost = input.customDomains && input.requestedHost !== null;
  const [active] =
    askedHost && target.customHost !== null
      ? await db.global
          .select({ hostname: schema.customDomains.hostname })
          .from(schema.customDomains)
          .where(
            and(
              eq(schema.customDomains.hostname, target.customHost),
              eq(schema.customDomains.state, "active"),
              eq(schema.customDomains.artifactId, input.artifactId),
            ),
          )
          .limit(1)
      : [];
  const host = handoffHost({
    artifactId: input.artifactId,
    contentDomain: input.contentDomain,
    requested: input.requestedHost,
    activeHost: active !== undefined ? target.customHost : null,
  });
  if (host === null) return unavailable();
  return ok({ host, artifactName: target.name, ownerId: target.ownerId });
}

/** What the anonymous control shows: the artifact's host and owner. Reads only. */
export async function anonymousDataGrantControl(
  db: RegionalDb,
  input: AnonymousTargetInput,
): Promise<Result<AnonymousDataGrantControl>> {
  const target = await anonymousGrantTarget(db, input);
  if (!target.ok) return target;
  const { host, artifactName, ownerId } = target.value;
  const workspaceOwner = isWorkspaceId(ownerId);
  const [owner] = workspaceOwner
    ? await db.global
        .select({ name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ownerId))
        .limit(1)
    : await db.global
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, ownerId))
        .limit(1);
  return ok({
    artifactId: input.artifactId,
    artifactName,
    host,
    owner: { kind: workspaceOwner ? "workspace" : "user", name: owner?.name ?? "" },
    grantDays: DATA_GRANT.anonymousGrantTtlSeconds / 86_400,
  });
}

const HOUR_MS = 3_600_000;

/**
 * The visitor allowed, and the human check passed (checked by the adapter before this): limits
 * codes per network address (`addressKey`, a hash the adapter made, never the address) and per
 * artifact, checks the target again, then writes the grant with its one-use code in one
 * statement. The code is returned once and stored only as a hash.
 */
export async function issueAnonymousDataGrantCode(
  db: RegionalDb,
  input: AnonymousTargetInput & { nonceHash: string; addressKey: string; termsVersion: string },
): Promise<Result<{ code: string; host: string; expiresAt: number }>> {
  const limited = () => fail<never>("rate_limited", "Too many requests. Try again later.");
  // Allow agrees to the terms the prompt showed; only the current ones grant writing.
  if (needsTermsAcceptance(input.termsVersion)) {
    return fail(
      "terms_not_accepted",
      "The terms changed since this prompt opened. Reload it, read the notice and choose Allow again.",
    );
  }
  // Every attempt from an address counts, so probing artifacts costs it too.
  const byAddress = await hitRateLimit(
    db.global.$client,
    `data_anon:ip:${input.addressKey}`,
    HOUR_MS,
    input.now,
  );
  if (byAddress.count > DATA_GRANT.anonymousPerIpPerHour) return limited();
  const target = await anonymousGrantTarget(db, input);
  if (!target.ok) return target;
  const byArtifact = await hitRateLimit(
    db.global.$client,
    `data_anon:artifact:${input.artifactId}`,
    HOUR_MS,
    input.now,
  );
  if (byArtifact.count > DATA_GRANT.anonymousPerArtifactPerHour) return limited();
  const code = randomToken();
  const codeExpiresAt = input.now + DATA_GRANT.codeTtlSeconds * SECOND_MS;
  await db.insert(ag).values({
    id: grantId(),
    artifactId: input.artifactId,
    visitorId: newVisitorId(),
    host: target.value.host,
    codeHash: await hashSecret(code),
    nonceHash: input.nonceHash,
    codeExpiresAt,
    expiresAt: input.now + DATA_GRANT.anonymousGrantTtlSeconds * SECOND_MS,
    // Choosing Allow under the sign-in-wrap notice accepts the terms it showed, checked above.
    termsVersion: input.termsVersion,
    createdAt: input.now,
  });
  return ok({ code, host: target.value.host, expiresAt: codeExpiresAt });
}

/**
 * Redeems an anonymous code on the host it was issued for, with the nonce of the browser that
 * began: one guarded update marks it used, so a replay or a concurrent redemption gets nothing,
 * and the artifact must still be open to anonymous writers.
 */
export async function redeemAnonymousDataGrantCode(
  db: RegionalDb,
  input: {
    code: string;
    artifactId: string;
    nonceHash: string | null;
    host: string;
    enabled: boolean;
    now: number;
  },
): Promise<Result<LiveGrant>> {
  const refused = fail<never>("invalid_input", "This link has expired or was already used.");
  if (input.nonceHash === null) return refused;
  // The one-use code's material goes with its use: nothing left could redeem it again.
  const [row] = await db
    .update(ag)
    .set({ usedAt: input.now, codeHash: null, nonceHash: null })
    .where(
      and(
        eq(ag.codeHash, await hashSecret(input.code)),
        eq(ag.artifactId, input.artifactId),
        eq(ag.nonceHash, input.nonceHash),
        eq(ag.host, input.host),
        isNull(ag.usedAt),
        gt(ag.codeExpiresAt, input.now),
        gt(ag.expiresAt, input.now),
      ),
    )
    .returning({ id: ag.id });
  if (!row) return refused;
  const live = await renewAnonymousDataGrant(db, {
    grantId: row.id,
    artifactId: input.artifactId,
    enabled: input.enabled,
    now: input.now,
  });
  return live.ok ? live : refused;
}

/**
 * Renews an anonymous grant's claims: the grant exists for this artifact, was redeemed and has
 * not expired, and the artifact is still open to anonymous writers (the switch, active and
 * public, writers `anyone`, the owner's plan and policy). It writes only while the terms version
 * the visitor agreed to on Allow is the current one; after a change it reads, and a new Allow
 * agrees again. Read every 60 seconds; writes nothing.
 */
export async function renewAnonymousDataGrant(
  db: RegionalDb,
  input: { grantId: string; artifactId: string; enabled: boolean; now: number },
): Promise<Result<LiveGrant>> {
  if (!input.enabled) return unavailable();
  const [grant] = await db
    .select({ visitorId: ag.visitorId, expiresAt: ag.expiresAt, termsVersion: ag.termsVersion })
    .from(ag)
    .where(
      and(
        eq(ag.id, input.grantId),
        eq(ag.artifactId, input.artifactId),
        isNotNull(ag.usedAt),
        gt(ag.expiresAt, input.now),
      ),
    )
    .limit(1);
  if (!grant) return unavailable();
  if ((await anonymousTarget(db, input)) === null) return unavailable();
  return ok({
    grantId: input.grantId,
    userId: "",
    visitorId: grant.visitorId,
    name: "",
    // Like a person's grant: write only under the terms version current now.
    write: !needsTermsAcceptance(grant.termsVersion),
    expiresAt: grant.expiresAt,
  });
}
