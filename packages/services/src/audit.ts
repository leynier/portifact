// The audit log (premium plan T10, feature `audit`): who changed what, per owner.
//
// Writing: every recorded change adds one statement, `auditEvent`, to its own batch, on the
// write's own claim or old-state condition, so an event exists exactly when the change does and
// costs no round trip. The statement is an `insert ... select ... where <condition>`: it is
// placed before the guarded write with that write's condition (or after an insert, on the row
// that insert created), the way the outbox and webhook marks are. A refused change never
// reaches its batch; a change lost to a race matches no row, so neither does its event.
//
// Where: an owner's events live in its region's database next to its artifacts; the changes to
// global rows (members, invitations, plans, decision 0005) are written in the global database by
// their own global batch. No batch spans two databases. `GLOBAL_AUDIT_KINDS` says which, and the
// reader asks each database only for its kinds, so with one region (both handles on one database)
// nothing is listed twice.
//
// Reading: only the owner's admins (`audit` role action), gated on the owner's plan, within the
// plan's `auditRetentionDays`. Events are written for every owner, so a plan that lapses keeps
// its history and an upgrade shows the last 90 days.
import {
  AUDIT_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGETS,
  type AuditDetail,
  type AuditEventView,
  type AuditFilters,
  type AuditKind,
  type AuditLogView,
  isWorkspaceId,
} from "@portifact/contracts";
import { type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  auditActorView,
  auditCutoff,
  auditDetail,
  auditWindow,
  authorize,
  decodeAuditCursor,
  encodeAuditCursor,
  entitlements,
  newAuditEventId,
  ok,
  type Result,
  requireFeature,
} from "@portifact/domain";
import { and, asc, desc, eq, gt, gte, lt, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ownerEntitlements } from "./plans.ts";
import { ownerView } from "./workspaces.ts";

const ae = schema.auditEvents;

/** Kinds that describe global rows and are written in the global database. */
export const GLOBAL_AUDIT_KINDS: readonly AuditKind[] = [
  // Custom domains are global rows (decision 0006); the artifact's host follows them.
  "domain.attached",
  "domain.removed",
  "member.invited",
  "member.invitation_revoked",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "member.left",
  "plan.granted",
  "plan.removed",
];
const REGIONAL_AUDIT_KINDS = AUDIT_KINDS.filter((kind) => !GLOBAL_AUDIT_KINDS.includes(kind));

/** Who acted: a signed-in account, the operator tool or a scheduled job. */
export type AuditActor = { type: "user"; id: string } | { type: "operator" } | { type: "system" };

export interface AuditEntry<K extends AuditKind> {
  ownerId: string;
  kind: K;
  actor: AuditActor;
  /** The member, link, webhook or invitation the event is about; the artifact for artifact kinds. */
  targetId: string | null;
  artifactId?: string | null | undefined;
  detail: AuditDetail<K>;
  now: number;
  /** A known ID, for a writer that may have to withdraw the event (`withdrawAuditEvent`). */
  id?: string | undefined;
  /**
   * Detail fields the batch itself computes (a rollback's new version number), set over the
   * checked detail in the same statement. Only numbers: a subquery that reads a count or number.
   */
  computed?: Record<string, SQL> | undefined;
}

/**
 * The one statement that records an event in the batch of its change, only when `condition`
 * holds. Put it before the guarded write, with that write's own condition, or after the insert
 * that creates the target, on that row existing.
 */
export function auditEvent<K extends AuditKind>(
  db: Db,
  entry: AuditEntry<K>,
  condition: SQL,
): BatchItem<"sqlite"> {
  let detail: SQL = sql`${JSON.stringify(auditDetail(entry.kind, entry.detail))}`;
  for (const [field, value] of Object.entries(entry.computed ?? {})) {
    detail = sql`json_set(${detail}, ${`$.${field}`}, ${value})`;
  }
  const actorId = entry.actor.type === "user" ? entry.actor.id : null;
  // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail.
  return db
    .insert(ae)
    .select(
      sql`select ${entry.id ?? newAuditEventId()}, ${entry.ownerId}, ${entry.now}, ${entry.kind}, ${entry.actor.type}, ${actorId}, ${entry.targetId}, ${entry.artifactId ?? null}, ${detail} where ${condition}`,
    );
}

/** Takes back an event whose change was undone in a later step (an invitation whose send failed). */
export function withdrawAuditEvent(db: Db, id: string): BatchItem<"sqlite"> {
  return db.delete(ae).where(eq(ae.id, id));
}

/** The statement that erases every event of an owner, for the batches that delete owners. */
export function eraseOwnerAuditEvents(
  db: Db,
  ownerId: string,
  condition?: SQL,
): BatchItem<"sqlite"> {
  return db
    .delete(ae)
    .where(condition ? and(eq(ae.ownerId, ownerId), condition) : eq(ae.ownerId, ownerId));
}

/** Erases the events of the owners `owners` (a subquery of IDs), as `applyTombstones` does. */
export function eraseAuditEventsOf(db: Db, owners: SQL): BatchItem<"sqlite"> {
  return db.delete(ae).where(sql`${ae.ownerId} in (${owners})`);
}

const ids = (values: readonly string[]) =>
  sql`(select value from json_each(${JSON.stringify([...new Set(values)])}))`;

type AuditRow = typeof ae.$inferSelect;

/** One database's page of an owner's events matching the filters, newest first. */
async function page(
  db: Db,
  input: {
    ownerId: string;
    kinds: readonly AuditKind[];
    filters: AuditFilters;
    from: number;
    to: number;
    after: { at: number; id: string } | null;
    limit: number;
  },
): Promise<AuditRow[]> {
  if (input.kinds.length === 0) return [];
  const conditions: (SQL | undefined)[] = [
    eq(ae.ownerId, input.ownerId),
    gte(ae.at, input.from),
    lt(ae.at, input.to),
    sql`${ae.kind} in ${ids(input.kinds)}`,
    input.filters.actor === undefined ? undefined : eq(ae.actorId, input.filters.actor),
    input.filters.target === undefined
      ? undefined
      : or(eq(ae.targetId, input.filters.target), eq(ae.artifactId, input.filters.target)),
    input.after === null
      ? undefined
      : or(lt(ae.at, input.after.at), and(eq(ae.at, input.after.at), lt(ae.id, input.after.id))),
  ];
  return db
    .select()
    .from(ae)
    .where(and(...conditions))
    .orderBy(desc(ae.at), desc(ae.id))
    .limit(input.limit);
}

/** The display names of the accounts that are members of the owner now (its user, if personal). */
async function memberNames(
  global: GlobalDb,
  ownerId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;
  const u = schema.users;
  if (!isWorkspaceId(ownerId)) {
    if (!userIds.includes(ownerId)) return names;
    const [row] = await global.select({ name: u.name }).from(u).where(eq(u.id, ownerId)).limit(1);
    if (row) names.set(ownerId, row.name);
    return names;
  }
  const m = schema.workspaceMembers;
  const rows = await global
    .select({ id: u.id, name: u.name })
    .from(m)
    .innerJoin(u, eq(u.id, m.userId))
    .where(and(eq(m.workspaceId, ownerId), sql`${m.userId} in ${ids(userIds)}`));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/** Current names of the artifacts events name; gone (purged or deleted) ones have none. */
async function artifactNames(db: RegionalDb, artifactIds: readonly string[]) {
  const names = new Map<string, string>();
  if (artifactIds.length === 0) return names;
  const a = schema.artifacts;
  const rows = await db
    .select({ id: a.id, name: a.name })
    .from(a)
    .where(and(sql`${a.id} in ${ids(artifactIds)}`, sql`${a.state} not in ('purging', 'deleted')`));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

/** Events as every interface shows them. */
async function present(db: RegionalDb, ownerId: string, rows: readonly AuditRow[]) {
  const userIds = rows.flatMap((row) => {
    const found: string[] = [];
    if (row.actorType === "user" && row.actorId) found.push(row.actorId);
    if (AUDIT_TARGETS[row.kind as AuditKind] === "member" && row.targetId) found.push(row.targetId);
    return found;
  });
  const names = await memberNames(db.global, ownerId, userIds);
  const artifactIds = rows.flatMap((row) => (row.artifactId ? [row.artifactId] : []));
  const artifacts = await artifactNames(db, artifactIds);
  return rows.map((row): AuditEventView => {
    const kind = row.kind as AuditKind;
    const targetType = AUDIT_TARGETS[kind];
    return {
      id: row.id,
      at: new Date(row.at).toISOString(),
      kind,
      actor: auditActorView(row.actorType, row.actorId, names),
      target: {
        type: targetType,
        id: row.targetId,
        ...(targetType === "member" && row.targetId
          ? { member: auditActorView("user", row.targetId, names) }
          : {}),
      },
      artifact: row.artifactId
        ? { id: row.artifactId, name: artifacts.get(row.artifactId) ?? null }
        : null,
      detail: (row.detail ?? {}) as Record<string, unknown>,
    };
  });
}

export interface AuditLogInput {
  /** From `resolveOwnerScope`: the caller's role on the owner they named. */
  actor: Actor;
  filters: AuditFilters;
  cursor?: string | undefined;
  limit: number;
  now: number;
}

/**
 * A page of the owner's audit log, newest first, for its admins when the owner's plan includes
 * `audit`. An editor or member gets `forbidden`; someone with no role never gets this far (their
 * scope answers like a missing workspace).
 */
export async function getAuditLog(
  db: RegionalDb,
  input: AuditLogInput,
): Promise<Result<AuditLogView>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const ownerId = input.actor.ownerId;
  const gate = requireFeature(await ownerEntitlements(db.global, ownerId, input.now), "audit");
  if (!gate.ok) return gate;
  const retentionDays = gate.value.limits.auditRetentionDays;
  const window = auditWindow(input.filters, retentionDays, input.now);
  if (!window.ok) return window;
  let after: { at: number; id: string } | null = null;
  if (input.cursor !== undefined) {
    const decoded = decodeAuditCursor(input.cursor);
    if (!decoded.ok) return decoded;
    after = decoded.value;
  }
  const limit = Math.min(Math.max(1, input.limit), AUDIT_LIMITS.pageSize);
  const wanted = input.filters.kinds ?? AUDIT_KINDS;
  const query = {
    ownerId,
    filters: input.filters,
    from: window.value.from,
    to: window.value.to,
    after,
    limit: limit + 1,
  };
  const rows = [
    ...(await page(db, {
      ...query,
      kinds: REGIONAL_AUDIT_KINDS.filter((k) => wanted.includes(k)),
    })),
    ...(await page(db.global, {
      ...query,
      kinds: GLOBAL_AUDIT_KINDS.filter((k) => wanted.includes(k)),
    })),
  ].sort((x, y) => y.at - x.at || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0));
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return ok({
    owner: await ownerView(db.global, ownerId),
    events: await present(db, ownerId, shown),
    nextCursor:
      rows.length > limit && last ? encodeAuditCursor({ at: last.at, id: last.id }) : null,
    retentionDays,
  });
}

/**
 * A personal space's events for the account export: everything still kept, newest first, shown
 * the way the audit log shows them. Not behind the plan: an export is never refused.
 */
export async function exportAuditEvents(
  db: RegionalDb,
  userId: string,
  now: number,
): Promise<AuditEventView[]> {
  const retention = (await ownerEntitlements(db.global, userId, now)).limits.auditRetentionDays;
  const from = auditCutoff(retention, now);
  const read = (handle: Db, kinds: readonly AuditKind[]) =>
    handle
      .select()
      .from(ae)
      .where(and(eq(ae.ownerId, userId), gte(ae.at, from), sql`${ae.kind} in ${ids(kinds)}`))
      .orderBy(desc(ae.at), desc(ae.id));
  const rows = [
    ...(await read(db, REGIONAL_AUDIT_KINDS)),
    ...(await read(db.global, GLOBAL_AUDIT_KINDS)),
  ].sort((x, y) => y.at - x.at || (y.id < x.id ? -1 : 1));
  return present(db, userId, rows);
}

const PLAN_PAGE = 100;

/**
 * Deletes events past their owner's retention, at most `rounds` statements of
 * `AUDIT_LIMITS.pruneBatch` rows per kind of owner and run; the next run goes on. Owners whose
 * plan keeps events for another number of days (an Enterprise override) are pruned on their own
 * and left out of the default pass; a plan row changed after it was read keeps its owner's events
 * until the next run. Run on every control database, the global one included.
 */
export async function pruneAuditEvents(
  db: Db,
  global: GlobalDb,
  now: number,
  rounds = 5,
): Promise<number> {
  const p = schema.ownerPlans;
  const defaultDays = entitlements(null, now).limits.auditRetentionDays;
  const special = new Map<string, number>();
  let cursor = "";
  for (;;) {
    const plans = await global
      .select({
        ownerId: p.ownerId,
        plan: p.plan,
        seats: p.seats,
        validUntil: p.validUntil,
        overrides: p.overrides,
      })
      .from(p)
      .where(gt(p.ownerId, cursor))
      .orderBy(asc(p.ownerId))
      .limit(PLAN_PAGE);
    for (const plan of plans) {
      const days = entitlements(plan, now).limits.auditRetentionDays;
      if (days !== defaultDays) special.set(plan.ownerId, days);
    }
    if (plans.length < PLAN_PAGE) break;
    cursor = (plans.at(-1) as (typeof plans)[number]).ownerId;
  }
  const keptByPlan = [...special.keys()];
  // A grant written after the plans were read decides next time.
  const unchangedPlan = sql`not exists (select 1 from ${p} where ${p.ownerId} = ${ae.ownerId} and ${p.updatedAt} > ${now})`;
  let pruned = 0;
  const sweep = async (where: SQL) => {
    for (let round = 0; round < rounds; round += 1) {
      const deleted = await db
        .delete(ae)
        .where(
          sql`${ae.id} in (select ${ae.id} from ${ae} where ${where} limit ${AUDIT_LIMITS.pruneBatch})`,
        )
        .returning({ id: ae.id });
      pruned += deleted.length;
      if (deleted.length < AUDIT_LIMITS.pruneBatch) break;
    }
  };
  await sweep(
    sql`${ae.at} < ${auditCutoff(defaultDays, now)} and ${ae.ownerId} not in ${ids(keptByPlan)} and ${unchangedPlan}`,
  );
  for (const [ownerId, days] of special) {
    await sweep(
      sql`${ae.ownerId} = ${ownerId} and ${ae.at} < ${auditCutoff(days, now)} and ${unchangedPlan}`,
    );
  }
  return pruned;
}
