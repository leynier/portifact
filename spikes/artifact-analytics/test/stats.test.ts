import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ViewDelta } from "../src/meter.ts";
import { recordViews, setOwnerRetention } from "../src/record.ts";
import { analyticsRetention, getArtifactStats, MAX_RANGE_DAYS } from "../src/stats.ts";
import { DAY_MS } from "../src/views.ts";
import { daysAgo, NOW, seedArtifact, seedOpening, TODAY } from "./harness.ts";

const views = (
  artifactId: string,
  ownerId: string,
  day: number,
  n: number,
  signedIn = 0,
): ViewDelta => ({
  artifactId,
  ownerId,
  day,
  views: n,
  signedInViews: signedIn,
  retentionDays: 365,
});

const read = (artifactId: string, actorId: string, from = daysAgo(6), to = NOW) =>
  getArtifactStats(env.CONTROL, env.ACCESS, { actorId, artifactId, from, to, now: NOW });

describe("getArtifactStats", () => {
  it("returns every day of the range, with zeros for days without views, and exact totals", async () => {
    const { id, ownerId } = await seedArtifact();
    await recordViews(env.ACCESS, [
      views(id, ownerId, daysAgo(3), 12, 2),
      views(id, ownerId, TODAY, 1),
    ]);
    const result = await read(id, ownerId);
    if (!result.ok) throw new Error(result.code);
    expect(result.stats.days).toHaveLength(7);
    expect(result.stats.days.map((day) => day.views)).toEqual([0, 0, 0, 12, 0, 0, 1]);
    expect(result.stats.days[3]).toEqual({
      day: daysAgo(3),
      views: 12,
      signedInViews: 2,
      visitors: null,
    });
    expect(result.stats.totals).toEqual({ views: 13, signedInViews: 2, visitors: null });
    expect(result.stats).toMatchObject({ artifactId: id, from: daysAgo(6), to: TODAY });
  });

  it("counts distinct signed-in visitors per day and over the range only for restricted artifacts", async () => {
    const { id, ownerId } = await seedArtifact({ accessMode: "restricted" });
    await recordViews(env.ACCESS, [
      views(id, ownerId, daysAgo(1), 5, 5),
      views(id, ownerId, TODAY, 3, 3),
    ]);
    // Ana opens twice yesterday (two windows) and once today; Ben once today.
    await seedOpening(id, ownerId, "ana", daysAgo(1) + 1_000);
    await seedOpening(id, ownerId, "ana", daysAgo(1) + 4 * 3_600_000);
    await seedOpening(id, ownerId, "ana", TODAY + 1_000);
    await seedOpening(id, ownerId, "ben", TODAY + 2_000);
    const result = await read(id, ownerId, daysAgo(2));
    if (!result.ok) throw new Error(result.code);
    expect(result.stats.days.map((day) => day.visitors)).toEqual([0, 1, 2]);
    expect(result.stats.totals.visitors).toBe(2);
  });

  it("public and authenticated artifacts never show visitors, even with old openings in the log", async () => {
    for (const accessMode of ["public", "authenticated"]) {
      const { id, ownerId } = await seedArtifact({ accessMode });
      await seedOpening(id, ownerId, "ana", TODAY + 1_000);
      const result = await read(id, ownerId);
      if (!result.ok) throw new Error(result.code);
      expect(result.stats.totals.visitors).toBeNull();
      expect(result.stats.days.every((day) => day.visitors === null)).toBe(true);
    }
  });

  it("answers not_found to anyone but the owner, for a missing artifact and while purging", async () => {
    const { id, ownerId } = await seedArtifact();
    await recordViews(env.ACCESS, [views(id, ownerId, TODAY, 4)]);
    expect(await read(id, "someone-else")).toEqual({ ok: false, code: "not_found" });
    expect(await read("missingid22", ownerId)).toEqual({ ok: false, code: "not_found" });
    const purging = await seedArtifact({ state: "purging" });
    expect(await read(purging.id, purging.ownerId)).toEqual({ ok: false, code: "not_found" });
  });

  it("answers plan_required to an owner whose plan has no analytics", async () => {
    const free = await seedArtifact({ plan: "free" });
    expect(await read(free.id, free.ownerId)).toEqual({ ok: false, code: "plan_required" });
    const none = await seedArtifact({ plan: null });
    expect(await read(none.id, none.ownerId)).toEqual({ ok: false, code: "plan_required" });
    expect(analyticsRetention("unknown-plan")).toBeNull();
  });

  it("clamps the range to the retention and to today, and refuses empty or too long ranges", async () => {
    const { id, ownerId } = await seedArtifact();
    const clamped = await read(id, ownerId, daysAgo(900), NOW + 30 * DAY_MS);
    if (!clamped.ok) throw new Error(clamped.code);
    expect(clamped.stats.from).toBe(daysAgo(365));
    expect(clamped.stats.to).toBe(TODAY);
    expect(clamped.stats.days).toHaveLength(366);
    expect(await read(id, ownerId, NOW, daysAgo(1))).toEqual({ ok: false, code: "invalid_input" });
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it("never shows rows past their expiry, even before the prune deletes them", async () => {
    const { id, ownerId } = await seedArtifact({ accessMode: "restricted" });
    await recordViews(env.ACCESS, [views(id, ownerId, daysAgo(40), 7, 7)]);
    await seedOpening(id, ownerId, "ana", daysAgo(40) + 1_000);
    await setOwnerRetention(env.ACCESS, ownerId, 30);
    const result = await read(id, ownerId, daysAgo(45), NOW);
    if (!result.ok) throw new Error(result.code);
    expect(result.stats.totals).toEqual({ views: 0, signedInViews: 0, visitors: 0 });
  });

  it("costs the same few queries whatever the traffic", async () => {
    const { id, ownerId } = await seedArtifact({ accessMode: "restricted" });
    await recordViews(
      env.ACCESS,
      Array.from({ length: 30 }, (_, i) => views(id, ownerId, TODAY - i * DAY_MS, 1_000 + i)),
    );
    let queries = 0;
    const counted = (db: D1Database) =>
      new Proxy(db, {
        get(target, property) {
          const value = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]) => {
                if (property === "prepare") queries += 1;
                return value.apply(target, args);
              }
            : value;
        },
      });
    const result = await getArtifactStats(counted(env.CONTROL), counted(env.ACCESS), {
      actorId: ownerId,
      artifactId: id,
      from: daysAgo(29),
      to: NOW,
      now: NOW,
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.stats.totals.views).toBe(30 * 1_000 + 435);
    // One control read, the counters, and the two access log aggregates (sent as one batch).
    expect(queries).toBe(4);
  });
});
