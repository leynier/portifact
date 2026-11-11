// The grace forecast against the real thing (decision 0022): for random plan histories (holds that
// overlap, cover one another or drop in several steps) and random data, every step's date and
// count is exactly what the scans delete when the clock passes that date, and nothing else of
// those kinds goes at those moments.
import { env } from "cloudflare:test";
import { type GraceSlot, PLAN_GRACE_MS, PLANS } from "@portifact/contracts";
import { accessSchema, createAccessDb, schema } from "@portifact/db";
import {
  type GraceForecastStep,
  graceForecastSteps,
  graceHoldEndDrops,
  liveGraceSlots,
  readGrace,
} from "@portifact/domain";
import { and, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneAccessEvents, recordOpenings } from "../src/access-log.ts";
import { applyOwnerRetention } from "../src/analytics.ts";
import { pruneAuditEvents } from "../src/audit.ts";
import { graceForecastKinds } from "../src/grace-forecast.ts";
import { pruneVersions } from "../src/maintenance.ts";
import { ownerPlanRecord, removeOwnerPlan, setOwnerPlan, unpinLapsedPlans } from "../src/plans.ts";
import { DAY, db, NOW, publishSite, user, value } from "./fixtures.ts";
import { versions } from "./version-support.ts";

const access = () => createAccessDb(env.ACCESS_DB);
const STEP_KINDS: readonly GraceForecastStep["kind"][] = [
  "versions",
  "accessLog",
  "auditEvents",
  "pins",
];

/** A small seeded generator, so a failure names the seed that reproduces it. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Grant {
  at: number;
  plan: "pro" | "team" | "enterprise";
  seats?: number;
  validUntil?: number | null;
  overrides?: unknown;
}
type Change = Grant | { at: number; remove: true };

/** Overrides beyond the plan's own values, or none. */
function overridesOf(rand: () => number): unknown {
  if (rand() < 0.4) return null;
  const limits: Record<string, number> = {};
  if (rand() < 0.6) limits.retainedPreviousVersions = 60 + Math.floor(rand() * 100);
  if (rand() < 0.6) limits.accessLogRetentionDays = 400 + Math.floor(rand() * 300);
  if (rand() < 0.6) limits.auditRetentionDays = 200 + Math.floor(rand() * 200);
  return Object.keys(limits).length === 0 ? null : { limits };
}

/**
 * Plan histories through the operator's services: overlapping holds dropping in several steps, an
 * audit override that drops alone, a plan with a future end on top of a hold, and a natural
 * expiry. Path 3 adds a covered hold by writing the slots directly: the services never keep one
 * (a grant that covers a hold ends it as renewed), so it exists only through a hand-applied plan
 * (`apply-plans`), and the test keeps the forecast honest for it.
 */
function history(rand: () => number, seed: number): { path: number; changes: Change[] } {
  // Off whole days (and off NOW's time of day), so no event the history records turns exactly as
  // old as a retention at a step: its own expiry would then coincide with the step.
  const t1 = NOW - Math.floor(5 + rand() * 50) * DAY - 7_777;
  const seats = 1 + Math.floor(rand() * 3);
  const audit = { limits: { auditRetentionDays: 200 + Math.floor(rand() * 200) } };
  const paths: Change[][] = [
    // Team lowered to Pro, then Pro removed: two holds, versions drop twice.
    [
      { at: NOW - 300 * DAY, plan: "team", seats, overrides: overridesOf(rand) },
      { at: t1, plan: "pro", overrides: overridesOf(rand) },
      { at: NOW, remove: true },
    ],
    // Enterprise with a longer audit log, lowered to Pro, then removed: audit drops at the first end.
    [
      { at: NOW - 300 * DAY, plan: "enterprise", seats, overrides: audit },
      { at: t1, plan: "pro" },
      { at: NOW, remove: true },
    ],
    // Team removed, then Pro granted with an end in the future: the hold, then the plan's own end.
    [
      { at: NOW - 300 * DAY, plan: "team", overrides: overridesOf(rand) },
      { at: t1, remove: true },
      {
        at: NOW,
        plan: "pro",
        seats,
        validUntil: NOW + Math.floor(5 + rand() * 40) * DAY + 3_333,
      },
    ],
    // Pro removed (one hold), then a covering Team hold written by hand (see above).
    [
      { at: NOW - 300 * DAY, plan: "pro", overrides: overridesOf(rand) },
      { at: t1, remove: true },
    ],
    // Enterprise whose end passed (a natural expiry the grace scan has not stored yet).
    [
      {
        at: NOW - 300 * DAY,
        plan: "enterprise",
        seats,
        overrides: overridesOf(rand),
        validUntil: NOW - Math.floor(1 + rand() * 30) * DAY - 5_555,
      },
    ],
  ];
  const path = seed % paths.length;
  return { path, changes: paths[path] as Change[] };
}

async function apply(ownerId: string, change: Change) {
  if ("remove" in change) {
    value(await removeOwnerPlan(db(), { ownerId, now: change.at }));
    return;
  }
  value(
    await setOwnerPlan(db(), {
      ownerId,
      plan: change.plan,
      seats: change.seats ?? 1,
      validUntil: change.validUntil ?? null,
      overrides: (change.overrides ?? null) as never,
      grantedBy: "operator",
      note: null,
      now: change.at,
    }),
  );
}

/** A hold of Team's values from `from`, as a covering hold written by hand. */
function teamHold(from: number): GraceSlot {
  const { limits } = PLANS.team;
  return {
    plan: "team",
    reason: "removed",
    from,
    until: from + PLAN_GRACE_MS,
    limits: {
      archiveMonths: limits.archiveMonths,
      retainedPreviousVersions: limits.retainedPreviousVersions,
      previousVersionRetentionDays: limits.previousVersionRetentionDays,
      accessLogRetentionDays: limits.accessLogRetentionDays,
      auditRetentionDays: limits.auditRetentionDays,
    },
    features: [...PLANS.team.features],
  };
}

async function tally(ownerId: string) {
  const v = schema.versions;
  const a = schema.artifacts;
  const e = accessSchema.accessEvents;
  const w = accessSchema.artifactViews;
  const ae = schema.auditEvents;
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  return {
    versions: n(
      await db()
        .select({ n: count() })
        .from(v)
        .innerJoin(a, eq(a.id, v.artifactId))
        .where(eq(a.ownerId, ownerId)),
    ),
    accessLog: n(await access().select({ n: count() }).from(e).where(eq(e.ownerId, ownerId))),
    analytics: n(await access().select({ n: count() }).from(w).where(eq(w.ownerId, ownerId))),
    auditEvents: n(await db().select({ n: count() }).from(ae).where(eq(ae.ownerId, ownerId))),
    pins: n(
      await db()
        .select({ n: count() })
        .from(a)
        .where(and(eq(a.ownerId, ownerId), eq(a.pinned, true))),
    ),
  };
}

async function scans(now: number) {
  for (let i = 0; i < 20; i += 1) {
    if ((await pruneVersions(db(), env.ARTIFACTS, now)).processed === 0) break;
  }
  await pruneAccessEvents(access(), now);
  await pruneAuditEvents(db(), db().global, now);
  await unpinLapsedPlans(db(), now);
}

/** How many seeds exercised each shape: each must be above zero. */
const seen = { overlapping: 0, multiStep: 0, covered: 0, futureEnd: 0, naturalExpiry: 0 };

describe("the grace forecast against the scans", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "matches what the scans delete (seed %i)",
    async (seed) => {
      const rand = random(seed);
      const owner = await user("Owner");
      const reader = await user("Reader");
      const { path, changes } = history(rand, seed);
      // The first grant, then data published under it, then the rest of the history.
      await apply(owner.id, changes[0] as Change);
      for (let a = 0; a < 2; a += 1) {
        await versions(owner.id, 3 + Math.floor(rand() * 4), {
          now: NOW - Math.floor(rand() * 250) * DAY,
        });
      }
      const site = await publishSite(owner.id);
      await db()
        .update(schema.artifacts)
        .set({ pinned: true, expiresAt: null })
        .where(eq(schema.artifacts.id, site.artifactId));
      const openings = Array.from({ length: 12 }, () => ({
        artifactId: site.artifactId,
        userId: reader.id,
        at: NOW - Math.floor(rand() * 600 * 24) * 3_600_000,
      }));
      await recordOpenings(db(), access(), openings);
      for (let d = 0; d < 10; d += 1) {
        const day = Math.floor((NOW - Math.floor(rand() * 600) * DAY) / DAY) * DAY;
        await access()
          .insert(accessSchema.artifactViews)
          .values({
            artifactId: site.artifactId,
            day,
            ownerId: owner.id,
            views: 1,
            signedInViews: 0,
            expiresAt: NOW + 400 * DAY,
          })
          .onConflictDoNothing();
      }
      for (let i = 0; i < 12; i += 1) {
        await db()
          .insert(schema.auditEvents)
          .values({
            id: `ae_${crypto.randomUUID()}`,
            ownerId: owner.id,
            at: NOW - Math.floor(rand() * 420 * 24) * 3_600_000 - 1_234,
            kind: "artifact.renamed",
            actorType: "system",
            detail: {},
            recordedAt: NOW,
          });
      }
      for (const change of changes.slice(1)) await apply(owner.id, change);
      if (path === 3) {
        // The covering Team hold, written by hand next to the stored Pro one.
        const [row] = await db()
          .global.select({ grace: schema.ownerPlans.grace })
          .from(schema.ownerPlans)
          .where(eq(schema.ownerPlans.ownerId, owner.id));
        const stored = JSON.parse(row?.grace ?? "[]") as GraceSlot[];
        await db()
          .global.update(schema.ownerPlans)
          .set({ grace: JSON.stringify([...stored, teamHold(NOW - 2 * DAY - 1_111)]) })
          .where(eq(schema.ownerPlans.ownerId, owner.id));
      }
      await applyOwnerRetention(db(), access(), owner.id, NOW);

      const record = await ownerPlanRecord(db().global, owner.id);
      const steps = graceForecastSteps(record, NOW);
      const live = liveGraceSlots(record, NOW);
      if (live.length >= 2) seen.overlapping += 1;
      if (STEP_KINDS.some((kind) => steps.filter((step) => step.kind === kind).length >= 2)) {
        seen.multiStep += 1;
      }
      if (
        readGrace(record).slots.some((slot) => slot.until > NOW && !graceHoldEndDrops(record, slot))
      ) {
        seen.covered += 1;
      }
      if (record?.validUntil != null && record.validUntil > NOW) seen.futureEnd += 1;
      if (record?.validUntil != null && record.validUntil <= NOW) seen.naturalExpiry += 1;

      const { kinds } = await graceForecastKinds(db(), access(), owner.id, NOW);
      expect(kinds.length).toBeGreaterThan(0);
      // Every moment at which what is kept could change, and points between them: the scans must
      // delete exactly what the forecast lists for that moment, and nothing where it lists nothing.
      const changes_ = new Set<number>(live.map((slot) => slot.until));
      if (record?.validUntil != null) {
        changes_.add(record.validUntil);
        changes_.add(record.validUntil + PLAN_GRACE_MS);
      }
      for (const kind of kinds) changes_.add(kind.from);
      const sorted = [...changes_].filter((at) => at > NOW).sort((a, b) => a - b);
      const moments = new Set<number>(sorted);
      let previous = NOW;
      for (const at of sorted) {
        moments.add(Math.floor((previous + at) / 2) + 17);
        previous = at;
      }
      moments.add(previous + 3 * DAY + 29);
      for (const date of [...moments].sort((a, b) => a - b)) {
        // What goes on its own before the moment is not the moment's.
        await scans(date - 1);
        const before = await tally(owner.id);
        await scans(date + 1);
        const after = await tally(owner.id);
        const deleted = Object.fromEntries(
          (Object.keys(before) as (keyof typeof before)[]).map((key) => [
            key,
            before[key] - after[key],
          ]),
        );
        const forecast = { versions: 0, accessLog: 0, analytics: 0, auditEvents: 0, pins: 0 };
        for (const kind of kinds.filter((entry) => entry.from === date)) {
          forecast[kind.kind] += kind.count;
        }
        expect({ seed, path, date: (date - NOW) / DAY, ...deleted }).toEqual({
          seed,
          path,
          date: (date - NOW) / DAY,
          ...forecast,
        });
      }
      // The steps a kind goes in, for the shapes the history builds.
      const firstEnd = (changes[1]?.at ?? NOW) + PLAN_GRACE_MS;
      if (path === 0) {
        expect(steps.filter((step) => step.kind === "versions").map((step) => step.from)).toEqual([
          firstEnd,
          NOW + PLAN_GRACE_MS,
        ]);
      }
      if (path === 1) {
        expect(steps.find((step) => step.kind === "auditEvents")?.from).toBe(firstEnd);
      }
    },
  );

  it("covered every shape at least once", () => {
    for (const [shape, count] of Object.entries(seen)) {
      expect({ shape, count: count > 0 }).toEqual({ shape, count: true });
    }
  });
});
