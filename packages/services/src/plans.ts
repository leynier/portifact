// The owner's plan (premium plan section 3, F1 and F2): the services read the `owner_plans` row
// and pass the effective limits to the domain rules, so every adapter gets the same limits.
// Adapters never resolve a plan themselves. The content Worker reads the row with its artifact
// lookup instead (`findDeliveryArtifact`), so delivery adds no read.
//
// Plans are granted only by the operator tool (`setOwnerPlan`, `removeOwnerPlan`); no web route,
// API endpoint, MCP tool or CLI command reaches them. A grant writes the row and the four limit
// columns the CHECK constraints compare usage against in one batch, creating the usage rows when
// they do not exist yet, so whichever path creates a row later (a publish, the annotation
// triggers) finds it and keeps its limits. `alignPlanLimits`, a maintenance scan, brings the
// columns back in line when a plan expires or usage falls; a column never drops below usage.
import {
  AUDIT_RETENTION_BOUNDS,
  OwnerPlanExport,
  type PlanFeature,
  type PlanName,
  PlanName as PlanNameSchema,
  PlanOverrides,
  type PlanView,
} from "@portifact/contracts";
import { type Db, type GlobalDb, schema } from "@portifact/db";
import {
  alignedLimit,
  type Entitlements,
  entitlements,
  FREE_LIMIT_COLUMNS,
  fail,
  type LimitColumns,
  limitColumns,
  nextExpiry,
  type OwnerPlanRecord,
  ok,
  pinsLapse,
  type Result,
  requireFeature,
} from "@portifact/domain";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ownerRetentionJob } from "./analytics.ts";
import { auditEvent } from "./audit.ts";

/**
 * The query for the owner's plan row, for a batch of the global database (plans are global,
 * decision 0005: no regional query may join them).
 */
export function ownerPlanQuery(db: GlobalDb, ownerId: string) {
  return db
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
    })
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId))
    .limit(1);
}

/** The owner's plan row, or null for an owner on `free` without one. */
export async function ownerPlanRecord(
  db: GlobalDb,
  ownerId: string,
): Promise<OwnerPlanRecord | null> {
  const [row] = await ownerPlanQuery(db, ownerId);
  return row ?? null;
}

/** What the owner's plan grants at `now`; `free` without a row or once it expired. */
export async function ownerEntitlements(
  db: GlobalDb,
  ownerId: string,
  now: number,
): Promise<Entitlements> {
  return entitlements(await ownerPlanRecord(db, ownerId), now);
}

/**
 * Refuses a paid feature the owner's plan does not include with `plan_required`, or gives back
 * the owner's entitlements so the caller needs no second read. `owner` is the artifact's owner
 * (or the actor from `authorizeOn`/`resolveActor`, whose `ownerId` is that owner): a feature
 * belongs to the owner's plan, a workspace's for a workspace, never to the acting user's. Call it
 * after authorization, so a user with no role still gets what a missing artifact gives. A caller
 * that already holds the owner's entitlements calls `requireFeature` instead.
 */
export async function requireOwnerFeature(
  db: GlobalDb,
  owner: { ownerId: string },
  feature: PlanFeature,
  now: number,
): Promise<Result<Entitlements>> {
  return requireFeature(await ownerEntitlements(db, owner.ownerId, now), feature);
}

/** The plan as the usage endpoint, the CLI, MCP and the account export show it. */
export function planView(owner: Entitlements): PlanView {
  return {
    name: owner.plan,
    validUntil: owner.validUntil === null ? null : new Date(owner.validUntil).toISOString(),
    seats: owner.seats,
    limits: owner.limits,
    features: owner.features,
  };
}

/** Bounds of what the operator may grant; safety caps, not product rules. */
export const PLAN_GRANT = {
  maxSeats: 10_000,
  noteMaxLength: 500,
  grantedByMaxLength: 200,
} as const;

export interface SetOwnerPlanInput {
  ownerId: string;
  plan: PlanName;
  seats: number;
  /** Epoch milliseconds; null for a plan that does not end. */
  validUntil: number | null;
  /** `PlanOverrides`, validated here; null for none. */
  overrides: unknown;
  /** Who granted it, for the record (the operator's name or, later, the billing system). */
  grantedBy: string;
  note: string | null;
  now: number;
}

export interface OwnerPlanState {
  /** The stored row, or null when the owner has none (and is on `free`). */
  row: {
    plan: string;
    seats: number;
    validUntil: number | null;
    overrides: unknown;
    grantedBy: string;
    note: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  entitlements: Entitlements;
  /** The owner's usage and the limit columns, or null when the row does not exist yet. */
  account: {
    activeArtifacts: number;
    storedBytes: number;
    reservedBytes: number;
    activeLimit: number;
    bytesLimit: number;
  } | null;
  annotations: {
    messages: number;
    bytes: number;
    messagesLimit: number;
    bytesLimit: number;
  } | null;
}

/** The owner's plan row, its effective entitlements, usage and limit columns. */
export async function getOwnerPlan(db: Db, ownerId: string, now: number): Promise<OwnerPlanState> {
  const [row] = await db
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
      grantedBy: schema.ownerPlans.grantedBy,
      note: schema.ownerPlans.note,
      createdAt: schema.ownerPlans.createdAt,
      updatedAt: schema.ownerPlans.updatedAt,
    })
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, ownerId))
    .limit(1);
  const [account] = await db
    .select({
      activeArtifacts: schema.accountUsage.activeArtifacts,
      storedBytes: schema.accountUsage.storedBytes,
      reservedBytes: schema.accountUsage.reservedBytes,
      activeLimit: schema.accountUsage.activeLimit,
      bytesLimit: schema.accountUsage.bytesLimit,
    })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId))
    .limit(1);
  const [annotations] = await db
    .select({
      messages: schema.annotationUsage.messages,
      bytes: schema.annotationUsage.bytes,
      messagesLimit: schema.annotationUsage.messagesLimit,
      bytesLimit: schema.annotationUsage.bytesLimit,
    })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, ownerId))
    .limit(1);
  return {
    row: row ?? null,
    entitlements: entitlements(row ?? null, now),
    account: account ?? null,
    annotations: annotations ?? null,
  };
}

function monthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * Sets both usage rows' limit columns to `columns`, never below the usage they hold, when `guard`
 * holds. With `create`, a missing row is created with no usage, so its limits are exactly
 * `columns`; without it only existing rows change. A row is written only where a column differs,
 * so an owner already in line gets no write.
 */
function limitStatements(
  db: Db,
  ownerId: string,
  columns: LimitColumns,
  guard: SQL,
  now: number,
  create: boolean,
): [BatchItem<"sqlite">, BatchItem<"sqlite">] {
  const u = schema.accountUsage;
  const n = schema.annotationUsage;
  const active = sql`max(${columns.activeLimit}, ${u.activeArtifacts})`;
  const bytes = sql`max(${columns.bytesLimit}, ${u.storedBytes} + ${u.reservedBytes})`;
  const messages = sql`max(${columns.messagesLimit}, ${n.messages})`;
  const annotationBytes = sql`max(${columns.annotationBytesLimit}, ${n.bytes})`;
  const accountDiffers = sql`(${u.activeLimit} <> ${active} or ${u.bytesLimit} <> ${bytes})`;
  const annotationsDiffer = sql`(${n.messagesLimit} <> ${messages} or ${n.bytesLimit} <> ${annotationBytes})`;
  if (!create) {
    return [
      db
        .update(u)
        .set({ activeLimit: active, bytesLimit: bytes })
        .where(and(eq(u.ownerId, ownerId), accountDiffers, guard)),
      db
        .update(n)
        .set({ messagesLimit: messages, bytesLimit: annotationBytes })
        .where(and(eq(n.ownerId, ownerId), annotationsDiffer, guard)),
    ];
  }
  return [
    db
      .insert(u)
      .select(
        sql`select ${ownerId}, 0, 0, 0, 0, 0, ${monthStart(now)}, ${now}, ${columns.activeLimit}, ${columns.bytesLimit} where ${guard}`,
      )
      .onConflictDoUpdate({
        target: u.ownerId,
        set: { activeLimit: active, bytesLimit: bytes },
        setWhere: accountDiffers,
      }),
    db
      .insert(n)
      .select(
        sql`select ${ownerId}, 0, 0, ${columns.messagesLimit}, ${columns.annotationBytesLimit} where ${guard}`,
      )
      .onConflictDoUpdate({
        target: n.ownerId,
        set: { messagesLimit: messages, bytesLimit: annotationBytes },
        setWhere: annotationsDiffer,
      }),
  ];
}

/**
 * The owner is an account or a workspace that exists and is not being deleted (a deleted
 * workspace's row is already gone).
 */
export function grantableOwner(ownerId: string): SQL {
  return sql`((exists (select 1 from ${schema.users} where ${schema.users.id} = ${ownerId}) and not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${ownerId})) or exists (select 1 from ${schema.workspaces} where ${schema.workspaces.id} = ${ownerId}))`;
}

export function checkGrant(input: SetOwnerPlanInput): Result<PlanOverrides | null> {
  if (!PlanNameSchema.safeParse(input.plan).success) {
    return fail("invalid_input", `Unknown plan: ${input.plan}.`);
  }
  if (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > PLAN_GRANT.maxSeats) {
    return fail("invalid_input", `Seats must be a whole number from 1 to ${PLAN_GRANT.maxSeats}.`);
  }
  if (
    input.validUntil !== null &&
    !(Number.isSafeInteger(input.validUntil) && input.validUntil > input.now)
  ) {
    return fail("invalid_input", "The plan must end in the future.");
  }
  const grantedBy = input.grantedBy.trim();
  if (grantedBy === "" || grantedBy.length > PLAN_GRANT.grantedByMaxLength) {
    return fail("invalid_input", "Say who grants the plan.");
  }
  if (input.note !== null && input.note.length > PLAN_GRANT.noteMaxLength) {
    return fail("invalid_input", `The note can be at most ${PLAN_GRANT.noteMaxLength} characters.`);
  }
  if (input.overrides === null || input.overrides === undefined) return ok(null);
  const overrides = PlanOverrides.safeParse(input.overrides);
  if (!overrides.success) {
    const retention = overrides.error.issues.some(
      (issue) => issue.path.join(".") === "limits.auditRetentionDays",
    );
    return fail(
      "invalid_input",
      retention
        ? `The overrides are not valid: auditRetentionDays must be a whole number of days from ${AUDIT_RETENTION_BOUNDS.minDays} to ${AUDIT_RETENTION_BOUNDS.maxDays}.`
        : "The overrides are not valid.",
    );
  }
  return ok(overrides.data);
}

/**
 * Grants or changes an owner's plan: the `owner_plans` row and the four limit columns, in one
 * batch, only while the account exists and is not being deleted. Retrying the same grant gives
 * the same state, and of two concurrent grants the later batch wins whole, row and columns
 * together. Lowering a plan never sets a column below usage (`alignedLimit`).
 */
export async function setOwnerPlan(
  db: Db,
  input: SetOwnerPlanInput,
): Promise<Result<OwnerPlanState>> {
  const checked = checkGrant(input);
  if (!checked.ok) return checked;
  const overrides = checked.value;
  const granted = entitlements(
    { plan: input.plan, seats: input.seats, validUntil: input.validUntil, overrides },
    input.now,
  );
  const guard = grantableOwner(input.ownerId);
  const p = schema.ownerPlans;
  const same = sql`exists (select 1 from ${p} where ${p.ownerId} = ${input.ownerId} and ${p.plan} = ${input.plan} and ${p.seats} = ${input.seats} and ${p.validUntil} is ${input.validUntil} and ${p.overrides} is ${overrides === null ? null : JSON.stringify(overrides)})`;
  const [, , plan] = (await db.batch([
    // Before the grant, only when it changes the plan: retrying the same grant records once.
    auditEvent(
      db,
      {
        ownerId: input.ownerId,
        kind: "plan.granted",
        actor: { type: "operator" },
        targetId: input.ownerId,
        detail: {
          plan: input.plan as PlanName,
          seats: input.seats,
          validUntil: input.validUntil === null ? null : new Date(input.validUntil).toISOString(),
        },
        now: input.now,
      },
      sql`${guard} and not ${same}`,
    ),
    // Retention follows the plan: the job moves the expiries of the owner's analytics and access
    // log rows (`applyOwnerRetention`), on the same condition as the grant.
    ownerRetentionJob(db, input.ownerId, guard, input.now),
    db
      .insert(p)
      .select(
        sql`select ${input.ownerId}, ${input.plan}, ${input.seats}, ${input.validUntil}, ${overrides === null ? null : JSON.stringify(overrides)}, ${input.grantedBy.trim()}, ${input.note}, ${input.now}, ${input.now} where ${guard}`,
      )
      .onConflictDoUpdate({
        target: p.ownerId,
        set: {
          plan: sql`excluded.plan`,
          seats: sql`excluded.seats`,
          validUntil: sql`excluded.valid_until`,
          overrides: sql`excluded.overrides`,
          grantedBy: sql`excluded.granted_by`,
          note: sql`excluded.note`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ ownerId: p.ownerId }),
    ...limitStatements(db, input.ownerId, limitColumns(granted), guard, input.now, true),
  ])) as [unknown, unknown, unknown[], ...unknown[]];
  if (plan.length === 0) return fail("not_found", "Account or workspace not found.");
  return ok(await getOwnerPlan(db, input.ownerId, input.now));
}

/**
 * Removes an owner's plan, which puts it back on `free`: deletes the row and lowers the limit
 * columns toward the free values in the same batch, never below usage. Nothing else changes:
 * artifacts, versions and comments over the free limits stay, and only new work is refused.
 */
export async function removeOwnerPlan(
  db: Db,
  input: { ownerId: string; now: number },
): Promise<Result<{ removed: boolean; state: OwnerPlanState }>> {
  const hadPlan = sql`exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${input.ownerId})`;
  const [, , deleted] = (await db.batch([
    auditEvent(
      db,
      {
        ownerId: input.ownerId,
        kind: "plan.removed",
        actor: { type: "operator" },
        targetId: input.ownerId,
        detail: {},
        now: input.now,
      },
      hadPlan,
    ),
    ownerRetentionJob(db, input.ownerId, hadPlan, input.now),
    db
      .delete(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, input.ownerId))
      .returning({ ownerId: schema.ownerPlans.ownerId }),
    ...limitStatements(db, input.ownerId, FREE_LIMIT_COLUMNS, sql`1`, input.now, false),
  ])) as [unknown, unknown, unknown[], ...unknown[]];
  return ok({
    removed: deleted.length === 1,
    state: await getOwnerPlan(db, input.ownerId, input.now),
  });
}

/** Owners a scan reads per query. */
const ALIGN_PAGE = 100;

export interface AlignResult {
  /** Owners whose columns this run changed. */
  processed: number;
}

/**
 * Brings the limit columns in line with each owner's plan at `now` (a maintenance scan): an
 * expired, removed or lowered plan, or usage that fell, lowers a column toward the effective
 * limit, never below usage; a column below the plan is raised. Only owners with a plan row or a
 * column off the free values are read, and only those out of line are written, at most `limit`
 * per run. Each write is conditioned on the plan row it was computed from being unchanged, so a
 * grant that lands first is never overwritten with stale limits.
 */
export async function alignPlanLimits(db: Db, now: number, limit = 50): Promise<AlignResult> {
  const free = FREE_LIMIT_COLUMNS;
  let processed = 0;
  let cursor = "";
  while (processed < limit) {
    const owners = (
      await db.all<{ owner_id: string }>(
        sql`select "owner_id" from (select "owner_id" from "owner_plans" union select "owner_id" from "account_usage" where "active_limit" <> ${free.activeLimit} or "bytes_limit" <> ${free.bytesLimit} union select "owner_id" from "annotation_usage" where "messages_limit" <> ${free.messagesLimit} or "bytes_limit" <> ${free.annotationBytesLimit}) where "owner_id" > ${cursor} order by "owner_id" limit ${ALIGN_PAGE}`,
      )
    ).map((row) => row.owner_id);
    if (owners.length === 0) break;
    cursor = owners.at(-1) as string;
    const plans = new Map(
      (
        await db
          .select({
            ownerId: schema.ownerPlans.ownerId,
            plan: schema.ownerPlans.plan,
            seats: schema.ownerPlans.seats,
            validUntil: schema.ownerPlans.validUntil,
            overrides: schema.ownerPlans.overrides,
            updatedAt: schema.ownerPlans.updatedAt,
          })
          .from(schema.ownerPlans)
          .where(inArray(schema.ownerPlans.ownerId, owners))
      ).map((row) => [row.ownerId, row]),
    );
    const accounts = new Map(
      (
        await db
          .select({
            ownerId: schema.accountUsage.ownerId,
            used: schema.accountUsage.activeArtifacts,
            bytes: sql<number>`${schema.accountUsage.storedBytes} + ${schema.accountUsage.reservedBytes}`,
            activeLimit: schema.accountUsage.activeLimit,
            bytesLimit: schema.accountUsage.bytesLimit,
          })
          .from(schema.accountUsage)
          .where(inArray(schema.accountUsage.ownerId, owners))
      ).map((row) => [row.ownerId, row]),
    );
    const annotations = new Map(
      (
        await db
          .select({
            ownerId: schema.annotationUsage.ownerId,
            messages: schema.annotationUsage.messages,
            bytes: schema.annotationUsage.bytes,
            messagesLimit: schema.annotationUsage.messagesLimit,
            bytesLimit: schema.annotationUsage.bytesLimit,
          })
          .from(schema.annotationUsage)
          .where(inArray(schema.annotationUsage.ownerId, owners))
      ).map((row) => [row.ownerId, row]),
    );
    for (const ownerId of owners) {
      if (processed >= limit) break;
      const plan = plans.get(ownerId);
      const columns = limitColumns(entitlements(plan ?? null, now));
      if (inLine(columns, accounts.get(ownerId), annotations.get(ownerId), free)) continue;
      const unchanged = plan
        ? sql`exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${ownerId} and ${schema.ownerPlans.updatedAt} = ${plan.updatedAt})`
        : sql`not exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${ownerId})`;
      // A missing row is created only for an owner with a plan; without one the defaults are free.
      const [account, annotation] = limitStatements(db, ownerId, columns, unchanged, now, !!plan);
      await db.batch([account, annotation]);
      processed += 1;
    }
    if (owners.length < ALIGN_PAGE) break;
  }
  return { processed };
}

const PIN_PAGE = 100;

/**
 * Unpins the artifacts of owners whose plan no longer includes `pin` (expired, removed or
 * lowered), a maintenance scan (premium plan P2). Each gets the normal 30-day expiry from `now`,
 * which also makes it due for the normal expiry notice; nothing is archived or deleted on the
 * spot. Owners that still have the feature are read but never written. At most `limit`
 * artifacts per run; each owner's writes are conditioned on the plan row they were decided from
 * being unchanged, so a grant that lands meanwhile keeps the pins, and on the artifact still
 * being pinned and active, so a run that repeats or races another changes nothing twice.
 */
export async function unpinLapsedPlans(db: Db, now: number, limit = 50): Promise<AlignResult> {
  const a = schema.artifacts;
  const pinnedActive = sql`${a.pinned} = 1 and ${a.state} = 'active'`;
  const expiresAt = nextExpiry(new Date(now)).getTime();
  let processed = 0;
  let cursor = "";
  while (processed < limit) {
    const owners = (
      await db
        .selectDistinct({ ownerId: a.ownerId })
        .from(a)
        .where(and(pinnedActive, gt(a.ownerId, cursor)))
        .orderBy(asc(a.ownerId))
        .limit(PIN_PAGE)
    ).map((row) => row.ownerId);
    if (owners.length === 0) break;
    cursor = owners.at(-1) as string;
    const plans = new Map(
      (
        await db
          .select({
            ownerId: schema.ownerPlans.ownerId,
            plan: schema.ownerPlans.plan,
            seats: schema.ownerPlans.seats,
            validUntil: schema.ownerPlans.validUntil,
            overrides: schema.ownerPlans.overrides,
            updatedAt: schema.ownerPlans.updatedAt,
          })
          .from(schema.ownerPlans)
          .where(inArray(schema.ownerPlans.ownerId, owners))
      ).map((row) => [row.ownerId, row]),
    );
    for (const ownerId of owners) {
      if (processed >= limit) break;
      const plan = plans.get(ownerId);
      if (!pinsLapse(entitlements(plan ?? null, now))) continue;
      const unchanged = plan
        ? sql`exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${ownerId} and ${schema.ownerPlans.updatedAt} = ${plan.updatedAt})`
        : sql`not exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${ownerId})`;
      const targets = sql`select ${a.id} from ${a} where ${a.ownerId} = ${ownerId} and ${pinnedActive} and ${unchanged} order by ${a.id} limit ${limit - processed}`;
      // The events are written first, from the same rows the update then changes.
      const [, unpinned] = await db.batch([
        db
          .insert(schema.lifecycleEvents)
          .select(
            sql`select null, ${a.id}, null, 'system', 'unpinned', ${JSON.stringify({ reason: "plan" })}, ${now} from ${a} where ${a.id} in (${targets})`,
          ),
        db
          .update(a)
          .set({
            pinned: false,
            expiresAt,
            lifecycleGeneration: sql`${a.lifecycleGeneration} + 1`,
            updatedAt: now,
          })
          .where(sql`${a.id} in (${targets})`)
          .returning({ id: a.id }),
      ]);
      processed += unpinned.length;
    }
    if (owners.length < PIN_PAGE) break;
  }
  return { processed };
}

/**
 * Whether an owner's columns already hold their aligned values. A missing row is in line when
 * the plan's values are the defaults it would be created with.
 */
function inLine(
  columns: LimitColumns,
  account: { used: number; bytes: number; activeLimit: number; bytesLimit: number } | undefined,
  annotations:
    | { messages: number; bytes: number; messagesLimit: number; bytesLimit: number }
    | undefined,
  free: LimitColumns,
): boolean {
  const accountInLine = account
    ? account.activeLimit === alignedLimit(columns.activeLimit, account.used) &&
      account.bytesLimit === alignedLimit(columns.bytesLimit, Number(account.bytes))
    : columns.activeLimit === free.activeLimit && columns.bytesLimit === free.bytesLimit;
  const annotationsInLine = annotations
    ? annotations.messagesLimit === alignedLimit(columns.messagesLimit, annotations.messages) &&
      annotations.bytesLimit === alignedLimit(columns.annotationBytesLimit, annotations.bytes)
    : columns.messagesLimit === free.messagesLimit &&
      columns.annotationBytesLimit === free.annotationBytesLimit;
  return accountInLine && annotationsInLine;
}

/**
 * Every plan row, for `export-plans` before a D1 Time Travel restore. A row whose overrides no
 * longer validate is exported without them, as `entitlements` already reads it.
 */
export async function exportOwnerPlans(db: Db): Promise<OwnerPlanExport[]> {
  const rows = await db
    .select({
      ownerId: schema.ownerPlans.ownerId,
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
      grantedBy: schema.ownerPlans.grantedBy,
      note: schema.ownerPlans.note,
    })
    .from(schema.ownerPlans)
    .orderBy(schema.ownerPlans.ownerId);
  return rows.map((row) => {
    const overrides = PlanOverrides.safeParse(row.overrides);
    return OwnerPlanExport.parse({
      ...row,
      overrides: row.overrides !== null && overrides.success ? overrides.data : null,
    });
  });
}

export interface ApplyPlansResult {
  /** Plans granted again. */
  applied: number;
  /** Plans that ended before now, or whose account is gone or being deleted. */
  skipped: number;
  /** Owners with a plan row the export does not have: the operator decides whether to remove it. */
  extra: string[];
}

/**
 * Grants the exported plans again after a restore, each through `setOwnerPlan`, so the limit
 * columns follow. It never removes a plan: a plan the restore brought back that the export does
 * not list is reported for the operator to remove with `remove-plan`. Run after
 * `apply-tombstones`, so deleted accounts are gone and their plans are skipped.
 */
export async function applyOwnerPlans(
  db: Db,
  plans: readonly OwnerPlanExport[],
  now: number,
): Promise<ApplyPlansResult> {
  let applied = 0;
  let skipped = 0;
  for (const plan of plans) {
    if (plan.validUntil !== null && plan.validUntil <= now) {
      skipped += 1;
      continue;
    }
    const result = await setOwnerPlan(db, { ...plan, now });
    if (result.ok) applied += 1;
    else skipped += 1;
  }
  const listed = new Set(plans.map((plan) => plan.ownerId));
  const extra = (await db.select({ ownerId: schema.ownerPlans.ownerId }).from(schema.ownerPlans))
    .map((row) => row.ownerId)
    .filter((ownerId) => !listed.has(ownerId))
    .sort();
  return { applied, skipped, extra };
}
