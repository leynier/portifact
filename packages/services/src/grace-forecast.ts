// What a running plan grace will let go (decision 0022, second delivery): for the space's
// "Download your data" page, per kind, how many items and from when. Counts only, owner-scoped,
// read on this route alone: nothing here is on another request path. The kinds and dates come from
// `graceForecastSteps` (@portifact/domain); each count is one bounded query on the owner's rows.
import { GRACE_FORECAST_LIMITS, type GraceForecastKind } from "@portifact/contracts";
import {
  type AccessDb,
  accessSchema,
  bothSides,
  type Db,
  hitRateLimit,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  type Actor,
  auditPruneCutoff,
  authorize,
  type Entitlements,
  entitlements,
  fail,
  type GraceForecastStep,
  graceForecastSteps,
  ok,
  type Result,
  versionRetention,
} from "@portifact/domain";
import { and, count, eq, gte, inArray, lt, not } from "drizzle-orm";
import { ownerPlanRecord } from "./plans.ts";
import { previousRetainedSql } from "./retention.ts";

export interface GraceForecast {
  ownerId: string;
  /** The owner's entitlements, whose `grace` is the running grace or null. */
  owner: Entitlements;
  kinds: { kind: GraceForecastKind; count: number; from: number }[];
}

/**
 * What the owner's running grace will let go, for the actor's own space: authorized like the usage
 * body (`usage`: the owner's admins and editors, and its service tokens), since it holds counts and
 * dates only. Without a grace, no kinds.
 */
export async function getGraceForecast(
  db: RegionalDb,
  access: AccessDb,
  input: { actor: Actor; now: number },
): Promise<Result<GraceForecast>> {
  const allowed = authorize(input.actor, "usage");
  if (!allowed.ok) return allowed;
  // Each kind is a count over the owner's rows: bounded per person or token, after authorization.
  const hit = await hitRateLimit(
    db.global.$client,
    `grace-forecast:${input.actor.userId}`,
    60_000,
    input.now,
  );
  if (hit.count > GRACE_FORECAST_LIMITS.perActorPerMinute) {
    return fail("rate_limited", "Too many requests for this forecast. Try again in a minute.");
  }
  const ownerId = input.actor.ownerId;
  return ok({ ownerId, ...(await graceForecastKinds(db, access, ownerId, input.now)) });
}

/**
 * The counts behind the forecast, for one owner, without authorization or rate limit: the route
 * above checks both, and the grace emails (decision 0022, third delivery) count the same way from
 * their job. One entry per step of `graceForecastSteps` (a kind can go in several steps, one per
 * hold end at which its retention drops), each counting exactly what the scans delete when the
 * clock passes that step: what the retention just before kept and the one from then on does not.
 * One bounded count per step on the owner's rows, never a read per artifact.
 */
export async function graceForecastKinds(
  db: RegionalDb,
  access: AccessDb,
  ownerId: string,
  now: number,
): Promise<Omit<GraceForecast, "ownerId">> {
  const record = await ownerPlanRecord(db.global, ownerId);
  const owner = entitlements(record, now);
  const kinds: GraceForecast["kinds"] = [];
  for (const step of graceForecastSteps(record, now)) {
    const { from, before, after } = step;
    if (step.kind === "versions") {
      kinds.push({ kind: "versions", count: await droppedVersions(db, ownerId, step), from });
    } else if (step.kind === "accessLog") {
      const [openings, days] = await expiringAt(access, ownerId, from);
      kinds.push({ kind: "accessLog", count: openings, from });
      kinds.push({ kind: "analytics", count: days, from });
    } else if (step.kind === "auditEvents") {
      // The sweep deletes events older than the retention in force: until `from` the one before,
      // from then on the one after.
      const window = {
        from: auditPruneCutoff(before.auditRetentionDays, from),
        to: auditPruneCutoff(after.auditRetentionDays, from),
      };
      kinds.push({
        kind: "auditEvents",
        // The owner's events live in its region and, for global rows, the global database; with
        // one database both are the same rows, counted once.
        count: bothSides(db)
          ? await eventsBetween(db, ownerId, window)
          : (await eventsBetween(db, ownerId, window)) +
            (await eventsBetween(db.global, ownerId, window)),
        from,
      });
    } else {
      kinds.push({ kind: "pins", count: await pinnedArtifacts(db, ownerId), from });
    }
  }
  return { owner, kinds };
}

/** Previous versions the retention just before `from` keeps and the one from then on does not. */
async function droppedVersions(
  db: RegionalDb,
  ownerId: string,
  step: GraceForecastStep,
): Promise<number> {
  const v = schema.versions;
  const a = schema.artifacts;
  const [row] = await db
    .select({ n: count() })
    .from(v)
    .innerJoin(a, eq(a.id, v.artifactId))
    .where(
      and(
        eq(a.ownerId, ownerId),
        inArray(a.state, ["active", "archived", "suspended"]),
        previousRetainedSql(versionRetention(step.before), step.from),
        not(previousRetainedSql(versionRetention(step.after), step.from)),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Access log openings and analytics day counters dated to go exactly at `from`: a row's expiry is
 * the moment the retention in force no longer keeps it (`retentionExpiry`), so a drop at a hold's
 * end dates every row it lets go to that end, and the prune deletes them once it has passed.
 */
async function expiringAt(
  access: AccessDb,
  ownerId: string,
  from: number,
): Promise<[number, number]> {
  const e = accessSchema.accessEvents;
  const v = accessSchema.artifactViews;
  const [openings, days] = await access.batch([
    access
      .select({ n: count() })
      .from(e)
      .where(and(eq(e.ownerId, ownerId), eq(e.expiresAt, from))),
    access
      .select({ n: count() })
      .from(v)
      .where(and(eq(v.ownerId, ownerId), eq(v.expiresAt, from))),
  ]);
  return [Number(openings[0]?.n ?? 0), Number(days[0]?.n ?? 0)];
}

/** The owner's audit events in one database recorded in `[from, to)`. */
async function eventsBetween(
  db: Db,
  ownerId: string,
  window: { from: number; to: number },
): Promise<number> {
  const ae = schema.auditEvents;
  const [row] = await db
    .select({ n: count() })
    .from(ae)
    .where(and(eq(ae.ownerId, ownerId), gte(ae.at, window.from), lt(ae.at, window.to)));
  return Number(row?.n ?? 0);
}

/** The owner's pinned artifacts that are still active (the unpin scan's targets). */
async function pinnedArtifacts(db: RegionalDb, ownerId: string): Promise<number> {
  const a = schema.artifacts;
  const [row] = await db
    .select({ n: count() })
    .from(a)
    .where(and(eq(a.ownerId, ownerId), eq(a.pinned, true), eq(a.state, "active")));
  return Number(row?.n ?? 0);
}
