// What a running plan grace will let go (decision 0022, second delivery): for the space's
// "Download your data" page, per kind, how many items and from when. Counts only, owner-scoped,
// read on this route alone: nothing here is on another request path. The kinds and dates come from
// `graceForecastSteps` (@portifact/domain); each count is one bounded query on the owner's rows.
import type { GraceForecastKind } from "@portifact/contracts";
import {
  type AccessDb,
  accessSchema,
  bothSides,
  type Db,
  type RegionalDb,
  schema,
} from "@portifact/db";
import {
  type Actor,
  auditPruneCutoff,
  authorize,
  type Entitlements,
  entitlements,
  graceForecastSteps,
  ok,
  ownEntitlements,
  type Result,
  versionRetention,
} from "@portifact/domain";
import { and, count, eq, gt, inArray, lt, lte, not } from "drizzle-orm";
import { ownerPlanRecord } from "./plans.ts";
import { previousRetainedSql } from "./retention.ts";

export interface GraceForecast {
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
  const ownerId = input.actor.ownerId;
  const { now } = input;
  const record = await ownerPlanRecord(db.global, ownerId);
  const owner = entitlements(record, now);
  const own = ownEntitlements(record, now);
  const kinds: GraceForecast["kinds"] = [];
  for (const step of graceForecastSteps(record, now)) {
    if (step.kind === "versions") {
      kinds.push({ kind: "versions", count: await lettingGoVersions(db, ownerId, owner, own, now, step.from), from: step.from });
    } else if (step.kind === "accessLog") {
      const [openings, days] = await expiringRows(access, ownerId, now, step.from);
      kinds.push({ kind: "accessLog", count: openings, from: step.from });
      kinds.push({ kind: "analytics", count: days, from: step.from });
    } else if (step.kind === "auditEvents") {
      const cutoff = auditPruneCutoff(own.limits.auditRetentionDays, step.from);
      kinds.push({
        kind: "auditEvents",
        // The owner's events live in its region and, for global rows, the global database; with
        // one database both are the same rows, counted once.
        count: bothSides(db)
          ? await olderEvents(db, ownerId, cutoff)
          : (await olderEvents(db, ownerId, cutoff)) + (await olderEvents(db.global, ownerId, cutoff)),
        from: step.from,
      });
    } else {
      kinds.push({ kind: "pins", count: await pinnedArtifacts(db, ownerId), from: step.from });
    }
  }
  return ok({ owner, kinds });
}

/** Previous versions retained now that the plan's own retention no longer keeps at `from`. */
async function lettingGoVersions(
  db: RegionalDb,
  ownerId: string,
  owner: Entitlements,
  own: Entitlements,
  now: number,
  from: number,
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
        previousRetainedSql(versionRetention(owner.limits), now),
        not(previousRetainedSql(versionRetention(own.limits), from)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Access log openings and analytics day counters still kept now that expire by `from`. */
async function expiringRows(
  access: AccessDb,
  ownerId: string,
  now: number,
  from: number,
): Promise<[number, number]> {
  const e = accessSchema.accessEvents;
  const v = accessSchema.artifactViews;
  const [openings, days] = await access.batch([
    access
      .select({ n: count() })
      .from(e)
      .where(and(eq(e.ownerId, ownerId), gt(e.expiresAt, now), lte(e.expiresAt, from))),
    access
      .select({ n: count() })
      .from(v)
      .where(and(eq(v.ownerId, ownerId), gt(v.expiresAt, now), lte(v.expiresAt, from))),
  ]);
  return [Number(openings[0]?.n ?? 0), Number(days[0]?.n ?? 0)];
}

/** The owner's audit events in one database older than `cutoff`. */
async function olderEvents(db: Db, ownerId: string, cutoff: number): Promise<number> {
  const ae = schema.auditEvents;
  const [row] = await db
    .select({ n: count() })
    .from(ae)
    .where(and(eq(ae.ownerId, ownerId), lt(ae.at, cutoff)));
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
