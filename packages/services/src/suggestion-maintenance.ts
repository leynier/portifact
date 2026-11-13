// The maintenance scans of edit suggestions (decision 0027, "Costs and limits", "Withdrawal,
// deletion and retention"), run in every region:
//
// - `expireAcceptAttempts` ends acceptance attempts still running after their deliveries or 30
//   minutes (`failed`): the suggestion is pending again, its upload released.
// - `pruneSuggestionRecords` deletes what has a lifetime: cached plans past their 10 minutes,
//   finished attempts (and their claims) after 30 days, closed change items 90 days after closing
//   and drafts nobody saved for 30 days. Each is one bounded delete over its own index; nothing of
//   a held artifact is deleted.
// - `pruneDraftsWithoutRole` deletes the drafts of people who no longer act for the artifact's
//   owner (they left the workspace, were removed or lost their role), paging the drafts from a
//   cursor and reading the memberships from the global database in chunks.
//
// Preview codes are the preview delivery's (their issuing, redemption and pruning).
import {
  CHANGE_LIST_LIMITS,
  DRAFT_LIMITS,
  isWorkspaceId,
  SUGGESTION_LIMITS,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { notHeldSql } from "./legal-holds.ts";
import { cursorFor, resumeAt, type ScanCaps } from "./maintenance-cursors.ts";
import { endAttempt } from "./suggestion-accept.ts";

const at = schema.acceptanceAttempts;
const dr = schema.editDrafts;
const DAY_MS = 86_400_000;
const PRUNE_BATCH = 500;
const EXPIRE_BATCH = 50;

/** Ends attempts still running after their deliveries or their time, oldest first. */
export async function expireAcceptAttempts(
  db: RegionalDb,
  now: number,
  limit = EXPIRE_BATCH,
): Promise<{ ended: number }> {
  const overdue = await db
    .select()
    .from(at)
    .where(
      and(
        eq(at.state, "running"),
        or(
          gte(at.deliveries, SUGGESTION_LIMITS.attemptDeliveries),
          lte(at.createdAt, now - SUGGESTION_LIMITS.attemptMs),
        ),
      ),
    )
    .orderBy(asc(at.updatedAt))
    .limit(limit);
  for (const attempt of overdue) await endAttempt(db, attempt, "failed", now);
  return { ended: overdue.length };
}

/** The artifacts row of a pruned row, so the hold rule reads its own artifact. */
const heldFree = (artifactId: unknown) => notHeldSql(sql`${artifactId}`);

/** Deletes cached plans, finished attempts, closed items and unused drafts past their time. */
export async function pruneSuggestionRecords(
  db: RegionalDb,
  now: number,
  limit = PRUNE_BATCH,
): Promise<{ plans: number; attempts: number; items: number; drafts: number }> {
  const sp = schema.suggestionPlans;
  const ci = schema.changeItems;
  const [plans, attempts, items, drafts] = await db.batch([
    db
      .delete(sp)
      .where(
        sql`(${sp.userId}, ${sp.digest}) in (select ${sp.userId}, ${sp.digest} from ${sp} where ${sp.expiresAt} <= ${now} limit ${limit})`,
      )
      .returning({ id: sp.digest }),
    // Finished attempts (their claims go by cascade); a running one is ended first.
    db
      .delete(at)
      .where(
        inArray(
          at.id,
          db
            .select({ id: at.id })
            .from(at)
            .where(
              and(
                sql`${at.state} <> 'running'`,
                lte(at.createdAt, now - SUGGESTION_LIMITS.attemptRetentionMs),
                heldFree(at.artifactId),
              ),
            )
            .limit(limit),
        ),
      )
      .returning({ id: at.id }),
    db
      .delete(ci)
      .where(
        inArray(
          ci.id,
          db
            .select({ id: ci.id })
            .from(ci)
            .where(
              and(
                lte(ci.closedAt, now - CHANGE_LIST_LIMITS.closedRetentionDays * DAY_MS),
                heldFree(ci.artifactId),
              ),
            )
            .limit(limit),
        ),
      )
      .returning({ id: ci.id }),
    db
      .delete(dr)
      .where(
        sql`(${dr.artifactId}, ${dr.userId}) in (select ${dr.artifactId}, ${dr.userId} from ${dr} where ${dr.updatedAt} <= ${now - DRAFT_LIMITS.unusedDays * DAY_MS} and ${dr.attemptId} is null and ${heldFree(dr.artifactId)} limit ${limit})`,
      )
      .returning({ id: dr.userId }),
  ]);
  return {
    plans: plans.length,
    attempts: attempts.length,
    items: items.length,
    drafts: drafts.length,
  };
}

const DRAFT_SCAN = "suggestion_drafts_roles";
const DRAFT_CAPS: ScanCaps = { pageSize: 200, maxPages: 1 };

/**
 * Deletes the drafts of people who no longer act for their artifact's owner: in a personal space
 * only its own account drafts; in a workspace, its admins and editors. Pages the drafts from a
 * cursor; one global read per chunk of people. A draft with a running publish is left to its
 * job, which ends the attempt as `revoked`.
 */
export async function pruneDraftsWithoutRole(
  db: RegionalDb,
  now: number,
  caps: ScanCaps = DRAFT_CAPS,
): Promise<{ deleted: number }> {
  const started = await cursorFor(db, DRAFT_SCAN);
  const [afterArtifact, afterUser] = started === "" ? ["", ""] : started.split("|");
  const rows = await db
    .select({ artifactId: dr.artifactId, userId: dr.userId, ownerId: dr.ownerId })
    .from(dr)
    .where(
      started === ""
        ? undefined
        : or(
            gt(dr.artifactId, afterArtifact as string),
            and(eq(dr.artifactId, afterArtifact as string), gt(dr.userId, afterUser as string)),
          ),
    )
    .orderBy(asc(dr.artifactId), asc(dr.userId))
    .limit(caps.pageSize);
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
          heldFree(dr.artifactId),
        ),
      )
      .returning({ id: dr.userId }),
  );
  const [first, ...rest] = deletes;
  const results = first ? await db.batch([first, ...rest]) : [];
  const deleted = results.reduce((sum, gone) => sum + gone.length, 0);
  const last = rows.at(-1);
  await resumeAt(
    db,
    DRAFT_SCAN,
    started,
    rows.length === caps.pageSize && last ? `${last.artifactId}|${last.userId}` : null,
    now,
  );
  return { deleted };
}
