// The owner's read of an artifact's numbers: the one service behind `GET
// /api/v1/artifacts/:id/stats`, the MCP tool `get_artifact_stats` and `portifact stats`, so the
// three show the same numbers. One control read (owner, mode, state, plan) and one or two access
// reads, whatever the range: the cost of a dashboard load does not grow with traffic.
import { DAY_MS, utcDay } from "./views.ts";

/**
 * What the spike needs of `PLANS`: whether the plan has the `analytics` feature, and how long it
 * keeps the numbers. Production reads both from `entitlements` and reuses
 * `accessLogRetentionDays`, so the Privacy Policy states one retention for both.
 */
export const ANALYTICS_RETENTION_DAYS: Readonly<Record<string, number | null>> = {
  free: null,
  pro: 365,
  team: 365,
  enterprise: 365,
};

export function analyticsRetention(plan: string | null): number | null {
  return ANALYTICS_RETENTION_DAYS[plan ?? "free"] ?? null;
}

/** The longest range one read returns. */
export const MAX_RANGE_DAYS = 366;

export interface StatsDay {
  day: number;
  views: number;
  signedInViews: number;
  /** Distinct signed-in visitors from the access log; null when the artifact keeps no log. */
  visitors: number | null;
}

export interface ArtifactStats {
  artifactId: string;
  from: number;
  to: number;
  days: StatsDay[];
  totals: { views: number; signedInViews: number; visitors: number | null };
}

export type StatsResult =
  | { ok: true; stats: ArtifactStats }
  | { ok: false; code: "not_found" | "plan_required" | "invalid_input" };

export interface StatsInput {
  /** The acting user, from the session or token, never from input. */
  actorId: string;
  artifactId: string;
  /** Any instants; both are rounded to their UTC day and the range includes both days. */
  from: number;
  to: number;
  now: number;
}

interface ArtifactRow {
  owner_id: string;
  access_mode: string;
  state: string;
  plan: string | null;
}

export async function getArtifactStats(
  control: D1Database,
  access: D1Database,
  input: StatsInput,
): Promise<StatsResult> {
  const artifact = await control
    .prepare(
      `select a.owner_id, a.access_mode, a.state, p.plan from artifacts a
       left join owner_plans p on p.owner_id = a.owner_id where a.id = ?`,
    )
    .bind(input.artifactId)
    .first<ArtifactRow>();
  // Anyone but the owner, and an artifact being purged, gets exactly what a missing one gets.
  if (!artifact || artifact.owner_id !== input.actorId || artifact.state === "purging") {
    return { ok: false, code: "not_found" };
  }
  const retention = analyticsRetention(artifact.plan);
  if (retention === null) return { ok: false, code: "plan_required" };

  const today = utcDay(input.now);
  const from = Math.max(utcDay(input.from), today - retention * DAY_MS);
  const to = Math.min(utcDay(input.to), today);
  if (from > to || (to - from) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return { ok: false, code: "invalid_input" };
  }

  const views = await access
    .prepare(
      `select day, views, signed_in_views from artifact_views
       where artifact_id = ? and day >= ? and day <= ? and expires_at > ? order by day`,
    )
    .bind(input.artifactId, from, to, input.now)
    .all<{ day: number; views: number; signed_in_views: number }>();
  const byDay = new Map(views.results.map((row) => [row.day, row]));

  // Distinct visitors exist only where the access log names them: `restricted` artifacts.
  const logged = artifact.access_mode === "restricted";
  const visitorsByDay = new Map<number, number>();
  let totalVisitors: number | null = null;
  if (logged) {
    const [perDay, total] = await access.batch<{ day: number; visitors: number }>([
      access
        .prepare(
          `select (window_start / ${DAY_MS}) * ${DAY_MS} as day, count(distinct user_id) as visitors
           from access_events where artifact_id = ? and window_start >= ? and window_start < ?
           and expires_at > ? group by day`,
        )
        .bind(input.artifactId, from, to + DAY_MS, input.now),
      access
        .prepare(
          `select 0 as day, count(distinct user_id) as visitors from access_events
           where artifact_id = ? and window_start >= ? and window_start < ? and expires_at > ?`,
        )
        .bind(input.artifactId, from, to + DAY_MS, input.now),
    ]);
    for (const row of perDay?.results ?? []) visitorsByDay.set(row.day, row.visitors);
    totalVisitors = total?.results[0]?.visitors ?? 0;
  }

  const days: StatsDay[] = [];
  for (let day = from; day <= to; day += DAY_MS) {
    const row = byDay.get(day);
    days.push({
      day,
      views: row?.views ?? 0,
      signedInViews: row?.signed_in_views ?? 0,
      visitors: logged ? (visitorsByDay.get(day) ?? 0) : null,
    });
  }
  const sum = (pick: (day: StatsDay) => number) => days.reduce((n, day) => n + pick(day), 0);
  return {
    ok: true,
    stats: {
      artifactId: input.artifactId,
      from,
      to,
      days,
      totals: {
        views: sum((day) => day.views),
        signedInViews: sum((day) => day.signedInViews),
        visitors: totalVisitors,
      },
    },
  };
}
