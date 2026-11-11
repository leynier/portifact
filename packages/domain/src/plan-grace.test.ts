// Plan grace (decision 0022): what `entitlements` holds after each way a plan drops, how a plan
// change and the grace scan move the holds, and the invariants a grace keeps.
import {
  GRACE_LIMITS,
  type GraceSlot,
  PLAN_FEATURES,
  PLAN_GRACE_DAYS,
  PLAN_GRACE_MAX_SLOTS,
  PLAN_NAMES,
  PLANS,
  type PlanFeature,
  PlanName,
  PlanOverrides,
} from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pinsLapse } from "./lifecycle.ts";
import {
  compactSlots,
  coversSlot,
  entitlements,
  expirySlot,
  graceAfterChange,
  graceForecastSteps,
  graceScanStep,
  graceSlotOf,
  hasFeature,
  holdsFeature,
  liveGraceSlots,
  type OwnerPlanRecord,
  readGrace,
  requireHeldFeature,
  storedGraceSlots,
} from "./plans.ts";
import { previousVersionRetained, versionRetention } from "./versions.ts";

const DAY = 86_400_000;
const GRACE = PLAN_GRACE_DAYS * DAY;
const NOW = Date.parse("2026-11-10T12:00:00Z");

const row = (overrides: Partial<OwnerPlanRecord> = {}): OwnerPlanRecord => ({
  plan: "pro",
  seats: 1,
  validUntil: null,
  overrides: null,
  ...overrides,
});

/** The row a plan change leaves, with its new holds. */
function changed(
  before: OwnerPlanRecord | null,
  after: OwnerPlanRecord | null,
  now: number,
  options: { reason?: "lowered" | "removed"; noGrace?: boolean } = {},
) {
  const change = graceAfterChange(before, after, {
    now,
    reason: options.reason ?? (after === null ? "removed" : "lowered"),
    noGrace: options.noGrace ?? false,
  });
  const next: OwnerPlanRecord = {
    ...(after ?? { plan: "free", seats: 1, validUntil: null, overrides: null }),
    grace: change.slots.length === 0 ? null : change.slots,
  };
  return { change, next };
}

describe("PLAN_GRACE_DAYS", () => {
  it("is 60 days", () => {
    expect(PLAN_GRACE_DAYS).toBe(60);
  });
});

describe("the three ways a plan drops", () => {
  it("natural expiry holds the plan's retention and reads for 60 days, from the row itself", () => {
    const expired = row({ validUntil: NOW - DAY });
    const owner = entitlements(expired, NOW);
    expect(owner.plan).toBe("free");
    expect(owner.features).toEqual([]);
    expect(owner.limits.retainedPreviousVersions).toBe(PLANS.pro.limits.retainedPreviousVersions);
    expect(owner.limits.previousVersionRetentionDays).toBe(90);
    expect(owner.limits.accessLogRetentionDays).toBe(365);
    expect(owner.limits.archiveMonths).toBe(12);
    // Every other limit is the free plan's: quotas follow the plan the owner has now.
    expect(owner.limits.activeArtifacts).toBe(PLANS.free.limits.activeArtifacts);
    expect(owner.limits.accountBytes).toBe(PLANS.free.limits.accountBytes);
    expect(owner.grace).toMatchObject({ until: NOW - DAY + GRACE, plan: "pro" });
    expect(owner.grace?.features).toEqual(PLANS.pro.features);
    // Day 59 still holds, day 60 does not.
    expect(entitlements(expired, NOW - DAY + GRACE - 1).grace).not.toBeNull();
    expect(entitlements(expired, NOW - DAY + GRACE)).toEqual(entitlements(null, NOW));
  });

  it("removal stores a hold of what the plan kept", () => {
    const { change, next } = changed(row(), null, NOW);
    expect(change.started[0]).toMatchObject({ plan: "pro", reason: "removed", until: NOW + GRACE });
    expect(change.ended).toEqual([]);
    const owner = entitlements(next, NOW + DAY);
    expect(owner.plan).toBe("free");
    expect(owner.limits.retainedPreviousVersions).toBe(50);
    expect(owner.grace?.until).toBe(NOW + GRACE);
  });

  it("lowering to another plan holds the previous plan's values", () => {
    const { change, next } = changed(row({ plan: "team" }), row({ plan: "pro" }), NOW);
    expect(change.started[0]).toMatchObject({ plan: "team", reason: "lowered" });
    const owner = entitlements(next, NOW + DAY);
    expect(owner.plan).toBe("pro");
    expect(owner.limits.retainedPreviousVersions).toBe(100);
    expect(owner.limits.previousVersionRetentionDays).toBe(365);
    expect(owner.limits.activeArtifacts).toBe(500);
    expect(owner.grace?.features).toEqual(
      PLANS.team.features.filter((feature) => !PLANS.pro.features.includes(feature)),
    );
  });

  it("lowering seats holds nothing: seats change quotas, not what is kept", () => {
    const { change } = changed(
      row({ plan: "team", seats: 5 }),
      row({ plan: "team", seats: 2 }),
      NOW,
    );
    expect(change.started).toEqual([]);
    expect(change.slots).toEqual([]);
  });

  it("lowering an override holds the overridden value", () => {
    const before = row({ plan: "enterprise", overrides: { limits: { auditRetentionDays: 730 } } });
    const after = row({ plan: "enterprise" });
    const { change, next } = changed(before, after, NOW);
    expect(change.started[0]?.limits.auditRetentionDays).toBe(730);
    expect(entitlements(next, NOW + DAY).limits.auditRetentionDays).toBe(730);
    expect(entitlements(next, NOW + GRACE).limits.auditRetentionDays).toBe(90);
  });

  it("taking away a feature holds the reads of its data", () => {
    const before = row();
    const after = row({ overrides: { features: { analytics: false } } });
    const { next } = changed(before, after, NOW);
    const owner = entitlements(next, NOW + DAY);
    expect(hasFeature(owner, "analytics")).toBe(false);
    expect(holdsFeature(owner, "analytics")).toBe(true);
    expect(requireHeldFeature(owner, "analytics").ok).toBe(true);
    expect(requireHeldFeature(entitlements(next, NOW + GRACE), "analytics")).toMatchObject({
      ok: false,
      code: "plan_required",
    });
  });
});

describe("ending a grace", () => {
  it("a renewal within the grace ends it with nothing lost", () => {
    const { next: removed } = changed(row(), null, NOW);
    const { change, next } = changed(removed, row(), NOW + 10 * DAY);
    expect(change.ended.map((e) => e.reason)).toEqual(["renewed"]);
    expect(change.started).toEqual([]);
    expect(next.grace).toBeNull();
    expect(entitlements(next, NOW + 10 * DAY)).toEqual(entitlements(row(), NOW));
  });

  it("renewing a naturally expired plan ends its hold too", () => {
    const { change } = changed(row({ validUntil: NOW - DAY }), row(), NOW);
    expect(change.ended).toMatchObject([{ reason: "renewed", slot: { reason: "expired" } }]);
  });

  it("a raise that covers only part of the hold keeps the rest", () => {
    const before = row({ plan: "team" });
    const { next: lowered } = changed(before, row({ plan: "free" }), NOW);
    const partial = row({ plan: "pro" });
    const { change, next } = changed(lowered, partial, NOW + DAY);
    expect(change.ended).toEqual([]);
    expect(storedGraceSlots(next)).toHaveLength(1);
    expect(entitlements(next, NOW + DAY).limits.retainedPreviousVersions).toBe(100);
  });

  it("the operator's --no-grace ends every hold and starts none", () => {
    const { next: lowered } = changed(row({ plan: "team" }), row(), NOW);
    const { change, next } = changed(lowered, null, NOW + DAY, { noGrace: true });
    expect(change.started).toEqual([]);
    expect(change.ended.map((e) => e.reason)).toEqual(["operator"]);
    expect(next.grace).toBeNull();
    expect(entitlements(next, NOW + DAY)).toEqual(entitlements(null, NOW));
  });

  it("--no-grace on a naturally expired plan ends its hold", () => {
    const { change } = changed(row({ validUntil: NOW - DAY }), null, NOW, { noGrace: true });
    expect(change.ended).toMatchObject([{ reason: "operator" }]);
  });
});

describe("a second drop during a grace", () => {
  it("neither extends nor shortens the first: each hold keeps its own end", () => {
    const { next: first } = changed(row({ plan: "team" }), row({ plan: "pro" }), NOW);
    const second = NOW + 20 * DAY;
    const { change, next } = changed(first, null, second);
    expect(change.started[0]).toMatchObject({ plan: "pro", until: second + GRACE });
    const slots = storedGraceSlots(next);
    expect(slots.map((slot) => slot.until).sort()).toEqual([NOW + GRACE, second + GRACE]);
    // Until the first's end, team's values; then pro's until the second's end; then free.
    expect(entitlements(next, NOW + GRACE - 1).limits.retainedPreviousVersions).toBe(100);
    expect(entitlements(next, NOW + GRACE).limits.retainedPreviousVersions).toBe(50);
    expect(entitlements(next, second + GRACE - 1).limits.retainedPreviousVersions).toBe(50);
    expect(entitlements(next, second + GRACE).limits.retainedPreviousVersions).toBe(2);
  });

  it("a natural expiry of the lowered plan adds its own hold", () => {
    const { next: first } = changed(
      row({ plan: "team" }),
      row({ plan: "pro", validUntil: NOW + 10 * DAY }),
      NOW,
    );
    const live = liveGraceSlots(first, NOW + 11 * DAY);
    expect(live.map((slot) => [slot.plan, slot.until])).toEqual([
      ["team", NOW + GRACE],
      ["pro", NOW + 10 * DAY + GRACE],
    ]);
  });

  it("past the slot limit, folds the two that end first: never shorter", () => {
    let record: OwnerPlanRecord = row({ plan: "enterprise" });
    let at = NOW;
    for (let i = 0; i < PLAN_GRACE_MAX_SLOTS + 2; i += 1) {
      const auditRetentionDays = 600 - i * 10;
      const before = { ...record, overrides: { limits: { auditRetentionDays } } };
      record = changed(before, { ...record, overrides: null }, at).next;
      at += DAY;
    }
    const slots = storedGraceSlots(record);
    expect(slots.length).toBeLessThanOrEqual(PLAN_GRACE_MAX_SLOTS);
    // The highest held value is still there, at least until its own end.
    expect(entitlements(record, NOW + GRACE - 1).limits.auditRetentionDays).toBe(600);
    // The folded hold says how many it holds, and keeps them no longer than the grace length
    // after the newest drop folded into it.
    const folded = slots.find((slot) => slot.folded !== undefined);
    expect(folded?.folded).toBe(3);
    expect(folded && folded.until - folded.from).toBeLessThanOrEqual(GRACE);
    expect(entitlements(record, folded?.until ?? 0).limits.auditRetentionDays).toBeLessThan(600);
  });

  it("reports each folded hold as ended (folded), so every hold has one end", () => {
    let record: OwnerPlanRecord = row({ plan: "enterprise" });
    const ends: string[] = [];
    const starts: number[] = [];
    for (let i = 0; i < PLAN_GRACE_MAX_SLOTS + 1; i += 1) {
      const before = { ...record, overrides: { limits: { auditRetentionDays: 600 - i } } };
      const { change, next } = changed(before, { ...record, overrides: null }, NOW + i * DAY);
      starts.push(change.started.length);
      ends.push(...change.ended.map((e) => e.reason));
      record = next;
    }
    expect(starts.every((n) => n === 1)).toBe(true);
    expect(ends).toEqual(["folded"]);
  });
});

describe("one start per hold, whoever stores it first", () => {
  const expired = row({ plan: "team", validUntil: NOW - DAY });

  it("the scan first: the scan reports the start, a later change does not", () => {
    const step = graceScanStep(expired, NOW);
    expect(step?.started).toMatchObject({ reason: "expired" });
    const stored = { ...expired, grace: step?.slots };
    expect(changed(stored, null, NOW + DAY).change.started).toEqual([]);
  });

  it.each([
    ["remove-plan", null, false],
    ["a lowering", row({ plan: "pro" }), false],
    ["--no-grace", null, true],
  ] as const)(
    "the operator first by %s: the change reports the expiry's start",
    (_, after, noGrace) => {
      const { change, next } = changed(expired, after, NOW, { noGrace });
      expect(change.started.filter((slot) => slot.reason === "expired")).toHaveLength(1);
      // Stored with its marker, so the scan never reports it again.
      expect(graceScanStep(next, NOW + DAY)?.started ?? null).toBeNull();
    },
  );
});

describe("unreadable graces hold, never delete", () => {
  const hostile = ["{", "[1]", 42, [{ plan: "pro" }], "null", Array(20).fill(0), [1, 2]];

  it.each(hostile.map((value) => [JSON.stringify(value), value]))(
    "%s reads as the most any retention may be, without throwing",
    (_, grace) => {
      const owner = entitlements(row({ plan: "free", grace }), NOW);
      expect(owner.grace?.unreadable).toBe(true);
      expect(owner.limits.retainedPreviousVersions).toBe(10_000);
      expect(owner.limits.auditRetentionDays).toBe(2_557);
      expect(owner.features).toEqual([]);
      expect(() => new Date(owner.grace?.until ?? 0).toISOString()).not.toThrow();
      expect(graceScanStep(row({ plan: "free", grace }), NOW)).toBeNull();
    },
  );

  it("a slot past the bounds is unreadable, not held forever or unprintable", () => {
    const slot = {
      plan: "enterprise",
      reason: "removed",
      from: 0,
      until: 9e15,
      limits: {
        archiveMonths: 999,
        retainedPreviousVersions: 1e9,
        previousVersionRetentionDays: 1e9,
        accessLogRetentionDays: 1e9,
        auditRetentionDays: 1e9,
      },
      features: ["audit"],
    };
    const owner = entitlements(row({ plan: "free", grace: [slot] }), NOW);
    expect(owner.grace?.unreadable).toBe(true);
    expect(owner.grace?.until).toBe(NOW + GRACE);
    expect(() => new Date(owner.grace?.until ?? 0).toISOString()).not.toThrow();
    // A well formed slot longer than the grace length is refused too.
    const long = { ...slot, until: NOW + 2 * GRACE, from: NOW, limits: PLANS.pro.limits };
    expect(readGrace(row({ grace: [{ ...long, limits: undefined }] })).unreadable).toBe(true);
  });

  it("the operator's next change stores a readable hold in its place, reported as started", () => {
    const { change, next } = changed(row({ plan: "free", grace: "{" }), row({ plan: "free" }), NOW);
    expect(change.started.map((slot) => slot.reason)).toEqual(["unreadable"]);
    expect(readGrace(next).unreadable).toBe(false);
    expect(entitlements(next, NOW + GRACE - 1).limits.retainedPreviousVersions).toBe(10_000);
    expect(entitlements(next, NOW + GRACE).limits.retainedPreviousVersions).toBe(2);
  });
});

describe("the previous release's rule", () => {
  // The reviewer's check: for every row without a grace, `entitlements` is develop's.
  function developEntitlements(record: OwnerPlanRecord | null, now: number) {
    const freePlan = () => ({
      plan: "free",
      seats: 1,
      validUntil: null,
      limits: { ...PLANS.free.limits },
      features: [...PLANS.free.features],
    });
    if (record === null || !(record.validUntil === null || now < record.validUntil))
      return freePlan();
    const name = PlanName.safeParse(record.plan);
    if (!name.success) return freePlan();
    const definition = PLANS[name.data];
    const seats = Number.isSafeInteger(record.seats) && record.seats >= 1 ? record.seats : 1;
    const limits: Record<string, number> = { ...definition.limits };
    for (const key of definition.perSeat) limits[key] = definition.limits[key] * seats;
    const enabled = new Set<PlanFeature>(definition.features);
    const overrides = PlanOverrides.safeParse(record.overrides ?? {});
    if (overrides.success) {
      Object.assign(limits, overrides.data.limits);
      for (const [feature, on] of Object.entries(overrides.data.features ?? {})) {
        if (on) enabled.add(feature as PlanFeature);
        else enabled.delete(feature as PlanFeature);
      }
    }
    return {
      plan: name.data,
      seats,
      validUntil: record.validUntil,
      limits,
      features: PLAN_FEATURES.filter((feature) => enabled.has(feature)),
    };
  }

  it("is unchanged for rows without a grace (outside a natural expiry's 60 days)", () => {
    const record = fc.record({
      plan: fc.constantFrom("free", "pro", "team", "enterprise", "bogus"),
      seats: fc.oneof(fc.integer({ min: -2, max: 50 }), fc.constant(1.5)),
      validUntil: fc.oneof(
        fc.constant(null),
        fc.integer({ min: NOW + 1, max: NOW + 1e11 }),
        fc.integer({ min: NOW - 1e11, max: NOW - 61 * DAY }),
      ),
      overrides: fc.oneof(
        fc.constant(null),
        fc.constant({ features: { pin: true } }),
        fc.constant({ limits: { auditRetentionDays: 400 } }),
        fc.constant("garbage"),
      ),
      grace: fc.constant(null),
    });
    fc.assert(
      fc.property(fc.option(record), (value) => {
        expect(entitlements(value, NOW)).toEqual(developEntitlements(value, NOW));
      }),
      { numRuns: 5_000 },
    );
  });
});

describe("the grace scan", () => {
  it("stores a natural expiry's hold once, then ends it", () => {
    const expired = row({ validUntil: NOW - DAY });
    const step = graceScanStep(expired, NOW);
    expect(step?.started).toMatchObject({ reason: "expired", expiry: NOW - DAY });
    const stored = { ...expired, grace: step?.slots ?? null };
    expect(expirySlot(stored, NOW)).toBeNull();
    expect(graceScanStep(stored, NOW + DAY)).toBeNull();
    // The stored hold reads exactly as the row's own did.
    expect(entitlements(stored, NOW)).toEqual(entitlements(expired, NOW));
    const ended = graceScanStep(stored, NOW - DAY + GRACE);
    expect(ended).toMatchObject({ started: null, slots: [] });
    expect(ended?.ended).toHaveLength(1);
  });

  it("does nothing for an active plan or one whose grace already ended", () => {
    expect(graceScanStep(row(), NOW)).toBeNull();
    expect(graceScanStep(row({ validUntil: NOW + DAY }), NOW)).toBeNull();
    expect(graceScanStep(row({ validUntil: NOW - GRACE }), NOW)).toBeNull();
    expect(graceScanStep(row({ plan: "free", validUntil: NOW - DAY }), NOW)).toBeNull();
  });
});

describe("what a grace keeps", () => {
  it("previous versions: day 59 retained, day 61 not", () => {
    const { next } = changed(row(), null, NOW);
    const version = { supersededAt: NOW - 80 * DAY, newer: 10 };
    const on = (at: number) =>
      previousVersionRetained(version, versionRetention(entitlements(next, at).limits), at);
    expect(on(NOW + 59 * DAY)).toBe(false); // replaced 139 days before day 59: past pro's 90
    const recent = { supersededAt: NOW - DAY, newer: 10 };
    const keeps = (at: number) =>
      previousVersionRetained(recent, versionRetention(entitlements(next, at).limits), at);
    expect(keeps(NOW + 59 * DAY)).toBe(true);
    expect(keeps(NOW + 61 * DAY)).toBe(false);
  });

  it("pins: held for the grace, lapse after", () => {
    const { next } = changed(row(), null, NOW);
    expect(pinsLapse(entitlements(next, NOW + 59 * DAY))).toBe(false);
    expect(pinsLapse(entitlements(next, NOW + 61 * DAY))).toBe(true);
    // New pins still need the feature: it is not granted.
    expect(hasFeature(entitlements(next, NOW + DAY), "pin")).toBe(false);
  });

  it("reads stored holds that are not valid as nothing", () => {
    expect(storedGraceSlots(row({ grace: "not json" }))).toEqual([]);
    expect(storedGraceSlots(row({ grace: [{ plan: "pro" }] }))).toEqual([]);
    expect(storedGraceSlots(row({ grace: JSON.stringify([]) }))).toEqual([]);
    expect(storedGraceSlots(null)).toEqual([]);
  });
});

const planArb = fc.constantFrom(...PLAN_NAMES);
const recordArb = fc.record({
  plan: planArb,
  seats: fc.integer({ min: 1, max: 20 }),
  validUntil: fc.option(fc.integer({ min: NOW - 90 * DAY, max: NOW + 90 * DAY }), {
    nil: null,
  }),
  overrides: fc.option(
    fc.record({
      limits: fc.record(
        {
          retainedPreviousVersions: fc.integer({ min: 0, max: 500 }),
          accessLogRetentionDays: fc.integer({ min: 0, max: 900 }),
          auditRetentionDays: fc.integer({ min: 30, max: 2_557 }),
        },
        { requiredKeys: [] },
      ),
      features: fc.dictionary(fc.constantFrom(...PLAN_FEATURES), fc.boolean()),
    }),
    { nil: null },
  ),
});

describe("properties", () => {
  it("during a grace no retention value is below the previous plan's, and no new feature is granted", () => {
    fc.assert(
      fc.property(
        recordArb,
        fc.option(recordArb, { nil: null }),
        fc.integer({ min: 0, max: GRACE - 1 }),
        (generated, after, elapsed) => {
          // The plan the owner has until the change: one that has not ended (an ended one is held
          // by its own expiry's hold, from its own end).
          const before = { ...generated, validUntil: null };
          const afterRecord = after && { ...after, validUntil: null };
          const previous = entitlements(before, NOW);
          const { next } = changed(before, afterRecord, NOW);
          const owner = entitlements(next, NOW + elapsed);
          for (const key of GRACE_LIMITS) {
            expect(owner.limits[key]).toBeGreaterThanOrEqual(previous.limits[key]);
          }
          // New work: only what the plan the owner has now grants.
          const current = entitlements(afterRecord, NOW + elapsed);
          expect(owner.features).toEqual(current.features);
          for (const feature of previous.features) {
            expect(holdsFeature(owner, feature)).toBe(true);
          }
        },
      ),
    );
  });

  it("after a grace the owner reads exactly as its plan", () => {
    fc.assert(
      fc.property(recordArb, fc.option(recordArb, { nil: null }), (before, after) => {
        const afterRecord = after && { ...after, validUntil: null };
        const { next } = changed(before, afterRecord, NOW);
        const end = NOW + GRACE;
        expect(entitlements(next, end)).toEqual(
          entitlements(afterRecord, end) ?? entitlements(null, end),
        );
      }),
    );
  });

  it("compacting never shortens a value's hold", () => {
    const slotArb = fc.record({
      plan: planArb,
      reason: fc.constantFrom("lowered" as const, "removed" as const, "expired" as const),
      from: fc.integer({ min: NOW, max: NOW + 30 * DAY }),
      until: fc.integer({ min: NOW + DAY, max: NOW + 90 * DAY }),
      limits: fc.record({
        archiveMonths: fc.integer({ min: 0, max: 24 }),
        retainedPreviousVersions: fc.integer({ min: 0, max: 200 }),
        previousVersionRetentionDays: fc.integer({ min: 0, max: 400 }),
        accessLogRetentionDays: fc.integer({ min: 0, max: 400 }),
        auditRetentionDays: fc.integer({ min: 30, max: 400 }),
      }),
      features: fc.subarray([...PLAN_FEATURES]),
    });
    fc.assert(
      fc.property(
        fc.array(slotArb, { maxLength: 14 }),
        fc.integer({ min: 0, max: 90 }),
        (slots, d) => {
          const at = NOW + d * DAY;
          const compacted = compactSlots(slots as GraceSlot[]).slots;
          expect(compacted.length).toBeLessThanOrEqual(PLAN_GRACE_MAX_SLOTS);
          const live = (list: readonly GraceSlot[]) => list.filter((slot) => slot.until > at);
          for (const slot of live(slots as GraceSlot[])) {
            for (const key of GRACE_LIMITS) {
              expect(
                Math.max(...live(compacted).map((kept) => kept.limits[key])),
              ).toBeGreaterThanOrEqual(slot.limits[key]);
            }
          }
        },
      ),
    );
  });

  it("a hold made from a plan covers that plan", () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        const owner = entitlements({ ...record, validUntil: null }, NOW);
        expect(coversSlot(owner, graceSlotOf(owner, "lowered", NOW))).toBe(true);
      }),
    );
  });
});

describe("rank", () => {
  it("names the highest plan held", () => {
    const team = graceSlotOf(entitlements(row({ plan: "team" }), NOW), "lowered", NOW);
    const pro = graceSlotOf(entitlements(row(), NOW), "removed", NOW + DAY);
    const owner = entitlements(row({ plan: "free", grace: [pro, team] as GraceSlot[] }), NOW + DAY);
    expect(owner.grace?.plan).toBe<PlanName>("team");
  });
});

describe("the forecast of an unreadable grace", () => {
  it("lists nothing, since an unreadable grace holds everything and deletes nothing", () => {
    const record = row({ plan: "free", grace: "{not json" });
    expect(entitlements(record, NOW).grace?.unreadable).toBe(true);
    expect(graceForecastSteps(record, NOW)).toEqual([]);
    // A readable one still forecasts.
    const { next } = changed(row(), null, NOW);
    expect(graceForecastSteps(next, NOW + DAY).map((step) => step.kind)).toContain("versions");
  });
});
