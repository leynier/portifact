import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_LIMITS,
  admissionReached,
  assessBudget,
  BUDGET_LEVELS,
  budgetCycle,
  budgetLevel,
  carryForward,
  checkAnnotationCapacity,
  checkDataCapacity,
  checkPublishCapacity,
  DATA_WORK_PAUSED,
  type DataWork,
  EMPTY_METRICS,
  effectiveProtection,
  levelActions,
  NO_PROTECTION,
  overrideActions,
  type PlatformMetrics,
  PROTECTION_ACTIONS,
  PROTECTION_STEPS,
  PROTECTION_TRAFFIC_LIMITS,
  projectionFactor,
  projectSpend,
  protectionBlock,
  REFERENCE_PRICES,
  readMetrics,
  trafficLimited,
} from "./budget.ts";

const GB = 1_000_000_000;
const DAY = 86_400_000;
// November has 30 days: day 15 at 00:00 is exactly half the cycle.
const START = Date.UTC(2026, 10, 1);
const MID = Date.UTC(2026, 10, 16);

const empty: PlatformMetrics = EMPTY_METRICS;

/** Metrics at mid-cycle whose only cost beyond the fixed US$9 is D1 writes worth `usd` dollars. */
function costing(usd: number): PlatformMetrics {
  return { ...empty, d1RowsWritten: (50_000_000 + usd * 1_000_000) / 2 };
}

describe("budget cycle and projection", () => {
  it("uses the calendar month in UTC", () => {
    expect(budgetCycle(Date.UTC(2026, 10, 8, 12))).toEqual({
      start: START,
      end: Date.UTC(2026, 11, 1),
    });
    expect(budgetCycle(Date.UTC(2026, 11, 31, 23, 59)).end).toBe(Date.UTC(2027, 0, 1));
  });

  it("extrapolates counters linearly, counting at least one day as elapsed", () => {
    expect(projectionFactor(MID)).toBeCloseTo(2, 10);
    expect(projectionFactor(START + 60_000)).toBe(30);
    expect(projectionFactor(START + DAY)).toBe(30);
    expect(projectionFactor(Date.UTC(2026, 11, 1) - 1)).toBeCloseTo(1, 6);
  });

  it("charges only what exceeds the included amounts, at the reference prices", () => {
    expect(projectSpend(empty, MID)).toEqual({
      totalUsd: 9,
      items: {
        workersBase: 5,
        domains: 4,
        r2Storage: 0,
        r2ClassA: 0,
        r2ClassB: 0,
        workerRequests: 0,
        d1RowsRead: 0,
        d1RowsWritten: 0,
        emails: 0,
        dataRequests: 0,
        dataDuration: 0,
        dataRowsRead: 0,
        dataRowsWritten: 0,
        dataStorage: 0,
      },
    });
    // Half the cycle: every counter doubles by the end.
    const metrics: PlatformMetrics = {
      storedBytes: 1_010 * GB,
      r2ClassA: 1_000_000,
      r2ClassB: 10_000_000,
      workerRequests: 10_000_000,
      d1RowsRead: 25_000_000_000,
      d1RowsWritten: 50_000_000,
      emails: 3_000,
      // The documents objects: requests and duration are billed in whole blocks of a million.
      dataRequests: 1_000_000,
      dataGbSeconds: 200_001,
      dataRowsRead: 13_000_000_000,
      dataRowsWritten: 26_000_000,
      dataStoredBytes: 6 * GB,
    };
    const { items, totalUsd } = projectSpend(metrics, MID);
    expect(items).toEqual({
      workersBase: 5,
      domains: 4,
      r2Storage: 15,
      r2ClassA: 4.5,
      r2ClassB: 3.6,
      workerRequests: 3,
      d1RowsRead: 25,
      d1RowsWritten: 50,
      emails: 1.05,
      dataRequests: 0.15,
      dataDuration: 12.5,
      dataRowsRead: 1,
      dataRowsWritten: 2,
      dataStorage: 0.2,
    });
    expect(totalUsd).toBe(127);
    // One unit past what is included is a whole block; nothing past it is nothing.
    expect(projectSpend({ ...empty, dataRequests: 500_000 }, MID).items.dataRequests).toBe(0);
    expect(projectSpend({ ...empty, dataRequests: 1_000_001 }, MID).items.dataRequests).toBe(0.3);
  });

  it("matches the plan's reference cost for 1,000 full accounts", () => {
    // Plan section 12: 2,500 GB in R2 Standard with the Workers base is US$42.35, plus domains.
    const { items } = projectSpend({ ...empty, storedBytes: 2_500 * GB }, MID);
    expect(items.r2Storage + items.workersBase).toBe(42.35);
  });

  it("never projects less than the fixed costs and grows with every counter", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5_000 }),
        fc.nat({ max: 50_000_000 }),
        fc.nat({ max: 50_000_000 }),
        (gb, a, extra) => {
          const base = { ...empty, storedBytes: gb * GB, r2ClassA: a };
          const more = { ...base, r2ClassA: a + extra };
          const low = projectSpend(base, MID).totalUsd;
          expect(low).toBeGreaterThanOrEqual(9);
          expect(projectSpend(more, MID).totalUsd).toBeGreaterThanOrEqual(low);
        },
      ),
    );
  });
});

describe("budget levels and protection", () => {
  it("maps projected spend to the plan's thresholds", () => {
    expect(budgetLevel(0)).toBe("none");
    expect(budgetLevel(24.99)).toBe("none");
    expect(budgetLevel(25)).toBe("alert25");
    expect(budgetLevel(50)).toBe("alert50");
    expect(budgetLevel(75)).toBe("slow75");
    expect(budgetLevel(99.99)).toBe("slow75");
    expect(budgetLevel(100)).toBe("protect100");
    expect(budgetLevel(10_000)).toBe("protect100");
  });

  it("brakes new capacity at US$75 and applies the steps at US$100 in the plan's order", () => {
    expect(levelActions("alert50", 60)).toEqual([]);
    expect(levelActions("slow75", 80)).toEqual(["stop_new_artifacts"]);
    expect(levelActions("protect100", 100)).toEqual(["stop_new_artifacts", "block_uploads"]);
    expect(levelActions("protect100", 105)).toEqual([
      "stop_new_artifacts",
      "block_uploads",
      "pause_data_writes",
    ]);
    expect(levelActions("protect100", 110)).toEqual([
      "stop_new_artifacts",
      "block_uploads",
      "pause_data_writes",
      "pause_annotation_writes",
    ]);
    expect(levelActions("protect100", 125)).toEqual([
      "stop_new_artifacts",
      "block_uploads",
      "pause_data_writes",
      "pause_annotation_writes",
      "tighten_public_traffic",
    ]);
    expect(levelActions("protect100", 150)).toEqual([...PROTECTION_ACTIONS]);
  });

  it("only adds a later step once every earlier step applies", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1_000, noNaN: true }), (usd) => {
        const actions = levelActions(budgetLevel(usd), usd);
        expect(actions).toEqual(PROTECTION_ACTIONS.slice(0, actions.length));
      }),
    );
  });

  it("stops admitting new content when a global admission limit is reached", () => {
    expect(admissionReached(empty)).toEqual([]);
    const full: PlatformMetrics = {
      ...empty,
      storedBytes: ADMISSION_LIMITS.storedBytes,
      r2ClassA: ADMISSION_LIMITS.r2ClassA - 1,
      workerRequests: ADMISSION_LIMITS.workerRequests,
      emails: ADMISSION_LIMITS.emails,
    };
    expect(admissionReached(full)).toEqual(["storedBytes", "workerRequests", "emails"]);
    // Late in the cycle with storage just at the limit: spend is modest but admission stops.
    const assessment = assessBudget(
      { ...empty, storedBytes: ADMISSION_LIMITS.storedBytes },
      Date.UTC(2026, 10, 30),
    );
    expect(assessment.level).toBe("none");
    expect(assessment.actions).toEqual(["stop_new_artifacts", "block_uploads"]);
    expect(assessment.alerts).toEqual(["admission_storedBytes"]);
  });

  it("pauses only data writes when the documents objects reach their admission limit", () => {
    const data = { ...empty, dataRowsWritten: ADMISSION_LIMITS.dataRowsWritten };
    expect(admissionReached({ ...data, dataRowsWritten: data.dataRowsWritten - 1 })).toEqual([]);
    const assessment = assessBudget(data, Date.UTC(2026, 10, 30));
    expect(assessment.admission).toEqual(["dataRowsWritten"]);
    expect(assessment.actions).toEqual(["pause_data_writes"]);
    expect(assessment.alerts).toContain("admission_dataRowsWritten");
    // With another limit reached too, both stops apply in the plan's order.
    const both = assessBudget(
      { ...data, storedBytes: ADMISSION_LIMITS.storedBytes },
      Date.UTC(2026, 10, 30),
    );
    expect(both.actions).toEqual(["stop_new_artifacts", "block_uploads", "pause_data_writes"]);
    expect(ADMISSION_LIMITS.dataRowsWritten).toBe(100_000_000);
  });

  it("earns every alert up to the projected spend", () => {
    expect(assessBudget(costing(10), MID).alerts).toEqual([]);
    expect(assessBudget(costing(16), MID).alerts).toEqual(["spend_25"]);
    const high = assessBudget(costing(95), MID);
    expect(high).toMatchObject({
      cycleStart: START,
      projectedUsd: 104,
      level: "protect100",
      admission: [],
      actions: ["stop_new_artifacts", "block_uploads"],
      alerts: ["spend_25", "spend_50", "spend_75", "spend_100"],
    });
  });

  it("accepts other reference prices", () => {
    const prices = { ...REFERENCE_PRICES, domainsUsd: 0, workersBaseUsd: 0 };
    expect(assessBudget(empty, MID, prices).projectedUsd).toBe(0);
  });
});

describe("carrying counters forward", () => {
  it("keeps the last counters of the cycle when a source could not measure them", () => {
    const previous = { ...empty, storedBytes: 5, r2ClassB: 40, workerRequests: 7 };
    const current = { ...empty, storedBytes: 9, workerRequests: 8 };
    expect(carryForward(current, previous)).toEqual({
      ...empty,
      storedBytes: 9,
      r2ClassB: 40,
      workerRequests: 8,
    });
    expect(carryForward(current, null)).toBe(current);
  });

  it("carries the documents objects' counters and stored bytes too", () => {
    const previous = { ...empty, dataRowsWritten: 10, dataGbSeconds: 2, dataStoredBytes: 30 };
    const current = { ...empty, dataRowsWritten: 11 };
    expect(carryForward(current, previous)).toEqual({
      ...empty,
      dataRowsWritten: 11,
      dataGbSeconds: 2,
      dataStoredBytes: 30,
    });
  });

  it("reads stored metrics written before a metric existed as unmeasured", () => {
    expect(readMetrics(null)).toBeNull();
    expect(readMetrics("x")).toBeNull();
    expect(readMetrics({ storedBytes: "1" })).toBeNull();
    expect(readMetrics({ storedBytes: Number.NaN })).toBeNull();
    expect(
      readMetrics({ storedBytes: 4, emails: 2, dataRowsRead: "9", dataRequests: Infinity }),
    ).toEqual({ ...empty, storedBytes: 4, emails: 2 });
    const full = { ...empty, storedBytes: 1, dataStoredBytes: 5, dataRequests: 6 };
    expect(readMetrics(full)).toEqual(full);
  });
});

describe("operator override", () => {
  const automatic = { level: "protect100" as const, actions: [...PROTECTION_ACTIONS] };

  it("maps an override level and step count to actions", () => {
    expect(overrideActions({ level: "none", steps: 4 })).toEqual([]);
    expect(overrideActions({ level: "alert50", steps: 4 })).toEqual([]);
    expect(overrideActions({ level: "slow75", steps: 4 })).toEqual(["stop_new_artifacts"]);
    expect(overrideActions({ level: "protect100", steps: 1 })).toEqual([
      "stop_new_artifacts",
      "block_uploads",
    ]);
    expect(overrideActions({ level: "protect100", steps: 0 })).toHaveLength(2);
    expect(overrideActions({ level: "protect100", steps: 9 })).toEqual([...PROTECTION_ACTIONS]);
  });

  it("replaces the automatic decision until it ends", () => {
    const off = { level: "none" as const, steps: 1, until: 2_000 };
    expect(effectiveProtection(automatic, off, 1_999)).toEqual({
      level: "none",
      actions: [],
      overridden: true,
    });
    expect(effectiveProtection(automatic, off, 2_000)).toEqual({ ...automatic, overridden: false });
    const on = { level: "protect100" as const, steps: 2, until: null };
    expect(effectiveProtection({ level: "none", actions: [] }, on, 9e15)).toEqual({
      level: "protect100",
      actions: ["stop_new_artifacts", "block_uploads", "pause_data_writes"],
      overridden: true,
    });
    expect(effectiveProtection({ level: "none", actions: [] }, null, 0)).toEqual(NO_PROTECTION);
  });

  it("lists every level", () => {
    expect(BUDGET_LEVELS).toEqual(["none", "alert25", "alert50", "slow75", "protect100"]);
  });
});

describe("protection notice", () => {
  it("tells accounts what is paused and what still works", () => {
    expect(protectionBlock([])).toBeNull();
    expect(protectionBlock(["stop_new_artifacts"])).toMatchObject({
      reason: "capacity",
      stops: "new_artifacts",
      until: null,
    });
    const uploads = protectionBlock(["stop_new_artifacts", "block_uploads"]);
    expect(uploads).toMatchObject({ reason: "capacity", stops: "publishing" });
    expect(uploads?.message).toMatch(/^New uploads are paused/);
    expect(uploads?.message).toContain("exporting, deleting, renewing and reducing access");
    const comments = protectionBlock(["block_uploads", "pause_annotation_writes"]);
    expect(comments?.message).toMatch(/^New uploads and comments are paused/);
  });
});

describe("enforcement checks", () => {
  it("pauses new data writes and connects from the data step, never reads, exports or erasure", () => {
    const paused = [
      "declare",
      "index_step",
      "create",
      "replace",
      "bulk_create",
      "bulk_replace",
      "connect",
    ];
    for (const work of Object.keys(DATA_WORK_PAUSED) as DataWork[]) {
      expect(checkDataCapacity([], work), work).toEqual({ ok: true, value: true });
      expect(checkDataCapacity(["stop_new_artifacts", "block_uploads"], work).ok, work).toBe(true);
      const result = checkDataCapacity(["pause_data_writes"], work);
      if (paused.includes(work)) {
        expect(result, work).toMatchObject({ ok: false, code: "capacity_unavailable" });
      } else {
        expect(result, work).toEqual({ ok: true, value: true });
      }
    }
    expect(
      Object.keys(DATA_WORK_PAUSED).filter((work) => DATA_WORK_PAUSED[work as DataWork]),
    ).toEqual(paused);
  });

  it("puts the data step at US$105, between uploads and comments", () => {
    expect(PROTECTION_STEPS).toEqual([
      { action: "block_uploads", fromUsd: 100 },
      { action: "pause_data_writes", fromUsd: 105 },
      { action: "pause_annotation_writes", fromUsd: 110 },
      { action: "tighten_public_traffic", fromUsd: 125 },
      { action: "limit_protected_traffic", fromUsd: 150 },
    ]);
  });

  it("refuses new artifacts from the brake and every upload from the first step", () => {
    expect(checkPublishCapacity([], true)).toEqual({ ok: true, value: true });
    expect(checkPublishCapacity(["stop_new_artifacts"], false)).toEqual({ ok: true, value: true });
    expect(checkPublishCapacity(["stop_new_artifacts"], true)).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
      message: expect.stringContaining("new artifacts"),
    });
    expect(checkPublishCapacity(["stop_new_artifacts", "block_uploads"], false)).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
      message: expect.stringContaining("new uploads"),
    });
  });

  it("pauses comments only from the second step", () => {
    expect(checkAnnotationCapacity(["stop_new_artifacts", "block_uploads"]).ok).toBe(true);
    expect(checkAnnotationCapacity(["block_uploads", "pause_annotation_writes"])).toMatchObject({
      ok: false,
      code: "capacity_unavailable",
    });
  });

  it("limits public traffic before protected traffic", () => {
    const public_ = PROTECTION_ACTIONS.slice(0, 5);
    expect(trafficLimited(public_, true)).toBe(true);
    expect(trafficLimited(public_, false)).toBe(false);
    expect(trafficLimited(PROTECTION_ACTIONS, false)).toBe(true);
    expect(trafficLimited(PROTECTION_ACTIONS.slice(0, 4), true)).toBe(false);
  });

  it("limits public visitors tighter than protected readers, per minute", () => {
    expect(PROTECTION_TRAFFIC_LIMITS).toEqual({ periodMs: 60_000, public: 120, protected: 240 });
  });
});
