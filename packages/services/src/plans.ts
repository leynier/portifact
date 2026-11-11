// The owner's plan (premium plan section 3, F1 and F2): the services read the `owner_plans` row
// and pass the effective limits to the domain rules, so every adapter gets the same limits.
// Adapters never resolve a plan themselves. Plans are global (decision 0005): when a region's
// database is the global one, the write paths and the content Worker's delivery lookup join the
// row into their artifact read (`bothSides`, `findDeliveryArtifact` with `withPlan`), so they add
// no read; with a separate regional database it comes in a global batch the path already makes
// (`ownerPlanQuery`, `actorAndPlanOn`), and delivery caches it per isolate for a minute.
//
// Plans are granted only by the operator tool (`setOwnerPlan`, `removeOwnerPlan`); no web route,
// API endpoint, MCP tool or CLI command reaches them. A grant writes the row and the four limit
// columns the CHECK constraints compare usage against in one batch, creating the usage rows when
// they do not exist yet, so whichever path creates a row later (a publish, the annotation
// triggers) finds it and keeps its limits. `alignPlanLimits`, a maintenance scan, brings the
// columns back in line when a plan expires or usage falls; a column never drops below usage.
import {
  AUDIT_RETENTION_BOUNDS,
  DEFAULT_REGION,
  type GraceSlot,
  GraceSlots,
  OwnerPlanExport,
  PLAN_GRACE_DAYS,
  type PlanFeature,
  type PlanName,
  PlanName as PlanNameSchema,
  PlanOverrides,
  type PlanView,
} from "@portifact/contracts";
import {
  bothSides,
  type Db,
  type GlobalDb,
  isRegion,
  type Region,
  type RegionalDb,
  type Regions,
  schema,
} from "@portifact/db";
import {
  alignedLimit,
  type Entitlements,
  entitlements,
  FREE_LIMIT_COLUMNS,
  fail,
  type GraceChange,
  graceAfterChange,
  graceScanStep,
  type LimitColumns,
  limitColumns,
  liveGraceSlots,
  nextExpiry,
  type OwnerPlanRecord,
  ok,
  pinsLapse,
  planActive,
  type Result,
  requireFeature,
  storedGraceSlots,
} from "@portifact/domain";
import { and, asc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ownerRetentionJob } from "./analytics.ts";
import { auditEvent } from "./audit.ts";
import {
  cursorFor,
  cursorRead,
  resumeAt,
  type ScanCaps,
  savedCursorSql,
} from "./maintenance-cursors.ts";
import { ownerOfRegion } from "./shapes.ts";
import { retried } from "./workspaces.ts";

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
      grace: schema.ownerPlans.grace,
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
    grace: owner.grace
      ? {
          until: new Date(owner.grace.until).toISOString(),
          plan: owner.grace.plan,
          limits: owner.grace.limits,
          features: owner.grace.features,
        }
      : null,
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
  /**
   * Ends every running grace and starts none (decision 0022): the operator's `--no-grace`, for
   * abuse. Without it a grant that takes something away holds it for `PLAN_GRACE_DAYS`.
   */
  noGrace?: boolean;
}

export interface OwnerPlanState {
  /** The stored row, or null when the owner has none (and is on `free`). */
  row: {
    plan: string;
    seats: number;
    validUntil: number | null;
    overrides: unknown;
    grace: unknown;
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
export async function getOwnerPlan(
  db: RegionalDb,
  ownerId: string,
  now: number,
): Promise<OwnerPlanState> {
  // The plan is global and the usage rows regional (decision 0005): the same three reads either
  // way, the first through the global handle.
  const [row] = await db.global
    .select({
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
      grace: schema.ownerPlans.grace,
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

/** The row a plan change starts from, for `graceAfterChange` and the change's condition. */
async function planBefore(global: GlobalDb, ownerId: string) {
  const p = schema.ownerPlans;
  const [row] = await global
    .select({
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
      grace: p.grace,
      updatedAt: p.updatedAt,
    })
    .from(p)
    .where(eq(p.ownerId, ownerId))
    .limit(1);
  return row ?? null;
}

/**
 * The row is still the one a change read: it holds the same plan, update and grace, or there is
 * still none. A change is decided from that row (what it takes away starts a grace), so it writes
 * only on it, and is read and decided again when another change landed first.
 */
function stillBefore(ownerId: string, before: Awaited<ReturnType<typeof planBefore>>): SQL {
  const p = schema.ownerPlans;
  if (before === null) {
    return sql`not exists (select 1 from ${p} where ${p.ownerId} = ${ownerId})`;
  }
  const grace = before.grace === null ? null : JSON.stringify(before.grace);
  return sql`exists (select 1 from ${p} where ${p.ownerId} = ${ownerId} and ${p.updatedAt} = ${before.updatedAt} and ${p.grace} is ${grace} and ${p.validUntil} is ${before.validUntil})`;
}

/** How often a plan change is read and decided again when another change landed first. */
const PLAN_CHANGE_ATTEMPTS = 3;

/** The audit events of what a change did to the graces, on the change's own condition. */
function graceEvents(w: Db, ownerId: string, change: GraceChange, now: number, when: SQL) {
  const iso = (at: number) => new Date(at).toISOString();
  return [
    ...change.ended.map(({ slot, reason }) =>
      auditEvent(
        w,
        {
          ownerId,
          kind: "plan.grace_ended",
          actor: { type: "operator" },
          targetId: ownerId,
          detail: { reason, plan: slot.plan, until: iso(slot.until) },
          now,
        },
        when,
      ),
    ),
    ...(change.started
      ? [
          auditEvent(
            w,
            {
              ownerId,
              kind: "plan.grace_started",
              actor: { type: "operator" },
              targetId: ownerId,
              detail: {
                reason: change.started.reason,
                plan: change.started.plan,
                until: iso(change.started.until),
              },
              now,
            },
            when,
          ),
        ]
      : []),
  ];
}

function graceJson(slots: readonly GraceSlot[]): string | null {
  return slots.length === 0 ? null : JSON.stringify(slots);
}

/**
 * Grants or changes an owner's plan: the `owner_plans` row and the four limit columns, in one
 * batch, only while the account exists and is not being deleted. Retrying the same grant gives
 * the same state. Lowering a plan never sets a column below usage (`alignedLimit`), and what the
 * outgoing plan kept that the new one does not is held for `PLAN_GRACE_DAYS` (decision 0022,
 * `graceAfterChange`), unless `noGrace`. The change is decided from the row it read and written
 * only while the row is still that one; another change landing first makes it decide again.
 */
export async function setOwnerPlan(
  db: RegionalDb,
  input: SetOwnerPlanInput,
): Promise<Result<OwnerPlanState>> {
  // `db` is the owner's region. With one database the row and the columns go in one batch, as
  // they always did. With a separate regional database the global batch (the row, its audit
  // events and a `plan_region` job that does the regional half) goes first, then the regional
  // half inline, retried, which then withdraws the job; if every attempt fails the job finishes
  // it and the command says the grant is half applied (decision 0005, "Second delivery").
  const both = bothSides(db);
  const w = both ?? db.global;
  const checked = checkGrant(input);
  if (!checked.ok) return checked;
  const overrides = checked.value;
  const record = {
    plan: input.plan,
    seats: input.seats,
    validUntil: input.validUntil,
    overrides,
  };
  const granted = entitlements(record, input.now);
  const guard = grantableOwner(input.ownerId);
  const p = schema.ownerPlans;
  const same = sql`exists (select 1 from ${p} where ${p.ownerId} = ${input.ownerId} and ${p.plan} = ${input.plan} and ${p.seats} = ${input.seats} and ${p.validUntil} is ${input.validUntil} and ${p.overrides} is ${overrides === null ? null : JSON.stringify(overrides)})`;
  let written = false;
  for (let attempt = 0; attempt < PLAN_CHANGE_ATTEMPTS && !written; attempt += 1) {
    const before = await planBefore(db.global, input.ownerId);
    const change = graceAfterChange(before, record, {
      now: input.now,
      reason: "lowered",
      noGrace: input.noGrace === true,
    });
    const when = sql`${guard} and ${stillBefore(input.ownerId, before)}`;
    const results = (await w.batch([
      // Before the grant, only when it changes the plan: retrying the same grant records once.
      auditEvent(
        w,
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
        sql`${when} and not ${same}`,
      ),
      // Retention follows the plan: the job moves the expiries of the owner's analytics and access
      // log rows (`applyOwnerRetention`), on the same condition as the grant. It runs where the
      // owner's access log is, so with a separate regional database the regional half writes it.
      both
        ? ownerRetentionJob(both, input.ownerId, when, input.now)
        : planRegionJob(w, input.ownerId, when, input.now),
      w
        .insert(p)
        .select(
          sql`select ${input.ownerId}, ${input.plan}, ${input.seats}, ${input.validUntil}, ${overrides === null ? null : JSON.stringify(overrides)}, ${input.grantedBy.trim()}, ${input.note}, ${input.now}, ${input.now}, ${graceJson(change.slots)} where ${when}`,
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
            grace: sql`excluded.grace`,
          },
        })
        .returning({ ownerId: p.ownerId }),
      ...graceEvents(w, input.ownerId, change, input.now, when),
      ...(both
        ? limitStatements(both, input.ownerId, limitColumns(granted), when, input.now, true)
        : []),
    ])) as unknown[][];
    written = (results[2] ?? []).length > 0;
    if (!written && !(await isGrantable(db.global, input.ownerId))) {
      return fail("not_found", "Account or workspace not found.");
    }
  }
  if (!written) return fail("capacity_unavailable", PLAN_CHANGED);
  if (!both) {
    const applied = await applyPendingPlanRegion(db, input.ownerId, input.now);
    if (!applied) return fail("capacity_unavailable", HALF_APPLIED);
  }
  return ok(await getOwnerPlan(db, input.ownerId, input.now));
}

/** What the operator is told when the owner's plan kept changing while a change was decided. */
export const PLAN_CHANGED =
  "The plan changed while this change was being made. Run the command again; nothing was written.";

async function isGrantable(global: GlobalDb, ownerId: string): Promise<boolean> {
  const [row] = await global.all<{ ok: number }>(sql`select ${grantableOwner(ownerId)} as ok`);
  return Number(row?.ok ?? 0) === 1;
}

/**
 * Removes an owner's plan, which puts it back on `free`, and lowers the limit columns toward the
 * free values in the same batch, never below usage. Nothing else changes: artifacts, versions and
 * comments over the free limits stay, and only new work is refused. What the plan kept is held
 * for `PLAN_GRACE_DAYS` (decision 0022): the row stays, as `free` with its grace, until the grace
 * scan removes it when the last hold ends. With `noGrace`, or when nothing is held, the row goes
 * at once, as it always did.
 */
export async function removeOwnerPlan(
  db: RegionalDb,
  input: { ownerId: string; now: number; noGrace?: boolean },
): Promise<Result<{ removed: boolean; state: OwnerPlanState }>> {
  // The same two shapes as `setOwnerPlan`.
  const both = bothSides(db);
  const w = both ?? db.global;
  const p = schema.ownerPlans;
  let done: { removed: boolean } | null = null;
  for (let attempt = 0; attempt < PLAN_CHANGE_ATTEMPTS && done === null; attempt += 1) {
    const before = await planBefore(db.global, input.ownerId);
    const change = graceAfterChange(before, null, {
      now: input.now,
      reason: "removed",
      noGrace: input.noGrace === true,
    });
    const had = before !== null && planActive(before, input.now) && before.plan !== "free";
    const when = stillBefore(input.ownerId, before);
    const existed = sql.raw(before === null ? "0" : "1");
    const keep = change.slots.length > 0;
    const results = (await w.batch([
      auditEvent(
        w,
        {
          ownerId: input.ownerId,
          kind: "plan.removed",
          actor: { type: "operator" },
          targetId: input.ownerId,
          detail: {},
          now: input.now,
        },
        sql`${when} and ${sql.raw(had ? "1" : "0")}`,
      ),
      both
        ? ownerRetentionJob(both, input.ownerId, sql`${when} and ${existed}`, input.now)
        : planRegionJob(w, input.ownerId, sql`${when} and ${existed}`, input.now),
      ...graceEvents(w, input.ownerId, change, input.now, when),
      keep
        ? w
            .update(p)
            .set({
              plan: "free",
              seats: 1,
              validUntil: null,
              overrides: null,
              grace: sql`${graceJson(change.slots)}`,
              updatedAt: input.now,
            })
            .where(and(eq(p.ownerId, input.ownerId), when))
            .returning({ ownerId: p.ownerId })
        : w
            .delete(p)
            .where(and(eq(p.ownerId, input.ownerId), when))
            .returning({ ownerId: p.ownerId }),
      ...(both
        ? limitStatements(both, input.ownerId, FREE_LIMIT_COLUMNS, sql`1`, input.now, false)
        : []),
    ])) as unknown[][];
    const changed = (results[2 + change.ended.length + (change.started ? 1 : 0)] ?? []).length;
    if (before === null || changed === 1) done = { removed: had && changed === 1 };
  }
  if (done === null) return fail("capacity_unavailable", PLAN_CHANGED);
  if (!both) {
    const applied = await applyPendingPlanRegion(db, input.ownerId, input.now);
    if (!applied) return fail("capacity_unavailable", HALF_APPLIED);
  }
  return ok({
    removed: done.removed,
    state: await getOwnerPlan(db, input.ownerId, input.now),
  });
}

/** What the operator is told when the regional half of a grant or removal could not be written. */
export const HALF_APPLIED =
  "The plan change is half applied: the plan row is saved, but the limit columns and retention of the owner's region could not be written. Run the same command again to complete it; the jobs Worker also completes it from its outbox within minutes.";

/**
 * With a separate regional database: the job that does the regional half of a plan change (the
 * limit columns and the `owner_retention` job), written in the global batch on the change's own
 * condition, so the change is never left half applied (`applyOwnerPlanRegion`).
 */
function planRegionJob(global: Db, ownerId: string, condition: SQL, now: number) {
  return global
    .insert(schema.outbox)
    .select(
      sql`select null, 'plan_region', '{}', ${now}, null, 0, ${now}, ${ownerId}, null where ${condition}`,
    );
}

/**
 * The regional half of a plan change with a separate regional database, done inline: the owner's
 * pending `plan_region` jobs (this change's and any a failed attempt left) are applied with the
 * current plan, then withdrawn. Without one (a removal that removed nothing) only the columns are
 * aligned. False when the region could not be written after its retries; the jobs stay.
 */
async function applyPendingPlanRegion(db: RegionalDb, ownerId: string, now: number) {
  const o = schema.outbox;
  const pending = await db.global
    .select({ id: o.id })
    .from(o)
    .where(and(eq(o.topic, "plan_region"), eq(o.subject, ownerId)));
  try {
    await retried(() => planRegionBatch(db, db.global, ownerId, now, pending.length > 0));
  } catch {
    return false;
  }
  if (pending.length > 0) {
    await db.global.delete(o).where(
      inArray(
        o.id,
        pending.map((row) => row.id),
      ),
    );
  }
  return true;
}

/** How often the regional half is written again when the plan changed while it was written. */
const PLAN_REGION_ROUNDS = 3;

/**
 * The limit columns from the owner's current plan, and its retention job when asked. No batch
 * spans the two databases, so another change can commit, and write its own columns, between the
 * read of the plan and this write, which would then land with the older plan's limits. The plan
 * is read again after the write and the columns written again while it differs, so the last
 * write is always from the plan as it was after it. Thrown when it never settles: the caller
 * keeps the job, which runs again.
 */
async function planRegionBatch(
  db: RegionalDb,
  global: GlobalDb,
  ownerId: string,
  now: number,
  retention: boolean,
) {
  const read = async () => {
    const [row] = await global
      .select({
        plan: schema.ownerPlans.plan,
        seats: schema.ownerPlans.seats,
        validUntil: schema.ownerPlans.validUntil,
        overrides: schema.ownerPlans.overrides,
        grace: schema.ownerPlans.grace,
        updatedAt: schema.ownerPlans.updatedAt,
      })
      .from(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, ownerId));
    return row;
  };
  let plan = await read();
  for (let round = 0; round < PLAN_REGION_ROUNDS; round += 1) {
    const columns = limitColumns(entitlements(plan ?? null, now));
    await db.batch([
      ...limitStatements(db, ownerId, columns, sql`1`, now, plan !== undefined),
      // The retention job reads the plan when it runs, so one is enough.
      ...(retention && round === 0 ? [ownerRetentionJob(db, ownerId, sql`1`, now)] : []),
    ]);
    const after = await read();
    if (JSON.stringify(after ?? null) === JSON.stringify(plan ?? null)) return;
    plan = after;
  }
  throw new Error("plan_region: the plan kept changing while its region was written");
}

/**
 * The `plan_region` job: the regional half of a plan change in the owner's region, from the
 * owner's current plan, so running it again, late or after the inline half changes nothing.
 */
export async function applyOwnerPlanRegion(
  regions: { global: GlobalDb; all(): readonly { db: RegionalDb; region: Region }[] },
  ownerId: string,
  now: number,
): Promise<"done"> {
  const region = await ownerRegion(regions.global, ownerId);
  const handles = regions.all().find((h) => h.region === region);
  // Thrown, not reported done: the row stays and the job runs again where the region is bound.
  if (!handles) throw new Error(`plan_region needs region ${region}`);
  await planRegionBatch(handles.db, regions.global, ownerId, now, true);
  return "done";
}

/** The region an owner's data lives in: its workspace's, the default one for a personal space. */
export async function ownerRegion(global: GlobalDb, ownerId: string): Promise<Region> {
  if (!ownerId.startsWith("ws_")) return DEFAULT_REGION;
  const [row] = await global
    .select({ region: schema.workspaces.region })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, ownerId))
    .limit(1);
  return row && isRegion(row.region) ? row.region : DEFAULT_REGION;
}

/** Owners a scan reads per query. */
const ALIGN_PAGE = 100;

/**
 * How much of the owners the alignment reads per run (decision 0005, "Second delivery"): at most
 * `maxPages` pages, then it resumes from `maintenance_cursors` on the next run, wrapping around,
 * so a run costs the same whatever the number of owners.
 */
export const ALIGN_CAPS: ScanCaps = { pageSize: ALIGN_PAGE, maxPages: 3 };

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
export async function alignPlanLimits(
  db: RegionalDb,
  now: number,
  limit = 50,
  /** The region `db` is, for a separate regional database: which plan owners live there. */
  region: Region = DEFAULT_REGION,
  caps: ScanCaps = ALIGN_CAPS,
): Promise<AlignResult> {
  const both = bothSides(db);
  if (!both) return alignSeparateRegion(db, now, limit, region, caps);
  return alignOneDatabase(both, now, limit, region, caps);
}

/**
 * With one database: the scan as it always was, except that the plans it pages are those of the
 * default region's owners, so a workspace in another region never gets usage rows here.
 */
async function alignOneDatabase(
  db: Db,
  now: number,
  limit: number,
  region: Region,
  caps: ScanCaps,
): Promise<AlignResult> {
  const free = FREE_LIMIT_COLUMNS;
  const name = `align_plan_limits:${region}`;
  const pageOf = (after: SQL) =>
    db
      .select({ ownerId: sql<string>`"owner_id"` })
      .from(
        sql`(select "owner_id" from (select "owner_id" from "owner_plans" where ${ownerOfRegion(sql`"owner_id"`, DEFAULT_REGION)} union select "owner_id" from "account_usage" where "active_limit" <> ${free.activeLimit} or "bytes_limit" <> ${free.bytesLimit} union select "owner_id" from "annotation_usage" where "messages_limit" <> ${free.messagesLimit} or "bytes_limit" <> ${free.annotationBytesLimit}) where "owner_id" > ${after} order by "owner_id" limit ${caps.pageSize})`,
      );
  let processed = 0;
  let cursor: string | null = null;
  let started = "";
  let resume: string | null = null;
  let ended = false;
  for (let pages = 0; processed < limit && pages < caps.maxPages; pages += 1) {
    let owners: string[];
    // The saved cursor rides the first page's call, so a pass that fits in one run costs what
    // it always did.
    if (cursor === null) {
      const [saved, first] = await db.batch([cursorRead(db, name), pageOf(savedCursorSql(name))]);
      started = saved[0]?.cursor ?? "";
      resume = started;
      owners = first.map((row) => row.ownerId);
    } else {
      owners = (await pageOf(sql`${cursor}`)).map((row) => row.ownerId);
    }
    if (owners.length === 0) {
      ended = true;
      break;
    }
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
            grace: schema.ownerPlans.grace,
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
    let examined = 0;
    for (const ownerId of owners) {
      if (processed >= limit) break;
      examined += 1;
      resume = ownerId;
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
    if (owners.length < caps.pageSize && examined === owners.length) {
      ended = true;
      break;
    }
  }
  if (cursor !== null) await resumeAt(db, name, started, ended ? null : resume, now);
  return { processed };
}

/**
 * With a separate regional database: the owners with a plan that live in the region (from the
 * global database) and those whose columns are off the free values (from the region), merged by
 * owner ID one page at a time; the plans read from the global database, the usage rows from the
 * region. A write cannot be conditioned on the global plan row, so a grant that lands between the
 * read and the write can be overwritten with the older limits; its own regional batch writes them
 * again right after, and otherwise the next run (15 minutes) does.
 */
async function alignSeparateRegion(
  db: RegionalDb,
  now: number,
  limit: number,
  region: Region,
  caps: ScanCaps,
): Promise<AlignResult> {
  const free = FREE_LIMIT_COLUMNS;
  const p = schema.ownerPlans;
  const name = `align_plan_limits:${region}`;
  const started = await cursorFor(db, name);
  let processed = 0;
  let cursor = started;
  let resume = started;
  let ended = false;
  for (let pages = 0; processed < limit && pages < caps.maxPages; pages += 1) {
    const planned = (
      await db.global
        .select({ ownerId: p.ownerId })
        .from(p)
        .where(and(gt(p.ownerId, cursor), ownerOfRegion(p.ownerId, region)))
        .orderBy(asc(p.ownerId))
        .limit(caps.pageSize)
    ).map((row) => row.ownerId);
    const offFree = (
      await db.all<{ owner_id: string }>(
        sql`select "owner_id" from (select "owner_id" from "account_usage" where "active_limit" <> ${free.activeLimit} or "bytes_limit" <> ${free.bytesLimit} union select "owner_id" from "annotation_usage" where "messages_limit" <> ${free.messagesLimit} or "bytes_limit" <> ${free.annotationBytesLimit}) where "owner_id" > ${cursor} order by "owner_id" limit ${caps.pageSize}`,
      )
    ).map((row) => row.owner_id);
    const owners = [...new Set([...planned, ...offFree])].sort().slice(0, caps.pageSize);
    if (owners.length === 0) {
      ended = true;
      break;
    }
    cursor = owners.at(-1) as string;
    const plans = new Map(
      (
        await db.global
          .select({
            ownerId: p.ownerId,
            plan: p.plan,
            seats: p.seats,
            validUntil: p.validUntil,
            overrides: p.overrides,
            grace: p.grace,
          })
          .from(p)
          .where(inArray(p.ownerId, owners))
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
    let examined = 0;
    for (const ownerId of owners) {
      if (processed >= limit) break;
      examined += 1;
      resume = ownerId;
      const plan = plans.get(ownerId);
      const columns = limitColumns(entitlements(plan ?? null, now));
      if (inLine(columns, accounts.get(ownerId), annotations.get(ownerId), free)) continue;
      await db.batch(limitStatements(db, ownerId, columns, sql`1`, now, !!plan));
      processed += 1;
    }
    if (
      planned.length < caps.pageSize &&
      offFree.length < caps.pageSize &&
      examined === owners.length
    ) {
      ended = true;
      break;
    }
  }
  await resumeAt(db, name, started, ended ? null : resume, now);
  return { processed };
}

const PIN_PAGE = 100;

/** How much of the pinned owners the unpin scan reads per run (decision 0005, "Second delivery"). */
export const UNPIN_CAPS: ScanCaps = { pageSize: PIN_PAGE, maxPages: 3 };

/**
 * Unpins the artifacts of owners whose plan no longer includes `pin` (expired, removed or
 * lowered), a maintenance scan (premium plan P2). Each gets the normal 30-day expiry from `now`,
 * which also makes it due for the normal expiry notice; nothing is archived or deleted on the
 * spot. Owners that still have the feature are read but never written. At most `limit`
 * artifacts per run; each owner's writes are conditioned on the plan row they were decided from
 * being unchanged, so a grant that lands meanwhile keeps the pins, and on the artifact still
 * being pinned and active, so a run that repeats or races another changes nothing twice.
 */
export async function unpinLapsedPlans(
  db: RegionalDb,
  now: number,
  limit = 50,
  region: Region = DEFAULT_REGION,
  caps: ScanCaps = UNPIN_CAPS,
): Promise<AlignResult> {
  // With one database the plans are read and the writes conditioned on them as they always were;
  // with a separate regional database the plans come from the global database, and a grant that
  // lands between that read and the unpin is not seen (the artifact keeps a 30-day expiry and can
  // be pinned again).
  const both = bothSides(db);
  const w = both ?? db;
  const plansDb = both ?? db.global;
  const a = schema.artifacts;
  const pinnedActive = sql`${a.pinned} = 1 and ${a.state} = 'active'`;
  const expiresAt = nextExpiry(new Date(now)).getTime();
  // A page at a time from where the last run stopped, at most `caps.maxPages` pages; the saved
  // cursor rides the first page's call (decision 0005, "Second delivery").
  const name = `unpin_lapsed_plans:${region}`;
  const pageOf = (after: SQL) =>
    w
      .selectDistinct({ ownerId: a.ownerId })
      .from(a)
      .where(and(pinnedActive, sql`${a.ownerId} > ${after}`))
      .orderBy(asc(a.ownerId))
      .limit(caps.pageSize);
  let processed = 0;
  let cursor: string | null = null;
  let started = "";
  let resume: string | null = null;
  let ended = false;
  for (let pages = 0; processed < limit && pages < caps.maxPages; pages += 1) {
    let owners: string[];
    if (cursor === null) {
      const [saved, first] = await w.batch([cursorRead(w, name), pageOf(savedCursorSql(name))]);
      started = saved[0]?.cursor ?? "";
      resume = started;
      owners = first.map((row) => row.ownerId);
    } else {
      owners = (await pageOf(sql`${cursor}`)).map((row) => row.ownerId);
    }
    if (owners.length === 0) {
      ended = true;
      break;
    }
    cursor = owners.at(-1) as string;
    const plans = new Map(
      (
        await plansDb
          .select({
            ownerId: schema.ownerPlans.ownerId,
            plan: schema.ownerPlans.plan,
            seats: schema.ownerPlans.seats,
            validUntil: schema.ownerPlans.validUntil,
            overrides: schema.ownerPlans.overrides,
            grace: schema.ownerPlans.grace,
            updatedAt: schema.ownerPlans.updatedAt,
          })
          .from(schema.ownerPlans)
          .where(inArray(schema.ownerPlans.ownerId, owners))
      ).map((row) => [row.ownerId, row]),
    );
    let examined = 0;
    for (const ownerId of owners) {
      if (processed >= limit) break;
      examined += 1;
      const plan = plans.get(ownerId);
      if (!pinsLapse(entitlements(plan ?? null, now))) {
        resume = ownerId;
        continue;
      }
      const unchanged = !both
        ? sql`1`
        : plan
          ? sql`exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${ownerId} and ${schema.ownerPlans.updatedAt} = ${plan.updatedAt})`
          : sql`not exists (select 1 from ${schema.ownerPlans} where ${schema.ownerPlans.ownerId} = ${ownerId})`;
      const targets = sql`select ${a.id} from ${a} where ${a.ownerId} = ${ownerId} and ${pinnedActive} and ${unchanged} order by ${a.id} limit ${limit - processed}`;
      // The events are written first, from the same rows the update then changes.
      const [, unpinned] = await w.batch([
        w
          .insert(schema.lifecycleEvents)
          .select(
            sql`select null, ${a.id}, null, 'system', 'unpinned', ${JSON.stringify({ reason: "plan" })}, ${now} from ${a} where ${a.id} in (${targets})`,
          ),
        w
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
      // An owner the limit cut short is read again next time.
      if (unpinned.length < limit - processed) resume = ownerId;
      processed += unpinned.length;
    }
    if (owners.length < caps.pageSize && examined === owners.length) {
      ended = true;
      break;
    }
  }
  if (cursor !== null) await resumeAt(w, name, started, ended ? null : resume, now);
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
export async function exportOwnerPlans(db: GlobalDb): Promise<OwnerPlanExport[]> {
  const rows = await db
    .select({
      ownerId: schema.ownerPlans.ownerId,
      plan: schema.ownerPlans.plan,
      seats: schema.ownerPlans.seats,
      validUntil: schema.ownerPlans.validUntil,
      overrides: schema.ownerPlans.overrides,
      grace: schema.ownerPlans.grace,
      grantedBy: schema.ownerPlans.grantedBy,
      note: schema.ownerPlans.note,
    })
    .from(schema.ownerPlans)
    .orderBy(schema.ownerPlans.ownerId);
  return rows.map((row) => {
    const overrides = PlanOverrides.safeParse(row.overrides);
    const slots = storedGraceSlots(row);
    return OwnerPlanExport.parse({
      ...row,
      overrides: row.overrides !== null && overrides.success ? overrides.data : null,
      grace: slots.length === 0 ? null : slots,
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
 * Puts the exported plans back after a restore exactly as they were, the running graces included
 * (decision 0022), with their limit columns and retention job, so a restore neither shortens nor
 * restarts a grace. A plan that ended and holds nothing any more is skipped. It never removes a
 * plan: a plan the restore brought back that the export does not list is reported for the
 * operator to remove with `remove-plan`. Run after `apply-tombstones`, so deleted accounts are
 * gone and their plans are skipped.
 */
export async function applyOwnerPlans(
  regions: Regions,
  plans: readonly OwnerPlanExport[],
  now: number,
): Promise<ApplyPlansResult> {
  const db = regions.global;
  let applied = 0;
  let skipped = 0;
  for (const plan of plans) {
    const record = { ...plan, grace: plan.grace ?? null };
    if (!planActive(record, now) && liveGraceSlots(record, now).length === 0) {
      skipped += 1;
      continue;
    }
    // Each plan goes to its owner's region, where its limit columns live.
    const result = await restoreOwnerPlan(
      regions.get(await ownerRegion(db, plan.ownerId)).db,
      plan,
      now,
    );
    if (result) applied += 1;
    else skipped += 1;
  }
  const listed = new Set(plans.map((plan) => plan.ownerId));
  const extra = (await db.select({ ownerId: schema.ownerPlans.ownerId }).from(schema.ownerPlans))
    .map((row) => row.ownerId)
    .filter((ownerId) => !listed.has(ownerId))
    .sort();
  return { applied, skipped, extra };
}

/**
 * Writes one exported plan back as it was: the row (its end and grace included), the limit
 * columns and the retention job, like a grant, but without deciding a grace from the row the
 * restore left: the export is the record. False when the owner is gone or being deleted.
 */
async function restoreOwnerPlan(db: RegionalDb, plan: OwnerPlanExport, now: number) {
  const both = bothSides(db);
  const w = both ?? db.global;
  const p = schema.ownerPlans;
  const guard = grantableOwner(plan.ownerId);
  const grace = plan.grace && plan.grace.length > 0 ? JSON.stringify(plan.grace) : null;
  const record = { ...plan, grace: plan.grace ?? null };
  const results = (await w.batch([
    both
      ? ownerRetentionJob(both, plan.ownerId, guard, now)
      : planRegionJob(w, plan.ownerId, guard, now),
    w
      .insert(p)
      .select(
        sql`select ${plan.ownerId}, ${plan.plan}, ${plan.seats}, ${plan.validUntil}, ${plan.overrides === null ? null : JSON.stringify(plan.overrides)}, ${plan.grantedBy}, ${plan.note}, ${now}, ${now}, ${grace} where ${guard}`,
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
          grace: sql`excluded.grace`,
        },
      })
      .returning({ ownerId: p.ownerId }),
    ...(both
      ? limitStatements(
          both,
          plan.ownerId,
          limitColumns(entitlements(record, now)),
          guard,
          now,
          true,
        )
      : []),
  ])) as unknown[][];
  if ((results[1] ?? []).length === 0) return false;
  if (!both) return applyPendingPlanRegion(db, plan.ownerId, now);
  return true;
}

/** How much of the plans the grace scan reads per run (decision 0005, "Second delivery"). */
export const GRACE_CAPS: ScanCaps = { pageSize: 100, maxPages: 3 };

const GRACE_MS = PLAN_GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface GraceScanResult {
  /** Owners whose row this run changed. */
  processed: number;
}

/**
 * The grace scan (decision 0022), on the global database, once per run: stores a natural
 * expiry's hold, so its start is recorded once, and removes the holds whose days passed,
 * recording each as expired; a removed plan's row goes with its last hold. Only rows with
 * something to do are read (`json_each` over the stored holds), a page at a time from
 * `maintenance_cursors`, at most `caps` per run. Each owner's events and write are one batch
 * conditioned on the row still holding what was read. Nothing else changes here: what the holds
 * kept is pruned by the existing scans once the retention they read is the plan's own again.
 */
export async function maintainPlanGraces(
  global: GlobalDb,
  now: number,
  caps: ScanCaps = GRACE_CAPS,
): Promise<GraceScanResult> {
  const p = schema.ownerPlans;
  const name = "plan_graces";
  const due = sql`((${p.grace} is not null and exists (select 1 from json_each(${p.grace}) where json_extract(value, '$.until') <= ${now})) or (${p.validUntil} <= ${now} and ${p.validUntil} > ${now - GRACE_MS} and ${p.plan} <> 'free' and (${p.grace} is null or not exists (select 1 from json_each(${p.grace}) where json_extract(value, '$.expiry') = ${p.validUntil}))))`;
  const page = (after: SQL) =>
    global
      .select({
        ownerId: p.ownerId,
        plan: p.plan,
        seats: p.seats,
        validUntil: p.validUntil,
        overrides: p.overrides,
        grace: p.grace,
      })
      .from(p)
      .where(and(sql`${p.ownerId} > ${after}`, due))
      .orderBy(asc(p.ownerId))
      .limit(caps.pageSize);
  let processed = 0;
  let cursor: string | null = null;
  let started = "";
  let ended = false;
  for (let pages = 0; pages < caps.maxPages; pages += 1) {
    let rows: Awaited<ReturnType<typeof page>>;
    if (cursor === null) {
      const [saved, first] = await global.batch([
        cursorRead(global, name),
        page(savedCursorSql(name)),
      ]);
      started = saved[0]?.cursor ?? "";
      rows = first;
    } else {
      rows = await page(sql`${cursor}`);
    }
    if (rows.length > 0) cursor = rows.at(-1)?.ownerId ?? cursor;
    else cursor ??= started;
    for (const row of rows) {
      const step = graceScanStep(row, now);
      if (step === null) continue;
      const grace = row.grace === null ? null : JSON.stringify(row.grace);
      const when = sql`exists (select 1 from ${p} where ${p.ownerId} = ${row.ownerId} and ${p.grace} is ${grace} and ${p.validUntil} is ${row.validUntil} and ${p.plan} = ${row.plan})`;
      const iso = (at: number) => new Date(at).toISOString();
      const events = [
        ...step.ended.map((slot) =>
          auditEvent(
            global,
            {
              ownerId: row.ownerId,
              kind: "plan.grace_ended",
              actor: { type: "system" },
              targetId: row.ownerId,
              detail: { reason: "expired", plan: slot.plan, until: iso(slot.until) },
              now,
            },
            when,
          ),
        ),
        ...(step.started
          ? [
              auditEvent(
                global,
                {
                  ownerId: row.ownerId,
                  kind: "plan.grace_started",
                  actor: { type: "system" },
                  targetId: row.ownerId,
                  detail: {
                    reason: "expired",
                    plan: step.started.plan,
                    until: iso(step.started.until),
                  },
                  now,
                },
                when,
              ),
            ]
          : []),
      ];
      // A removed plan's row (free, no end, no overrides) holds only its grace: it goes with the
      // last hold, as a removal without grace deletes it.
      const removable =
        step.slots.length === 0 &&
        row.plan === "free" &&
        row.validUntil === null &&
        row.overrides === null;
      const write = removable
        ? global.delete(p).where(and(eq(p.ownerId, row.ownerId), when))
        : global
            .update(p)
            .set({ grace: sql`${step.slots.length === 0 ? null : JSON.stringify(step.slots)}` })
            .where(and(eq(p.ownerId, row.ownerId), when));
      const [first, ...rest] = [...events, write];
      if (first) await global.batch([first, ...rest]);
      processed += 1;
    }
    if (rows.length < caps.pageSize) {
      ended = true;
      break;
    }
  }
  await resumeAt(global, name, started, ended ? null : cursor, now);
  return { processed };
}
