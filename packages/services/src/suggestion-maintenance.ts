// The maintenance scans of edit suggestions (decision 0027, "Costs and limits", "Withdrawal,
// deletion and retention"), run in every region. Each reads only rows it can return, through its
// own index (migration 0079 and the indexes of 0077), never a prefix of rows it skips:
//
// - `expireAcceptAttempts` ends acceptance attempts still running after 3 deliveries or 30
//   minutes (`failed`): the suggestion is pending again, its upload released. Two indexed
//   selections, one per reason.
// - `pruneSuggestionRecords` deletes what has a lifetime: cached plans past their 10 minutes
//   (caches: deleted on held artifacts too, as an account deletion does), finished attempts with
//   their claims after 30 days, closed change items 90 days after closing and drafts nobody saved
//   for 30 days. The last three are kept on a held artifact: each walks its due rows in index
//   order from a cursor (time and row ID), so a held row is read once per pass, never again at
//   the head of every run.
// - `pruneDraftsWithoutRole` deletes the drafts of people who no longer act for the artifact's
//   owner, seeking the drafts from a cursor on their primary key and reading the memberships from
//   the global database in chunks.
//
// Preview codes are the preview delivery's (`prunePreviewCodes`).
import {
  CHANGE_LIST_LIMITS,
  DRAFT_LIMITS,
  isWorkspaceId,
  SUGGESTION_LIMITS,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { notHeldSql } from "./legal-holds.ts";
import { type ScanCaps, saveCursor } from "./maintenance-cursors.ts";
import { endAttempt } from "./suggestion-accept.ts";

const at = schema.acceptanceAttempts;
const dr = schema.editDrafts;
const ci = schema.changeItems;
const mc = schema.maintenanceCursors;
const DAY_MS = 86_400_000;
const PRUNE_BATCH = 500;
const EXPIRE_BATCH = 50;

/**
 * The running attempts each reason makes overdue, each read through its own partial index
 * (migration 0079), named with `indexed by` so the planner never walks `(state, updated_at)`.
 */
export function overdueAttemptQueries(now: number, limit: number): SQL[] {
  const columns = sql.raw(`"id", "artifact_id" as "artifactId", "owner_id" as "ownerId", "origin"`);
  return [
    sql`select ${columns} from "acceptance_attempts" indexed by "acceptance_attempts_running_deliveries_idx" where "state" = 'running' and "deliveries" >= ${SUGGESTION_LIMITS.attemptDeliveries} order by "deliveries" limit ${limit}`,
    sql`select ${columns} from "acceptance_attempts" indexed by "acceptance_attempts_running_created_idx" where "state" = 'running' and "created_at" <= ${now - SUGGESTION_LIMITS.attemptMs} order by "created_at" limit ${limit}`,
  ];
}

type OverdueAttempt = {
  id: string;
  artifactId: string;
  ownerId: string;
  origin: "suggestion" | "draft";
};

/** Ends attempts still running after their deliveries or their time. */
export async function expireAcceptAttempts(
  db: RegionalDb,
  now: number,
  limit = EXPIRE_BATCH,
): Promise<{ ended: number }> {
  const found: OverdueAttempt[] = [];
  for (const query of overdueAttemptQueries(now, limit))
    found.push(...(await db.all<OverdueAttempt>(query)));
  const overdue = [...new Map(found.map((row) => [row.id, row])).values()].slice(0, limit);
  for (const attempt of overdue) await endAttempt(db, attempt, "failed", now);
  return { ended: overdue.length };
}

/** A retention sweep: due rows walked by `(time, rowid)` from a saved cursor. */
interface Sweep {
  name: string;
  table: typeof at | typeof ci | typeof dr;
  time: SQL;
  due: SQL;
  artifactId: SQL;
}

const sweeps = (now: number): Sweep[] => [
  {
    name: "suggestion_attempts_retention",
    table: at,
    time: sql`"acceptance_attempts"."created_at"`,
    due: sql`"acceptance_attempts"."state" <> 'running' and "acceptance_attempts"."created_at" <= ${now - SUGGESTION_LIMITS.attemptRetentionMs}`,
    artifactId: sql`"acceptance_attempts"."artifact_id"`,
  },
  {
    name: "suggestion_items_retention",
    table: ci,
    time: sql`"change_items"."closed_at"`,
    due: sql`"change_items"."closed_at" is not null and "change_items"."closed_at" <= ${now - CHANGE_LIST_LIMITS.closedRetentionDays * DAY_MS}`,
    artifactId: sql`"change_items"."artifact_id"`,
  },
  {
    name: "suggestion_drafts_retention",
    table: dr,
    time: sql`"edit_drafts"."updated_at"`,
    due: sql`"edit_drafts"."updated_at" <= ${now - DRAFT_LIMITS.unusedDays * DAY_MS} and "edit_drafts"."attempt_id" is null`,
    artifactId: sql`"edit_drafts"."artifact_id"`,
  },
];

/** A sweep's cursor, `<time>:<rowid>`, or the start. */
function parseCursor(text: string | undefined): [number, number] {
  const [time, rowid] = (text ?? "").split(":").map(Number);
  return Number.isSafeInteger(time) && Number.isSafeInteger(rowid)
    ? [time as number, rowid as number]
    : [-1, -1];
}

/** The page of a sweep after its cursor: rowid, time and whether its artifact is free of holds. */
export function sweepPage(db: RegionalDb, sweep: Sweep, after: [number, number], limit: number) {
  return sql`select rowid as rowid, ${sweep.time} as time, ${notHeldSql(sweep.artifactId)} as free from ${sweep.table} where ${sweep.due} and (${sweep.time}, rowid) > (${after[0]}, ${after[1]}) order by ${sweep.time}, rowid limit ${limit}`;
}

/** The retention sweeps' selections, for tests that read their query plans and rows read. */
export const retentionSweeps = sweeps;

/** Deletes cached plans, finished attempts, closed items and unused drafts past their time. */
export async function pruneSuggestionRecords(
  db: RegionalDb,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ plans: number; attempts: number; items: number; drafts: number }> {
  const sp = schema.suggestionPlans;
  const list = sweeps(now);
  const cursors = await db
    .select({ name: mc.name, cursor: mc.cursor })
    .from(mc)
    .where(
      inArray(
        mc.name,
        list.map((sweep) => sweep.name),
      ),
    );
  const saved = new Map(cursors.map((row) => [row.name, row.cursor]));
  const pages: { rowid: number; time: number; free: number }[][] = [];
  for (const sweep of list) {
    pages.push(
      await db.all<{ rowid: number; time: number; free: number }>(
        sweepPage(db, sweep, parseCursor(saved.get(sweep.name)), limit),
      ),
    );
  }
  const deletes = list.map((sweep, index) => {
    const free = (pages[index] ?? []).filter((row) => Number(row.free) === 1);
    const rowids =
      free.length === 0
        ? sql`(null)`
        : sql`(${sql.join(
            free.map((row) => sql`${row.rowid}`),
            sql`, `,
          )})`;
    // Deleted only while still due and not held, by the rows the page read.
    return db
      .delete(sweep.table)
      .where(sql`rowid in ${rowids} and ${sweep.due} and ${notHeldSql(sweep.artifactId)}`)
      .returning({ one: sql<number>`1` });
  });
  const [plans, attempts, items, drafts] = await db.batch([
    db
      .delete(sp)
      .where(
        sql`(${sp.userId}, ${sp.digest}) in (select ${sp.userId}, ${sp.digest} from ${sp} where ${sp.expiresAt} <= ${now} order by ${sp.expiresAt} limit ${limit})`,
      )
      .returning({ id: sp.digest }),
    ...(deletes as [(typeof deletes)[0], (typeof deletes)[0], (typeof deletes)[0]]),
  ]);
  // Each cursor moves past the page it read; a page shorter than the limit ends the pass.
  for (const [index, sweep] of list.entries()) {
    const page = pages[index] ?? [];
    const last = page.at(-1);
    const next = page.length === limit && last ? `${last.time}:${last.rowid}` : "";
    if (next !== (saved.get(sweep.name) ?? "")) await saveCursor(db, sweep.name, next, now);
  }
  return {
    plans: plans.length,
    attempts: attempts.length,
    items: items.length,
    drafts: drafts.length,
  };
}

const DRAFT_SCAN = "suggestion_drafts_roles";
const DRAFT_CAPS: ScanCaps = { pageSize: 200, maxPages: 1 };

/** The drafts after `(artifactId, userId)` in primary-key order: a seek, never a prefix scan. */
export function draftPage(db: RegionalDb, after: [string, string], pageSize: number) {
  return db
    .select({ artifactId: dr.artifactId, userId: dr.userId, ownerId: dr.ownerId })
    .from(dr)
    .where(sql`(${dr.artifactId}, ${dr.userId}) > (${after[0]}, ${after[1]})`)
    .orderBy(dr.artifactId, dr.userId)
    .limit(pageSize);
}

/**
 * Deletes the drafts of people who no longer act for their artifact's owner: in a personal space
 * only its own account drafts; in a workspace, its admins and editors. Pages the drafts from a
 * cursor; one global read per chunk of people. A draft with a running publish is left to its
 * job, which ends the attempt as `revoked`; a held artifact's drafts are kept.
 */
export async function pruneDraftsWithoutRole(
  db: RegionalDb,
  now: number,
  caps: ScanCaps = DRAFT_CAPS,
): Promise<{ deleted: number }> {
  const [cursor] = await db.select({ cursor: mc.cursor }).from(mc).where(eq(mc.name, DRAFT_SCAN));
  const started = cursor?.cursor ?? "";
  const [afterArtifact = "", afterUser = ""] = started.split("|");
  const rows = await draftPage(db, [afterArtifact, afterUser], caps.pageSize);
  const lost = rows.filter((row) => !isWorkspaceId(row.ownerId) && row.ownerId !== row.userId);
  const workspace = rows.filter((row) => isWorkspaceId(row.ownerId));
  const acting = new Set<string>();
  for (let i = 0; i < workspace.length; i += 40) {
    const chunk = workspace.slice(i, i + 40);
    const m = schema.workspaceMembers;
    const members = await db.global
      .select({ workspaceId: m.workspaceId, userId: m.userId })
      .from(m)
      .where(
        and(
          inArray(m.userId, [...new Set(chunk.map((row) => row.userId))]),
          inArray(m.workspaceId, [...new Set(chunk.map((row) => row.ownerId))]),
          inArray(m.role, ["admin", "editor"]),
        ),
      );
    for (const member of members) acting.add(`${member.workspaceId}|${member.userId}`);
  }
  for (const row of workspace) {
    if (!acting.has(`${row.ownerId}|${row.userId}`)) lost.push(row);
  }
  const deletes = lost.map((row) =>
    db
      .delete(dr)
      .where(
        and(
          eq(dr.artifactId, row.artifactId),
          eq(dr.userId, row.userId),
          eq(dr.ownerId, row.ownerId),
          isNull(dr.attemptId),
          notHeldSql(sql`${dr.artifactId}`),
        ),
      )
      .returning({ id: dr.userId }),
  );
  const [first, ...rest] = deletes;
  const results = first ? await db.batch([first, ...rest]) : [];
  const deleted = results.reduce((sum, gone) => sum + gone.length, 0);
  const last = rows.at(-1);
  const next = rows.length === caps.pageSize && last ? `${last.artifactId}|${last.userId}` : "";
  if (next !== started) await saveCursor(db, DRAFT_SCAN, next, now);
  return { deleted };
}
