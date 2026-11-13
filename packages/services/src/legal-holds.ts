// Legal holds (docs/operations.md, "Legal holds"): the operator preserves an artifact for an
// authority. A hold is set, listed and released only with the operator tool. While it is open
// the artifact stays suspended (served to nobody, its owner included), and no path deletes it,
// moves it or prunes its versions: the owner side's deletion and transfer are refused with
// `forbidden` and a message that never says why (`HELD_MESSAGE`), account and workspace deletions
// and a restore's re-applied deletions leave it out and wait, and triggers in the
// `legal_hold_triggers` migration back every one of those. Releasing the hold (by hand, or by the
// maintenance scan at its release date) lets a deferred deletion go on at its next run.

import { type AbuseReason, isWorkspaceId, type LegalHoldLine } from "@portifact/contracts";
import {
  type AccessDb,
  accessSchema,
  type Db,
  type GlobalDb,
  type RegionalDb,
  schema,
} from "@portifact/db";
import { checkHoldPlacement, fail, HELD_MESSAGE, ok, type Result } from "@portifact/domain";
import { and, asc, eq, inArray, isNotNull, isNull, lte, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { eraseAuthorFromThread } from "./annotations.ts";
import { dataFenceStatements, wakeDataJobs } from "./artifact-data.ts";
import { eraseAccountTraces } from "./history-retention.ts";
import { suspendArtifact } from "./moderation.ts";

const h = schema.legalHolds;

/** The artifacts row's ID, named with its table so it never binds to the subquery's own `id`. */
const ARTIFACT_ID = sql`"artifacts"."id"`;

/**
 * SQL that is true while an artifact has an open hold: the `artifacts` row of the statement, or
 * the ID given. Its own columns name their table, so it holds inside any statement.
 */
export function heldSql(artifactId: SQL = ARTIFACT_ID): SQL {
  return sql`exists (select 1 from "legal_holds" where "legal_holds"."artifact_id" = ${artifactId} and "legal_holds"."released_at" is null)`;
}

/** SQL that is true while an artifact has no open hold (see `heldSql`). */
export function notHeldSql(artifactId: SQL = ARTIFACT_ID): SQL {
  return sql`not ${heldSql(artifactId)}`;
}

/** Whether an artifact has an open hold. */
export async function isHeld(db: Db, artifactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: h.id })
    .from(h)
    .where(and(eq(h.artifactId, artifactId), isNull(h.releasedAt)))
    .limit(1);
  return row !== undefined;
}

/** The artifacts with an open hold in this region, for the scans that cannot join the hold. */
export async function heldArtifactIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: h.artifactId }).from(h).where(isNull(h.releasedAt));
  return rows.map((row) => row.id);
}

/** The refusal of every owner-side change a hold stops; it never says why. */
export const heldRefusal = () => fail<never>("forbidden", HELD_MESSAGE);

export type LegalHoldRow = typeof schema.legalHolds.$inferSelect;
export type HoldIdentity = typeof schema.legalHoldIdentities.$inferSelect;

const hi = schema.legalHoldIdentities;

/**
 * The people a hold keeps for an artifact: its owner account, whoever created it and the
 * publisher of each committed version, with their emails now (null for a token or an account
 * already gone). Read before the hold's batch; users are global, the rows regional.
 */
async function identitiesOf(
  db: RegionalDb,
  holdId: string,
  artifact: { id: string; ownerId: string; createdBy: string | null },
  now: number,
): Promise<HoldIdentity[]> {
  const versions = await db
    .select({ id: schema.versions.id, authorId: schema.versions.authorId })
    .from(schema.versions)
    .where(
      and(eq(schema.versions.artifactId, artifact.id), eq(schema.versions.state, "committed")),
    );
  const people: { role: HoldIdentity["role"]; versionId: string; actorId: string }[] = [
    ...(isWorkspaceId(artifact.ownerId)
      ? []
      : [{ role: "owner" as const, versionId: "", actorId: artifact.ownerId }]),
    ...(artifact.createdBy
      ? [{ role: "creator" as const, versionId: "", actorId: artifact.createdBy }]
      : []),
    ...versions.map((v) => ({ role: "publisher" as const, versionId: v.id, actorId: v.authorId })),
  ];
  const ids = [...new Set(people.map((p) => p.actorId))];
  const emails = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await db.global
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, ids.slice(i, i + 90)));
    for (const row of rows) emails.set(row.id, row.email);
  }
  return people.map((p) => ({
    holdId,
    ...p,
    email: emails.get(p.actorId) ?? null,
    recordedAt: now,
  }));
}

/** Statements that store a hold's identities, replacing what it kept before. */
function identityStatements(db: Db, holdId: string, rows: readonly HoldIdentity[]) {
  return [
    db.delete(hi).where(eq(hi.holdId, holdId)),
    ...chunks(rows, 10).map((chunk) => db.insert(hi).values(chunk).onConflictDoNothing()),
  ];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The identities an artifact's open hold keeps, for the operator tool and the tests. */
export async function holdIdentities(db: Db, artifactId: string): Promise<HoldIdentity[]> {
  return db
    .select({
      holdId: hi.holdId,
      role: hi.role,
      versionId: hi.versionId,
      actorId: hi.actorId,
      email: hi.email,
      recordedAt: hi.recordedAt,
    })
    .from(hi)
    .innerJoin(h, eq(h.id, hi.holdId))
    .where(and(eq(h.artifactId, artifactId), isNull(h.releasedAt)));
}

function newHoldId(): string {
  return `hold_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The account's address while the hold lasts, so the uploader is known even after deletion. */
async function ownerEmail(global: GlobalDb, ownerId: string): Promise<string | null> {
  if (isWorkspaceId(ownerId)) return null;
  const [row] = await global
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Places a hold on a suspended artifact. Holding one already held changes nothing and answers the
 * open hold.
 */
export async function placeLegalHold(
  db: RegionalDb,
  input: { artifactId: string; ground: string; releaseAt: number | null; now: number },
): Promise<Result<{ hold: LegalHoldRow; changed: boolean }>> {
  const ground = input.ground.trim();
  if (ground.length === 0 || ground.length > 500) {
    return fail("invalid_input", "The ground must be 1 to 500 characters.");
  }
  const [artifact] = await db
    .select({
      id: schema.artifacts.id,
      state: schema.artifacts.state,
      ownerId: schema.artifacts.ownerId,
      reason: schema.artifacts.suspensionReason,
      createdBy: schema.artifacts.createdBy,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (!artifact) return fail("not_found", "Artifact not found.");
  const open = await openHold(db, artifact.id);
  if (open) return ok({ hold: open, changed: false });
  const allowed = checkHoldPlacement(artifact.state, input.releaseAt, input.now);
  if (!allowed.ok) return allowed;
  const row: LegalHoldRow = {
    id: newHoldId(),
    artifactId: artifact.id,
    ownerId: artifact.ownerId,
    ownerEmail: await ownerEmail(db.global, artifact.ownerId),
    reason: (artifact.reason ?? "other") as AbuseReason,
    ground,
    createdAt: input.now,
    releaseAt: input.releaseAt,
    releasedAt: null,
  };
  const identities = await identitiesOf(db, row.id, artifact, input.now);
  try {
    // The hold and who it keeps in one batch: a hold the trigger refuses stores nobody.
    await db.batch([
      db.insert(h).values(row),
      ...identityStatements(db, row.id, identities),
      // The object's hold (decision 0026): the epoch raised and the fence's job, after the hold
      // the trigger may refuse, so a refused hold fences nothing.
      ...dataFenceStatements(db, {
        which: sql`d.artifact_id = ${row.artifactId}`,
        fence: sql`json_object('kind', 'hold', 'transition', ${row.id})`,
        owner: sql`da.owner_id`,
        now: input.now,
      }),
    ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (error) {
    // A concurrent hold won the open slot, or the artifact was reinstated in between.
    const won = await openHold(db, artifact.id);
    if (won) return ok({ hold: won, changed: false });
    if (causeIncludes(error, "legal_hold_needs_suspension")) {
      return fail("version_conflict", "The artifact changed meanwhile. Try again.");
    }
    throw error;
  }
  return ok({ hold: row, changed: true });
}

/** An artifact's open hold, read directly (the operator's `hold`). */
export async function openHold(db: Db, artifactId: string): Promise<LegalHoldRow | undefined> {
  const [row] = await db
    .select()
    .from(h)
    .where(and(eq(h.artifactId, artifactId), isNull(h.releasedAt)))
    .limit(1);
  return row;
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

/**
 * Releases an artifact's open hold and forgets the owner's address it kept. The artifact stays
 * suspended until the operator reinstates it; deletions that waited for the hold go on at their
 * next run. `released` is false when there was no open hold.
 */
export async function releaseLegalHold(
  db: RegionalDb,
  input: { artifactId: string; now: number },
): Promise<{ released: boolean }> {
  // The job that applies what the hold deferred is written in the release's batch, on the hold
  // still being open, before the release.
  const rows = await release(db, sql`${h.artifactId} = ${input.artifactId}`, input.now);
  return { released: rows > 0 };
}

/** Moves an open hold's planned release date, which must be in the future. */
export async function updateHoldRelease(
  db: Db,
  input: { artifactId: string; releaseAt: number; now: number },
): Promise<Result<{ releaseAt: number }>> {
  if (input.releaseAt <= input.now) {
    return fail("invalid_input", "The release date must be in the future.");
  }
  const rows = await db
    .update(h)
    .set({ releaseAt: input.releaseAt })
    .where(and(eq(h.artifactId, input.artifactId), isNull(h.releasedAt)))
    .returning({ id: h.id });
  return rows.length > 0
    ? ok({ releaseAt: input.releaseAt })
    : fail("not_found", "This artifact has no open hold.");
}

/** The region's holds, open ones first, then the released ones when `all`. */
export async function listLegalHolds(
  db: Db,
  input: { all: boolean; limit: number },
): Promise<LegalHoldRow[]> {
  return db
    .select()
    .from(h)
    .where(input.all ? undefined : isNull(h.releasedAt))
    .orderBy(sql`${h.releasedAt} is not null`, asc(h.createdAt), asc(h.id))
    .limit(input.limit);
}

/** The maintenance scan's part: releases the holds whose release date has come. */
export async function releaseDueHolds(db: Db, now: number): Promise<number> {
  return release(db, sql`${h.releaseAt} is not null and ${h.releaseAt} <= ${now}`, now);
}

/**
 * Releases the open holds `which` selects, in one batch: their `legal_hold_release` jobs on the
 * holds still being open, the release (stamped `releasedAt`), and the addresses they kept. Every
 * release goes through it: by hand, at the release date and when a restore releases again.
 */
async function release(db: Db, which: SQL, releasedAt: number, now = releasedAt): Promise<number> {
  const open = sql`${which} and ${h.releasedAt} is null`;
  const [, , , rows] = (await db.batch([
    releaseJobs(db, open, now),
    // The objects' releases (decision 0026), on the holds still being open, before the release:
    // the epoch raised and one `data_fence` job per hold whose artifact has data.
    ...dataFenceStatements(db, {
      which: open,
      from: sql`join ${h} on ${h.artifactId} = d.artifact_id`,
      fence: sql`json_object('kind', 'release', 'transition', ${h.id} || ':release')`,
      owner: sql`da.owner_id`,
      now,
    }),
    db.update(h).set({ releasedAt, ownerEmail: null }).where(open).returning({ id: h.id }),
    forgetReleasedIdentities(db),
  ])) as unknown as [unknown, unknown, unknown, { id: string }[]];
  return rows.length;
}

/** One `legal_hold_release` job per hold that `which` selects, subject the artifact. */
function releaseJobs(db: Db, which: SQL, now: number) {
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'legal_hold_release', '{}', ${now}, null, 0, ${now}, ${h.artifactId}, null from ${h} where ${which}`,
    );
}

/** People whose deletion the hold deferred: those of `ids` with an `account` tombstone. */
async function tombstonedAccounts(global: GlobalDb, ids: readonly string[]): Promise<string[]> {
  const gone: string[] = [];
  const t = schema.tombstones;
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await global
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.kind, "account"), inArray(t.id, ids.slice(i, i + 90))));
    gone.push(...rows.map((row) => row.id));
  }
  return gone;
}

/** Threads a `legal_hold_release` job erases a deleted author from per run. */
const RELEASE_THREADS = 25;

/**
 * Runs a `legal_hold_release` job: applies what the hold deferred for accounts deleted while it
 * lasted (found by their tombstones): their comments and review verdicts on the artifact and
 * their openings of it in the access log. Normal expiry needs nothing: the prunes stop skipping
 * the artifact once it is no longer held. Bounded per run (`pending` to go on), idempotent, and
 * nothing while the artifact is held again.
 */
export async function runHoldRelease(
  db: RegionalDb,
  access: AccessDb | undefined,
  artifactId: string,
  now: number,
): Promise<"done" | "pending"> {
  if (await isHeld(db, artifactId)) return "done";
  // The artifact data jobs the hold kept waiting (decision 0026) go now.
  await wakeDataJobs(db, artifactId, now);
  const th = schema.annotationThreads;
  const m = schema.annotationMessages;
  const authors = await db
    .selectDistinct({ authorId: m.authorId })
    .from(m)
    .innerJoin(th, eq(th.id, m.threadId))
    .where(eq(th.artifactId, artifactId));
  const rq = schema.reviewRequests;
  const rv = schema.reviewVerdicts;
  const reviewers = await db
    .selectDistinct({ authorId: rv.authorId })
    .from(rv)
    .innerJoin(rq, eq(rq.id, rv.requestId))
    .where(eq(rq.artifactId, artifactId));
  const e = accessSchema.accessEvents;
  const visitors = access
    ? await access.selectDistinct({ userId: e.userId }).from(e).where(eq(e.artifactId, artifactId))
    : [];
  const le = schema.lifecycleEvents;
  const ev = schema.annotationEvents;
  const actors = [
    ...(await db.selectDistinct({ id: le.actorId }).from(le).where(eq(le.artifactId, artifactId))),
    ...(await db.selectDistinct({ id: ev.actorId }).from(ev).where(eq(ev.artifactId, artifactId))),
    ...(await db
      .selectDistinct({ id: th.resolvedBy })
      .from(th)
      .where(eq(th.artifactId, artifactId))),
    ...(await db
      .selectDistinct({ id: rq.requestedBy })
      .from(rq)
      .where(eq(rq.artifactId, artifactId))),
    // Edit suggestions (decision 0027): the people beside change items, who decided a suggestion,
    // who ran an acceptance and whose drafts the hold kept.
    ...(await suggestionPeople(db, artifactId)),
  ]
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  const gone = await tombstonedAccounts(db.global, [
    ...new Set([
      ...authors.map((row) => row.authorId),
      ...reviewers.map((row) => row.authorId),
      ...visitors.map((row) => row.userId),
      ...actors,
    ]),
  ]);
  if (gone.length === 0) return "done";
  let erased = 0;
  for (const authorId of gone) {
    // The same selection as an account deletion's (`threadsToErase`): a message that is not
    // deleted, or a "message deleted" marker nobody replied to after it.
    const threads = await db.all<{ threadId: string }>(sql`
      select distinct mine.thread_id as threadId from ${m} as mine
      join ${th} on ${th.id} = mine.thread_id
      where ${th.artifactId} = ${artifactId} and mine.author_id = ${authorId} and (
        mine.state <> 'deleted' or not exists (
          select 1 from ${m} as reply
          where reply.thread_id = mine.thread_id and reply.author_id <> ${authorId}
            and reply.state <> 'deleted'
            and (reply.created_at > mine.created_at
              or (reply.created_at = mine.created_at and reply.rowid > mine.rowid))
        )
      )`);
    for (const { threadId } of threads) {
      if (erased >= RELEASE_THREADS) return "pending";
      await eraseAuthorFromThread(db, { authorId, threadId, now });
      erased += 1;
    }
  }
  for (let i = 0; i < gone.length; i += 90) {
    const some = gone.slice(i, i + 90);
    await db
      .update(rq)
      .set({ requestedBy: null })
      .where(and(eq(rq.artifactId, artifactId), inArray(rq.requestedBy, some)));
    await db
      .delete(rv)
      .where(
        and(
          inArray(rv.authorId, some),
          sql`${rv.requestId} in (select ${rq.id} from ${rq} where ${rq.artifactId} = ${artifactId})`,
        ),
      );
    if (access) {
      await access.delete(e).where(and(eq(e.artifactId, artifactId), inArray(e.userId, some)));
    }
  }
  // Their traces in the history the hold kept (who acted, the deleted markers), as their
  // account's deletion would have done.
  for (const userId of gone) {
    if ((await eraseAccountTraces(db, userId, now)).more) return "pending";
  }
  return "done";
}

/** Everyone edit suggestions name on an artifact, for the release to erase deleted accounts. */
async function suggestionPeople(
  db: RegionalDb,
  artifactId: string,
): Promise<{ id: string | null }[]> {
  const ci = schema.changeItems;
  const th = schema.annotationThreads;
  const aa = schema.acceptanceAttempts;
  const ed = schema.editDrafts;
  return [
    ...(await db
      .selectDistinct({ id: ci.createdBy })
      .from(ci)
      .where(eq(ci.artifactId, artifactId))),
    ...(await db
      .selectDistinct({ id: ci.submittedBy })
      .from(ci)
      .where(eq(ci.artifactId, artifactId))),
    ...(await db.selectDistinct({ id: ci.closedBy }).from(ci).where(eq(ci.artifactId, artifactId))),
    ...(await db
      .selectDistinct({ id: th.decidedBy })
      .from(th)
      .where(eq(th.artifactId, artifactId))),
    ...(await db.selectDistinct({ id: aa.userId }).from(aa).where(eq(aa.artifactId, artifactId))),
    ...(await db.selectDistinct({ id: ed.userId }).from(ed).where(eq(ed.artifactId, artifactId))),
  ];
}

/** Deletes the identities of every hold that is no longer open: idempotent, one statement. */
function forgetReleasedIdentities(db: Db) {
  return db
    .delete(hi)
    .where(sql`${hi.holdId} not in (select ${h.id} from ${h} where ${h.releasedAt} is null)`);
}

/**
 * Every region's holds, for `export-tombstones` before a restore: never an address (the owner's
 * and the identities stay in the database; `applyLegalHolds` captures them again).
 */
export async function exportLegalHolds(regions: {
  all(): readonly { db: RegionalDb }[];
}): Promise<LegalHoldLine[]> {
  const lines: LegalHoldLine[] = [];
  for (const { db } of regions.all()) {
    for (const row of await db.select().from(h).orderBy(asc(h.id))) {
      lines.push({
        legalHold: {
          id: row.id,
          artifactId: row.artifactId,
          ownerId: row.ownerId,
          ownerEmail: null,
          reason: row.reason,
          ground: row.ground,
          createdAt: row.createdAt,
          releaseAt: row.releaseAt,
          releasedAt: row.releasedAt,
        },
      });
    }
  }
  return lines;
}

export interface ApplyLegalHoldsResult {
  /** Holds the restore had lost or brought back open, put back as they were. */
  restored: number;
  /** Held artifacts the restore brought back unsuspended, suspended again. */
  suspended: number;
  /** Open holds whose artifact is gone or being purged in every region given: report these. */
  missing: string[];
}

/**
 * Puts the exported holds back after a restore, before any tombstone is re-applied: a hold the
 * restore lost is inserted again (its artifact suspended again first if the restore brought it
 * back served), and one released after the restore point is released again, the releases first.
 * Running it again changes nothing.
 */
export async function applyLegalHolds(
  regions: { all(): readonly { db: RegionalDb }[] },
  lines: readonly LegalHoldLine[],
  now: number,
): Promise<ApplyLegalHoldsResult> {
  const result: ApplyLegalHoldsResult = { restored: 0, suspended: 0, missing: [] };
  // Releases first: an artifact has at most one open hold, so a hold the file has open could not
  // be put back while an earlier one the restore left open is still open.
  const ordered = [
    ...lines.filter((line) => line.legalHold.releasedAt !== null),
    ...lines.filter((line) => line.legalHold.releasedAt === null),
  ];
  for (const { legalHold: line } of ordered) {
    let found = false;
    for (const { db } of regions.all()) {
      const [artifact] = await db
        .select({ state: schema.artifacts.state })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, line.artifactId))
        .limit(1);
      if (!artifact) continue;
      found = true;
      const [current] = await db.select().from(h).where(eq(h.id, line.id)).limit(1);
      if (line.releasedAt !== null) {
        if (current && current.releasedAt === null) {
          // As any release: the job, the stamp from the file and the addresses forgotten.
          await release(db, sql`${h.id} = ${line.id}`, line.releasedAt, now);
          result.restored += 1;
        }
        continue;
      }
      if (current?.releasedAt === null) continue;
      if (artifact.state === "purging" || artifact.state === "deleted") {
        result.missing.push(line.artifactId);
        continue;
      }
      if (artifact.state !== "suspended") {
        const suspended = await suspendArtifact(db, {
          artifactId: line.artifactId,
          reason: line.reason as AbuseReason,
          note: "Suspended again after a restore: legal hold.",
          now,
        });
        if (!suspended.ok) {
          result.missing.push(line.artifactId);
          continue;
        }
        result.suspended += 1;
      }
      const values = {
        id: line.id,
        artifactId: line.artifactId,
        ownerId: line.ownerId,
        ownerEmail: line.ownerEmail,
        reason: line.reason as AbuseReason,
        ground: line.ground,
        createdAt: line.createdAt,
        releaseAt: line.releaseAt,
        releasedAt: null,
      };
      if (current) {
        await db.update(h).set({ releasedAt: null }).where(eq(h.id, line.id));
      } else if (!(await openHold(db, line.artifactId))) {
        await db.insert(h).values(values).onConflictDoNothing();
      }
      // The addresses never travel in the file: captured again from the accounts as they are.
      const [restoredArtifact] = await db
        .select({
          id: schema.artifacts.id,
          ownerId: schema.artifacts.ownerId,
          createdBy: schema.artifacts.createdBy,
        })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, line.artifactId))
        .limit(1);
      const open = await openHold(db, line.artifactId);
      if (restoredArtifact && open) {
        const owner = await ownerEmail(db.global, restoredArtifact.ownerId);
        await db.batch([
          db.update(h).set({ ownerEmail: owner }).where(eq(h.id, open.id)),
          ...identityStatements(
            db,
            open.id,
            await identitiesOf(db, open.id, restoredArtifact, now),
          ),
        ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      }
      result.restored += 1;
    }
    if (!found && line.releasedAt === null) result.missing.push(line.artifactId);
  }
  return result;
}
