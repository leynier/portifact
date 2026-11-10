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
  AUDIT_EXPORT,
  AUDIT_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGETS,
  type AuditDetail,
  type AuditEventView,
  type AuditExportFormat,
  type AuditFilters,
  type AuditKind,
  type AuditLogView,
  isServiceTokenId,
  isWorkspaceId,
} from "@portifact/contracts";
import { type Db, type GlobalDb, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  type AuditPosition,
  auditActorView,
  auditCutoff,
  auditDetail,
  auditExportContentType,
  auditExportDetail,
  auditExportFileName,
  auditExportLine,
  auditExportPreamble,
  auditExportStop,
  auditWindow,
  authorize,
  decodeAuditCursor,
  encodeAuditCursor,
  entitlements,
  fail,
  hasFeature,
  newAuditEventId,
  newerFirst,
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
  // Service tokens are rows of the workspace, in the global database (decision 0011).
  "service_token.created",
  "service_token.revoked",
  // A workspace's email domains are global rows too (decision 0010).
  "email_domain.verified",
  "email_domain.removed",
];
const REGIONAL_AUDIT_KINDS = AUDIT_KINDS.filter((kind) => !GLOBAL_AUDIT_KINDS.includes(kind));

/**
 * Who acted: a signed-in account, the operator tool or a scheduled job. A service token acts
 * with its ID where a user ID goes (decision 0011), so the writers pass it as `user` and
 * `auditEvent` stores it as a token.
 */
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
  const actorType = actorId !== null && isServiceTokenId(actorId) ? "token" : entry.actor.type;
  // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail.
  return db
    .insert(ae)
    .select(
      sql`select ${entry.id ?? newAuditEventId()}, ${entry.ownerId}, ${entry.now}, ${entry.kind}, ${actorType}, ${actorId}, ${entry.targetId}, ${entry.artifactId ?? null}, ${detail} where ${condition}`,
    );
}

/**
 * One `member.left` in every workspace `userId` is a member of, for the batch that deletes the
 * account before the cascade takes the memberships. The actor is the system: the person is gone,
 * and the event keeps only the opaque ID the workspace's earlier events already hold.
 */
export function accountLeftEvents(db: Db, userId: string, now: number): BatchItem<"sqlite"> {
  const m = schema.workspaceMembers;
  // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail.
  return db
    .insert(ae)
    .select(
      sql`select 'ae_' || lower(hex(randomblob(12))), ${m.workspaceId}, ${now}, 'member.left', 'system', null, ${m.userId}, null, json_object('role', ${m.role}) from ${m} where ${m.userId} = ${userId}`,
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

interface PageQuery {
  ownerId: string;
  kinds: readonly AuditKind[];
  filters: AuditFilters;
  from: number;
  to: number;
  after: { at: number; id: string } | null;
  /** For an export part: the oldest position it includes. */
  until?: AuditPosition | null;
}

/** Where an owner's events match the filters, between the cursor and an export part's stop. */
function matching(input: PageQuery): SQL | undefined {
  return and(
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
    input.until === null || input.until === undefined
      ? undefined
      : or(gt(ae.at, input.until.at), and(eq(ae.at, input.until.at), gte(ae.id, input.until.id))),
  );
}

/** One database's page of an owner's events matching the filters, newest first. */
async function page(db: Db, input: PageQuery & { limit: number }): Promise<AuditRow[]> {
  if (input.kinds.length === 0) return [];
  return db
    .select()
    .from(ae)
    .where(matching(input))
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

/** Current labels of the workspace's service tokens that events name; a revoked one has none. */
async function tokenLabels(global: GlobalDb, ownerId: string, tokenIds: readonly string[]) {
  const labels = new Map<string, string>();
  if (tokenIds.length === 0) return labels;
  const st = schema.serviceTokens;
  const rows = await global
    .select({ id: st.id, label: st.label })
    .from(st)
    .where(and(eq(st.workspaceId, ownerId), sql`${st.id} in ${ids(tokenIds)}`));
  for (const row of rows) labels.set(row.id, row.label);
  return labels;
}

/**
 * Current names of the owner's artifacts that events name. One that is gone (purged or deleted)
 * or that moved to another owner has none: what its new owner calls it is not this owner's to see.
 */
async function artifactNames(db: RegionalDb, ownerId: string, artifactIds: readonly string[]) {
  const names = new Map<string, string>();
  if (artifactIds.length === 0) return names;
  const a = schema.artifacts;
  const rows = await db
    .select({ id: a.id, name: a.name })
    .from(a)
    .where(
      and(
        eq(a.ownerId, ownerId),
        sql`${a.id} in ${ids(artifactIds)}`,
        sql`${a.state} not in ('purging', 'deleted')`,
      ),
    );
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
  const tokenIds = rows.flatMap((row) => {
    const found: string[] = [];
    if (row.actorType === "token" && row.actorId) found.push(row.actorId);
    if (AUDIT_TARGETS[row.kind as AuditKind] === "service_token" && row.targetId) {
      found.push(row.targetId);
    }
    return found;
  });
  const tokens = await tokenLabels(db.global, ownerId, tokenIds);
  const artifactIds = rows.flatMap((row) => (row.artifactId ? [row.artifactId] : []));
  const artifacts = await artifactNames(db, ownerId, artifactIds);
  return rows.map((row): AuditEventView => {
    const kind = row.kind as AuditKind;
    const targetType = AUDIT_TARGETS[kind];
    return {
      id: row.id,
      at: new Date(row.at).toISOString(),
      kind,
      actor: auditActorView(row.actorType, row.actorId, names, tokens),
      target: {
        type: targetType,
        id: row.targetId,
        ...(targetType === "member" && row.targetId
          ? { member: auditActorView("user", row.targetId, names) }
          : {}),
        ...(targetType === "service_token" && row.targetId
          ? { serviceToken: auditActorView("token", row.targetId, names, tokens) }
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
    exportable: hasFeature(gate.value, "auditExport"),
  });
}

export interface AuditExportInput {
  /** From `resolveOwnerScope`: the caller's role on the owner they named. */
  actor: Actor;
  format: AuditExportFormat;
  filters: AuditFilters;
  /** The cursor a previous part named; none starts a new export. */
  cursor?: string | undefined;
  now: number;
  /** Tests make the parts small; the Worker uses `AUDIT_EXPORT`. */
  bounds?: { rowsPerDatabase: number; pageSize: number } | undefined;
}

export interface AuditExport {
  format: AuditExportFormat;
  fileName: string;
  contentType: string;
  /** The cursor of the next part, or null when this part ends the export. */
  nextCursor: string | null;
  /** The part's bytes as text, in order: the CSV header on a first part, then a page at a time. */
  lines(): AsyncGenerator<string>;
}

/**
 * One part of an export of the owner's audit log (premium plan E3), for its admins when the
 * owner's plan includes `audit` and `auditExport`: the same events, filters, order, presentation
 * and retention window as reading it, as CSV or JSON Lines. The part reads at most
 * `rowsPerDatabase` events from each database (`auditExportStop`) and streams them in pages, so
 * neither the rows nor the file are ever held whole; `nextCursor` resumes after it.
 *
 * Starting an export (no cursor) is rate limited per owner and per person and records
 * `audit.exported` in the owner's regional database before anything is read. That insert is the
 * one event written outside the batch of its change: an export is a read with no batch, and the
 * event records that it was asked for, so it is written unconditionally once the request passed
 * authorization, the plan gate, validation and the rate limit. The part ends just before `now`,
 * so it never lists its own event. A resumed part records nothing more, and counts against the
 * owner's own limit on parts: a cursor is only a position, so anyone who may export could make
 * one up, and without a limit could keep the database busy without ever starting an export.
 */
export async function exportAuditLog(
  db: RegionalDb,
  input: AuditExportInput,
): Promise<Result<AuditExport>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const ownerId = input.actor.ownerId;
  const owner = await ownerEntitlements(db.global, ownerId, input.now);
  // The export's own feature first, so an owner without either hears about the export.
  const gate = requireFeature(owner, "auditExport");
  if (!gate.ok) return gate;
  const reading = requireFeature(owner, "audit");
  if (!reading.ok) return reading;
  const window = auditWindow(input.filters, owner.limits.auditRetentionDays, input.now);
  if (!window.ok) return window;
  let after: AuditPosition | null = null;
  if (input.cursor !== undefined) {
    const decoded = decodeAuditCursor(input.cursor);
    if (!decoded.ok) return decoded;
    after = decoded.value;
    const part = AUDIT_EXPORT.partsPerOwner;
    const hit = await hitRateLimit(
      db.global.$client,
      `audit-export-part:owner:${ownerId}`,
      part.windowSeconds * 1000,
      input.now,
    );
    if (hit.count > part.max) {
      return fail("rate_limited", "Too many audit log exports. Try again later.");
    }
  } else {
    const limited = await exportRateLimited(db.global, ownerId, input.actor.userId, input.now);
    if (limited) return fail("rate_limited", "Too many audit log exports. Try again later.");
    await auditEvent(
      db,
      {
        ownerId,
        kind: "audit.exported",
        actor: { type: "user", id: input.actor.userId },
        targetId: null,
        detail: auditExportDetail(input.format, input.filters),
        now: input.now,
      },
      sql`1 = 1`,
    );
  }
  const bounds = input.bounds ?? AUDIT_EXPORT;
  const wanted = input.filters.kinds ?? AUDIT_KINDS;
  const query = {
    ownerId,
    filters: input.filters,
    from: window.value.from,
    to: Math.min(window.value.to, input.now),
    after,
  };
  const sources = [
    { handle: db as Db, kinds: REGIONAL_AUDIT_KINDS.filter((k) => wanted.includes(k)) },
    { handle: db.global as Db, kinds: GLOBAL_AUDIT_KINDS.filter((k) => wanted.includes(k)) },
  ];
  const boundaries = await Promise.all(
    sources.map(({ handle, kinds }) =>
      boundary(handle, { ...query, kinds }, bounds.rowsPerDatabase),
    ),
  );
  const stop = auditExportStop(boundaries);
  const format = input.format;
  return ok({
    format,
    fileName: auditExportFileName(format),
    contentType: auditExportContentType(format),
    nextCursor: stop === null ? null : encodeAuditCursor(stop),
    async *lines() {
      if (after === null) {
        const preamble = auditExportPreamble(format);
        if (preamble) yield preamble;
      }
      for await (const rows of merged(sources, { ...query, until: stop }, bounds.pageSize)) {
        const events = await present(db, ownerId, rows);
        yield events.map((event) => auditExportLine(format, event)).join("");
      }
    },
  });
}

/** Counts one export start per owner and per person; true when either is over its limit. */
async function exportRateLimited(
  global: GlobalDb,
  ownerId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  let limited = false;
  for (const [key, rule] of [
    [`audit-export:owner:${ownerId}`, AUDIT_EXPORT.perOwner],
    [`audit-export:actor:${userId}`, AUDIT_EXPORT.perActor],
  ] as const) {
    const hit = await hitRateLimit(global.$client, key, rule.windowSeconds * 1000, now);
    if (hit.count > rule.max) limited = true;
  }
  return limited;
}

type PartQuery = Omit<PageQuery, "kinds" | "until">;

/**
 * The position of one database's `count`-th matching row after the cursor, or null when it has
 * fewer: one indexed query that returns one position, never the rows.
 */
async function boundary(db: Db, query: PageQuery, count: number): Promise<AuditPosition | null> {
  if (query.kinds.length === 0) return null;
  const [row] = await db
    .select({ at: ae.at, id: ae.id })
    .from(ae)
    .where(matching(query))
    .orderBy(desc(ae.at), desc(ae.id))
    .limit(1)
    .offset(count - 1);
  return row ? { at: row.at, id: row.id } : null;
}

/**
 * The rows of both databases in one order, newest first, a page at a time: each database is
 * read `pageSize` rows at a time and only refilled when its rows are used up, so at most two
 * pages are held.
 */
async function* merged(
  sources: readonly { handle: Db; kinds: readonly AuditKind[] }[],
  query: PartQuery & { until: AuditPosition | null },
  pageSize: number,
): AsyncGenerator<AuditRow[]> {
  const state = sources.map((source) => ({
    ...source,
    buffer: [] as AuditRow[],
    after: query.after,
    done: source.kinds.length === 0,
  }));
  let out: AuditRow[] = [];
  for (;;) {
    for (const one of state) {
      if (one.buffer.length > 0 || one.done) continue;
      one.buffer = await page(one.handle, {
        ...query,
        kinds: one.kinds,
        after: one.after,
        limit: pageSize,
      });
      one.done = one.buffer.length < pageSize;
      const last = one.buffer.at(-1);
      if (last) one.after = { at: last.at, id: last.id };
    }
    let next: (typeof state)[number] | undefined;
    for (const one of state) {
      const head = one.buffer[0];
      if (head && (!next || newerFirst(head, next.buffer[0] as AuditRow) < 0)) next = one;
    }
    if (!next) break;
    out.push(next.buffer.shift() as AuditRow);
    if (out.length === pageSize) {
      yield out;
      out = [];
    }
  }
  if (out.length > 0) yield out;
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
 * `AUDIT_LIMITS.pruneBatch` rows per kind of owner and run (`AUDIT_LIMITS.pruneRounds` by
 * default, far more than owners can write between runs); the next run goes on. Owners whose
 * plan keeps events for another number of days (an Enterprise override) are pruned on their own
 * and left out of the default pass; a plan row changed after it was read keeps its owner's events
 * until the next run. Run on every control database, the global one included.
 */
export async function pruneAuditEvents(
  db: Db,
  global: GlobalDb,
  now: number,
  rounds: number = AUDIT_LIMITS.pruneRounds,
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
