// Issue integrations (premium plan T7, decision 0018): an owner's connections to GitHub Issues,
// Linear or Jira Cloud. Only admins manage them (role action `integrations`), only through the dashboard
// session; the owner side picks one to create an issue from a thread (./thread-issues.ts). The
// credential an admin pastes is checked against the service, sealed (./integration-keys.ts) and
// never returned or logged; Portifact shows only its last four characters and the identity the
// service reported for it. Connections are the owner's data, so they live in its region.
import {
  type AuditDetail,
  type ConnectionService,
  INTEGRATION_LIMITS,
  type IntegrationAttention,
  type IntegrationCheckProblem,
  type IntegrationCreate,
  type IntegrationFailingReason,
  type IntegrationService,
  type IntegrationTarget,
  type IntegrationUpdate,
  type IssueConnectionCreate,
  isWorkspaceId,
  SLACK_LIMITS,
  SLACK_MANIFEST_VERSION,
} from "@portifact/contracts";
import { bothSides, type Db, type GlobalDb, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  checkIntegrationTargets,
  checkSlackBotToken,
  checkSlackSigningSecret,
  credentialHint,
  fail,
  hasFeature,
  type JiraSite,
  jiraCloudId,
  jiraCredential,
  jiraSiteName,
  logEvent,
  ok,
  openSlackCredential,
  type Result,
  requireFeature,
  slackBaseString,
  slackCredential,
} from "@portifact/domain";
import { and, eq, inArray, lte, ne, type SQL, sql } from "drizzle-orm";
import { actorOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { type CallOptions, type CheckedTarget, checkCredential } from "./integration-clients.ts";
import { type IntegrationKey, openCredential, sealCredential } from "./integration-keys.ts";
import { ownerEntitlements } from "./plans.ts";
import { slackAuthTest, slackRevoke } from "./slack-client.ts";

const c = schema.integrationConnections;
type ConnectionRow = typeof c.$inferSelect;

export const INTEGRATION_FEATURE = "integrations" as const;

/** Whether the platform offers integrations (`INTEGRATIONS_ENABLED` and the key, decision 0018). */
export interface IntegrationSwitch {
  enabled: boolean;
  /**
   * Slack connections are offered too (`SLACK_ENABLED` besides the integrations switch, decision
   * 0025). Absent is off.
   */
  slack?: boolean | undefined;
}

export const INTEGRATIONS_UNAVAILABLE = "Integrations are not available yet.";
export const SLACK_UNAVAILABLE = "Slack is not available yet.";
const slackUnavailable = () => fail<never>("capacity_unavailable", SLACK_UNAVAILABLE);

const unavailable = () => fail<never>("capacity_unavailable", INTEGRATIONS_UNAVAILABLE);
const missing = () => fail<never>("not_found", "Connection not found.");

function hexId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The stored targets, or none when the column does not read as a list. A Jira project also keeps
 * the issue type checked with it (`issueType`), which only the job reads.
 */
export function storedTargets(raw: string): CheckedTarget[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const { id, name, issueType } = item as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string") return [];
      return [{ id, name, ...(typeof issueType === "string" ? { issueType } : {}) }];
    });
  } catch {
    return [];
  }
}

/** A Jira connection's site, or null for other services (and a Jira row missing either value). */
export function connectionSite(row: Pick<ConnectionRow, "site" | "cloudId">): JiraSite | null {
  return row.site !== null && row.cloudId !== null
    ? { name: row.site, cloudId: row.cloudId }
    : null;
}

/** Targets as people see them: never the issue type kept for the job. */
const shown = (targets: readonly CheckedTarget[]): IntegrationTarget[] =>
  targets.map(({ id, name }) => ({ id, name }));

export interface ConnectionChoice {
  id: string;
  service: ConnectionService;
  label: string;
  targets: IntegrationTarget[];
  usable: boolean;
}

export interface ConnectionRecord extends ConnectionChoice {
  /** Jira: the site's name; null for other services. */
  site: string | null;
  identity: string;
  credentialHint: string;
  attention: IntegrationAttention | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  /** Slack: the manifest version the connection was completed with; null otherwise. */
  manifestVersion: number | null;
}

function choice(row: ConnectionRow): ConnectionChoice {
  return {
    id: row.id,
    service: row.service,
    label: row.label,
    targets: shown(storedTargets(row.targets)),
    usable: row.attention === null,
  };
}

function record(row: ConnectionRow, names: ReadonlyMap<string, string>): ConnectionRecord {
  return {
    ...choice(row),
    site: row.site,
    identity: row.identity,
    credentialHint: row.credentialHint,
    attention: row.attention,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy === null ? null : (names.get(row.createdBy) ?? null),
    manifestVersion: row.manifestVersion,
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
  // An upsert with RETURNING always answers its row.
  return Number((row as { count: number }).count) > max ? fail("rate_limited", message) : ok(true);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Credential checks per owner and, across every owner, per admin: both must have room. */
async function checkLimit(global: GlobalDb, actor: Actor, now: number): Promise<Result<true>> {
  const perOwner = await ownerLimit(
    global,
    `integration:check:${actor.ownerId}`,
    HOUR_MS,
    INTEGRATION_LIMITS.checksPerOwnerPerHour,
    `At most ${INTEGRATION_LIMITS.checksPerOwnerPerHour} connection checks an hour. Try again later.`,
    now,
  );
  if (!perOwner.ok) return perOwner;
  return ownerLimit(
    global,
    `integration:check:user:${actor.userId}`,
    HOUR_MS,
    INTEGRATION_LIMITS.checksPerAdminPerHour,
    `At most ${INTEGRATION_LIMITS.checksPerAdminPerHour} connection checks an hour per person. Try again later.`,
    now,
  );
}

/**
 * The caller is still an admin of the owner, decided again after the slow check against the
 * service (up to eleven calls of ten seconds): an admin removed meanwhile stores nothing.
 */
async function stillManages(db: RegionalDb, actor: Actor): Promise<Result<true>> {
  const resolved = await actorOn(db.global, actor.userId, actor.ownerId);
  if (!resolved.ok) return resolved;
  const again = authorize(resolved.value, "integrations");
  return again.ok ? ok(true) : again;
}

/**
 * The handle a connection write runs on, and the condition it adds: with one database the write
 * holds only while the caller is still a workspace's admin (`stillAdmin`, inside the batch); with
 * a separate regional database the re-check just before the batch is all there is, and a removal
 * landing between that read and the batch is not seen (decision 0018, "Who manages connections").
 */
function writeScope(db: RegionalDb, actor: Actor): { w: Db; holds: SQL | undefined } {
  const both = bothSides(db);
  if (both && isWorkspaceId(actor.ownerId)) {
    const m = schema.workspaceMembers;
    // As `stillAdmin` in ./workspaces.ts (not imported: that module imports this one).
    const holds = sql`exists (select 1 from ${m} as "caller" where "caller"."workspace_id" = ${actor.ownerId} and "caller"."user_id" = ${actor.userId} and "caller"."role" = 'admin')`;
    return { w: both, holds };
  }
  return { w: db, holds: undefined };
}

const SERVICE_NAMES: Record<IntegrationService, string> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
};

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
        : service === "linear"
          ? "Linear refused the API key: it is wrong or revoked."
          : "Jira refused the email and API token: they are wrong, the token expired or was revoked, or it is a token without scopes.";
    case "missing_permission":
      return `${name} accepted the credential but it cannot read its own account.`;
    case "target_unreachable":
      return service === "github"
        ? `The token cannot reach ${target ?? "a repository"}. Give it access to that repository with Issues read and write.`
        : service === "linear"
          ? `The API key cannot see the team ${target ?? ""}. Check the team ID and that the key's account is in that team.`.replace(
              " team .",
              " team.",
            )
          : `The token cannot see the project ${target ?? ""}. Check the project key, the token's scopes and that its account can browse that project.`.replace(
              " project .",
              " project.",
            );
    case "site_mismatch":
      return "The cloud ID does not belong to that Jira site (or the site changed its address). Copy both again from the site; for a connection, remove it and connect the site again.";
    case "issues_disabled":
      return service === "jira"
        ? `Portifact cannot create issues in ${target ?? "the project"}: it has no standard issue type.`
        : `Issues are turned off in ${target ?? "the repository"}.`;
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
    // Only issue trackers: a Slack connection creates no issue, and clients up to v0.39.0 refuse
    // a listing that names a service they do not know (decision 0025, "Who manages and who lists").
    input.service.enabled
      ? db
          .select()
          .from(c)
          .where(and(eq(c.ownerId, input.actor.ownerId), ne(c.service, "slack")))
          .orderBy(c.createdAt, c.id)
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
  if (input.connection.service === "slack" && !input.deps.service.slack) return slackUnavailable();
  const [key] = input.deps.keys;
  if (!key) return unavailable();
  const ownerId = input.actor.ownerId;
  const gate = requireFeature(
    await ownerEntitlements(db.global, ownerId, input.now),
    INTEGRATION_FEATURE,
  );
  if (!gate.ok) return gate;
  if (input.connection.service === "slack") {
    return startSlackConnection(db, { ...input, label: input.connection.label });
  }
  const { service, label, credential } = input.connection;
  const targets = checkIntegrationTargets(service, input.connection.targets);
  if (!targets.ok) return targets;
  const jira = service === "jira" ? jiraEndpoint(input.connection) : null;
  if (jira && !jira.ok) return jira;
  const site = jira?.value.site ?? null;
  // Jira's token goes with its account's email; both are sealed together, never stored apart.
  const sealed = jira ? jiraCredential(jira.value.account, credential) : credential;
  const [existing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(c)
    .where(eq(c.ownerId, ownerId));
  if (Number((existing as { count: number }).count) >= INTEGRATION_LIMITS.perOwner) return full();
  const created = await ownerLimit(
    db.global,
    `integration:create:${ownerId}`,
    DAY_MS,
    INTEGRATION_LIMITS.createsPerOwnerPerDay,
    `At most ${INTEGRATION_LIMITS.createsPerOwnerPerDay} connections can be created a day. Try again later.`,
    input.now,
  );
  if (!created.ok) return created;
  const limited = await checkLimit(db.global, input.actor, input.now);
  if (!limited.ok) return limited;
  const checked = await checkCredential(service, sealed, targets.value, input.deps, site);
  if (!checked.ok) {
    return fail("invalid_input", checkProblemMessage(service, checked.problem, checked.target));
  }
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  const id = hexId("ic_");
  const box = await sealCredential(key, id, sealed);
  // Columns in schema order: id, owner, service, label, key, credential, hint, identity, targets,
  // attention, attention at, revision, created, updated, created by, site, cloud ID, external ID,
  // manifest version. The count keeps concurrent creates under the cap.
  const [inserted] = await w.batch([
    w
      .insert(c)
      .select(
        sql`select ${id}, ${ownerId}, ${service}, ${label}, ${key.id}, ${box}, ${credentialHint(credential)}, ${checked.identity}, ${JSON.stringify(checked.targets)}, null, null, 1, ${input.now}, ${input.now}, ${input.actor.userId}, ${site?.name ?? null}, ${site?.cloudId ?? null}, null, null where (select count(*) from ${c} where ${c.ownerId} = ${ownerId}) < ${INTEGRATION_LIMITS.perOwner}${holds ? sql` and ${holds}` : sql``}`,
      )
      .returning(),
    // After the insert, on the row it created: the service and how many targets, never the
    // credential, the identity or the targets' names.
    connectionEvent(
      w,
      input.actor,
      id,
      "integration.connected",
      { service, targets: checked.targets.length },
      input.now,
      sql`exists (select 1 from ${c} where ${c.id} = ${id})`,
    ),
  ]);
  const [row] = inserted;
  if (!row) {
    const again = await stillManages(db, input.actor);
    return again.ok ? full() : again;
  }
  return ok(await present(db, row));
}

/** A Jira connection's site, cloud ID and account, checked; the contract already requires them. */
function jiraEndpoint(
  connection: Pick<IssueConnectionCreate, "site" | "cloudId" | "account">,
): Result<{ site: JiraSite; account: string }> {
  const name = jiraSiteName(connection.site ?? "");
  if (!name.ok) return name;
  const cloudId = jiraCloudId(connection.cloudId ?? "");
  if (!cloudId.ok) return cloudId;
  if (!connection.account) return fail("invalid_input", "Jira needs the token's account email.");
  return ok({ site: { name: name.value, cloudId: cloudId.value }, account: connection.account });
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
  if (row.service === "slack" && !input.deps.service.slack) return slackUnavailable();
  const [key] = input.deps.keys;
  if (!key) return unavailable();
  const gate = requireFeature(
    await ownerEntitlements(db.global, input.actor.ownerId, input.now),
    INTEGRATION_FEATURE,
  );
  if (!gate.ok) return gate;
  if (row.service === "slack") return completeSlackConnection(db, { ...input, row, key });
  if (input.update.botToken !== undefined || input.update.signingSecret !== undefined) {
    return fail("invalid_input", "Only Slack takes a bot token and a signing secret.");
  }
  if (row.service === "jira" && input.update.credential !== undefined && !input.update.account) {
    return fail("invalid_input", "Send the email of the new token's Atlassian account with it.");
  }
  if (row.service !== "jira" && input.update.account !== undefined) {
    return fail("invalid_input", "Only Jira takes an account email.");
  }
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
  const pasted = input.update.credential;
  // The value sealed: a Jira token together with its account's email.
  const newCredential =
    pasted === undefined
      ? undefined
      : row.service === "jira"
        ? jiraCredential(String(input.update.account), pasted)
        : pasted;
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
    const limited = await checkLimit(db.global, input.actor, input.now);
    if (!limited.ok) return limited;
    const checked = await checkCredential(
      row.service,
      credential,
      targetIds,
      input.deps,
      connectionSite(row),
    );
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
    } else if (row.service === "jira") {
      // The same projects, checked again: keep the issue types and names just read.
      change.targets = JSON.stringify(checked.targets);
    }
    if (newCredential !== undefined) {
      Object.assign(change, {
        keyId: key.id,
        credentialBox: await sealCredential(key, row.id, newCredential),
        // The pasted token's end, never the email sealed with a Jira token.
        credentialHint: credentialHint(String(pasted)),
        attention: null,
        attentionAt: null,
      });
      detail.credential = true;
    }
  }
  // Nothing that counts changed (the same label and targets, no new credential): no check ran,
  // nothing is written and nothing recorded.
  if (Object.keys(detail).length === 0) return ok(await present(db, row));
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  // Conditioned on the revision read, so two changes at once cannot interleave their checks.
  const where = and(
    eq(c.id, row.id),
    eq(c.ownerId, input.actor.ownerId),
    eq(c.revision, row.revision),
    holds,
  ) as SQL;
  const [, updated] = await w.batch([
    connectionEvent(
      w,
      input.actor,
      row.id,
      "integration.changed",
      detail,
      input.now,
      sql`exists (select 1 from ${c} where ${where})`,
    ),
    w
      .update(c)
      .set({ ...change, revision: row.revision + 1, updatedAt: input.now })
      .where(where)
      .returning(),
  ]);
  const [saved] = updated;
  if (!saved) {
    const again = await stillManages(db, input.actor);
    if (!again.ok) return again;
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
  /** Jira projects whose stored issue type was gone and is now the project's current one. */
  refreshed: string[];
}

/**
 * Asks the service again who the credential acts as and whether every target is reachable, and
 * reports in plain words what failed. A credential the service refuses, or a Jira cloud ID that
 * no longer serves the stored site, marks the connection as needing attention; one that works
 * again clears it. For Jira it also saves each project's current issue type, so a type a Jira
 * admin removed stops failing every issue. Never gated: a lapsed plan can still see
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
  if (row.service === "slack") return testSlackConnection(db, { ...input, row });
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
      refreshed: [],
    });
  }
  const limited = await checkLimit(db.global, input.actor, input.now);
  if (!limited.ok) return limited;
  const checked = await checkCredential(
    row.service,
    credential,
    storedTargets(row.targets).map((target) => target.id),
    input.deps,
    connectionSite(row),
  );
  if (!checked.ok) {
    if (checked.problem === "credential_rejected" || checked.problem === "site_mismatch") {
      // Issues stop: a refused credential sends nothing, and a site that changed its address
      // would get links to the old name, shown to everyone who sees the thread.
      await markAttention(
        db,
        row,
        checked.problem,
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
      refreshed: [],
    });
  }
  const stored = new Map(storedTargets(row.targets).map((target) => [target.id, target]));
  const refreshed = checked.targets
    .filter((target) => {
      const before = stored.get(target.id)?.issueType;
      return before !== undefined && target.issueType !== undefined && before !== target.issueType;
    })
    .map((target) => target.id);
  // It works: the identity as reported now, and no attention needed any more; only on the row
  // as it was read, so a credential pasted meanwhile keeps its own identity and state. Jira
  // targets keep the issue types just read.
  await db
    .update(c)
    .set({
      identity: checked.identity,
      attention: null,
      attentionAt: null,
      ...(row.service === "jira" ? { targets: JSON.stringify(checked.targets) } : {}),
    })
    .where(sameCredential(row));
  const message = `Connected as ${checked.identity}. Every repository, team or project is reachable.`;
  return ok({
    ok: true,
    identity: checked.identity,
    problem: null,
    target: null,
    message:
      refreshed.length === 0
        ? message
        : `${message} The issue type of ${refreshed.join(", ")} was gone; Portifact now uses the project's current one.`,
    refreshed,
  });
}

/** The connection still holds the credential that was read: its revision and sealed value. */
function sameCredential(row: Pick<ConnectionRow, "id" | "revision" | "credentialBox">): SQL {
  return and(
    eq(c.id, row.id),
    eq(c.revision, row.revision),
    eq(c.credentialBox, row.credentialBox),
  ) as SQL;
}

/**
 * Marks a connection as needing an admin (the service refused its credential, no key opens it,
 * or a Jira cloud ID no longer serves the stored site), with one `integration.failing` event when it was not marked already. Issues stop going
 * through it until an admin pastes a new credential or a test passes.
 */
export async function markAttention(
  db: RegionalDb,
  row: Pick<ConnectionRow, "id" | "ownerId" | "service" | "revision" | "credentialBox">,
  reason: IntegrationFailingReason,
  actor: { type: "user"; id: string } | { type: "system" },
  now: number,
) {
  // Only the credential that failed: one pasted meanwhile (a new revision) is left alone.
  const unmarked = and(sameCredential(row), sql`${c.attention} is null`) as SQL;
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
  input: {
    actor: Actor;
    connectionId: string;
    now: number;
    /**
     * Revokes a removed Slack connection's bot token at Slack after the delete (decision 0025,
     * "Removing it"), in the caller's `waitUntil`. Absent, nothing calls Slack.
     */
    slack?: SlackRevocation | undefined;
  },
): Promise<Result<{ connectionId: string }>> {
  const allowed = authorize(input.actor, "integrations");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.connectionId);
  if (!row) return missing();
  // Opened before the delete and kept only in memory: after it, no copy is readable.
  const token =
    row.service === "slack" && input.slack?.enabled
      ? openSlackCredential(
          (await openCredential(input.slack.keys, row.keyId, row.id, row.credentialBox)) ?? "",
        )?.botToken
      : undefined;
  await db.global
    .insert(schema.tombstones)
    .values({ kind: "integration_connection", id: row.id, deletedAt: input.now })
    .onConflictDoNothing();
  const { w, holds } = writeScope(db, input.actor);
  const mine = and(eq(c.id, row.id), eq(c.ownerId, input.actor.ownerId), holds) as SQL;
  const [, deleted] = await w.batch([
    connectionEvent(
      w,
      input.actor,
      row.id,
      "integration.removed",
      { service: row.service },
      input.now,
      sql`exists (select 1 from ${c} where ${mine})`,
    ),
    w.delete(c).where(mine).returning({ id: c.id }),
  ]);
  if (deleted.length === 1) {
    if (token !== undefined && input.slack) {
      const { fetch, defer } = input.slack;
      defer(
        slackRevoke(token, { fetch }).then((answer) => {
          const outcome = answer.kind;
          if (outcome === "ok") logEvent("log", "slack_token_revoke", { outcome });
          else logEvent("warn", "slack_token_revoke", { outcome });
        }),
      );
    }
    return ok({ connectionId: row.id });
  }
  const again = await stillManages(db, input.actor);
  return again.ok ? missing() : again;
}

export interface SlackRevocation {
  /** `SLACK_ENABLED` with the integrations switch: off, nothing calls Slack. */
  enabled: boolean;
  keys: readonly IntegrationKey[];
  fetch: IntegrationFetchLike;
  /** Runs after the answer (`waitUntil`). */
  defer(task: Promise<unknown>): void;
}

type IntegrationFetchLike = CallOptions["fetch"];

/** The owner's connections for the account export: never the credential. */
export async function exportIntegrations(db: RegionalDb, ownerId: string) {
  const rows = await db.select().from(c).where(eq(c.ownerId, ownerId)).orderBy(c.createdAt);
  // A Slack connection started and never completed holds nothing.
  return rows
    .filter((row) => row.attention !== "pending")
    .map((row) => ({
      id: row.id,
      service: row.service,
      label: row.label,
      site: row.site,
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
        // A pending Slack connection has no key and nothing sealed.
        ne(c.keyId, ""),
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
    .where(and(ne(c.keyId, ""), ne(c.keyId, current.id)));
  return { rewrapped, left: Number((left as { count: number }).count) };
}

// Slack (decision 0025): a connection to the customer's own Slack app, made in two steps because
// the events endpoint's URL must be in the app's manifest before the app (and its token) exists.

/**
 * Starts a Slack connection: a pending row that holds no credential (`key_id` and
 * `credential_box` empty, which no key opens), counted against the per-owner cap and the daily
 * creates like any connection. Nothing is called and nothing recorded: a pending row holds
 * nothing (`integration.connected` comes with the credential). The maintenance run deletes it
 * after `SLACK_LIMITS.pendingMs` if it is never completed.
 */
async function startSlackConnection(
  db: RegionalDb,
  input: { actor: Actor; label: string; now: number },
): Promise<Result<ConnectionRecord>> {
  const ownerId = input.actor.ownerId;
  const [existing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(c)
    .where(eq(c.ownerId, ownerId));
  if (Number((existing as { count: number }).count) >= INTEGRATION_LIMITS.perOwner) return full();
  const created = await ownerLimit(
    db.global,
    `integration:create:${ownerId}`,
    DAY_MS,
    INTEGRATION_LIMITS.createsPerOwnerPerDay,
    `At most ${INTEGRATION_LIMITS.createsPerOwnerPerDay} connections can be created a day. Try again later.`,
    input.now,
  );
  if (!created.ok) return created;
  const { w, holds } = writeScope(db, input.actor);
  const id = hexId("ic_");
  // Columns in schema order, as in `createIntegrationConnection`.
  const [inserted] = await w.batch([
    w
      .insert(c)
      .select(
        sql`select ${id}, ${ownerId}, 'slack', ${input.label}, '', '', '', '', '[]', 'pending', ${input.now}, 1, ${input.now}, ${input.now}, ${input.actor.userId}, null, null, null, null where (select count(*) from ${c} where ${c.ownerId} = ${ownerId}) < ${INTEGRATION_LIMITS.perOwner}${holds ? sql` and ${holds}` : sql``}`,
      )
      .returning(),
  ]);
  const [row] = inserted;
  if (!row) {
    const again = await stillManages(db, input.actor);
    return again.ok ? full() : again;
  }
  return ok(await present(db, row));
}

const SLACK_CHECK_MESSAGES = {
  credential_rejected:
    "Slack refused the bot token: it is wrong, revoked, or its app was uninstalled.",
  not_bot:
    "That is not the app's bot token. Paste the Bot User OAuth Token from OAuth & Permissions in Slack.",
  rate_limited: "Slack is limiting requests from this token. Try again later.",
  service_unavailable: "Slack did not answer. Try again later.",
} as const;

/**
 * Completes a Slack connection, or replaces its credential: the bot token (`xoxb-`, never a
 * rotating `xoxe.` one) and the signing secret, sealed together after one `auth.test` call that
 * must report a bot. Stores the Slack workspace's name and ID and the manifest version, clears
 * `pending` or any attention, conditioned on the revision read and on the caller still managing
 * the owner. Records `integration.connected` for a pending row, `integration.changed` otherwise.
 */
async function completeSlackConnection(
  db: RegionalDb,
  input: {
    actor: Actor;
    update: IntegrationUpdate;
    deps: IntegrationDeps;
    now: number;
    row: ConnectionRow;
    key: IntegrationKey;
  },
): Promise<Result<ConnectionRecord>> {
  const { row, update } = input;
  if (
    update.credential !== undefined ||
    update.targets !== undefined ||
    update.account !== undefined
  ) {
    return fail("invalid_input", "Slack takes a bot token and a signing secret.");
  }
  const pending = row.attention === "pending";
  const change: Partial<typeof c.$inferInsert> = {};
  const detail: AuditDetail<"integration.changed"> = {};
  if (update.label !== undefined && update.label !== row.label) {
    change.label = update.label;
    detail.label = true;
  }
  if (update.botToken === undefined || update.signingSecret === undefined) {
    if (pending) {
      return fail(
        "invalid_input",
        "Paste the bot token and the signing secret to finish connecting Slack.",
      );
    }
    if (Object.keys(detail).length === 0) return ok(await present(db, row));
  } else {
    const token = checkSlackBotToken(update.botToken);
    if (!token.ok) return token;
    const secret = checkSlackSigningSecret(update.signingSecret);
    if (!secret.ok) return secret;
    const limited = await checkLimit(db.global, input.actor, input.now);
    if (!limited.ok) return limited;
    const identity = await slackAuthTest(token.value, input.deps);
    if (!identity.ok) return fail("invalid_input", SLACK_CHECK_MESSAGES[identity.problem]);
    Object.assign(change, {
      keyId: input.key.id,
      credentialBox: await sealCredential(
        input.key,
        row.id,
        slackCredential(token.value, secret.value),
      ),
      credentialHint: credentialHint(token.value),
      identity: identity.team,
      externalId: identity.teamId,
      manifestVersion: SLACK_MANIFEST_VERSION,
      attention: null,
      attentionAt: null,
    });
    detail.credential = true;
  }
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  const where = and(
    eq(c.id, row.id),
    eq(c.ownerId, input.actor.ownerId),
    eq(c.revision, row.revision),
    holds,
  ) as SQL;
  const condition = sql`exists (select 1 from ${c} where ${where})`;
  const [, updated] = await w.batch([
    pending
      ? connectionEvent(
          w,
          input.actor,
          row.id,
          "integration.connected",
          { service: "slack", targets: 0 },
          input.now,
          condition,
        )
      : connectionEvent(
          w,
          input.actor,
          row.id,
          "integration.changed",
          detail,
          input.now,
          condition,
        ),
    w
      .update(c)
      .set({ ...change, revision: row.revision + 1, updatedAt: input.now })
      .where(where)
      .returning(),
  ]);
  const [saved] = updated;
  if (!saved) {
    const again = await stillManages(db, input.actor);
    if (!again.ok) return again;
    return fail("version_conflict", "The connection changed meanwhile. Reload and try again.");
  }
  return ok(await present(db, saved));
}

/**
 * Tests a Slack connection with `auth.test`: a refused token marks it `credential_rejected`, a
 * working one for the same Slack workspace clears any attention. A pending row has nothing to
 * test. Never gated on the plan, but it calls Slack, so only while Slack is switched on.
 */
async function testSlackConnection(
  db: RegionalDb,
  input: { actor: Actor; row: ConnectionRow; deps: IntegrationDeps; now: number },
): Promise<Result<ConnectionTest>> {
  const { row } = input;
  if (!input.deps.service.slack) return slackUnavailable();
  if (row.attention === "pending") {
    return fail(
      "invalid_input",
      "Finish connecting Slack first: paste the bot token and the signing secret.",
    );
  }
  const result = (
    passed: boolean,
    problem: IntegrationCheckProblem | null,
    message: string,
    identity: string | null = null,
  ): Result<ConnectionTest> =>
    ok({ ok: passed, identity, problem, target: null, message, refreshed: [] });
  const opened = await openCredential(input.deps.keys, row.keyId, row.id, row.credentialBox);
  const pair = opened === null ? null : openSlackCredential(opened);
  const byAdmin = { type: "user" as const, id: input.actor.userId };
  if (pair === null) {
    await markAttention(db, row, "key_unavailable", byAdmin, input.now);
    return result(
      false,
      "credential_rejected",
      "The stored credential can no longer be opened. Paste the bot token and signing secret again.",
    );
  }
  const limited = await checkLimit(db.global, input.actor, input.now);
  if (!limited.ok) return limited;
  const identity = await slackAuthTest(pair.botToken, input.deps);
  if (!identity.ok) {
    if (identity.problem === "credential_rejected") {
      await markAttention(db, row, "credential_rejected", byAdmin, input.now);
    }
    const problem: IntegrationCheckProblem =
      identity.problem === "not_bot" ? "missing_permission" : identity.problem;
    return result(false, problem, SLACK_CHECK_MESSAGES[identity.problem]);
  }
  if (identity.teamId !== row.externalId) {
    return result(
      false,
      "credential_rejected",
      "The token now belongs to another Slack workspace. Paste the bot token of this connection's app again.",
    );
  }
  await db
    .update(c)
    .set({ identity: identity.team, attention: null, attentionAt: null })
    .where(sameCredential(row));
  return result(true, null, `Connected to the Slack workspace ${identity.team}.`, identity.team);
}

/**
 * Deletes Slack connections started and never completed, older than `SLACK_LIMITS.pendingMs`,
 * in one region. They hold no credential, so no tombstone is written (a restored one is deleted
 * again by this scan).
 */
export async function prunePendingConnections(db: RegionalDb, now: number): Promise<number> {
  const deleted = await db
    .delete(c)
    .where(
      and(
        eq(c.service, "slack"),
        eq(c.attention, "pending"),
        lte(c.createdAt, now - SLACK_LIMITS.pendingMs),
      ),
    )
    .returning({ id: c.id });
  return deleted.length;
}

/** A Slack connection as the events endpoint reads it: one primary-key read. */
export type SlackEventConnection = Pick<
  ConnectionRow,
  "id" | "ownerId" | "service" | "keyId" | "credentialBox" | "attention" | "revision" | "externalId"
>;

/**
 * A key no signing secret is: a missing or pending connection costs the same HMAC as any. Made on
 * first use, never at module load: workerd refuses random values in global scope, and a Worker
 * that did it would not start.
 */
let dummySigningKey: Uint8Array<ArrayBuffer> | undefined;
function dummyKey(): Uint8Array<ArrayBuffer> {
  dummySigningKey ??= crypto.getRandomValues(new Uint8Array(32));
  return dummySigningKey;
}

const encoder = new TextEncoder();

/**
 * Verifies an inbound request's signature with the connection's own signing secret (decision
 * 0025, "Order of checks", steps 2 and 3): one D1 read by primary key, then HMAC-SHA-256 over
 * `v0:<timestamp>:<raw body>`, compared in constant time by `crypto.subtle.verify`. A missing or
 * pending connection is checked against a dummy key and refused. A connection whose credential no
 * key opens is refused and, only when it has no attention yet, marked `key_unavailable`: the one
 * write an unverified request can cause, at most once per connection.
 */
export async function verifySlackRequest(
  db: RegionalDb,
  input: {
    connectionId: string;
    timestamp: string;
    signature: Uint8Array<ArrayBuffer>;
    body: Uint8Array;
    keys: readonly IntegrationKey[];
    now: number;
  },
): Promise<SlackEventConnection | null> {
  const [row] = await db
    .select({
      id: c.id,
      ownerId: c.ownerId,
      service: c.service,
      keyId: c.keyId,
      credentialBox: c.credentialBox,
      attention: c.attention,
      revision: c.revision,
      externalId: c.externalId,
    })
    .from(c)
    .where(and(eq(c.id, input.connectionId), eq(c.service, "slack")))
    .limit(1);
  const usable = row !== undefined && row.attention !== "pending";
  const opened = usable
    ? await openCredential(input.keys, row.keyId, row.id, row.credentialBox)
    : null;
  const secret = opened === null ? null : (openSlackCredential(opened)?.signingSecret ?? null);
  const key = await crypto.subtle.importKey(
    "raw",
    secret === null ? dummyKey() : encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    input.signature,
    slackBaseString(input.timestamp, input.body),
  );
  if (usable && secret === null) {
    if (row.attention === null) {
      await markAttention(db, row, "key_unavailable", { type: "system" }, input.now);
    }
    return null;
  }
  return usable && valid ? row : null;
}

/** What the endpoint did with a verified event, for its one log line. */
export type SlackEventOutcome = "ignored" | "team_mismatch" | "uninstalled";

/**
 * Acts on a verified `event_callback` after the answer (decision 0025, "After the answer"): the
 * envelope must come from the connection's Slack workspace; `app_uninstalled` and
 * `tokens_revoked` mark the connection `app_uninstalled` once, with one `integration.failing`.
 * `link_shared` is acknowledged and ignored until previews are delivered.
 */
export async function applySlackEvent(
  db: RegionalDb,
  input: {
    connection: SlackEventConnection;
    teamMatches: boolean;
    eventType: string | null;
    now: number;
  },
): Promise<SlackEventOutcome> {
  if (!input.teamMatches) return "team_mismatch";
  if (input.eventType !== "app_uninstalled" && input.eventType !== "tokens_revoked") {
    return "ignored";
  }
  // Already marked (by an earlier event, a refused token or a lost key): nothing to write.
  if (input.connection.attention !== null) return "ignored";
  await markAttention(db, input.connection, "app_uninstalled", { type: "system" }, input.now);
  return "uninstalled";
}
