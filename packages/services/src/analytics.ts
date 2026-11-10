// Analytics per artifact (premium plan P8, decision 0007). The content Worker adds up page views
// per artifact and UTC day in memory and hands them here once per window per isolate; they land
// in `artifact_views` in the access database, counts only. The owner side reads them with
// `getArtifactStats`, the one service behind the API route, the MCP tool and `portifact stats`.
// Retention follows the owner's plan through each row's `expires_at`; a plan change moves an
// owner's expiries with an `owner_retention` job, and the jobs Worker prunes what expired.
import { isWorkspaceId } from "@portifact/contracts";
import {
  type AccessDb,
  accessSchema,
  type Db,
  type GlobalDb,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  DAY_MS,
  FREE_RETENTION_DAYS,
  formatDay,
  ok,
  type Result,
  type RetentionPlan,
  requireFeature,
  statsRange,
  utcDay,
} from "@portifact/domain";
import { and, eq, gte, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { authorizeOn, ownerSide } from "./actors.ts";
import { ownerEntitlements } from "./plans.ts";

/** Statements per D1 batch when writing views, well under the 1,000 queries of an invocation. */
export const VIEWS_CHUNK = 200;
/** Rows one prune, erase or retention statement touches, so no statement runs long. */
export const ANALYTICS_ROW_BATCH = 1_000;

/** Views of one artifact on one UTC day, still to be added to its row. */
export interface ViewDelta {
  artifactId: string;
  ownerId: string;
  /** The day's first instant (UTC). */
  day: number;
  /** Views without a session. */
  anonymous: number;
  /**
   * Views with a session, per signed-in visitor, so the write can drop those of a workspace's
   * admins and editors (the owner side). Held only in the isolate's memory until the write.
   */
  signedIn: Record<string, number>;
  /** When the row expires on the owner's plan as delivery read it (`viewsExpireAt`). */
  expiresAt: number;
}

/**
 * Adds each delta to its artifact's row for the day, one upsert per delta, so batches from other
 * isolates and retried batches add up instead of overwriting each other. Views of a workspace's
 * admins and editors are dropped here, with one read of the membership per workspace and batch,
 * never per request. The expiry is set when the row is first written; a plan change moves it
 * with an `owner_retention` job. Nothing is read about the artifact: a batch held across a purge
 * can recreate a counts-only row for a tombstoned ID, which is never shown and expires.
 */
export async function recordViews(
  global: GlobalDb,
  access: AccessDb,
  deltas: readonly ViewDelta[],
): Promise<number> {
  const sides = new Map<string, Set<string>>();
  for (const ownerId of new Set(deltas.map((delta) => delta.ownerId))) {
    if (isWorkspaceId(ownerId)) sides.set(ownerId, new Set(await ownerSide(global, ownerId)));
  }
  const v = accessSchema.artifactViews;
  const statements = deltas.flatMap((delta) => {
    const side = sides.get(delta.ownerId);
    let signedInViews = 0;
    for (const [visitorId, views] of Object.entries(delta.signedIn)) {
      if (visitorId !== delta.ownerId && !side?.has(visitorId)) signedInViews += views;
    }
    const views = delta.anonymous + signedInViews;
    if (views <= 0) return [];
    return [
      access
        .insert(v)
        .values({
          artifactId: delta.artifactId,
          day: utcDay(delta.day),
          ownerId: delta.ownerId,
          views,
          signedInViews,
          expiresAt: delta.expiresAt,
        })
        .onConflictDoUpdate({
          target: [v.artifactId, v.day],
          set: {
            views: sql`${v.views} + excluded.views`,
            signedInViews: sql`${v.signedInViews} + excluded.signed_in_views`,
          },
        }),
    ];
  });
  for (let start = 0; start < statements.length; start += VIEWS_CHUNK) {
    const [first, ...rest] = statements.slice(start, start + VIEWS_CHUNK);
    if (first) {
      await access.batch([first, ...rest] as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    }
  }
  return statements.length;
}

export interface ArtifactStatsInput {
  /** The signed-in user; an admin or editor of the artifact's owner reads its analytics. */
  userId: string;
  artifactId: string;
  /** `YYYY-MM-DD`, validated at the boundary; both optional. */
  from?: string | undefined;
  to?: string | undefined;
  now: number;
}

export interface ArtifactStatsDay {
  date: string;
  views: number;
  signedInViews: number;
  visitors: number | null;
}

export interface ArtifactStats {
  artifactId: string;
  from: string;
  to: string;
  days: ArtifactStatsDay[];
  totals: { views: number; signedInViews: number; visitors: number | null };
  retentionDays: number;
}

/**
 * Access log rows still kept at `now`: up to their expiry, or legacy rows without one within the
 * free 30 days. A row is kept through the instant it expires and pruned after it.
 */
export function keptOpenings(now: number): SQL {
  const e = accessSchema.accessEvents;
  return or(
    gte(e.expiresAt, now),
    and(isNull(e.expiresAt), gte(e.openedAt, now - FREE_RETENTION_DAYS * DAY_MS)),
  ) as SQL;
}

/**
 * An artifact's page views per UTC day over a range and, for `restricted` artifacts, distinct
 * signed-in visitors from the access log (`null` for `public` and `authenticated` ones, which
 * keep no log, even when old openings remain from when they were restricted). Anyone without a
 * role on the owner, a missing artifact and one being purged get `not_found`; a member gets
 * `forbidden`; an owner whose plan lacks `analytics`, `plan_required`. Archived and suspended
 * artifacts keep their numbers. Rows past their expiry are never shown, even before the prune.
 * The cost is fixed: the artifact, the role and the plan in the control database, then at most
 * three reads of the access database whatever the traffic.
 */
export async function getArtifactStats(
  db: RegionalDb,
  access: AccessDb,
  input: ArtifactStatsInput,
): Promise<Result<ArtifactStats>> {
  const [artifact] = await db
    .select({
      ownerId: schema.artifacts.ownerId,
      state: schema.artifacts.state,
      accessMode: schema.artifacts.accessMode,
      createdBy: schema.artifacts.createdBy,
      externalKey: schema.artifacts.externalKey,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  const missing = () => ({ ok: false, code: "not_found", message: "Artifact not found." }) as const;
  if (!artifact || artifact.state === "purging" || artifact.state === "deleted") return missing();
  // The access log's action: the same admins and editors read both.
  const allowed = await authorizeOn(db, input.userId, artifact, "access_log", missing);
  if (!allowed.ok) return allowed;
  const gate = requireFeature(
    await ownerEntitlements(db.global, artifact.ownerId, input.now),
    "analytics",
  );
  if (!gate.ok) return gate;
  const retentionDays = gate.value.limits.accessLogRetentionDays;
  const range = statsRange({ from: input.from, to: input.to, now: input.now, retentionDays });
  if (!range.ok) return range;
  const { from, to } = range.value;

  const v = accessSchema.artifactViews;
  const rows = await access
    .select({ day: v.day, views: v.views, signedInViews: v.signedInViews })
    .from(v)
    .where(
      and(
        eq(v.artifactId, input.artifactId),
        eq(v.ownerId, artifact.ownerId),
        gte(v.day, from),
        lt(v.day, to + DAY_MS),
        gte(v.expiresAt, input.now),
      ),
    );
  const byDay = new Map(rows.map((row) => [row.day, row]));

  const logged = artifact.accessMode === "restricted";
  const visitorsByDay = new Map<number, number>();
  let totalVisitors: number | null = null;
  if (logged) {
    const e = accessSchema.accessEvents;
    const where = and(
      eq(e.artifactId, input.artifactId),
      eq(e.ownerId, artifact.ownerId),
      gte(e.windowStart, from),
      lt(e.windowStart, to + DAY_MS),
      keptOpenings(input.now),
    );
    // Inline integers: D1 binds numbers as reals, which would turn the division fractional.
    const day = sql.raw(String(DAY_MS));
    const dayOf = sql<number>`(${e.windowStart} / ${day}) * ${day}`;
    const [perDay, total] = await access.batch([
      access
        .select({ day: dayOf, visitors: sql<number>`count(distinct ${e.userId})` })
        .from(e)
        .where(where)
        .groupBy(dayOf),
      access
        .select({ visitors: sql<number>`count(distinct ${e.userId})` })
        .from(e)
        .where(where),
    ]);
    for (const row of perDay) visitorsByDay.set(Number(row.day), Number(row.visitors));
    totalVisitors = Number(total[0]?.visitors ?? 0);
  }

  const days: ArtifactStatsDay[] = [];
  for (let day = from; day <= to; day += DAY_MS) {
    const row = byDay.get(day);
    days.push({
      date: formatDay(day),
      views: row?.views ?? 0,
      signedInViews: row?.signedInViews ?? 0,
      visitors: logged ? (visitorsByDay.get(day) ?? 0) : null,
    });
  }
  const sum = (pick: (day: ArtifactStatsDay) => number) =>
    days.reduce((total, day) => total + pick(day), 0);
  return ok({
    artifactId: input.artifactId,
    from: formatDay(from),
    to: formatDay(to),
    days,
    totals: {
      views: sum((day) => day.views),
      signedInViews: sum((day) => day.signedInViews),
      visitors: totalVisitors,
    },
    retentionDays,
  });
}

/**
 * The SQL for `retentionExpiry` (@portifact/domain) over a column: the same rule, applied to
 * every row of an owner by `applyOwnerRetention`.
 */
function expirySql(base: SQL, plan: RetentionPlan): SQL {
  const kept = plan.limits.accessLogRetentionDays * DAY_MS;
  const free = FREE_RETENTION_DAYS * DAY_MS;
  if (plan.validUntil === null || kept <= free) return sql`(${base} + ${kept})`;
  return sql`min(${base} + ${kept}, max(${base} + ${free}, ${plan.validUntil}))`;
}

/**
 * Moves the expiry of an owner's view rows and access log rows to its plan at `now` (the
 * `owner_retention` job a plan grant or removal writes). A lower plan shortens what is kept, so
 * the next prune deletes what the new plan does not keep; a higher one extends the rows still
 * there (rows already pruned do not come back). Bounded statements that only touch rows whose
 * expiry differs, so running it again changes nothing; `pending` asks the job to run again.
 */
export async function applyOwnerRetention(
  db: RegionalDb,
  access: AccessDb,
  ownerId: string,
  now: number,
  rounds = 10,
): Promise<"done" | "pending"> {
  const plan = await ownerEntitlements(db.global, ownerId, now);
  const v = accessSchema.artifactViews;
  const e = accessSchema.accessEvents;
  const viewsExpiry = expirySql(sql`${v.day} + ${DAY_MS}`, plan);
  const openingsExpiry = expirySql(sql`${e.openedAt}`, plan);
  let done = 0;
  for (let round = 0; round < rounds && done < 2; round += 1) {
    done = 0;
    const views = await access
      .update(v)
      .set({ expiresAt: viewsExpiry })
      .where(
        sql`(${v.artifactId}, ${v.day}) in (select ${v.artifactId}, ${v.day} from ${v} where ${v.ownerId} = ${ownerId} and ${v.expiresAt} <> ${viewsExpiry} limit ${ANALYTICS_ROW_BATCH})`,
      )
      .returning({ day: v.day });
    if (views.length < ANALYTICS_ROW_BATCH) done += 1;
    const openings = await access
      .update(e)
      .set({ expiresAt: openingsExpiry })
      .where(
        sql`rowid in (select rowid from ${e} where ${e.ownerId} = ${ownerId} and ${e.expiresAt} is not ${openingsExpiry} limit ${ANALYTICS_ROW_BATCH})`,
      )
      .returning({ userId: e.userId });
    if (openings.length < ANALYTICS_ROW_BATCH) done += 1;
  }
  return done === 2 ? "done" : "pending";
}

/**
 * Gives an artifact's access log and view rows to the owner it has now, kept by that owner's plan
 * (the `access_history_move` job a transfer writes): the history follows the artifact, so the
 * people who manage it now see who opened it before the move. It always converges on the current
 * owner, so a stale or repeated job changes nothing; a purged artifact has nothing left to move.
 * Bounded statements; `pending` asks the job to run again.
 */
export async function moveAccessHistory(
  db: RegionalDb,
  access: AccessDb,
  artifactId: string,
  now: number,
  rounds = 10,
): Promise<"done" | "pending"> {
  const [artifact] = await db
    .select({ ownerId: schema.artifacts.ownerId })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, artifactId))
    .limit(1);
  if (!artifact) return "done";
  const owner = artifact.ownerId;
  const plan = await ownerEntitlements(db.global, owner, now);
  const v = accessSchema.artifactViews;
  const e = accessSchema.accessEvents;
  const viewsExpiry = expirySql(sql`${v.day} + ${DAY_MS}`, plan);
  const openingsExpiry = expirySql(sql`${e.openedAt}`, plan);
  let done = 0;
  for (let round = 0; round < rounds && done < 2; round += 1) {
    done = 0;
    const views = await access
      .update(v)
      .set({ ownerId: owner, expiresAt: viewsExpiry })
      .where(
        sql`(${v.artifactId}, ${v.day}) in (select ${v.artifactId}, ${v.day} from ${v} where ${v.artifactId} = ${artifactId} and (${v.ownerId} <> ${owner} or ${v.expiresAt} <> ${viewsExpiry}) limit ${ANALYTICS_ROW_BATCH})`,
      )
      .returning({ day: v.day });
    if (views.length < ANALYTICS_ROW_BATCH) done += 1;
    const openings = await access
      .update(e)
      .set({ ownerId: owner, expiresAt: openingsExpiry })
      .where(
        sql`rowid in (select rowid from ${e} where ${e.artifactId} = ${artifactId} and (${e.ownerId} <> ${owner} or ${e.expiresAt} is not ${openingsExpiry}) limit ${ANALYTICS_ROW_BATCH})`,
      )
      .returning({ userId: e.userId });
    if (openings.length < ANALYTICS_ROW_BATCH) done += 1;
  }
  return done === 2 ? "done" : "pending";
}

/** Inserts an `access_history_move` job for an artifact when `condition` holds. */
export function accessHistoryMoveJob(db: Db, artifactId: string, condition: SQL, now: number) {
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'access_history_move', '{}', ${now}, null, 0, ${now}, ${artifactId}, null where ${condition}`,
    );
}

/**
 * Inserts an `owner_retention` job for an owner when `condition` holds. Put it in the batch that
 * changes the owner's plan, on the same condition.
 */
export function ownerRetentionJob(db: Db, ownerId: string, condition: SQL, now: number) {
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'owner_retention', '{}', ${now}, null, 0, ${now}, ${ownerId}, null where ${condition}`,
    );
}

/**
 * Deletes view rows of a purged artifact in bounded statements (part of its
 * `erase_access_events` job). `pending` when `rounds` statements did not reach the end.
 */
export async function eraseArtifactViews(
  access: AccessDb,
  artifactId: string,
  rounds = 10,
): Promise<"done" | "pending"> {
  const v = accessSchema.artifactViews;
  for (let round = 0; round < rounds; round += 1) {
    const deleted = await access
      .delete(v)
      .where(
        sql`${v.artifactId} = ${artifactId} and ${v.day} in (select ${v.day} from ${v} where ${v.artifactId} = ${artifactId} limit ${ANALYTICS_ROW_BATCH})`,
      )
      .returning({ day: v.day });
    if (deleted.length < ANALYTICS_ROW_BATCH) return "done";
  }
  return "pending";
}

/** Deletes view rows past their expiry, at most `rounds` bounded statements per run. */
export async function pruneArtifactViews(access: AccessDb, now: number, rounds = 10) {
  const v = accessSchema.artifactViews;
  let pruned = 0;
  for (let round = 0; round < rounds; round += 1) {
    const deleted = await access
      .delete(v)
      .where(
        sql`(${v.artifactId}, ${v.day}) in (select ${v.artifactId}, ${v.day} from ${v} where ${v.expiresAt} < ${now} limit ${ANALYTICS_ROW_BATCH})`,
      )
      .returning({ day: v.day });
    pruned += deleted.length;
    if (deleted.length < ANALYTICS_ROW_BATCH) break;
  }
  return pruned;
}
