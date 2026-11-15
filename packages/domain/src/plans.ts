// The effective plan of one owner (premium plan section 3, F1): its plan row, read at `now`,
// with seats multiplying the per-seat limits and overrides applied on top. No row, an expired
// row or an unknown plan name all read as `free`, so nothing ever grants more than the row says.
import {
  type DataPlanLimits,
  GRACE_LIMITS,
  type GraceLimits,
  type GraceSlot,
  GraceSlots,
  PLAN_FEATURES,
  PLAN_GRACE_MAX_SLOTS,
  PLAN_GRACE_MS,
  PLAN_NAMES,
  PLANS,
  type PlanFeature,
  type PlanLimits,
  PlanName,
  PlanOverrides,
  planRequiredMessage,
  RETENTION_LIMIT_MAX,
} from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/** The columns of an `owner_plans` row that decide what it grants. */
export interface OwnerPlanRecord {
  plan: string;
  seats: number;
  /** Epoch milliseconds; null when the plan does not end. */
  validUntil: number | null;
  /** The stored JSON, validated here; anything that is not valid overrides is ignored. */
  overrides: unknown;
  /**
   * `owner_plans.grace`: the drops still held (decision 0022), a JSON list validated here. A
   * reader that leaves it out still sees a natural expiry's hold, which comes from `validUntil`.
   */
  grace?: unknown;
}

/**
 * A running grace (decision 0022): until when, the highest plan held, the retention it keeps,
 * the paid features whose held data can still be read, and the access log's holds, from which
 * `retentionExpiry` dates rows.
 */
export interface Grace {
  until: number;
  plan: PlanName;
  limits: GraceLimits;
  features: PlanFeature[];
  slots: GraceSlot[];
  /**
   * The stored grace could not be read (decision 0022, "Unreadable graces"): it is held with the
   * most any retention limit may be, and its access log hold never ends, until the operator's
   * next change to the plan stores a readable one. Nothing is deleted because of it.
   */
  unreadable: boolean;
}

export interface Entitlements {
  plan: PlanName;
  seats: number;
  validUntil: number | null;
  /**
   * The plan's limits. During a grace the retention limits (`GRACE_LIMITS`) are the highest of
   * the plan's and the held ones, so every scan and reader that keeps or lists data by them holds
   * what the previous plan kept; every other limit is the plan's own.
   */
  limits: PlanLimits;
  /** The paid features the plan grants now: what new work may use. */
  features: PlanFeature[];
  /**
   * Artifact data (decision 0026): the plan's own values with overrides, never held by a grace
   * (a lower plan only refuses new work, from the next command).
   */
  data: DataPlanLimits;
  /** The running grace, or null (absent on values built before graces existed). */
  grace?: Grace | null;
  /** The plan's own access log retention, before any grace (`retentionExpiry`). */
  ownAccessLogDays?: number;
}

export { PLAN_GRACE_MS };

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
    data: dataOf(PLANS.free.data),
  };
}

function dataOf(data: DataPlanLimits): DataPlanLimits {
  return { artifacts: data.artifacts, perArtifact: { ...data.perArtifact } };
}

/** What the row grants while it applies, ignoring its end and its grace; free when unreadable. */
function granted(record: OwnerPlanRecord): Entitlements {
  const name = PlanName.safeParse(record.plan);
  if (!name.success) return free();
  const definition = PLANS[name.data];
  const seats = Number.isSafeInteger(record.seats) && record.seats >= 1 ? record.seats : 1;
  const limits = { ...definition.limits };
  for (const key of definition.perSeat) limits[key] = definition.limits[key] * seats;
  const enabled = new Set<PlanFeature>(definition.features);
  const data = dataOf(definition.data);
  const overrides = PlanOverrides.safeParse(record.overrides ?? {});
  if (overrides.success) {
    Object.assign(limits, overrides.data.limits);
    if (overrides.data.data?.artifacts !== undefined)
      data.artifacts = overrides.data.data.artifacts;
    Object.assign(data.perArtifact, overrides.data.data?.perArtifact);
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
    data,
  };
}

function graceLimitsOf(limits: PlanLimits): GraceLimits {
  return Object.fromEntries(GRACE_LIMITS.map((key) => [key, limits[key]])) as GraceLimits;
}

/**
 * The stored grace: its slots, or `unreadable` when the column holds something that is not a
 * valid list of slots (a bad JSON text, a slot out of bounds). Never throws.
 */
export function readGrace(record: OwnerPlanRecord | null): {
  slots: GraceSlot[];
  unreadable: boolean;
} {
  if (record?.grace === null || record?.grace === undefined)
    return { slots: [], unreadable: false };
  const raw = typeof record.grace === "string" ? safeJson(record.grace) : record.grace;
  const parsed = GraceSlots.safeParse(raw);
  return parsed.success
    ? { slots: parsed.data, unreadable: false }
    : { slots: [], unreadable: true };
}

/** The stored slots when they read; none when the grace is unreadable (see `readGrace`). */
export function storedGraceSlots(record: OwnerPlanRecord | null): GraceSlot[] {
  return readGrace(record).slots;
}

/**
 * The hold that stands in for a grace that cannot be read: the most any retention limit may be,
 * no paid reads (they are not deletion), until `PLAN_GRACE_DAYS` from `now`.
 */
export function unreadableGraceSlot(now: number): GraceSlot {
  return {
    plan: "enterprise",
    reason: "unreadable",
    from: now,
    until: now + PLAN_GRACE_MS,
    limits: { ...RETENTION_LIMIT_MAX },
    features: [],
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The hold of a drop: what `previous` kept and granted, from `from` for `PLAN_GRACE_DAYS`. */
export function graceSlotOf(
  previous: Entitlements,
  reason: GraceSlot["reason"],
  from: number,
  expiry?: number,
): GraceSlot {
  const limits = graceLimitsOf(previous.limits);
  // Within the bounds a stored slot must keep (overrides are held to them too).
  for (const key of GRACE_LIMITS) limits[key] = Math.min(limits[key], RETENTION_LIMIT_MAX[key]);
  return {
    plan: previous.plan,
    reason,
    from,
    until: from + PLAN_GRACE_MS,
    limits,
    features: [...previous.features],
    ...(expiry === undefined ? {} : { expiry }),
  };
}

/**
 * A natural expiry's hold, from the row itself, while the scan has not stored it yet: the row
 * reached `validUntil` less than `PLAN_GRACE_DAYS` ago and no stored slot came from that expiry.
 */
export function expirySlot(record: OwnerPlanRecord | null, now: number): GraceSlot | null {
  if (record === null || record.validUntil === null || now < record.validUntil) return null;
  if (now >= record.validUntil + PLAN_GRACE_MS) return null;
  if (!PlanName.safeParse(record.plan).success) return null;
  const expiry = record.validUntil;
  if (storedGraceSlots(record).some((slot) => slot.expiry === expiry)) return null;
  const slot = graceSlotOf(granted(record), "expired", expiry, expiry);
  // A plan that kept and granted nothing beyond free (an ended free row) holds nothing.
  return coversSlot(free(), slot) ? null : slot;
}

/**
 * The holds running at `now`: the stored ones not ended, a natural expiry's and, for a grace
 * that cannot be read, the conservative hold that stands in for it.
 */
export function liveGraceSlots(record: OwnerPlanRecord | null, now: number): GraceSlot[] {
  const { slots, unreadable } = readGrace(record);
  const live = slots.filter((slot) => slot.until > now);
  const expired = expirySlot(record, now);
  if (expired) live.push(expired);
  if (unreadable) live.push(unreadableGraceSlot(now));
  return live;
}

/** Whether `owner` keeps and grants everything `slot` holds, so the hold adds nothing. */
export function coversSlot(
  owner: { limits: GraceLimits; features: readonly PlanFeature[] },
  slot: GraceSlot,
): boolean {
  return (
    GRACE_LIMITS.every((key) => owner.limits[key] >= slot.limits[key]) &&
    slot.features.every((feature) => owner.features.includes(feature))
  );
}

function rank(plan: PlanName): number {
  return PLAN_NAMES.indexOf(plan);
}

/**
 * What an owner may use at `now`, from its plan row or none. During a grace (decision 0022) the
 * retention limits are the highest of the plan's and every running hold's, and `grace` lists the
 * paid features whose held data stays readable; `features` is always the plan's own, so new work
 * is refused exactly as without a grace.
 */
export function entitlements(record: OwnerPlanRecord | null, now: number): Entitlements {
  const own = record === null || !planActive(record, now) ? free() : granted(record);
  const slots = liveGraceSlots(record, now);
  if (slots.length === 0) return own;
  const unreadable = readGrace(record).unreadable;
  const held = { ...graceLimitsOf(own.limits) };
  const heldFeatures = new Set<PlanFeature>();
  let plan: PlanName = slots[0]?.plan ?? "free";
  let until = 0;
  for (const slot of slots) {
    for (const key of GRACE_LIMITS) held[key] = Math.max(held[key], slot.limits[key]);
    for (const feature of slot.features) heldFeatures.add(feature);
    if (rank(slot.plan) > rank(plan)) plan = slot.plan;
    until = Math.max(until, slot.until);
  }
  return {
    ...own,
    ownAccessLogDays: own.limits.accessLogRetentionDays,
    limits: { ...own.limits, ...held },
    grace: {
      until,
      plan,
      limits: held,
      features: PLAN_FEATURES.filter((f) => heldFeatures.has(f) && !own.features.includes(f)),
      slots,
      unreadable,
    },
  };
}

/** What a plan change does to the holds (decision 0022). */
export interface GraceChange {
  /** The holds to store after the change. */
  slots: GraceSlot[];
  /**
   * The holds this change stores for the first time, each to be recorded as started: the one it
   * starts for what the outgoing plan kept, a natural expiry's hold the grace scan had not stored
   * yet (reason `expired`), and the hold standing in for an unreadable grace. Empty when the
   * change took nothing away and found nothing unstored.
   */
  started: GraceSlot[];
  /** Holds the change ended: covered again, the operator's `--no-grace`, or folded. */
  ended: { slot: GraceSlot; reason: "renewed" | "operator" | "folded" }[];
}

/** Whether a live slot is stored in the row already (so its start was recorded when it was). */
function isStored(record: OwnerPlanRecord | null, slot: GraceSlot): boolean {
  const same = (a: GraceSlot, b: GraceSlot) =>
    a.reason === b.reason && a.from === b.from && a.until === b.until && a.plan === b.plan;
  return storedGraceSlots(record).some((stored) => same(stored, slot));
}

/**
 * The holds after the operator changes a plan (`set-plan`) or removes it (`remove-plan`): the
 * running ones (a natural expiry's included, which is stored from then on) plus one for what the
 * outgoing plan kept, from `now` for `PLAN_GRACE_DAYS`, unless the new plan keeps all of it. A hold
 * the new plan covers ends early with nothing lost. Each hold keeps its own end: a second drop
 * during a grace neither extends nor shortens the first (decision 0022). `noGrace` ends them all.
 * Every hold gets exactly one start and one end whoever stores it first: a live hold not stored
 * yet is reported in `started` with the change that stores (or ends) it.
 */
export function graceAfterChange(
  before: OwnerPlanRecord | null,
  after: OwnerPlanRecord | null,
  input: { now: number; reason: "lowered" | "removed"; noGrace: boolean },
): GraceChange {
  const { now } = input;
  const live = liveGraceSlots(before, now);
  const unstored = live.filter((slot) => !isStored(before, slot));
  if (input.noGrace) {
    return {
      slots: [],
      started: unstored,
      ended: live.map((slot) => ({ slot, reason: "operator" })),
    };
  }
  const next = after === null || !planActive(after, now) ? free() : granted(after);
  // What the owner had until now: its plan, or free without one (a lower override below free is
  // a drop too). A plan that already ended is held by its own expiry's hold, in `live`.
  const outgoing = graceSlotOf(
    before !== null && planActive(before, now) ? granted(before) : free(),
    input.reason,
    now,
  );
  const ended: GraceChange["ended"] = [];
  const kept: GraceSlot[] = [];
  for (const slot of live) {
    if (coversSlot(next, slot)) ended.push({ slot, reason: "renewed" });
    else kept.push(slot);
  }
  const started = [...unstored];
  if (!coversSlot(next, outgoing)) {
    started.push(outgoing);
    kept.push(outgoing);
  }
  const compacted = compactSlots(kept);
  return {
    slots: compacted.slots,
    started,
    ended: [...ended, ...compacted.folded.map((slot) => ({ slot, reason: "folded" as const }))],
  };
}

/**
 * Past `PLAN_GRACE_MAX_SLOTS` running holds, folds the two that end first into the later one,
 * which keeps the highest of both until its own end and counts how many it holds (`folded`).
 * Only after that many drops, and only ever longer: a value can be held at most the grace length
 * after the newest drop folded in. The earlier hold is reported in `folded`, to be recorded as
 * ended (reason `folded`). Holds are otherwise kept as they are, each with its own start and end.
 */
export function compactSlots(slots: readonly GraceSlot[]): {
  slots: GraceSlot[];
  folded: GraceSlot[];
} {
  const kept = [...slots].sort((a, b) => a.until - b.until || a.from - b.from);
  const folded: GraceSlot[] = [];
  while (kept.length > PLAN_GRACE_MAX_SLOTS) {
    const [a, b, ...rest] = kept as [GraceSlot, GraceSlot, ...GraceSlot[]];
    const limits = { ...b.limits };
    for (const key of GRACE_LIMITS) limits[key] = Math.max(a.limits[key], b.limits[key]);
    folded.push(a);
    kept.splice(
      0,
      kept.length,
      {
        ...b,
        plan: rank(a.plan) > rank(b.plan) ? a.plan : b.plan,
        limits,
        features: PLAN_FEATURES.filter((f) => a.features.includes(f) || b.features.includes(f)),
        folded: (a.folded ?? 1) + (b.folded ?? 1),
      },
      ...rest,
    );
  }
  return { slots: kept, folded };
}

/** What the grace scan does to one row (decision 0022), or null when it has nothing to do. */
export interface GraceScanStep {
  /** The holds to store. */
  slots: GraceSlot[];
  /** A natural expiry's hold, stored now so its start is recorded once. */
  started: GraceSlot | null;
  /** Holds whose days passed: removed, and recorded as expired. */
  ended: GraceSlot[];
  /** Holds folded into a later one to stay within `PLAN_GRACE_MAX_SLOTS`, recorded as ended. */
  folded: GraceSlot[];
}

/**
 * One row's step of the grace scan. Null when there is nothing to do, and for a grace that
 * cannot be read: the scan never rewrites or deletes such a row (it logs it for the operator).
 */
export function graceScanStep(record: OwnerPlanRecord, now: number): GraceScanStep | null {
  const { slots: stored, unreadable } = readGrace(record);
  if (unreadable) return null;
  const ended = stored.filter((slot) => slot.until <= now);
  const started = expirySlot(record, now);
  if (ended.length === 0 && started === null) return null;
  const slots = stored.filter((slot) => slot.until > now);
  const compacted = compactSlots(started ? [...slots, started] : slots);
  return { slots: compacted.slots, started, ended, folded: compacted.folded };
}

/** What the row grants by itself at `now`, without any grace: the plan's own entitlements. */
export function ownEntitlements(record: OwnerPlanRecord | null, now: number): Entitlements {
  return record === null || !planActive(record, now) ? free() : granted(record);
}

/**
 * One step of what a running grace lets go (decision 0022): at `from`, the end of a hold, the
 * retention in force for one kind drops from `before` to `after` (the granted plan plus the holds
 * still running on each side of that moment). What `before` kept and `after` does not is what the
 * scans delete then; a kind can drop at several hold ends.
 */
export interface GraceForecastStep {
  kind: "versions" | "accessLog" | "auditEvents" | "pins";
  from: number;
  before: GraceLimits & { pin: boolean };
  after: GraceLimits & { pin: boolean };
}

/** What is kept at `at`: the retention limits in force and whether pins are kept. */
export function keptAt(record: OwnerPlanRecord | null, at: number): GraceLimits & { pin: boolean } {
  const owner = entitlements(record, at);
  return { ...graceLimitsOf(owner.limits), pin: holdsFeature(owner, "pin") };
}

const STEP_KINDS: readonly GraceForecastStep["kind"][] = [
  "versions",
  "accessLog",
  "auditEvents",
  "pins",
];

const drops: Record<
  GraceForecastStep["kind"],
  (before: GraceLimits & { pin: boolean }, after: GraceLimits & { pin: boolean }) => boolean
> = {
  versions: (b, a) =>
    a.retainedPreviousVersions < b.retainedPreviousVersions ||
    a.previousVersionRetentionDays < b.previousVersionRetentionDays,
  accessLog: (b, a) => a.accessLogRetentionDays < b.accessLogRetentionDays,
  auditEvents: (b, a) => a.auditRetentionDays < b.auditRetentionDays,
  pins: (b, a) => b.pin && !a.pin,
};

/**
 * The moments after `now` at which what is kept can change: each running hold's end, and a plan
 * with an end's own end and the end of its natural hold.
 */
function changeMoments(record: OwnerPlanRecord | null, now: number): number[] {
  const moments = liveGraceSlots(record, now).map((slot) => slot.until);
  if (record?.validUntil != null) {
    moments.push(record.validUntil, record.validUntil + PLAN_GRACE_MS);
  }
  return [...new Set(moments.filter((at) => at > now))].sort((a, b) => a - b);
}

/**
 * What a running grace will let go, in order: for each hold end at which the retention in force
 * for a kind drops (more previous versions or days, access log or audit days, or pins), the step
 * with what is kept just before and from then on. Not "the earliest end of a hold that keeps more
 * than the plan": while a later hold keeps the same, nothing goes at the earlier one's end. Empty
 * without a grace, and for a grace that cannot be read (it holds everything, deletes nothing).
 */
export function graceForecastSteps(
  record: OwnerPlanRecord | null,
  now: number,
): GraceForecastStep[] {
  if (readGrace(record).unreadable) return [];
  if (liveGraceSlots(record, now).length === 0) return [];
  const steps: GraceForecastStep[] = [];
  for (const at of changeMoments(record, now)) {
    const before = keptAt(record, at - 1);
    const after = keptAt(record, at);
    for (const kind of STEP_KINDS) {
      if (drops[kind](before, after)) steps.push({ kind, from: at, before, after });
    }
  }
  return steps;
}

/**
 * Whether the end of a hold lets anything go: a forecast step falls on it (decision 0022, third
 * delivery). The same rule as the forecast, so an email and the forecast can never disagree: a
 * hold another covers past its end, or one whose end only drops what deletes nothing (held reads,
 * `archiveMonths`, which only dates archives made meanwhile and never moves a `purge_at`), is
 * announced by nobody.
 */
export function graceHoldEndDrops(record: OwnerPlanRecord | null, slot: GraceSlot): boolean {
  return graceForecastSteps(record, slot.until - 1).some((step) => step.from === slot.until);
}

/** Whether the owner's plan includes a feature. */
export function hasFeature(owner: Entitlements, feature: PlanFeature): boolean {
  return owner.features.includes(feature);
}

/**
 * The one way to refuse a paid feature: the owner's entitlements back when its plan includes the
 * feature, `plan_required` naming the feature and the lowest plan with it otherwise. Pass the
 * entitlements of the artifact's owner (a workspace's plan for a workspace), never the caller's.
 */
export function requireFeature(owner: Entitlements, feature: PlanFeature): Result<Entitlements> {
  return hasFeature(owner, feature)
    ? ok(owner)
    : fail("plan_required", planRequiredMessage(feature));
}

/**
 * Whether the owner may read and export data a paid feature produced: the plan grants the
 * feature, or a running grace holds it (decision 0022). Only reads of held data use this; new
 * work uses `hasFeature`.
 */
export function holdsFeature(owner: Entitlements, feature: PlanFeature): boolean {
  return hasFeature(owner, feature) || (owner.grace?.features.includes(feature) ?? false);
}

/**
 * The gate of a read of held data (the analytics, the audit log and its export, comparing
 * retained versions): `requireFeature`, except that a running grace keeps it open for the
 * features the previous plan granted (decision 0022). Writes and new work keep `requireFeature`.
 */
export function requireHeldFeature(
  owner: Entitlements,
  feature: PlanFeature,
): Result<Entitlements> {
  return holdsFeature(owner, feature)
    ? ok(owner)
    : fail("plan_required", planRequiredMessage(feature));
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
