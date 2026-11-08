// Budget alerts and automatic protection (plan section 12, "Presupuesto y protección"). Cloudflare's
// budget alerts only inform, so Portifact projects the cycle's spend from its own metrics and
// protects itself. These rules are pure: the jobs Worker measures, services persist and enforce.
import { fail, ok, type Result } from "./result.ts";
import type { Block } from "./usage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1_000_000_000;
const MILLION = 1_000_000;

export const BUDGET_LEVELS = ["none", "alert25", "alert50", "slow75", "protect100"] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/**
 * What protection does, in the order it escalates. `stop_new_artifacts` is the brake at US$75;
 * the other four are the plan's ordered steps at US$100. Reads, exports, deletion, access
 * reduction and renewal are never on this list, and nothing here deletes data.
 */
export const PROTECTION_ACTIONS = [
  "stop_new_artifacts",
  "block_uploads",
  "pause_annotation_writes",
  "tighten_public_traffic",
  "limit_protected_traffic",
] as const;
export type ProtectionAction = (typeof PROTECTION_ACTIONS)[number];

/** Projected spend of the cycle, in US dollars, from which each level applies. */
export const BUDGET_THRESHOLDS: readonly { level: Exclude<BudgetLevel, "none">; usd: number }[] = [
  { level: "alert25", usd: 25 },
  { level: "alert50", usd: 50 },
  { level: "slow75", usd: 75 },
  { level: "protect100", usd: 100 },
];

/**
 * The protection steps at US$100, in the plan's order. Each step applies from its own projected
 * spend, so the measures that disturb readers least come first and the last resort, limiting
 * protected traffic, comes only if spend keeps growing. The operator can apply any prefix of
 * them by hand (`budget-override protect100 --steps N`).
 */
export const PROTECTION_STEPS: readonly { action: ProtectionAction; fromUsd: number }[] = [
  { action: "block_uploads", fromUsd: 100 },
  { action: "pause_annotation_writes", fromUsd: 110 },
  { action: "tighten_public_traffic", fromUsd: 125 },
  { action: "limit_protected_traffic", fromUsd: 150 },
];

/**
 * Global admission limits per cycle (plan section 12). Reaching one stops admitting new content
 * whatever the projected spend: serving what is published takes priority over new content.
 */
export const ADMISSION_LIMITS = {
  storedBytes: 800 * GB,
  r2ClassA: 2 * MILLION,
  workerRequests: 20 * MILLION,
  emails: 20_000,
} as const;
export type AdmissionMetric = keyof typeof ADMISSION_LIMITS;

/**
 * Reference prices of the Workers Paid plan (plan section 12; Cloudflare's published pricing for
 * R2, Workers, D1 and Email Service). They project spend, they are not the invoice: CPU time,
 * logs and taxes are not measured, and the margin of the budget covers them.
 */
export const REFERENCE_PRICES = {
  workersBaseUsd: 5,
  /** Domains prorated per month, from the plan's budget reserve. */
  domainsUsd: 4,
  r2StorageGbMonthUsd: 0.015,
  r2StorageIncludedGb: 10,
  r2ClassAPerMillionUsd: 4.5,
  r2ClassAIncluded: 1 * MILLION,
  r2ClassBPerMillionUsd: 0.36,
  r2ClassBIncluded: 10 * MILLION,
  workerRequestsPerMillionUsd: 0.3,
  workerRequestsIncluded: 10 * MILLION,
  d1RowsReadPerMillionUsd: 0.001,
  d1RowsReadIncluded: 25_000 * MILLION,
  d1RowsWrittenPerMillionUsd: 1,
  d1RowsWrittenIncluded: 50 * MILLION,
  emailsPerThousandUsd: 0.35,
  emailsIncluded: 3_000,
} as const;
export type ReferencePrices = { readonly [K in keyof typeof REFERENCE_PRICES]: number };

/**
 * What the platform used in the current cycle. `storedBytes` is a gauge (bytes stored now); the
 * rest are counters since the cycle started, `null` when no source measured them.
 */
export interface PlatformMetrics {
  storedBytes: number;
  r2ClassA: number | null;
  r2ClassB: number | null;
  workerRequests: number | null;
  d1RowsRead: number | null;
  d1RowsWritten: number | null;
  emails: number | null;
}

export const METRIC_COUNTERS = [
  "r2ClassA",
  "r2ClassB",
  "workerRequests",
  "d1RowsRead",
  "d1RowsWritten",
  "emails",
] as const satisfies readonly (keyof PlatformMetrics)[];

/** The billing cycle used for projections: the calendar month in UTC. */
export function budgetCycle(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

/**
 * How much a counter measured so far grows by the end of the cycle. At least one day counts as
 * elapsed, so the first minutes of a cycle cannot extrapolate a burst into a false emergency.
 */
export function projectionFactor(now: number): number {
  const { start, end } = budgetCycle(now);
  const elapsed = Math.min(Math.max(now - start, DAY_MS), end - start);
  return (end - start) / elapsed;
}

const overage = (used: number, included: number) => Math.max(0, used - included);
const cents = (usd: number) => Math.round(usd * 100) / 100;

export type SpendItem =
  | "workersBase"
  | "domains"
  | "r2Storage"
  | "r2ClassA"
  | "r2ClassB"
  | "workerRequests"
  | "d1RowsRead"
  | "d1RowsWritten"
  | "emails";

/** Projected spend of the cycle, in total and per item, rounded to cents. */
export function projectSpend(
  metrics: PlatformMetrics,
  now: number,
  prices: ReferencePrices = REFERENCE_PRICES,
): { totalUsd: number; items: Record<SpendItem, number> } {
  const factor = projectionFactor(now);
  const projected = (value: number | null) => (value === null ? 0 : value * factor);
  const items: Record<SpendItem, number> = {
    workersBase: prices.workersBaseUsd,
    domains: prices.domainsUsd,
    // A gauge: what is stored now is assumed to stay stored for the whole cycle.
    r2Storage:
      overage(metrics.storedBytes / GB, prices.r2StorageIncludedGb) * prices.r2StorageGbMonthUsd,
    r2ClassA:
      (overage(projected(metrics.r2ClassA), prices.r2ClassAIncluded) / MILLION) *
      prices.r2ClassAPerMillionUsd,
    r2ClassB:
      (overage(projected(metrics.r2ClassB), prices.r2ClassBIncluded) / MILLION) *
      prices.r2ClassBPerMillionUsd,
    workerRequests:
      (overage(projected(metrics.workerRequests), prices.workerRequestsIncluded) / MILLION) *
      prices.workerRequestsPerMillionUsd,
    d1RowsRead:
      (overage(projected(metrics.d1RowsRead), prices.d1RowsReadIncluded) / MILLION) *
      prices.d1RowsReadPerMillionUsd,
    d1RowsWritten:
      (overage(projected(metrics.d1RowsWritten), prices.d1RowsWrittenIncluded) / MILLION) *
      prices.d1RowsWrittenPerMillionUsd,
    emails:
      (overage(projected(metrics.emails), prices.emailsIncluded) / 1_000) *
      prices.emailsPerThousandUsd,
  };
  for (const key of Object.keys(items) as SpendItem[]) items[key] = cents(items[key]);
  const totalUsd = cents(Object.values(items).reduce((sum, value) => sum + value, 0));
  return { totalUsd, items };
}

/** The level a projected spend reaches. */
export function budgetLevel(projectedUsd: number): BudgetLevel {
  let level: BudgetLevel = "none";
  for (const threshold of BUDGET_THRESHOLDS)
    if (projectedUsd >= threshold.usd) level = threshold.level;
  return level;
}

function ordered(actions: Iterable<ProtectionAction>): ProtectionAction[] {
  const set = new Set(actions);
  return PROTECTION_ACTIONS.filter((action) => set.has(action));
}

/** Actions of an automatic level: the brake from US$75, then each step from its own spend. */
export function levelActions(level: BudgetLevel, projectedUsd: number): ProtectionAction[] {
  if (level !== "slow75" && level !== "protect100") return [];
  const actions: ProtectionAction[] = ["stop_new_artifacts"];
  if (level === "protect100") {
    for (const step of PROTECTION_STEPS)
      if (projectedUsd >= step.fromUsd) actions.push(step.action);
  }
  return actions;
}

/** Admission limits the cycle's counters reached, in the order of `ADMISSION_LIMITS`. */
export function admissionReached(metrics: PlatformMetrics): AdmissionMetric[] {
  return (Object.keys(ADMISSION_LIMITS) as AdmissionMetric[]).filter((metric) => {
    const value = metrics[metric];
    return value !== null && value >= ADMISSION_LIMITS[metric];
  });
}

/** An alert recorded at most once per cycle. */
export type BudgetAlertKind =
  | "spend_25"
  | "spend_50"
  | "spend_75"
  | "spend_100"
  | `admission_${AdmissionMetric}`;

export interface BudgetAssessment {
  cycleStart: number;
  projectedUsd: number;
  items: Record<SpendItem, number>;
  level: BudgetLevel;
  admission: AdmissionMetric[];
  /** Automatic protection: the level's actions plus what a reached admission limit stops. */
  actions: ProtectionAction[];
  /** Every alert the cycle has earned so far; the caller records each one once. */
  alerts: BudgetAlertKind[];
}

/** Projects the cycle's spend and decides the automatic level, protection and alerts. */
export function assessBudget(
  metrics: PlatformMetrics,
  now: number,
  prices: ReferencePrices = REFERENCE_PRICES,
): BudgetAssessment {
  const { totalUsd, items } = projectSpend(metrics, now, prices);
  const level = budgetLevel(totalUsd);
  const admission = admissionReached(metrics);
  const actions = levelActions(level, totalUsd);
  if (admission.length > 0) actions.push("stop_new_artifacts", "block_uploads");
  const alerts: BudgetAlertKind[] = [
    ...BUDGET_THRESHOLDS.filter((t) => totalUsd >= t.usd).map(
      (t) => `spend_${t.usd}` as BudgetAlertKind,
    ),
    ...admission.map((metric) => `admission_${metric}` as const),
  ];
  return {
    cycleStart: budgetCycle(now).start,
    projectedUsd: totalUsd,
    items,
    level,
    admission,
    actions: ordered(actions),
    alerts,
  };
}

/**
 * Fills counters a source could not measure this time with the last values of the same cycle.
 * Counters only grow within a cycle, so a stale value understates a little; dropping it would
 * understate a lot and could lift protection because an analytics query failed.
 */
export function carryForward(
  current: PlatformMetrics,
  previous: PlatformMetrics | null,
): PlatformMetrics {
  if (!previous) return current;
  const merged = { ...current };
  for (const key of METRIC_COUNTERS) merged[key] = current[key] ?? previous[key];
  return merged;
}

export interface BudgetOverride {
  level: BudgetLevel;
  /** Steps of `PROTECTION_STEPS` applied at `protect100`, 1 to 4. */
  steps: number;
  /** When the override ends by itself; null until the operator clears it. */
  until: number | null;
}

/** Actions an operator override applies: the level's brake and the first `steps` steps. */
export function overrideActions(override: Pick<BudgetOverride, "level" | "steps">) {
  if (override.level === "slow75") return ["stop_new_artifacts"] as ProtectionAction[];
  if (override.level !== "protect100") return [];
  const steps = Math.min(Math.max(Math.trunc(override.steps), 1), PROTECTION_STEPS.length);
  return ordered([
    "stop_new_artifacts",
    ...PROTECTION_STEPS.slice(0, steps).map((step) => step.action),
  ]);
}

export interface Protection {
  level: BudgetLevel;
  actions: ProtectionAction[];
  /** True while an operator override replaces the automatic decision. */
  overridden: boolean;
}

export const NO_PROTECTION: Protection = { level: "none", actions: [], overridden: false };

/**
 * What applies now: an operator override that has not ended replaces the automatic level and
 * actions in both directions (to protect sooner, or to lift protection the operator judged wrong).
 */
export function effectiveProtection(
  automatic: { level: BudgetLevel; actions: readonly ProtectionAction[] },
  override: BudgetOverride | null,
  now: number,
): Protection {
  if (override && (override.until === null || now < override.until)) {
    return { level: override.level, actions: overrideActions(override), overridden: true };
  }
  return { level: automatic.level, actions: ordered(automatic.actions), overridden: false };
}

/**
 * The usage block an account sees while protection limits publishing (plan section 12: "aviso
 * visible en el panel"). Null when nothing an account does is limited.
 */
export function protectionBlock(actions: readonly ProtectionAction[]): Block | null {
  const has = new Set(actions);
  const keeps =
    "Your artifacts stay online, and reading, exporting, deleting, renewing and reducing access still work.";
  if (has.has("block_uploads")) {
    const paused = has.has("pause_annotation_writes") ? "New uploads and comments" : "New uploads";
    return {
      reason: "capacity",
      stops: "publishing",
      message: `${paused} are paused for now while Portifact protects its capacity. ${keeps}`,
      until: null,
    };
  }
  if (has.has("stop_new_artifacts")) {
    return {
      reason: "capacity",
      stops: "new_artifacts",
      message: `Creating new artifacts is paused for now while Portifact protects its capacity; updates still work. ${keeps}`,
      until: null,
    };
  }
  return null;
}

/**
 * Whether protection lets a publish start: `block_uploads` stops every new upload, and
 * `stop_new_artifacts` stops only those that create an artifact. Rollbacks, restores and renewals
 * upload nothing, so they never pass through here.
 */
export function checkPublishCapacity(
  actions: readonly ProtectionAction[],
  createsArtifact: boolean,
): Result<true> {
  if (actions.includes("block_uploads")) {
    return fail(
      "capacity_unavailable",
      "Portifact is not accepting new uploads right now while it protects its capacity. Your artifacts stay online; try again later.",
    );
  }
  if (createsArtifact && actions.includes("stop_new_artifacts")) {
    return fail(
      "capacity_unavailable",
      "Portifact is not creating new artifacts right now while it protects its capacity. Updates to your existing artifacts still work.",
    );
  }
  return ok(true);
}

/**
 * Whether protection lets a comment be written (a new thread, a reply or an edit). Moderation,
 * resolving and deleting stay allowed: they add nothing.
 */
export function checkAnnotationCapacity(actions: readonly ProtectionAction[]): Result<true> {
  return actions.includes("pause_annotation_writes")
    ? fail(
        "capacity_unavailable",
        "New comments are paused for now while Portifact protects its capacity. Try again later.",
      )
    : ok(true);
}

/** Whether delivery applies the tight per-visitor rate limit to this kind of traffic. */
export function trafficLimited(actions: readonly ProtectionAction[], isPublic: boolean): boolean {
  return actions.includes(isPublic ? "tighten_public_traffic" : "limit_protected_traffic");
}
