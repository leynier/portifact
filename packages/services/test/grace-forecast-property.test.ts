// The grace forecast against the real thing (decision 0022): for random plan histories (holds that
// overlap, cover one another or drop in several steps) and random data, every step's date and
// count is exactly what the scans delete when the clock passes that date, and nothing else of
// those kinds goes at those moments.
import { env } from "cloudflare:test";
import { PLAN_GRACE_MS } from "@portifact/contracts";
import { accessSchema, createAccessDb, schema } from "@portifact/db";
import { and, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pruneAccessEvents, recordOpenings } from "../src/access-log.ts";
import { applyOwnerRetention } from "../src/analytics.ts";
import { pruneAuditEvents } from "../src/audit.ts";
import { graceForecastKinds } from "../src/grace-forecast.ts";
import { pruneVersions } from "../src/maintenance.ts";
import { removeOwnerPlan, setOwnerPlan, unpinLapsedPlans } from "../src/plans.ts";
import { DAY, db, NOW, publishSite, user, value } from "./fixtures.ts";
import { versions } from "./version-support.ts";

const access = () => createAccessDb(env.ACCESS_DB);

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

type Change =
  | { at: number; plan: "pro" | "team" | "enterprise"; overrides?: unknown }
  | { at: number; remove: true };

/** Plan histories that leave one hold, two that overlap, or one a later hold covers. */
function history(rand: () => number, seed: number): { path: number; changes: Change[] } {
  // Off whole days (and off NOW's time of day), so no event the history records turns exactly as
  // old as a retention at a step: its own expiry would then coincide with the step.
  const t1 = NOW - Math.floor(5 + rand() * 50) * DAY - 7_777;
  const audit = { limits: { auditRetentionDays: 200 + Math.floor(rand() * 200) } };
  const paths: Change[][] = [
    // Team lowered to Pro, then Pro removed: two holds, two steps for versions.
    [
      { at: NOW - 300 * DAY, plan: "team" },
      { at: t1, plan: "pro" },
      { at: NOW, remove: true },
    ],
    // Enterprise with a longer audit log, lowered to Pro, then removed: audit drops at the first end.
    [
      { at: NOW - 300 * DAY, plan: "enterprise", overrides: audit },
      { at: t1, plan: "pro" },
      { at: NOW, remove: true },
    ],
    // Pro removed, Team granted and removed: the later hold covers the earlier one.
    [
      { at: NOW - 300 * DAY, plan: "pro" },
      { at: t1, remove: true },
      { at: t1 + DAY, plan: "team" },
      { at: NOW, remove: true },
    ],
    // Team removed: one hold.
    [
      { at: NOW - 300 * DAY, plan: "team" },
      { at: t1, remove: true },
    ],
  ];
  // Every path, in turn: the seeds cover each one twice.
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
      seats: 1,
      validUntil: null,
      overrides: (change.overrides ?? null) as never,
      grantedBy: "operator",
      note: null,
      now: change.at,
    }),
  );
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

describe("the grace forecast against the scans", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("matches what the scans delete (seed %i)", async (seed) => {
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
      at: NOW - Math.floor(rand() * 380 * 24) * 3_600_000,
    }));
    await recordOpenings(db(), access(), openings);
    for (let d = 0; d < 10; d += 1) {
      const day = Math.floor((NOW - Math.floor(rand() * 380) * DAY) / DAY) * DAY;
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
    await applyOwnerRetention(db(), access(), owner.id, NOW);

    const { kinds } = await graceForecastKinds(db(), access(), owner.id, NOW);
    expect(kinds.length).toBeGreaterThan(0);
    const dates = [...new Set(kinds.map((kind) => kind.from))].sort((a, b) => a - b);
    const firstEnd = (changes[1]?.at ?? NOW) + PLAN_GRACE_MS;
    if (path === 0) {
      // Team then Pro: versions drop twice, at each hold's end.
      expect(kinds.filter((kind) => kind.kind === "versions").map((kind) => kind.from)).toEqual([
        firstEnd,
        NOW + PLAN_GRACE_MS,
      ]);
    }
    if (path === 1) {
      // The audit override goes at the first end; Pro keeps the default 90 days after it.
      expect(kinds.find((kind) => kind.kind === "auditEvents")?.from).toBe(firstEnd);
    }
    if (path === 2) {
      // The later Team hold covers the earlier Pro one: nothing goes at the earlier end.
      expect(dates).toEqual([NOW + PLAN_GRACE_MS]);
    }
    for (const date of dates) {
      expect(date).toBeGreaterThan(NOW);
      expect(date).toBeLessThanOrEqual(NOW + PLAN_GRACE_MS);
      // What goes on its own before the step is not the step's.
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
      expect({ seed, date: (date - NOW) / DAY, ...deleted }).toEqual({
        seed,
        date: (date - NOW) / DAY,
        ...forecast,
      });
    }
  });
});
