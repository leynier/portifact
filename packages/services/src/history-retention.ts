// Retention of the records that outlive what they describe (docs/operations.md, "History
// retention"): lifecycle and moderation records of purged artifacts and deleted accounts, the
// traces a deleted account leaves on other people's artifacts, upload and usage history, and
// stale storage findings. Every scan runs in each region on that region's database, bounded per
// run. The rules are in packages/domain/src/history.ts.
import { type Db, schema } from "@portifact/db";
import {
  CLOSED_UPLOAD_RETENTION_DAYS,
  daysBefore,
  ERASED_ACCOUNT,
  historyCutoff,
  STALE_FINDING_DAYS,
  USAGE_EVENT_RETENTION_DAYS,
} from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";
import { cursorFor, resumeAt } from "./maintenance-cursors.ts";

/** Rows each statement of these scans reads or changes at most per run. */
export const HISTORY_CAPS = { artifacts: 90, rows: 500 } as const;

const CURSOR = "gone_history";

/**
 * Whether a record about `targetId` (an artifact or account ID) is under a legal hold that keeps it
 * past its retention (docs/operations.md, "Legal holds"): an open hold on the artifact, or on an
 * artifact the account or workspace owns. Every scan below asks before it deletes.
 */
export function historyHeld(targetId: SQL): SQL {
  return sql`exists (select 1 from "legal_holds" where ("legal_holds"."artifact_id" = ${targetId} or "legal_holds"."owner_id" = ${targetId}) and "legal_holds"."released_at" is null)`;
}

/** An open hold on the artifact a row names (a column given with its table). */
function onHeld(artifactId: SQL): SQL {
  return sql`exists (select 1 from "legal_holds" where "legal_holds"."artifact_id" = ${artifactId} and "legal_holds"."released_at" is null)`;
}

/**
 * Deletes the lifecycle records of artifacts purged more than `HISTORY_RETENTION_DAYS` ago and the
 * suspension records whose artifact or account went that long ago (`target_gone_at`), unless
 * held. The purged artifacts are walked oldest first through their `purged` event, at most
 * `caps.artifacts` per run, resuming from `maintenance_cursors` past those it must keep (an
 * artifact a restore brought back, a held one).
 */
export async function pruneGoneHistory(
  db: Db,
  now: number,
  caps: { artifacts: number; rows: number } = HISTORY_CAPS,
): Promise<{ artifacts: number; suspensions: number }> {
  const cutoff = historyCutoff(now);
  const le = schema.lifecycleEvents;
  const a = schema.artifacts;
  const s = schema.suspensions;
  const started = await cursorFor(db, CURSOR);
  const [atText, ...rest] = started.split(":");
  const after =
    started === ""
      ? sql``
      : sql` and (${le.at} > ${Number(atText)} or (${le.at} = ${Number(atText)} and ${le.artifactId} > ${rest.join(":")}))`;
  const page = await db.all<{ at: number; artifact_id: string; kept: number }>(
    sql`select ${le.at} as at, ${le.artifactId} as artifact_id, (exists (select 1 from ${a} where ${a.id} = ${le.artifactId}) or ${historyHeld(sql`${le.artifactId}`)}) as kept from ${le} where ${le.event} = 'purged' and ${le.at} < ${cutoff}${after} order by ${le.at}, ${le.artifactId} limit ${caps.artifacts}`,
  );
  const gone = page.filter((row) => !row.kept).map((row) => row.artifact_id);
  const ids = sql`select value from json_each(${JSON.stringify(gone)})`;
  const d = schema.moderationDecisions;
  const ns = schema.moderationNoticeSends;
  const h = schema.legalHolds;
  const a2 = sql`"artifacts"`;
  // The operator's decisions go with what they are about: a year old, about an artifact or a brand
  // no longer in this region or a suspension already pruned, and not held. Their sends follow.
  const decisionGone = sql`case ${d.targetKind}
    when 'artifact' then not exists (select 1 from ${a2} where "artifacts"."id" = ${d.targetId})
    when 'brand' then not exists (select 1 from "owner_brands" where "owner_brands"."owner_id" = ${d.targetId})
    else ${d.suspensionId} is null or not exists (select 1 from ${s} where ${s.id} = ${d.suspensionId}) end`;
  const [, suspensions] = await db.batch([
    db.delete(le).where(sql`${le.artifactId} in (${ids})`),
    db
      .delete(s)
      .where(
        sql`rowid in (select rowid from ${s} where ${s.targetGoneAt} is not null and ${s.targetGoneAt} < ${cutoff} and not ${historyHeld(sql`${s.targetId}`)} limit ${caps.rows})`,
      )
      .returning({ id: s.id }),
    db
      .delete(d)
      .where(
        sql`rowid in (select rowid from ${d} where ${d.createdAt} < ${cutoff} and ${decisionGone} and not ${historyHeld(sql`${d.targetId}`)} limit ${caps.rows})`,
      ),
    db
      .delete(ns)
      .where(
        sql`rowid in (select rowid from ${ns} where not exists (select 1 from ${d} where ${d.id} = ${ns.decisionId}) limit ${caps.rows})`,
      ),
    // A released hold's record stays a year after its release, then goes; it kept no address
    // since the release.
    db
      .delete(h)
      .where(
        sql`rowid in (select rowid from ${h} where ${h.releasedAt} is not null and ${h.releasedAt} < ${cutoff} limit ${caps.rows})`,
      ),
  ]);
  const last = page.at(-1);
  // A full page may have more after it; a short one ends the pass. Rows kept stay behind the
  // cursor until the next pass.
  const resume =
    last && page.length === caps.artifacts && page.some((row) => row.kept)
      ? `${last.at}:${last.artifact_id}`
      : null;
  await resumeAt(db, CURSOR, started, resume, now);
  return { artifacts: gone.length, suspensions: suspensions.length };
}

/**
 * The statements that record when a purged artifact's suspensions lost their target, for the
 * batch that deletes it, on its condition.
 */
export function markArtifactGone(db: Db, artifactId: string, condition: SQL, now: number) {
  const s = schema.suspensions;
  return db
    .update(s)
    .set({ targetGoneAt: now })
    .where(
      sql`${s.kind} = 'artifact' and ${s.targetId} = ${artifactId} and ${s.targetGoneAt} is null and ${condition}`,
    );
}

/** The same for a deleted account's own suspensions, in the batch that finishes its deletion. */
export function markAccountGone(db: Db, userId: string, condition: SQL, now: number) {
  const s = schema.suspensions;
  return db
    .update(s)
    .set({ targetGoneAt: now })
    .where(
      sql`${s.kind} = 'account' and ${s.targetId} = ${userId} and ${s.targetGoneAt} is null and ${condition}`,
    );
}

/**
 * Forgets a deleted account in the records that stay with other people's artifacts, except those
 * of a held artifact, which the hold's release job erases (`runHoldRelease`): who acted in
 * the lifecycle records (null) and in the comment actions, who wrote the "message deleted"
 * markers and the threads others replied to, and who resolved a thread (`ERASED_ACCOUNT`, or null).
 * Run once the account's comments are erased (`eraseAuthorFromThread`), so the markers left are
 * those others replied to. At most `limit` rows per statement; `more` while any statement was full.
 */
export async function eraseAccountTraces(
  db: Db,
  userId: string,
  limit: number = HISTORY_CAPS.rows,
): Promise<{ more: boolean }> {
  const le = schema.lifecycleEvents;
  const e = schema.annotationEvents;
  const th = schema.annotationThreads;
  const m = schema.annotationMessages;
  const results = (await db.batch([
    db
      .update(le)
      .set({ actorId: null })
      .where(
        sql`rowid in (select rowid from ${le} where ${le.actorId} = ${userId} and not ${onHeld(sql`${le.artifactId}`)} limit ${limit})`,
      )
      .returning({ id: le.id }),
    db
      .update(e)
      .set({ actorId: ERASED_ACCOUNT })
      .where(
        sql`${e.id} in (select ${e.id} from ${e} where ${e.actorId} = ${userId} and not ${onHeld(sql`${e.artifactId}`)} limit ${limit})`,
      )
      .returning({ id: e.id }),
    db
      .update(th)
      .set({ resolvedBy: null })
      .where(
        sql`rowid in (select rowid from ${th} where ${th.resolvedBy} = ${userId} and not ${onHeld(sql`${th.artifactId}`)} limit ${limit})`,
      )
      .returning({ id: th.id }),
    db
      .update(th)
      .set({ authorId: ERASED_ACCOUNT })
      .where(
        sql`rowid in (select rowid from ${th} where ${th.authorId} = ${userId} and not ${onHeld(sql`${th.artifactId}`)} limit ${limit})`,
      )
      .returning({ id: th.id }),
    db
      .update(m)
      .set({ authorId: ERASED_ACCOUNT })
      .where(
        sql`rowid in (select rowid from ${m} where ${m.authorId} = ${userId} and ${m.state} = 'deleted' and not exists (select 1 from ${th} join "legal_holds" on "legal_holds"."artifact_id" = ${th.artifactId} and "legal_holds"."released_at" is null where ${th.id} = ${m.threadId}) limit ${limit})`,
      )
      .returning({ id: m.id }),
  ])) as unknown[][];
  return { more: results.some((rows) => rows.length >= limit) };
}

/**
 * Prunes upload and usage history: usage events older than `USAGE_EVENT_RETENTION_DAYS` (only
 * 24-hour windows count them), and closed upload sessions that expired more than
 * `CLOSED_UPLOAD_RETENTION_DAYS` ago once nothing needs them: no multipart upload left for the
 * abort job, and for a session that never committed, no version left for the version pruning.
 */
export async function pruneUploadHistory(
  db: Db,
  now: number,
  limit: number = HISTORY_CAPS.rows,
): Promise<{ usageEvents: number; uploads: number }> {
  const ue = schema.usageEvents;
  const us = schema.uploadSessions;
  const mu = schema.multipartUploads;
  const v = schema.versions;
  const [usage, uploads] = (await db.batch([
    db
      .delete(ue)
      .where(
        sql`${ue.id} in (select ${ue.id} from ${ue} where ${ue.at} < ${daysBefore(now, USAGE_EVENT_RETENTION_DAYS)} limit ${limit})`,
      )
      .returning({ id: ue.id }),
    db
      .delete(us)
      .where(
        sql`${us.id} in (select ${us.id} from ${us} where ${us.state} in ('committed', 'failed', 'aborted', 'expired') and ${us.expiresAt} < ${daysBefore(now, CLOSED_UPLOAD_RETENTION_DAYS)} and not exists (select 1 from ${mu} where ${mu.sessionId} = ${us.id}) and (${us.state} = 'committed' or not exists (select 1 from ${v} where ${v.id} = ${us.versionId})) limit ${limit})`,
      )
      .returning({ id: us.id }),
  ])) as unknown[][];
  return { usageEvents: usage?.length ?? 0, uploads: uploads?.length ?? 0 };
}

/** Deletes storage findings no pass has seen for `STALE_FINDING_DAYS`. */
export async function pruneStaleFindings(
  db: Db,
  now: number,
  limit: number = HISTORY_CAPS.rows,
): Promise<number> {
  const f = schema.storageFindings;
  const deleted = await db
    .delete(f)
    .where(
      sql`rowid in (select rowid from ${f} where ${f.lastSeenAt} < ${daysBefore(now, STALE_FINDING_DAYS)} limit ${limit})`,
    )
    .returning({ r2Key: f.r2Key });
  return deleted.length;
}
