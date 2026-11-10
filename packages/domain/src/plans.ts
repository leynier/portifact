// The effective plan of one owner (premium plan section 3, F1): its plan row, read at `now`,
// with seats multiplying the per-seat limits and overrides applied on top. No row, an expired
// row or an unknown plan name all read as `free`, so nothing ever grants more than the row says.
import {
  PLAN_FEATURES,
  PLANS,
  type PlanFeature,
  type PlanLimits,
  PlanName,
  PlanOverrides,
} from "@portifact/contracts";

/** The columns of an `owner_plans` row that decide what it grants. */
export interface OwnerPlanRecord {
  plan: string;
  seats: number;
  /** Epoch milliseconds; null when the plan does not end. */
  validUntil: number | null;
  /** The stored JSON, validated here; anything that is not valid overrides is ignored. */
  overrides: unknown;
}

export interface Entitlements {
  plan: PlanName;
  seats: number;
  validUntil: number | null;
  limits: PlanLimits;
  features: PlanFeature[];
}

/** True while the row's plan applies: it has no end, or `now` is before it. */
export function planActive(record: OwnerPlanRecord, now: number): boolean {
  return record.validUntil === null || now < record.validUntil;
}

function free(): Entitlements {
  return {
    plan: "free",
    seats: 1,
    validUntil: null,
    limits: { ...PLANS.free.limits },
    features: [...PLANS.free.features],
  };
}

/** What an owner may use at `now`, from its plan row or none. */
export function entitlements(record: OwnerPlanRecord | null, now: number): Entitlements {
  if (record === null || !planActive(record, now)) return free();
  const name = PlanName.safeParse(record.plan);
  if (!name.success) return free();
  const definition = PLANS[name.data];
  const seats = Number.isSafeInteger(record.seats) && record.seats >= 1 ? record.seats : 1;
  const limits = { ...definition.limits };
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

/** Whether the owner's plan includes a feature. */
export function hasFeature(owner: Entitlements, feature: PlanFeature): boolean {
  return owner.features.includes(feature);
}

/**
 * A size in decimal units for messages: `250 MB`, `2.5 GB`, `1 TB`. Values keep at most one
 * decimal, so the free plan's messages read exactly as before plans existed.
 */
export function formatSize(bytes: number): string {
  const [unit, size] =
    bytes >= 1e12
      ? ["TB", 1e12]
      : bytes >= 1e9
        ? ["GB", 1e9]
        : bytes >= 1e6
          ? ["MB", 1e6]
          : ["bytes", 1];
  return `${Math.round((bytes / size) * 10) / 10} ${unit}`;
}

/** A count for messages: whole millions as words (`1 million`), anything else with separators. */
export function formatCount(value: number): string {
  if (value >= 1e6 && value % 1e6 === 0) return `${value / 1e6} million`;
  return value.toLocaleString("en-US");
}

/**
 * The limit columns the database compares usage against (`account_usage.active_limit` and
 * `bytes_limit`, `annotation_usage.messages_limit` and `bytes_limit`), for one owner's
 * entitlements. The CHECK constraints are the safety net against races; the rules that refuse new
 * work read the entitlements, not these.
 */
export interface LimitColumns {
  activeLimit: number;
  bytesLimit: number;
  messagesLimit: number;
  annotationBytesLimit: number;
}

export function limitColumns(owner: Entitlements): LimitColumns {
  return {
    activeLimit: owner.limits.activeArtifacts,
    bytesLimit: owner.limits.accountBytes,
    messagesLimit: owner.limits.annotationMessages,
    annotationBytesLimit: owner.limits.annotationBytes,
  };
}

/**
 * The value a limit column should hold: the plan's limit, or the usage when that is higher. The
 * column never drops below what is already used, because the CHECK would refuse the update; the
 * rules refuse new work above the plan's limit, and later scans lower the column as usage falls.
 */
export function alignedLimit(planLimit: number, used: number): number {
  return Math.max(planLimit, used);
}

/** The limit columns of an owner on `free`: the database's column defaults. */
export const FREE_LIMIT_COLUMNS: LimitColumns = limitColumns(entitlements(null, 0));
