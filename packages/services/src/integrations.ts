// Issue integrations (premium plan T7, decision 0018): an owner's connections to GitHub Issues or
// Linear. Only admins manage them (role action `integrations`), only through the dashboard
// session; the owner side picks one to create an issue from a thread (./thread-issues.ts). The
// credential an admin pastes is checked against the service, sealed (./integration-keys.ts) and
// never returned or logged; Portifact shows only its last four characters and the identity the
// service reported for it. Connections are the owner's data, so they live in its region.
import {
  type AuditDetail,
  INTEGRATION_LIMITS,
  type IntegrationAttention,
  type IntegrationCheckProblem,
  type IntegrationCreate,
  type IntegrationService,
  type IntegrationTarget,
  type IntegrationUpdate,
} from "@portifact/contracts";
import { type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  checkIntegrationTargets,
  credentialHint,
  fail,
  hasFeature,
  ok,
  type Result,
  requireFeature,
} from "@portifact/domain";
import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { auditEvent } from "./audit.ts";
import { type CallOptions, checkCredential } from "./integration-clients.ts";
import { type IntegrationKey, openCredential, sealCredential } from "./integration-keys.ts";
import { ownerEntitlements } from "./plans.ts";

const c = schema.integrationConnections;
type ConnectionRow = typeof c.$inferSelect;

export const INTEGRATION_FEATURE = "integrations" as const;

/** Whether the platform offers integrations (`INTEGRATIONS_ENABLED` and the key, decision 0018). */
export interface IntegrationSwitch {
  enabled: boolean;
}

export const INTEGRATIONS_UNAVAILABLE = "Integrations are not available yet.";

const unavailable = () => fail<never>("capacity_unavailable", INTEGRATIONS_UNAVAILABLE);
const missing = () => fail<never>("not_found", "Connection not found.");

function hexId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The stored targets, or none when the column does not read as a list. */
export function storedTargets(raw: string): IntegrationTarget[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as IntegrationTarget).id === "string" &&
      typeof (item as IntegrationTarget).name === "string"
        ? [{ id: (item as IntegrationTarget).id, name: (item as IntegrationTarget).name }]
        : [],
    );
  } catch {
    return [];
  }
}

export interface ConnectionChoice {
  id: string;
  service: IntegrationService;
  label: string;
  targets: IntegrationTarget[];
  usable: boolean;
}

export interface ConnectionRecord extends ConnectionChoice {
  identity: string;
  credentialHint: string;
  attention: IntegrationAttention | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

function choice(row: ConnectionRow): ConnectionChoice {
  return {
    id: row.id,
    service: row.service,
    label: row.label,
    targets: storedTargets(row.targets),
    usable: row.attention === null,
  };
}

function record(row: ConnectionRow, names: ReadonlyMap<string, string>): ConnectionRecord {
  return {
    ...choice(row),
    identity: row.identity,
    credentialHint: row.credentialHint,
    attention: row.attention,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy === null ? null : (names.get(row.createdBy) ?? null),
  };
}

/** Display names of the accounts that connected, from the global users table. */
async function creatorNames(global: GlobalDb, rows: readonly ConnectionRow[]) {
  const ids = [...new Set(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])))];
  if (ids.length === 0) return new Map<string, string>();
  const users = await global
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(users.map((user) => [user.id, user.name]));
}

/**
 * Counts one action in a fixed window of the global `rate_limits` counters and refuses past
 * `max`. Keyed by owner, so removing and creating connections never resets it.
 */
async function ownerLimit(
  global: GlobalDb,
  key: string,
  windowMs: number,
  max: number,
  message: string,
  now: number,
): Promise<Result<true>> {
  const [row] = await global.all<{ count: number }>(
    sql`insert into rate_limits (key, window_start, count) values (${key}, ${now}, 1) on conflict (key) do update set count = case when window_start <= ${now} - ${windowMs} then 1 else count + 1 end, window_start = case when window_start <= ${now} - ${windowMs} then ${now} else window_start end returning count`,
  );
  return Number(row?.count ?? 0) > max ? fail("rate_limited", message) : ok(true);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function checkLimit(global: GlobalDb, ownerId: string, now: number) {
  return ownerLimit(
    global,
    `integration:check:${ownerId}`,
    HOUR_MS,
    INTEGRATION_LIMITS.checksPerOwnerPerHour,
    `At most ${INTEGRATION_LIMITS.checksPerOwnerPerHour} connection checks an hour. Try again later.`,
    now,
  );
}

const SERVICE_NAMES: Record<IntegrationService, string> = { github: "GitHub", linear: "Linear" };

/** What failed, in words for the admin (decision 0018: "Test reports in plain words"). */
export function checkProblemMessage(
  service: IntegrationService,
  problem: IntegrationCheckProblem,
  target: string | null,
): string {
  const name = SERVICE_NAMES[service];
  switch (problem) {
    case "credential_rejected":
      return service === "github"
        ? "GitHub refused the token: it is wrong, expired or revoked."
        : "Linear refused the API key: it is wrong or revoked.";
    case "missing_permission":
      return `${name} accepted the credential but it cannot read its own account.`;
    case "target_unreachable":
      return service === "github"
        ? `The token cannot reach ${target ?? "a repository"}. Give it access to that repository with Issues read and write.`
        : `The API key cannot see the team ${target ?? ""}. Check the team ID and that the key's account is in that team.`.replace(
            " team .",
            " team.",
          );
    case "issues_disabled":
      return `Issues are turned off in ${target ?? "the repository"}.`;
    case "rate_limited":
      return `${name} is limiting requests from this credential. Try again later.`;
    case "service_unavailable":
      return `${name} did not answer. Try again later.`;
  }
}

/** The audit event of a connection change, in its batch on `condition`. */
function connectionEvent<
  K extends "integration.connected" | "integration.changed" | "integration.removed",
>(
  db: Db,
  actor: Actor,
  connectionId: string,
  kind: K,
  detail: AuditDetail<K>,
  now: number,
  condition: SQL,
) {
  return auditEvent(
    db,
    {
      ownerId: actor.ownerId,
      kind,
      actor: { type: "user", id: actor.userId },
      targetId: connectionId,
      detail,
      now,
    },
    condition,
  );
}

export interface IntegrationDeps extends CallOptions {
  keys: readonly IntegrationKey[];
  service: IntegrationSwitch;
}

// Reading

export interface ChoiceListing {
  connections: ConnectionChoice[];
  available: boolean;
  serviceAvailable: boolean;
  euResidency: boolean;
}

/**
 * The owner's connections as the owner side picks one: labels, services and targets, never the
 * credential or who it acts as. Role action `issues` (admins and editors; never a token). Never
 * gated: reading what exists is never behind a plan. Empty while integrations are switched off.
 */
export async function listIntegrationChoices(
  db: RegionalDb,
  input: { actor: Actor; service: IntegrationSwitch; now: number },
): Promise<Result<ChoiceListing>> {
  const allowed = authorize(input.actor, "issues");
  if (!allowed.ok) return allowed;
  const [owner, rows] = await Promise.all([
    ownerEntitlements(db.global, input.actor.ownerId, input.now),
    input.service.enabled
      ? db.select().from(c).where(eq(c.ownerId, input.actor.ownerId)).orderBy(c.createdAt, c.id)
      : Promise.resolve([] as ConnectionRow[]),
  ]);
  return ok({
    connections: rows.map(choice),
    available: hasFeature(owner, INTEGRATION_FEATURE),
    serviceAvailable: input.service.enabled,
    euResidency: input.actor.region === "eu",
  });
}

export interface ConnectionListing {
  connections: ConnectionRecord[];
  available: boolean;
  serviceAvailable: boolean;
}

/** The owner's connections as its admins manage them. Never gated. */
export async function listIntegrationConnections(
  db: RegionalDb,
  input: { actor: Actor; service: IntegrationSwitch; now: number },
): Promise<Result<ConnectionListing>> {
  const allowed = authorize(input.actor, "integrations");
  if (!allowed.ok) return allowed;
  const [owner, rows] = await Promise.all([
    ownerEntitlements(db.global, input.actor.ownerId, input.now),
    db.select().from(c).where(eq(c.ownerId, input.actor.ownerId)).orderBy(c.createdAt, c.id),
  ]);
  const names = await creatorNames(db.global, rows);
  return ok({
    connections: rows.map((row) => record(row, names)),
    available: hasFeature(owner, INTEGRATION_FEATURE),
    serviceAvailable: input.service.enabled,
  });
}

async function owned(db: RegionalDb, actor: Actor, connectionId: string) {
  const [row] = await db
    .select()
    .from(c)
    .where(and(eq(c.id, connectionId), eq(c.ownerId, actor.ownerId)))
    .limit(1);
  return row;
}

async function present(db: RegionalDb, row: ConnectionRow) {
  return record(row, await creatorNames(db.global, [row]));
}

// Changing

/**
 * Connects a service: the credential is checked against it (who it acts as, and every target
 * reachable) before anything is stored. Needs `integrations` in the owner's plan.
 */
export async function createIntegrationConnection(
  db: RegionalDb,
  input: { actor: Actor; connection: IntegrationCreate; deps: IntegrationDeps; now: number },
): Promise<Result<ConnectionRecord>> {
  const allowed = authorize(input.actor, "integrations");
  if (!allowed.ok) return allowed;
  if (!input.deps.service.enabled) return unavailable();
  const [key] = input.deps.keys;
  if (!key) return unavailable();
  const ownerId = input.actor.ownerId;
  const gate = requireFeature(
    await ownerEntitlements(db.global, ownerId, input.now),
    INTEGRATION_FEATURE,
  );
  if (!gate.ok) return gate;
  const { service, label, credential } = input.connection;
  const targets = checkIntegrationTargets(service, input.connection.targets);
  if (!targets.ok) return targets;
  const [existing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(c)
    .where(eq(c.ownerId, ownerId));
  if (Number(existing?.count ?? 0) >= INTEGRATION_LIMITS.perOwner) return full();
  const created = await ownerLimit(
    db.global,
    `integration:create:${ownerId}`,
    DAY_MS,
    INTEGRATION_LIMITS.createsPerOwnerPerDay,
    `At most ${INTEGRATION_LIMITS.createsPerOwnerPerDay} connections can be created a day. Try again later.`,
    input.now,
  );
  if (!created.ok) return created;
  const limited = await checkLimit(db.global, ownerId, input.now);
  if (!limited.ok) return limited;
  const checked = await checkCredential(service, credential, targets.value, input.deps);
  if (!checked.ok) {
    return fail("invalid_input", checkProblemMessage(service, checked.problem, checked.target));
  }
  const id = hexId("ic_");
  const box = await sealCredential(key, id, credential);
  // Columns in schema order: id, owner, service, label, key, credential, hint, identity, targets,
  // attention, attention at, revision, created, updated, created by. The count keeps concurrent
  // creates under the cap.
  const [inserted] = await db.batch([
    db
      .insert(c)
      .select(
        sql`select ${id}, ${ownerId}, ${service}, ${label}, ${key.id}, ${box}, ${credentialHint(credential)}, ${checked.identity}, ${JSON.stringify(checked.targets)}, null, null, 1, ${input.now}, ${input.now}, ${input.actor.userId} where (select count(*) from ${c} where ${c.ownerId} = ${ownerId}) < ${INTEGRATION_LIMITS.perOwner}`,
      )
      .returning(),
    // After the insert, on the row it created: the service and how many targets, never the
    // credential, the identity or the targets' names.
    connectionEvent(
      db,
      input.actor,
      id,
      "integration.connected",
      { service, targets: checked.targets.length },
      input.now,
      sql`exists (select 1 from ${c} where ${c.id} = ${id})`,
    ),
  ]);
  const [row] = inserted;
  if (!row) return full();
  return ok(await present(db, row));
}

const full = () =>
  fail<never>(
    "quota_exceeded",
    `An owner can have at most ${INTEGRATION_LIMITS.perOwner} connections. Remove one to add another.`,
  );

/**
 * Changes a connection's label, credential or targets. A new credential or new targets are
 * checked against the service first, and a new credential clears the need for attention. Needs
 * the feature, like creating.
 */
export async function updateIntegrationConnection(
  db: RegionalDb,
  input: {
    actor: Actor;
    connectionId: string;
    update: IntegrationUpdate;
    deps: IntegrationDeps;
    now: number;
  },
): Promise<Result<ConnectionRecord>> {
  const allowed = authorize(input.actor, "integrations");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.connectionId);
  if (!row) return missing();
  if (!input.deps.service.enabled) return unavailable();
  const [key] = input.deps.keys;
  if (!key) return unavailable();
  const gate = requireFeature(
    await ownerEntitlements(db.global, input.actor.ownerId, input.now),
    INTEGRATION_FEATURE,
  );
  if (!gate.ok) return gate;
  const change: Partial<typeof c.$inferInsert> = {};
  const detail: AuditDetail<"integration.changed"> = {};
  if (input.update.label !== undefined && input.update.label !== row.label) {
    change.label = input.update.label;
    detail.label = true;
  }
  const current = storedTargets(row.targets);
  let targetIds = current.map((target) => target.id);
  if (input.update.targets !== undefined) {
    const checked = checkIntegrationTargets(row.service, input.update.targets);
    if (!checked.ok) return checked;
    targetIds = checked.value;
  }
  const targetsChanged =
    targetIds.length !== current.length ||
    targetIds.some((id, i) => id.toLowerCase() !== current[i]?.id.toLowerCase());
  const newCredential = input.update.credential;
  if (newCredential !== undefined || targetsChanged) {
    const credential =
      newCredential ??
      (await openCredential(input.deps.keys, row.keyId, row.id, row.credentialBox));
    if (credential === null) {
      return fail(
        "invalid_input",
        "The stored credential can no longer be opened. Paste the credential again.",
      );
    }
    const limited = await checkLimit(db.global, input.actor.ownerId, input.now);
    if (!limited.ok) return limited;
    const checked = await checkCredential(row.service, credential, targetIds, input.deps);
    if (!checked.ok) {
      return fail(
        "invalid_input",
        checkProblemMessage(row.service, checked.problem, checked.target),
      );
    }
    change.identity = checked.identity;
    if (targetsChanged) {
      change.targets = JSON.stringify(checked.targets);
      detail.targets = checked.targets.length;
    }
    if (newCredential !== undefined) {
      Object.assign(change, {
        keyId: key.id,
        credentialBox: await sealCredential(key, row.id, newCredential),
        credentialHint: credentialHint(newCredential),
        attention: null,
        attentionAt: null,
      });
      detail.credential = true;
    }
  }
  if (Object.keys(detail).length === 0) {
    // Nothing that counts changed (the identity may have, after a check): no event.
    if (change.identity !== undefined && change.identity !== row.identity) {
      const [updated] = await db
        .update(c)
        .set({ identity: change.identity })
        .where(and(eq(c.id, row.id), eq(c.revision, row.revision)))
        .returning();
      return ok(await present(db, updated ?? row));
    }
    return ok(await present(db, row));
  }
  // Conditioned on the revision read, so two changes at once cannot interleave their checks.
  const where = and(
    eq(c.id, row.id),
    eq(c.ownerId, input.actor.ownerId),
    eq(c.revision, row.revision),
  ) as SQL;
  const [, updated] = await db.batch([
    connectionEvent(
      db,
      input.actor,
      row.id,
      "integration.changed",
      detail,
      input.now,
      sql`exists (select 1 from ${c} where ${where})`,
    ),
    db
      .update(c)
      .set({ ...change, revision: row.revision + 1, updatedAt: input.now })
      .where(where)
      .returning(),
  ]);
  const [saved] = updated;
  if (!saved) {
    return fail("version_conflict", "The connection changed meanwhile. Reload and try again.");
  }
  return ok(await present(db, saved));
}

export interface ConnectionTest {
  ok: boolean;
  identity: string | null;
  problem: IntegrationCheckProblem | null;
  target: string | null;
  message: string;
}

/**
 * Asks the service again who the credential acts as and whether every target is reachable, and
 * reports in plain words what failed. A credential the service refuses marks the connection as
 * needing attention; one that works again clears it. Never gated: a lapsed plan can still see
 * whether its credential works.
 */
export async function testIntegrationConnection(
  db: RegionalDb,
  input: { actor: Actor; connectionId: string; deps: IntegrationDeps; now: number },
): Promise<Result<ConnectionTest>> {
  const allowed = authorize(input.actor, "integrations");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.connectionId);
  if (!row) return missing();
  if (!input.deps.service.enabled) return unavailable();
  const credential = await openCredential(input.deps.keys, row.keyId, row.id, row.credentialBox);
  if (credential === null) {
    await markAttention(
      db,
      row,
      "key_unavailable",
      { type: "user", id: input.actor.userId },
      input.now,
    );
    return ok({
      ok: false,
      identity: null,
      problem: "credential_rejected",
      target: null,
      message: "The stored credential can no longer be opened. Paste the credential again.",
    });
  }
  const limited = await checkLimit(db.global, input.actor.ownerId, input.now);
  if (!limited.ok) return limited;
  const checked = await checkCredential(
    row.service,
    credential,
    storedTargets(row.targets).map((target) => target.id),
    input.deps,
  );
  if (!checked.ok) {
    if (checked.problem === "credential_rejected") {
      await markAttention(
        db,
        row,
        "credential_rejected",
        { type: "user", id: input.actor.userId },
        input.now,
      );
    }
    return ok({
      ok: false,
      identity: null,
      problem: checked.problem,
      target: checked.target,
      message: checkProblemMessage(row.service, checked.problem, checked.target),
    });
  }
  // It works: the identity as reported now, and no attention needed any more.
  await db
    .update(c)
    .set({ identity: checked.identity, attention: null, attentionAt: null })
    .where(and(eq(c.id, row.id), eq(c.keyId, row.keyId)));
  return ok({
    ok: true,
    identity: checked.identity,
    problem: null,
    target: null,
    message: `Connected as ${checked.identity}. Every repository or team is reachable.`,
  });
}

/**
 * Marks a connection as needing an admin (the service refused its credential, or no key opens
 * it), with one `integration.failing` event when it was not marked already. Issues stop going
 * through it until an admin pastes a new credential or a test passes.
 */
export async function markAttention(
  db: RegionalDb,
  row: Pick<ConnectionRow, "id" | "ownerId" | "service">,
  reason: IntegrationAttention,
  actor: { type: "user"; id: string } | { type: "system" },
  now: number,
) {
  const unmarked = and(eq(c.id, row.id), sql`${c.attention} is null`) as SQL;
  await db.batch([
    auditEvent(
      db,
      {
        ownerId: row.ownerId,
        kind: "integration.failing",
        actor,
        targetId: row.id,
        detail: { service: row.service, reason },
        now,
      },
      sql`exists (select 1 from ${c} where ${unmarked})`,
    ),
    db.update(c).set({ attention: reason, attentionAt: now }).where(unmarked),
  ]);
}

/**
 * Removes a connection and its sealed credential. Never gated. The tombstone goes to the global
 * database first, then the regional batch deletes the row (decision 0005: global first, then
 * the region), so a restore of either database cannot bring the credential back; a retry after a
 * failed regional batch finds the tombstone already there. Issues already created keep their
 * links; requests still pending fail when their job finds the connection gone.
 */
export async function removeIntegrationConnection(
  db: RegionalDb,
  input: { actor: Actor; connectionId: string; now: number },
): Promise<Result<{ connectionId: string }>> {
  const allowed = authorize(input.actor, "integrations");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.connectionId);
  if (!row) return missing();
  await db.global
    .insert(schema.tombstones)
    .values({ kind: "integration_connection", id: row.id, deletedAt: input.now })
    .onConflictDoNothing();
  const mine = and(eq(c.id, row.id), eq(c.ownerId, input.actor.ownerId)) as SQL;
  const [, deleted] = await db.batch([
    connectionEvent(
      db,
      input.actor,
      row.id,
      "integration.removed",
      { service: row.service },
      input.now,
      sql`exists (select 1 from ${c} where ${mine})`,
    ),
    db.delete(c).where(mine).returning({ id: c.id }),
  ]);
  return deleted.length === 1 ? ok({ connectionId: row.id }) : missing();
}

/** The owner's connections for the account export: never the credential. */
export async function exportIntegrations(db: RegionalDb, ownerId: string) {
  const rows = await db.select().from(c).where(eq(c.ownerId, ownerId)).orderBy(c.createdAt);
  return rows.map((row) => ({
    id: row.id,
    service: row.service,
    label: row.label,
    identity: row.identity,
    targets: storedTargets(row.targets).map((target) => target.name),
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

/** Deletes an owner's connections, for the batches that delete an account or a workspace. */
export function deleteOwnerConnections(db: Db, ownerId: string, condition?: SQL) {
  return db.delete(c).where(and(eq(c.ownerId, ownerId), condition));
}

/**
 * Re-seals credentials sealed with an older key (`INTEGRATIONS_KEY_PREVIOUS`) with the current
 * one, up to `limit` a run. Returns how many it re-sealed and how many still use another key.
 */
export async function rewrapIntegrationKeys(
  db: RegionalDb,
  keys: readonly IntegrationKey[],
  limit = 200,
): Promise<{ rewrapped: number; left: number }> {
  const [current] = keys;
  if (!current) return { rewrapped: 0, left: 0 };
  const rows = await db
    .select()
    .from(c)
    .where(
      and(
        ne(c.keyId, current.id),
        inArray(
          c.keyId,
          keys.map((key) => key.id),
        ),
      ),
    )
    .limit(limit);
  let rewrapped = 0;
  for (const row of rows) {
    const credential = await openCredential(keys, row.keyId, row.id, row.credentialBox);
    if (credential === null) continue;
    const updated = await db
      .update(c)
      .set({ keyId: current.id, credentialBox: await sealCredential(current, row.id, credential) })
      .where(and(eq(c.id, row.id), eq(c.keyId, row.keyId)))
      .returning({ id: c.id });
    rewrapped += updated.length;
  }
  const [left] = await db
    .select({ count: sql<number>`count(*)` })
    .from(c)
    .where(ne(c.keyId, current.id));
  return { rewrapped, left: Number(left?.count ?? 0) };
}
