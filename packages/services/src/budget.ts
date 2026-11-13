// Budget state, alerts and the operator override (plan section 12). The jobs Worker records a
// measurement every run; services read the effective protection to enforce it; the operator tool
// shows the state and overrides it. The rules themselves are in packages/domain/src/budget.ts.
import { type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  assessBudget,
  type BudgetAssessment,
  type BudgetLevel,
  type BudgetOverride,
  budgetCycle,
  carryForward,
  checkDataCapacity,
  DATA_WORK_PAUSED,
  type DataWork,
  EMPTY_METRICS,
  effectiveProtection,
  NO_PROTECTION,
  ok,
  type PlatformMetrics,
  PROTECTION_ACTIONS,
  type Protection,
  type ProtectionAction,
  type Result,
  readMetrics,
} from "@portifact/domain";
import { and, count, desc, eq, gte, inArray, isNull, sql, sum } from "drizzle-orm";
import { emailsSentInCycle } from "./email.ts";

const ROW_ID = "global";

export type AnalyticsStatus = "off" | "ok" | "failed";

export interface BudgetState {
  cycleStart: number;
  /** The automatic decision of the last measurement. */
  automatic: { level: BudgetLevel; actions: ProtectionAction[] };
  projectedUsd: number;
  metrics: PlatformMetrics | null;
  analytics: AnalyticsStatus;
  /** 0 when nothing was measured yet (an override can exist before the first measurement). */
  measuredAt: number;
  levelChangedAt: number;
  override: (BudgetOverride & { note: string | null; setAt: number }) | null;
  /** What applies now, override included. */
  effective: Protection;
}

export interface BudgetAlert {
  id: number;
  cycleStart: number;
  kind: string;
  level: BudgetLevel;
  projectedUsd: number;
  createdAt: number;
  notifiedAt: number | null;
}

type BudgetRow = typeof schema.platformBudget.$inferSelect;

function parseActions(json: string): ProtectionAction[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return PROTECTION_ACTIONS.filter((action) => value.includes(action));
  } catch {
    return [];
  }
}

function parseMetrics(json: string): PlatformMetrics | null {
  try {
    return readMetrics(JSON.parse(json));
  } catch {
    return null;
  }
}

function overrideOf(row: BudgetRow): BudgetState["override"] {
  if (row.overrideLevel === null) return null;
  return {
    level: row.overrideLevel,
    steps: row.overrideSteps ?? 1,
    until: row.overrideUntil,
    note: row.overrideNote,
    setAt: row.overrideSetAt ?? 0,
  };
}

function stateOf(row: BudgetRow, now: number): BudgetState {
  const automatic = { level: row.level, actions: parseActions(row.actions) };
  const override = overrideOf(row);
  return {
    cycleStart: row.cycleStart,
    automatic,
    projectedUsd: row.projectedCents / 100,
    metrics: parseMetrics(row.metrics),
    analytics: row.analytics,
    measuredAt: row.measuredAt,
    levelChangedAt: row.levelChangedAt,
    override,
    effective: effectiveProtection(automatic, override, now),
  };
}

async function budgetRow(db: GlobalDb): Promise<BudgetRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.platformBudget)
    .where(eq(schema.platformBudget.id, ROW_ID))
    .limit(1);
  return row;
}

/** The persisted budget state, or null before the first measurement or override. */
export async function getBudgetState(db: GlobalDb, now: number): Promise<BudgetState | null> {
  const row = await budgetRow(db);
  return row ? stateOf(row, now) : null;
}

/** The protection that applies now; none before anything was measured. */
export async function platformProtection(db: GlobalDb, now: number): Promise<Protection> {
  return (await getBudgetState(db, now))?.effective ?? NO_PROTECTION;
}

/**
 * Whether budget protection lets a piece of artifact data work start (decision 0026, the data
 * step): `capacity_unavailable` while `pause_data_writes` applies and the work creates or grows
 * data or opens a live connection. The owner and page data services call it before their command
 * reaches the documents object; reads, exports, deletes and erasure pass whatever the step.
 */
export async function checkDataWriteCapacity(
  db: GlobalDb,
  work: DataWork,
  now: number,
): Promise<Result<true>> {
  // Work the step never stops adds no read for it.
  if (!DATA_WORK_PAUSED[work]) return ok(true);
  return checkDataCapacity((await platformProtection(db, now)).actions, work);
}

/**
 * Estimates the cycle's usage from what D1 already knows: the bytes of every stored object (what
 * R2 holds for Portifact) and the objects created this cycle (each one at least one class A
 * upload), and the emails counted as they were sent (`email_counters`). Cloudflare's analytics,
 * when configured, replace the estimates with measured values.
 */
export async function measurePlatformUsage(
  regions: { global: GlobalDb; all(): readonly { db: RegionalDb }[] },
  now: number,
): Promise<PlatformMetrics> {
  const { start } = budgetCycle(now);
  const o = schema.objects;
  // Objects live in their owner's region (decision 0005): the platform's usage is every region's.
  let storedBytes = 0;
  let classA = 0;
  for (const { db } of regions.all()) {
    const [stored] = await db.select({ bytes: sum(o.size) }).from(o);
    const [created] = await db.select({ count: count() }).from(o).where(gte(o.createdAt, start));
    storedBytes += Number(stored?.bytes ?? 0);
    classA += created?.count ?? 0;
  }
  const db = regions.global;
  return {
    storedBytes,
    r2ClassA: classA,
    r2ClassB: null,
    workerRequests: null,
    d1RowsRead: null,
    d1RowsWritten: null,
    emails: await emailsSentInCycle(db, now),
    // The documents objects are measured only by Cloudflare's analytics.
    dataRequests: null,
    dataGbSeconds: null,
    dataRowsRead: null,
    dataRowsWritten: null,
    dataStoredBytes: null,
  };
}

export interface RecordedMeasurement {
  assessment: BudgetAssessment;
  /** Alerts this measurement recorded for the first time in the cycle. */
  newAlerts: BudgetAlert[];
  /** True when the automatic level or actions changed. */
  changed: boolean;
  /** What applies now, override included. */
  effective: Protection;
}

const sameActions = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((action, i) => action === b[i]);

/**
 * Records one measurement: carries forward counters a source missed this time (same cycle only),
 * assesses the budget, stores the automatic decision and records each alert once per cycle. Safe
 * to run concurrently: the state is one upserted row and the alerts' unique index drops repeats.
 */
export async function recordBudgetMeasurement(
  db: GlobalDb,
  input: { metrics: PlatformMetrics; analytics: AnalyticsStatus; now: number },
): Promise<RecordedMeasurement> {
  const previous = await budgetRow(db);
  const { start } = budgetCycle(input.now);
  const sameCycle = previous !== undefined && previous.cycleStart === start;
  const metrics = carryForward(
    input.metrics,
    sameCycle ? parseMetrics((previous as BudgetRow).metrics) : null,
  );
  const assessment = assessBudget(metrics, input.now);
  const changed =
    previous === undefined ||
    previous.level !== assessment.level ||
    !sameActions(parseActions(previous.actions), assessment.actions);
  const values = {
    cycleStart: assessment.cycleStart,
    level: assessment.level,
    actions: JSON.stringify(assessment.actions),
    projectedCents: Math.round(assessment.projectedUsd * 100),
    metrics: JSON.stringify(metrics),
    analytics: input.analytics,
    measuredAt: input.now,
    levelChangedAt: changed ? input.now : (previous as BudgetRow).levelChangedAt,
  };
  const alertRows = assessment.alerts.map((kind) => ({
    cycleStart: assessment.cycleStart,
    kind,
    level: assessment.level,
    projectedCents: values.projectedCents,
    createdAt: input.now,
  }));
  const upsert = db
    .insert(schema.platformBudget)
    .values({ id: ROW_ID, ...values, levelChangedAt: input.now })
    .onConflictDoUpdate({ target: schema.platformBudget.id, set: values });
  let inserted: (typeof schema.budgetAlerts.$inferSelect)[] = [];
  if (alertRows.length === 0) {
    await upsert;
  } else {
    [, inserted] = await db.batch([
      upsert,
      db.insert(schema.budgetAlerts).values(alertRows).onConflictDoNothing().returning(),
    ]);
  }
  const row = await budgetRow(db);
  return {
    assessment,
    newAlerts: inserted.map(alertOf),
    changed,
    effective: row ? stateOf(row, input.now).effective : NO_PROTECTION,
  };
}

function alertOf(row: typeof schema.budgetAlerts.$inferSelect): BudgetAlert {
  return {
    id: row.id,
    cycleStart: row.cycleStart,
    kind: row.kind,
    level: row.level,
    projectedUsd: row.projectedCents / 100,
    createdAt: row.createdAt,
    notifiedAt: row.notifiedAt,
  };
}

/**
 * Sets the operator override: it replaces the automatic decision at once, in both directions,
 * until `until` or until cleared. Creates the state row if nothing was measured yet.
 */
export async function setBudgetOverride(
  db: GlobalDb,
  input: {
    level: BudgetLevel;
    steps: number;
    until: number | null;
    note: string | null;
    now: number;
  },
): Promise<BudgetState> {
  const override = {
    overrideLevel: input.level,
    overrideSteps: input.steps,
    overrideUntil: input.until,
    overrideNote: input.note,
    overrideSetAt: input.now,
  };
  await db
    .insert(schema.platformBudget)
    .values({
      id: ROW_ID,
      cycleStart: budgetCycle(input.now).start,
      metrics: JSON.stringify(EMPTY_METRICS),
      measuredAt: 0,
      levelChangedAt: input.now,
      ...override,
    })
    .onConflictDoUpdate({ target: schema.platformBudget.id, set: override });
  return stateOf((await budgetRow(db)) as BudgetRow, input.now);
}

/** Clears the operator override; the automatic decision applies again at once. */
export async function clearBudgetOverride(db: GlobalDb, now: number): Promise<BudgetState | null> {
  await db
    .update(schema.platformBudget)
    .set({
      overrideLevel: null,
      overrideSteps: null,
      overrideUntil: null,
      overrideNote: null,
      overrideSetAt: null,
    })
    .where(eq(schema.platformBudget.id, ROW_ID));
  return getBudgetState(db, now);
}

/** Recorded alerts, newest first, optionally only those of one cycle. */
export async function listBudgetAlerts(
  db: GlobalDb,
  input: { cycleStart?: number; limit: number },
): Promise<BudgetAlert[]> {
  const a = schema.budgetAlerts;
  const rows = await db
    .select()
    .from(a)
    .where(input.cycleStart === undefined ? undefined : eq(a.cycleStart, input.cycleStart))
    .orderBy(desc(a.createdAt), desc(a.id))
    .limit(input.limit);
  return rows.map(alertOf);
}

/** Alerts of the cycle whose email has not gone out yet, oldest first. */
export async function pendingBudgetAlerts(
  db: GlobalDb,
  cycleStart: number,
): Promise<BudgetAlert[]> {
  const a = schema.budgetAlerts;
  const rows = await db
    .select()
    .from(a)
    .where(and(eq(a.cycleStart, cycleStart), isNull(a.notifiedAt)))
    .orderBy(a.id);
  return rows.map(alertOf);
}

/** Marks alerts as sent; an alert already marked keeps its first time. */
export async function markBudgetAlertsNotified(
  db: GlobalDb,
  ids: number[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
  const a = schema.budgetAlerts;
  await db
    .update(a)
    .set({ notifiedAt: sql`coalesce(${a.notifiedAt}, ${now})` })
    .where(inArray(a.id, ids));
}
