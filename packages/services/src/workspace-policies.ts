// Workspace policies (premium plan E4, feature `policies`, decision 0015): reading, previewing
// and changing a workspace's policies, and applying a tightened policy to the existing artifacts
// in bounded steps. The rules are in packages/domain/src/workspace-policies.ts. The policy is a
// column of the workspace's global row and comes with the actor (`actorOn`), so the services that
// apply it (access, publish, share links, transfer) read nothing more.
import {
  CLI_CLIENT_ID,
  CLIENT_KINDS,
  DEFAULT_POLICY,
  type PolicyField,
  type PolicyImpact,
  type PolicyPreview,
  type RequestContext,
  type SingleFamilyLists,
  WORKSPACE_POLICIES,
  type WorkspacePolicy,
  WorkspacePolicyExport,
  WorkspacePolicyJobPayload,
  type WorkspacePolicyShown,
} from "@portifact/contracts";
import {
  type Db,
  type GlobalDb,
  isRegion,
  type RegionalDb,
  type Regions,
  schema,
} from "@portifact/db";
import {
  type Actor,
  authorize,
  can,
  changedFields,
  checkPolicyDefaults,
  checkPolicyImpact,
  checkPolicyKeepsCaller,
  checkSingleFamily,
  type Entitlements,
  entitlements,
  fail,
  hasFeature,
  lifetimeCutoff,
  liftedFields,
  normalizePolicy,
  ok,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyOf,
  policyTouchesArtifacts,
  type RequestSubject,
  type Result,
  readerAllowed,
  requireFeature,
  shownPolicy,
  singleFamilyLists,
  storedPolicy,
  withoutRequestPolicies,
} from "@portifact/domain";
import { and, asc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { actorOn } from "./actors.ts";
import { approvalAccessStatements } from "./approval-reviews.ts";
import { auditEvent } from "./audit.ts";
import { cursorFor, saveCursor } from "./maintenance-cursors.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";
import { markWebhookEvents } from "./webhook-activity.ts";
import { missingWorkspace, stillAdmin } from "./workspaces.ts";

const w = schema.workspaces;
const a = schema.artifacts;
const r = schema.artifactReaders;
const l = schema.shareLinks;
const s = schema.shareSessions;

export interface PolicyState {
  /** The network allowlists are `hidden` unless the caller is an admin (decision 0020). */
  policy: WorkspacePolicyShown;
  revision: number;
  /** Whether the plan includes `policies`. */
  enabled: boolean;
  /** Whether the caller may change them. */
  editable: boolean;
  domainVerified: boolean;
  /** The caller's address as this request reached the app, for admins only; never stored. */
  yourIp: string | null;
  /** Active service tokens, for admins only: what a people-only list leaves unbound. */
  serviceTokens: number | null;
  /** When the caller's own sign-in happened, for admins only (decision 0021). */
  yourSignInAt: number | null;
}

interface PolicyRow {
  id: string;
  region: string;
  policy: WorkspacePolicy;
  revision: number;
}

async function policyRow(global: GlobalDb, slug: string): Promise<PolicyRow | null> {
  const [row] = await global
    .select({ id: w.id, region: w.region, policy: w.policy, revision: w.policyRevision })
    .from(w)
    .where(eq(w.slug, slug))
    .limit(1);
  return row ? { ...row, policy: policyOf(row.policy) } : null;
}

/** The workspace a request names and the caller's actor there allowed to do `action`. */
async function scopedPolicy(
  global: GlobalDb,
  userId: string,
  slug: string,
  action: "read" | "policies",
): Promise<Result<{ row: PolicyRow; actor: Actor }>> {
  const row = await policyRow(global, slug);
  if (!row) return missingWorkspace();
  const resolved = await actorOn(global, userId, row.id);
  if (!resolved.ok) return resolved;
  const actor = resolved.value;
  if (!actor) return missingWorkspace();
  const allowed = authorize(actor, action);
  if (!allowed.ok) return allowed;
  return ok({ row, actor });
}

async function domainVerified(global: GlobalDb, workspaceId: string): Promise<boolean> {
  const wd = schema.workspaceDomains;
  const [row] = await global
    .select({ id: wd.id })
    .from(wd)
    .where(and(eq(wd.workspaceId, workspaceId), eq(wd.state, "verified")))
    .limit(1);
  return row !== undefined;
}

async function stateOf(
  global: GlobalDb,
  row: PolicyRow,
  actor: Actor,
  now: number,
): Promise<PolicyState> {
  // Reaching here means the network policy admitted the caller, so an admin sees the networks.
  const admin = can(actor, "policies");
  return {
    policy: shownPolicy(row.policy, admin),
    revision: row.revision,
    enabled: hasFeature(await ownerEntitlements(global, row.id, now), "policies"),
    editable: admin,
    domainVerified: await domainVerified(global, row.id),
    yourIp: admin && global.request.kind === "request" ? global.request.ip : null,
    serviceTokens: admin ? await activeTokens(global, row.id, now) : null,
    yourSignInAt: admin ? ownSignIn(global, actor.userId) : null,
  };
}

/** When the caller's own sign-in happened, from the credential this request recorded. */
function ownSignIn(global: GlobalDb, userId: string): number | null {
  const credential = global.request.kind === "request" ? global.request.credential : null;
  if (!credential || credential.userId !== userId || credential.kind === "service_token") {
    return null;
  }
  return credential.signedInAt;
}

function activeTokensQuery(global: GlobalDb, workspaceId: string, now: number) {
  const t = schema.serviceTokens;
  return global
    .select({ n: sql<number>`count(*)` })
    .from(t)
    .where(and(eq(t.workspaceId, workspaceId), gt(t.expiresAt, now)));
}

async function activeTokens(global: GlobalDb, workspaceId: string, now: number): Promise<number> {
  const [row] = await activeTokensQuery(global, workspaceId, now);
  return Number(row?.n ?? 0);
}

/**
 * A workspace's policies, for any member: they bind everyone, so everyone may know them. Reading
 * is never behind the plan.
 */
export async function getWorkspacePolicy(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<PolicyState>> {
  const found = await scopedPolicy(global, input.userId, input.slug, "read");
  if (!found.ok) return found;
  return ok(await stateOf(global, found.value.row, found.value.actor, input.now));
}

function regionalOf(regions: Regions, row: { id: string; region: string }): RegionalDb {
  if (!isRegion(row.region)) throw new Error(`Workspace ${row.id} is in an unknown region`);
  return regions.get(row.region).db;
}

const live = (now: number) =>
  and(isNull(l.revokedAt), or(isNull(l.expiresAt), gt(l.expiresAt, now))) as SQL;
const present = sql`${a.state} not in ('deleted', 'purging')`;
/**
 * The domain of a stored (lowercase) reader address, as SQL: the domain rule the job, the scan,
 * the preview and transfers match against an allowlist without binding any address.
 */
export const readerDomainSql = sql`substr(${r.email}, instr(${r.email}, '@') + 1)`;
const readerDomain = readerDomainSql;

async function countOf(db: Db, query: SQL): Promise<number> {
  const [row] = await db.all<{ n: number }>(sql`select (${query}) as n`);
  return Number(row?.n ?? 0);
}

/**
 * What saving `next` would change on the workspace's existing artifacts (`PolicyImpact`), from
 * the workspace's region. Only the fields `next` restricts are counted.
 */
export async function policyImpact(
  db: RegionalDb,
  workspaceId: string,
  next: WorkspacePolicy,
  now: number,
): Promise<PolicyImpact> {
  const zero = {
    publicArtifacts: 0,
    readersOutside: 0,
    linksRevoked: 0,
    linksWithoutPassword: 0,
    linksOverLifetime: 0,
  };
  if (!policyTouchesArtifacts(next)) return zero;
  const owned = sql`${a.ownerId} = ${workspaceId} and ${present}`;
  const links = sql`from ${l} join ${a} on ${a.id} = ${l.artifactId} where ${owned} and ${live(now)}`;
  const cutoff = lifetimeCutoff(next, now);
  return {
    publicArtifacts:
      next.publicAccess === "forbidden"
        ? await countOf(
            db,
            sql`select count(*) from ${a} where ${owned} and ${a.accessMode} = 'public'`,
          )
        : 0,
    readersOutside: next.readerDomains
      ? await countOf(
          db,
          sql`select count(*) from ${r} join ${a} on ${a.id} = ${r.artifactId} where ${owned} and ${readerDomain} not in ${next.readerDomains}`,
        )
      : 0,
    linksRevoked:
      next.shareLinks === "disabled" ? await countOf(db, sql`select count(*) ${links}`) : 0,
    linksWithoutPassword:
      next.shareLinks === "password_required"
        ? await countOf(db, sql`select count(*) ${links} and ${l.passwordHash} is null`)
        : 0,
    // Links a stricter rule already stops are not counted twice.
    linksOverLifetime:
      cutoff !== null && next.shareLinks !== "disabled"
        ? await countOf(
            db,
            sql`select count(*) ${links} and ${l.createdAt} <= ${cutoff}${next.shareLinks === "password_required" ? sql` and ${l.passwordHash} is not null` : sql``}`,
          )
        : 0,
  };
}

/**
 * Validates a proposed policy for the workspace: the domains, the networks, the `domain` default
 * and lock-out safety (decision 0020): a people allowlist must admit the request saving it.
 */
async function checkProposal(
  global: GlobalDb,
  workspaceId: string,
  input: WorkspacePolicy,
  subject: RequestSubject,
): Promise<Result<WorkspacePolicy>> {
  const normalized = normalizePolicy(input);
  if (!normalized.ok) return normalized;
  // Lock-out safety: the network, and the saving admin's own sign-in (decision 0021).
  const keeps = checkPolicyKeepsCaller(normalized.value, global.request, subject);
  if (!keeps.ok) return keeps;
  const defaults = checkPolicyDefaults(
    normalized.value,
    normalized.value.defaultAccess === "domain" ? await domainVerified(global, workspaceId) : true,
  );
  if (!defaults.ok) return defaults;
  return normalized;
}

/**
 * Who a network allowlist would bind (decision 0020), as counts: the workspace's members when the
 * people allowlist is set, its active service tokens when the token allowlist is. Portifact keeps
 * nobody's address, so it cannot say who is outside the networks; the admin saving is checked.
 */
async function networkReach(
  global: GlobalDb,
  workspaceId: string,
  current: WorkspacePolicy,
  next: WorkspacePolicy,
  now: number,
): Promise<PolicyPreview["networks"]> {
  if (next.ipAllowlist === null && next.tokenIpAllowlist === null) return null;
  const m = schema.workspaceMembers;
  const [members, tokens] = await global.batch([
    global.select({ n: sql<number>`count(*)` }).from(m).where(eq(m.workspaceId, workspaceId)),
    activeTokensQuery(global, workspaceId, now),
  ]);
  const active = Number(tokens[0]?.n ?? 0);
  return {
    members: next.ipAllowlist === null ? 0 : Number(members[0]?.n ?? 0),
    tokens: next.tokenIpAllowlist === null ? 0 : active,
    // Tokens are bound only by their own list: with only the people list they work from anywhere.
    unboundTokens: next.ipAllowlist !== null && next.tokenIpAllowlist === null ? active : 0,
    singleFamily: singleFamilyLists(current, next),
  };
}

/** What saving a policy would change, for the admins before they save. */
export async function previewWorkspacePolicy(
  regions: Regions,
  input: { userId: string; slug: string; policy: WorkspacePolicy; now: number },
): Promise<Result<PolicyPreview>> {
  const found = await scopedPolicy(regions.global, input.userId, input.slug, "policies");
  if (!found.ok) return found;
  const proposal = await checkProposal(regions.global, found.value.row.id, input.policy, {
    userId: input.userId,
    now: input.now,
  });
  if (!proposal.ok) return proposal;
  const impact = await policyImpact(
    regionalOf(regions, found.value.row),
    found.value.row.id,
    proposal.value,
    input.now,
  );
  return ok({
    ...impact,
    networks: await networkReach(
      regions.global,
      found.value.row.id,
      found.value.row.policy,
      proposal.value,
      input.now,
    ),
    signIns: await signInReach(regions.global, found.value.row.id, proposal.value, input.now),
  });
}

/**
 * Who the sign-in policies would bind (decision 0021), as counts, for the confirmation before a
 * save: every member when either is set; the members who would have to sign in again (no live
 * dashboard session younger than the maximum, or a live CLI or app grant whose sign-in is older
 * or not known); and the members holding a live OAuth grant of a kind of client the policy would
 * refuse.
 * One batch of the global database, on the preview only.
 */
async function signInReach(
  global: GlobalDb,
  workspaceId: string,
  next: WorkspacePolicy,
  now: number,
): Promise<PolicyPreview["signIns"]> {
  if (next.sessionMaxHours === null && next.allowedClients === null) return null;
  const m = schema.workspaceMembers;
  const sess = schema.sessions;
  const refresh = schema.oauthRefreshTokens;
  const access = schema.oauthAccessTokens;
  const at = new Date(now);
  const cutoff = new Date(now - (next.sessionMaxHours ?? 0) * 3_600_000);
  const refused = CLIENT_KINDS.filter((kind) => !next.allowedClients?.includes(kind));
  const refusedClient = (column: SQLiteColumn) =>
    refused.length === 2
      ? sql`1`
      : refused[0] === "cli"
        ? sql`${column} = ${CLI_CLIENT_ID}`
        : sql`${column} <> ${CLI_CLIENT_ID}`;
  const holds = (table: typeof refresh | typeof access) =>
    sql`exists (select 1 from ${table} where ${table.userId} = ${m.userId} and ${table.revoked} is null and ${table.expiresAt} > ${at.getTime()} and ${refusedClient(table.clientId)})`;
  const staleGrant = (table: typeof refresh | typeof access) =>
    sql`exists (select 1 from ${table} where ${table.userId} = ${m.userId} and ${table.revoked} is null and ${table.expiresAt} > ${at.getTime()} and coalesce(${table.authTime}, 0) < ${cutoff.getTime()})`;
  const member = eq(m.workspaceId, workspaceId);
  const [members, stale, clients] = await global.batch([
    global.select({ n: sql<number>`count(*)` }).from(m).where(member),
    global
      .select({ n: sql<number>`count(*)` })
      .from(m)
      .where(
        next.sessionMaxHours === null
          ? sql`0`
          : and(
              member,
              // No live dashboard session younger than the maximum, or a live CLI or app grant
              // whose sign-in is older (0 and null read as not known, so older).
              sql`(not exists (select 1 from ${sess} where ${sess.userId} = ${m.userId} and ${sess.expiresAt} > ${at.getTime()} and ${sess.createdAt} >= ${cutoff.getTime()}) or ${staleGrant(refresh)} or ${staleGrant(access)})`,
            ),
      ),
    global
      .select({ n: sql<number>`count(*)` })
      .from(m)
      .where(
        next.allowedClients === null || refused.length === 0
          ? sql`0`
          : and(member, sql`(${holds(refresh)} or ${holds(access)})`),
      ),
  ]);
  return {
    members: Number(members[0]?.n ?? 0),
    staleMembers: Number(stale[0]?.n ?? 0),
    clientMembers: Number(clients[0]?.n ?? 0),
  };
}

/** The `workspace_policy` job, in the batch that saves a policy, on the same condition. */
export function workspacePolicyJob(
  db: Db,
  input: { workspaceId: string; revision: number; condition: SQL; now: number },
): BatchItem<"sqlite"> {
  const payload = JSON.stringify(WorkspacePolicyJobPayload.parse({ revision: input.revision }));
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created,
  // subject, generation.
  return db
    .insert(schema.outbox)
    .select(
      sql`select null, 'workspace_policy', ${payload}, ${input.now}, null, 0, ${input.now}, ${input.workspaceId}, null where ${input.condition}`,
    );
}

/**
 * Changes a workspace's policies, for an admin, from the revision they read. Setting or
 * tightening needs `policies` in the plan; loosening never does. A save that changes existing
 * artifacts is refused with the counts unless `confirmed` holds them (or more); then the `workspace_policy` job
 * applies it in bounded steps. The global batch records the event, writes the job and updates the
 * row, all conditioned on the caller still being an admin and the revision being the one read.
 */
export async function setWorkspacePolicy(
  regions: Regions,
  input: {
    userId: string;
    slug: string;
    policy: WorkspacePolicy;
    revision: number;
    /** The impact the admin saw in the preview and accepted. */
    confirmed?: PolicyImpact | undefined;
    /** The single-family lists the preview reported and the admin accepted (decision 0020). */
    confirmedSingleFamily?: SingleFamilyLists | undefined;
    now: number;
  },
): Promise<Result<PolicyState>> {
  const global = regions.global;
  const found = await scopedPolicy(global, input.userId, input.slug, "policies");
  if (!found.ok) return found;
  const { row, actor } = found.value;
  if (row.revision !== input.revision) {
    return fail("version_conflict", "The policies changed meanwhile. Reload them and try again.");
  }
  const proposal = await checkProposal(global, row.id, input.policy, {
    userId: input.userId,
    now: input.now,
  });
  if (!proposal.ok) return proposal;
  const next = proposal.value;
  const fields = changedFields(row.policy, next);
  if (fields.length === 0) return ok(await stateOf(global, row, actor, input.now));
  if (policyChangeNeedsPlan(row.policy, next)) {
    const gate = requireFeature(await ownerEntitlements(global, row.id, input.now), "policies");
    if (!gate.ok) return gate;
  }
  // A list covering one address family is never saved without the admin confirming exactly it.
  const families = checkSingleFamily(
    singleFamilyLists(row.policy, next),
    input.confirmedSingleFamily,
  );
  if (!families.ok) return families;
  const impact = await policyImpact(regionalOf(regions, row), row.id, next, input.now);
  const confirmed = checkPolicyImpact(impact, input.confirmed);
  if (!confirmed.ok) return confirmed;

  const condition = sql`${stillAdmin(row.id, input.userId)} and exists (select 1 from ${w} where ${w.id} = ${row.id} and ${w.policyRevision} = ${row.revision})`;
  const stored = storedPolicy(next);
  const results = await global.batch([
    auditEvent(
      global,
      {
        ownerId: row.id,
        kind: "policy.changed",
        actor: { type: "user", id: input.userId },
        targetId: row.id,
        detail: policyChangeDetail(row.policy, next, input.confirmed !== undefined),
        now: input.now,
      },
      condition,
    ),
    // Even with nothing counted: a request that read the old policy may still write, and the job
    // (and the scan after it) brings anything it let through back in line.
    ...(policyTouchesArtifacts(next)
      ? [
          workspacePolicyJob(global, {
            workspaceId: row.id,
            revision: row.revision + 1,
            condition,
            now: input.now,
          }),
        ]
      : []),
    global
      .update(w)
      .set({ policy: stored, policyRevision: row.revision + 1, updatedAt: input.now })
      .where(and(eq(w.id, row.id), eq(w.policyRevision, row.revision), condition))
      .returning({ id: w.id }),
  ]);
  if ((results.at(-1) as unknown[]).length === 0) {
    const again = await scopedPolicy(global, input.userId, input.slug, "policies");
    if (!again.ok) return again;
    return fail("version_conflict", "The policies changed meanwhile. Reload them and try again.");
  }
  return ok(
    await stateOf(global, { ...row, policy: next, revision: row.revision + 1 }, actor, input.now),
  );
}

export interface EnforceCounts {
  artifactsNarrowed: number;
  readersRemoved: number;
  linksRevoked: number;
  sessionsEnded: number;
}

/**
 * The rows one step changes, as statements that select them, never as lists of IDs: D1 allows at
 * most 100 bound parameters per statement, and a list that grows with the batch would pass it.
 * Their parameters:
 * - `publicIds`: the owner and the limit, 2.
 * - `readerRows`: the owner, at most `WORKSPACE_POLICIES.readerDomains` (20) allowlist domains
 *   matched by the domain rule in SQL, and the limit, at most 22; `readerArtifacts` wraps it, 22.
 * - `linkIds`: the owner, now (twice) and the limit, 4.
 * - `sessionIds`: the owner, the lifetime cutoff and the limit, at most 3.
 * The widest statement is the step's `policy.enforced` event, which counts all four selections in
 * its detail and again in its condition: 2 × (2 + 22 + 4 + 3 + 4) = 70, plus its own 8 values, 78.
 * The webhook statements name a selection twice (2 × 22 + 3 = 47); every other statement names
 * one (at most 22 + 6). So no statement binds more than 78 parameters, whatever the batch size.
 */
interface Selections {
  publicIds: SQL | null;
  readerRows: SQL | null;
  readerArtifacts: SQL | null;
  linkIds: SQL | null;
  sessionIds: SQL | null;
}

function selections(
  workspaceId: string,
  policy: WorkspacePolicy,
  now: number,
  limit: number,
): Selections {
  const owned = sql`${a.ownerId} = ${workspaceId} and ${present}`;
  const readerRows = policy.readerDomains
    ? sql`select ${r}.rowid from ${r} join ${a} on ${a.id} = ${r.artifactId} where ${owned} and ${readerDomain} not in ${policy.readerDomains} order by ${r.artifactId}, ${r.email} limit ${limit}`
    : null;
  const cutoff = lifetimeCutoff(policy, now);
  const stopped = [
    ...(policy.shareLinks === "password_required" ? [sql`${l.passwordHash} is null`] : []),
    ...(cutoff === null ? [] : [sql`${l.createdAt} <= ${cutoff}`]),
  ];
  return {
    publicIds:
      policy.publicAccess === "forbidden"
        ? sql`select ${a.id} from ${a} where ${owned} and ${a.accessMode} = 'public' order by ${a.id} limit ${limit}`
        : null,
    readerRows,
    readerArtifacts: readerRows
      ? sql`select distinct ${r.artifactId} from ${r} where ${r}.rowid in (${readerRows})`
      : null,
    linkIds:
      policy.shareLinks === "disabled"
        ? sql`select ${l.id} from ${l} join ${a} on ${a.id} = ${l.artifactId} where ${owned} and ${live(now)} order by ${l.id} limit ${limit}`
        : null,
    sessionIds:
      policy.shareLinks !== "disabled" && stopped.length > 0
        ? sql`select ${s.id} from ${s} join ${l} on ${l.id} = ${s.linkId} join ${a} on ${a.id} = ${l.artifactId} where ${owned} and (${sql.join(stopped, sql` or `)}) order by ${s.id} limit ${limit}`
        : null,
  };
}

const newAuditId = sql`'ae_' || lower(hex(randomblob(12)))`;

/**
 * One bounded step of applying a workspace's current policy to its existing artifacts: at most
 * `limit` rows of each kind. Public artifacts become `workspace`, readers outside the allowlist are
 * removed, active links are revoked while links are disabled, and the link sessions of links the
 * policy stops opening end. Each changed artifact leaves the trail of a manual change: an
 * `access.changed` event by the system that says it was by policy, the `artifact.access_changed`
 * webhook event, the generation moved (sessions end) and approval reviewers who no longer take
 * part dropped. The step's `policy.enforced` event sums it up. Every statement selects the rows it
 * changes itself, so a retried or concurrent step changes nothing twice. `pending` while a kind
 * filled its limit.
 */
export async function enforceWorkspacePolicy(
  db: RegionalDb,
  workspaceId: string,
  now: number,
  limit: number = WORKSPACE_POLICIES.enforceBatch,
): Promise<{ outcome: JobOutcome; counts: EnforceCounts }> {
  const counts = { artifactsNarrowed: 0, readersRemoved: 0, linksRevoked: 0, sessionsEnded: 0 };
  const [row] = await db.global
    .select({ policy: w.policy })
    .from(w)
    .where(eq(w.id, workspaceId))
    .limit(1);
  if (!row) return { outcome: "stale", counts };
  const policy = policyOf(row.policy);
  if (!policyTouchesArtifacts(policy)) return { outcome: "done", counts };
  const set = selections(workspaceId, policy, now, limit);
  const owner = await ownerEntitlements(db.global, workspaceId, now);
  const approvals = await approvalDrops(db, workspaceId, policy, set, owner, now);

  const ae = schema.auditEvents;
  // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail,
  // recorded (the database's clock, decision 0019).
  const statements: BatchItem<"sqlite">[] = [enforceEvent(db, workspaceId, set, now)];
  if (set.publicIds) {
    statements.push(
      db
        .insert(ae)
        .select(
          sql`select ${newAuditId}, ${workspaceId}, ${now}, 'access.changed', 'system', null, ${a.id}, ${a.id}, json_object('mode', 'workspace', 'policy', 'publicAccess'), ${schema.recordedNow} from ${a} where ${a.id} in (${set.publicIds})`,
        ),
      ...markWebhookEvents(db, {
        entitlements: owner,
        ownerId: workspaceId,
        type: "artifact.access_changed",
        artifacts: set.publicIds,
        access: "workspace",
        now,
      }),
    );
  }
  if (set.readerRows && set.readerArtifacts) {
    statements.push(
      db
        .insert(ae)
        .select(
          sql`select ${newAuditId}, ${workspaceId}, ${now}, 'access.changed', 'system', null, ${r.artifactId}, ${r.artifactId}, json_object('readersRemoved', count(*), 'policy', 'readerDomains'), ${schema.recordedNow} from ${r} where ${r}.rowid in (${set.readerRows}) group by ${r.artifactId}`,
        ),
      ...markWebhookEvents(db, {
        entitlements: owner,
        ownerId: workspaceId,
        type: "artifact.access_changed",
        artifacts: set.readerArtifacts,
        now,
      }),
    );
  }
  // Before the changes they follow, on the same rows still breaking the policy.
  statements.push(...approvals);
  const publicIndex = statements.length;
  if (set.publicIds) {
    statements.push(
      db
        .update(a)
        .set({
          accessMode: "workspace",
          policyGeneration: sql`${a.policyGeneration} + 1`,
          updatedAt: now,
        })
        .where(sql`${a.id} in (${set.publicIds})`)
        .returning({ id: a.id }),
    );
  }
  const readerIndex = statements.length;
  if (set.readerRows && set.readerArtifacts) {
    statements.push(
      // A removed reader's sessions end on their next request: the generation moves.
      db
        .update(a)
        .set({ policyGeneration: sql`${a.policyGeneration} + 1`, updatedAt: now })
        .where(sql`${a.id} in (${set.readerArtifacts})`),
      db.delete(r).where(sql`${r}.rowid in (${set.readerRows})`).returning({ id: r.artifactId }),
    );
  }
  const linkIndex = statements.length;
  if (set.linkIds) {
    statements.push(
      db.delete(s).where(sql`${s.linkId} in (${set.linkIds})`).returning({ id: s.id }),
      db
        .update(l)
        .set({ revokedAt: now })
        .where(sql`${l.id} in (${set.linkIds})`)
        .returning({ id: l.id }),
    );
  }
  const sessionIndex = statements.length;
  if (set.sessionIds) {
    statements.push(
      db.delete(s).where(sql`${s.id} in (${set.sessionIds})`).returning({ id: s.id }),
    );
  }
  const results = (await db.batch(
    statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  )) as unknown[];
  const rows = (index: number) => (results[index] as unknown[] | undefined)?.length ?? 0;
  if (set.publicIds) counts.artifactsNarrowed = rows(publicIndex);
  if (set.readerRows) counts.readersRemoved = rows(readerIndex + 1);
  if (set.linkIds) {
    counts.sessionsEnded += rows(linkIndex);
    counts.linksRevoked = rows(linkIndex + 1);
  }
  if (set.sessionIds) counts.sessionsEnded += rows(sessionIndex);
  const pending =
    counts.artifactsNarrowed === limit ||
    counts.readersRemoved === limit ||
    counts.linksRevoked === limit ||
    (set.sessionIds !== null && rows(sessionIndex) === limit);
  return { outcome: pending ? "pending" : "done", counts };
}

/**
 * Approval reviewers who would no longer take part once this step narrows an artifact or removes
 * its readers, dropped in the step's batch as `updateAccess` drops them (decision 0013). One read
 * finds the artifacts the step changes that have an open request (usually none); each of those
 * costs the reads of `approvalAccessStatements` and one of its readers.
 */
async function approvalDrops(
  db: RegionalDb,
  workspaceId: string,
  policy: WorkspacePolicy,
  set: Selections,
  owner: Entitlements,
  now: number,
): Promise<BatchItem<"sqlite">[]> {
  const changed = [
    ...(set.publicIds ? [sql`${a.id} in (${set.publicIds})`] : []),
    ...(set.readerArtifacts ? [sql`${a.id} in (${set.readerArtifacts})`] : []),
  ];
  if (changed.length === 0) return [];
  const rq = schema.reviewRequests;
  const affected = await db
    .select({ id: a.id, ownerId: a.ownerId, accessMode: a.accessMode })
    .from(a)
    .where(
      sql`(${sql.join(changed, sql` or `)}) and exists (select 1 from ${rq} where ${rq.artifactId} = ${a.id} and ${rq.cancelledAt} is null)`,
    );
  const statements: BatchItem<"sqlite">[] = [];
  for (const artifact of affected) {
    const readers = (
      await db.select({ email: r.email }).from(r).where(eq(r.artifactId, artifact.id))
    ).map((one) => one.email);
    const narrowed = policy.publicAccess === "forbidden" && artifact.accessMode === "public";
    const outside = sql`exists (select 1 from ${r} where ${r.artifactId} = ${artifact.id} and ${readerDomain} not in ${policy.readerDomains ?? [""]})`;
    const still = sql`exists (select 1 from ${a} where ${a.id} = ${artifact.id} and ${a.ownerId} = ${workspaceId} and ${a.accessMode} = ${artifact.accessMode})`;
    statements.push(
      ...(await approvalAccessStatements(db, {
        artifact,
        policy: {
          mode: narrowed ? "workspace" : artifact.accessMode,
          readers: readers.filter((email) => readerAllowed(policy, email)),
        },
        owner,
        condition: narrowed ? still : sql`${still} and ${outside}`,
        now,
      })),
    );
  }
  return statements;
}

/**
 * The `policy.enforced` event of one step, first in its batch: its counts are read in its own
 * statement from the selections the step changes, and nothing is recorded when they are all zero.
 */
function enforceEvent(db: RegionalDb, workspaceId: string, set: Selections, now: number) {
  const count = (selection: SQL | null) =>
    selection ? sql`(select count(*) from (${selection}))` : sql`0`;
  const sessions =
    set.linkIds || set.sessionIds
      ? sql`(select count(*) from ${s} where ${sql.join(
          [
            ...(set.linkIds ? [sql`${s.linkId} in (${set.linkIds})`] : []),
            ...(set.sessionIds ? [sql`${s.id} in (${set.sessionIds})`] : []),
          ],
          sql` or `,
        )})`
      : sql`0`;
  const computed = {
    artifactsNarrowed: count(set.publicIds),
    readersRemoved: count(set.readerRows),
    linksRevoked: count(set.linkIds),
    sessionsEnded: sessions,
  };
  return auditEvent(
    db,
    {
      ownerId: workspaceId,
      kind: "policy.enforced",
      actor: { type: "system" },
      targetId: workspaceId,
      detail: { artifactsNarrowed: 0, readersRemoved: 0, linksRevoked: 0, sessionsEnded: 0 },
      computed,
      now,
    },
    sql`${computed.artifactsNarrowed} + ${computed.readersRemoved} + ${computed.linksRevoked} + ${computed.sessionsEnded} > 0`,
  );
}

/** Runs a `workspace_policy` job: one bounded step, `pending` until nothing is left. */
export async function runWorkspacePolicyJob(
  db: RegionalDb,
  row: { subject: string | null; payload: unknown },
  now: number,
): Promise<JobOutcome> {
  WorkspacePolicyJobPayload.parse(row.payload);
  return (await enforceWorkspacePolicy(db, row.subject ?? "", now)).outcome;
}

const SCAN = "workspace_policies";

/** A workspace's restricting flags, as the scan's query reads them from one JSON parameter. */
function scanEntry(id: string, policy: WorkspacePolicy) {
  return {
    id,
    p: policy.publicAccess === "forbidden" ? 1 : 0,
    d: policy.readerDomains,
    l: policy.shareLinks,
    m: policy.shareLinkMaxDays,
  };
}

/**
 * Maintenance safety net (decision 0015, "Races"): finds the workspaces whose artifacts break their
 * policy and runs one step for each. Per run and region:
 * - one global query reads the workspaces with a policy, at most `scanWorkspaces` (500) from a
 *   cursor in `maintenance_cursors` (with more, the next run continues after the last one read);
 * - one regional query, with the restricting flags of all of them as a single JSON parameter,
 *   returns the workspaces with a violation, public artifacts where public is forbidden first, at
 *   most `scanSteps` (20);
 * - one step for each of those (bounded as `enforceWorkspacePolicy` says).
 * A clean state costs the cursor read, the two queries and the cursor write. A violation among
 * the first 500 workspaces with a policy is found and corrected within one run; past 20 at once,
 * the rest are found on the next runs, worst first. A workspace whose step fails is logged and
 * counted, and never stops the others or the maintenance steps after the scan.
 */
export async function enforceWorkspacePolicies(
  db: RegionalDb,
  now: number,
): Promise<{ checked: number; corrected: number; failed: number }> {
  let failed = 0;
  let checked = 0;
  let corrected = 0;
  try {
    const cursor = await cursorFor(db.global, SCAN);
    const rows = await db.global
      .select({ id: w.id, policy: w.policy })
      .from(w)
      .where(and(sql`${w.policy} is not null`, gt(w.id, cursor)))
      .orderBy(asc(w.id))
      .limit(WORKSPACE_POLICIES.scanWorkspaces);
    checked = rows.length;
    const entries = rows.flatMap((one) => {
      try {
        const policy = policyOf(one.policy);
        return policyTouchesArtifacts(policy) ? [scanEntry(one.id, policy)] : [];
      } catch {
        failed += 1;
        console.error(JSON.stringify({ event: "workspace_policy_unreadable" }));
        return [];
      }
    });
    const found = entries.length === 0 ? [] : await violations(db, entries, now);
    for (const id of found) {
      try {
        await enforceWorkspacePolicy(db, id, now);
        corrected += 1;
      } catch (error) {
        failed += 1;
        console.error(
          JSON.stringify({
            event: "workspace_policy_enforce_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    await saveCursor(
      db.global,
      SCAN,
      rows.length < WORKSPACE_POLICIES.scanWorkspaces ? "" : (rows.at(-1)?.id ?? ""),
      now,
    );
  } catch (error) {
    failed += 1;
    console.error(
      JSON.stringify({
        event: "workspace_policy_scan_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
  return { checked, corrected, failed };
}

/**
 * The workspaces among `entries` that have an artifact breaking their policy, in one regional
 * query. The flags travel as one JSON parameter; with `now` and the cutoffs it binds 4 parameters
 * whatever the number of workspaces.
 */
async function violations(
  db: RegionalDb,
  entries: ReturnType<typeof scanEntry>[],
  now: number,
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    with p as (
      select json_extract(value, '$.id') as id, json_extract(value, '$.p') as forbid,
        json_extract(value, '$.d') as domains, json_extract(value, '$.l') as links,
        json_extract(value, '$.m') as days
      from json_each(${JSON.stringify(entries)})
    ),
    found as (
      select p.id, 0 as rank from p where p.forbid = 1 and exists (select 1 from ${a} where ${a.ownerId} = p.id and ${present} and ${a.accessMode} = 'public')
      union all
      select p.id, 1 from p where p.domains is not null and exists (select 1 from ${r} join ${a} on ${a.id} = ${r.artifactId} where ${a.ownerId} = p.id and ${present} and ${readerDomain} not in (select value from json_each(p.domains)))
      union all
      select p.id, 2 from p where p.links = 'disabled' and exists (select 1 from ${l} join ${a} on ${a.id} = ${l.artifactId} where ${a.ownerId} = p.id and ${present} and ${live(now)})
      union all
      select p.id, 3 from p where p.links <> 'disabled' and (p.links = 'password_required' or p.days is not null) and exists (select 1 from ${s} join ${l} on ${l.id} = ${s.linkId} join ${a} on ${a.id} = ${l.artifactId} where ${a.ownerId} = p.id and ((p.links = 'password_required' and ${l.passwordHash} is null) or (p.days is not null and ${l.createdAt} <= ${now} - p.days * 86400000)))
    )
    select id from found group by id order by min(rank), id limit ${WORKSPACE_POLICIES.scanSteps}
  `);
  return rows.map((one) => one.id);
}

/**
 * The owner's entitlements and, for a workspace, its policies, in one round trip: the share link
 * entry checks both for every visitor.
 */
export async function ownerEntitlementsAndPolicy(
  global: GlobalDb,
  ownerId: string,
  now: number,
): Promise<{ owner: Entitlements; policy: WorkspacePolicy | undefined }> {
  const p = schema.ownerPlans;
  const [plans, policies] = await global.batch([
    global
      .select({ plan: p.plan, seats: p.seats, validUntil: p.validUntil, overrides: p.overrides })
      .from(p)
      .where(eq(p.ownerId, ownerId))
      .limit(1),
    global.select({ policy: w.policy }).from(w).where(eq(w.id, ownerId)).limit(1),
  ]);
  const policy = policies[0];
  return {
    owner: entitlements(plans[0] ?? null, now),
    policy: policy ? policyOf(policy.policy) : undefined,
  };
}

/** Every workspace's policies that are not the defaults, for `export-policies` before a restore. */
export async function exportWorkspacePolicies(global: GlobalDb): Promise<WorkspacePolicyExport[]> {
  const rows = await global
    .select({ workspaceId: w.id, policy: w.policy })
    .from(w)
    .where(sql`${w.policy} is not null`)
    .orderBy(asc(w.id));
  return rows.map((row) =>
    WorkspacePolicyExport.parse({ workspaceId: row.workspaceId, policy: policyOf(row.policy) }),
  );
}

export type ApplyPoliciesResult =
  | {
      ok: true;
      /** Policies set again. */
      applied: number;
      /** Already as exported, or the workspace is gone. */
      skipped: number;
      /** Workspaces with a policy the file does not list: the operator decides whether to lift it. */
      extra: string[];
      /**
       * Workspaces left as they are because the file would lift a restriction they have now (an
       * export older than it), with the fields; applied only with `allowLifting`.
       */
      lifting: { workspaceId: string; fields: PolicyField[] }[];
    }
  /** An item that is not a valid policy (its index in the file): nothing was applied. */
  | { ok: false; index: number; message: string };

/**
 * Sets the exported policies again after a D1 Time Travel restore, which rewinds them with the
 * workspace rows and could lift one an admin set after the restore point. Every item is
 * validated and normalized first, as a save would (`normalizePolicy`): one invalid item refuses
 * the whole file and nothing is applied, so a hand-edited or corrupted export can never store a
 * range enforcement cannot read. Each change records `policy.changed` with the operator as actor
 * and writes the `workspace_policy` job, in one global batch conditioned on the revision read. It
 * never lifts a restriction the workspace has now (`liftedFields`) unless `allowLifting` says
 * so: those workspaces are reported and left as they are. A workspace with a policy the file
 * does not list is reported. Running it again changes nothing.
 */
export async function applyWorkspacePolicies(
  global: GlobalDb,
  input: readonly WorkspacePolicyExport[],
  now: number,
  options: { allowLifting?: boolean } = {},
): Promise<ApplyPoliciesResult> {
  const items: WorkspacePolicyExport[] = [];
  for (const [index, item] of input.entries()) {
    const normalized = normalizePolicy(item.policy);
    if (!normalized.ok) return { ok: false, index, message: normalized.message };
    items.push({ ...item, policy: normalized.value });
  }
  let applied = 0;
  let skipped = 0;
  const lifting: { workspaceId: string; fields: PolicyField[] }[] = [];
  for (const item of items) {
    const [row] = await global
      .select({ policy: w.policy, revision: w.policyRevision })
      .from(w)
      .where(eq(w.id, item.workspaceId))
      .limit(1);
    const current = row ? policyOf(row.policy) : null;
    if (!row || !current || changedFields(current, item.policy).length === 0) {
      skipped += 1;
      continue;
    }
    const lifted = liftedFields(current, item.policy);
    if (lifted.length > 0 && !options.allowLifting) {
      lifting.push({ workspaceId: item.workspaceId, fields: lifted });
      continue;
    }
    const condition = sql`exists (select 1 from ${w} where ${w.id} = ${item.workspaceId} and ${w.policyRevision} = ${row.revision})`;
    const results = await global.batch([
      auditEvent(
        global,
        {
          ownerId: item.workspaceId,
          kind: "policy.changed",
          actor: { type: "operator" },
          targetId: item.workspaceId,
          detail: policyChangeDetail(current, item.policy, true),
          now,
        },
        condition,
      ),
      ...(policyTouchesArtifacts(item.policy)
        ? [
            workspacePolicyJob(global, {
              workspaceId: item.workspaceId,
              revision: row.revision + 1,
              condition,
              now,
            }),
          ]
        : []),
      global
        .update(w)
        .set({
          policy: storedPolicy(item.policy),
          policyRevision: row.revision + 1,
          updatedAt: now,
        })
        .where(and(eq(w.id, item.workspaceId), eq(w.policyRevision, row.revision)))
        .returning({ id: w.id }),
    ]);
    if ((results.at(-1) as unknown[]).length > 0) applied += 1;
    else skipped += 1;
  }
  const listed = new Set(items.map((item) => item.workspaceId));
  const extra = (await exportWorkspacePolicies(global))
    .map((item) => item.workspaceId)
    .filter((id) => !listed.has(id));
  return { ok: true, applied, skipped, extra, lifting };
}

export type ClearRequestPoliciesResult =
  | { outcome: "cleared"; fields: string[] }
  | { outcome: "unchanged" }
  | { outcome: "missing" }
  /** The policy kept changing under it (`CLEAR_ATTEMPTS` times): run the command again. */
  | { outcome: "conflict" };

/** How many times the escape hatch tries again when a concurrent save moved the revision. */
export const CLEAR_ATTEMPTS = 3;

/**
 * The operator's escape hatch (decision 0020, docs/operations.md): lifts exactly the request
 * policies (both network allowlists) of a workspace whose admins locked themselves out, keeping
 * every other policy. Recorded as a `policy.changed` event by the operator, in the batch that
 * changes the row, conditioned on the revision read. Never behind the plan: it only loosens.
 */
export async function clearRequestPolicies(
  global: GlobalDb,
  workspaceId: string,
  now: number,
  attempt = 1,
): Promise<ClearRequestPoliciesResult> {
  const [row] = await global
    .select({ policy: w.policy, revision: w.policyRevision })
    .from(w)
    .where(eq(w.id, workspaceId))
    .limit(1);
  if (!row) return { outcome: "missing" };
  const current = policyOf(row.policy);
  const next = withoutRequestPolicies(current);
  const fields = changedFields(current, next);
  if (fields.length === 0) return { outcome: "unchanged" };
  const condition = sql`exists (select 1 from ${w} where ${w.id} = ${workspaceId} and ${w.policyRevision} = ${row.revision})`;
  const stored = storedPolicy(next);
  const results = await global.batch([
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "policy.changed",
        actor: { type: "operator" },
        targetId: workspaceId,
        detail: policyChangeDetail(current, next, false),
        now,
      },
      condition,
    ),
    global
      .update(w)
      .set({ policy: stored, policyRevision: row.revision + 1, updatedAt: now })
      .where(and(eq(w.id, workspaceId), eq(w.policyRevision, row.revision)))
      .returning({ id: w.id }),
  ]);
  // A concurrent save moved the revision: try again on what it wrote, a bounded number of times.
  if ((results.at(-1) as unknown[]).length === 0) {
    if (attempt >= CLEAR_ATTEMPTS) return { outcome: "conflict" };
    return clearRequestPolicies(global, workspaceId, now, attempt + 1);
  }
  return { outcome: "cleared", fields };
}
