// Workspace policies (premium plan E4, feature `policies`, decision 0015): reading, previewing
// and changing a workspace's policies, and applying a tightened policy to the existing artifacts
// in bounded steps. The rules are in packages/domain/src/workspace-policies.ts. The policy is a
// column of the workspace's global row and comes with the actor (`actorOn`), so the services that
// apply it (access, publish, share links, transfer) read nothing more.
import {
  DEFAULT_POLICY,
  type PolicyImpact,
  WORKSPACE_POLICIES,
  type WorkspacePolicy,
  WorkspacePolicyExport,
  WorkspacePolicyJobPayload,
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
  type Entitlements,
  entitlements,
  fail,
  hasFeature,
  lifetimeCutoff,
  normalizePolicy,
  ok,
  policyChangeDetail,
  policyChangeNeedsPlan,
  policyOf,
  policyTouchesArtifacts,
  type Result,
  readerAllowed,
  requireFeature,
} from "@portifact/domain";
import { and, asc, eq, gt, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { actorOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { cursorFor, saveCursor } from "./maintenance-cursors.ts";
import type { JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";
import { markWebhookEvent } from "./webhook-activity.ts";
import { missingWorkspace, stillAdmin } from "./workspaces.ts";

const w = schema.workspaces;
const a = schema.artifacts;
const r = schema.artifactReaders;
const l = schema.shareLinks;
const s = schema.shareSessions;

export interface PolicyState {
  policy: WorkspacePolicy;
  revision: number;
  /** Whether the plan includes `policies`. */
  enabled: boolean;
  /** Whether the caller may change them. */
  editable: boolean;
  domainVerified: boolean;
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
  const actor = await actorOn(global, userId, row.id);
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
  return {
    policy: row.policy,
    revision: row.revision,
    enabled: hasFeature(await ownerEntitlements(global, row.id, now), "policies"),
    editable: can(actor, "policies"),
    domainVerified: await domainVerified(global, row.id),
  };
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
/** The domain of a stored (lowercase) reader address, as SQL. */
const readerDomain = sql`substr(${r.email}, instr(${r.email}, '@') + 1)`;

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

/** Validates a proposed policy for the workspace: the domains and the `domain` default. */
async function checkProposal(
  global: GlobalDb,
  workspaceId: string,
  input: WorkspacePolicy,
): Promise<Result<WorkspacePolicy>> {
  const normalized = normalizePolicy(input);
  if (!normalized.ok) return normalized;
  const defaults = checkPolicyDefaults(
    normalized.value,
    normalized.value.defaultAccess === "domain" ? await domainVerified(global, workspaceId) : true,
  );
  if (!defaults.ok) return defaults;
  return normalized;
}

/** What saving a policy would change, for the admins before they save. */
export async function previewWorkspacePolicy(
  regions: Regions,
  input: { userId: string; slug: string; policy: WorkspacePolicy; now: number },
): Promise<Result<PolicyImpact>> {
  const found = await scopedPolicy(regions.global, input.userId, input.slug, "policies");
  if (!found.ok) return found;
  const proposal = await checkProposal(regions.global, found.value.row.id, input.policy);
  if (!proposal.ok) return proposal;
  return ok(
    await policyImpact(
      regionalOf(regions, found.value.row),
      found.value.row.id,
      proposal.value,
      input.now,
    ),
  );
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
 * artifacts is refused with the counts unless `confirm` is set; then the `workspace_policy` job
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
    confirm?: boolean | undefined;
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
  const proposal = await checkProposal(global, row.id, input.policy);
  if (!proposal.ok) return proposal;
  const next = proposal.value;
  const fields = changedFields(row.policy, next);
  if (fields.length === 0) return ok(await stateOf(global, row, actor, input.now));
  if (policyChangeNeedsPlan(row.policy, next)) {
    const gate = requireFeature(await ownerEntitlements(global, row.id, input.now), "policies");
    if (!gate.ok) return gate;
  }
  const impact = await policyImpact(regionalOf(regions, row), row.id, next, input.now);
  const confirmed = checkPolicyImpact(impact, input.confirm === true);
  if (!confirmed.ok) return confirmed;

  const condition = sql`${stillAdmin(row.id, input.userId)} and exists (select 1 from ${w} where ${w.id} = ${row.id} and ${w.policyRevision} = ${row.revision})`;
  const stored = changedFields(DEFAULT_POLICY, next).length === 0 ? null : next;
  const results = await global.batch([
    auditEvent(
      global,
      {
        ownerId: row.id,
        kind: "policy.changed",
        actor: { type: "user", id: input.userId },
        targetId: row.id,
        detail: policyChangeDetail(row.policy, next, input.confirm === true),
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
 * One bounded step of applying a workspace's current policy to its existing artifacts: at most
 * `limit` public artifacts become `workspace`, readers outside the allowlist are removed, active
 * links are revoked while links are disabled, and the link sessions of links the policy stops
 * opening end. Each statement is conditioned on the row still breaking the policy, so a retried
 * or concurrent step changes nothing twice. `pending` while a kind filled its limit.
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
  const owned = sql`${a.ownerId} = ${workspaceId} and ${present}`;

  const publicIds =
    policy.publicAccess === "forbidden"
      ? (
          await db
            .select({ id: a.id })
            .from(a)
            .where(sql`${owned} and ${a.accessMode} = 'public'`)
            .orderBy(asc(a.id))
            .limit(limit)
        ).map((one) => one.id)
      : [];
  const readers = policy.readerDomains
    ? (
        await db
          .select({ artifactId: r.artifactId, email: r.email })
          .from(r)
          .innerJoin(a, eq(a.id, r.artifactId))
          .where(sql`${owned} and ${readerDomain} not in ${policy.readerDomains}`)
          .orderBy(asc(r.artifactId), asc(r.email))
          .limit(limit)
      ).filter((one) => !readerAllowed(policy, one.email))
    : [];
  const linkIds =
    policy.shareLinks === "disabled"
      ? (
          await db
            .select({ id: l.id })
            .from(l)
            .innerJoin(a, eq(a.id, l.artifactId))
            .where(sql`${owned} and ${live(now)}`)
            .orderBy(asc(l.id))
            .limit(limit)
        ).map((one) => one.id)
      : [];
  const cutoff = lifetimeCutoff(policy, now);
  const stopped = [
    ...(policy.shareLinks === "password_required" ? [sql`${l.passwordHash} is null`] : []),
    ...(cutoff === null ? [] : [lte(l.createdAt, cutoff)]),
  ];
  const sessionIds =
    policy.shareLinks !== "disabled" && stopped.length > 0
      ? (
          await db
            .select({ id: s.id })
            .from(s)
            .innerJoin(l, eq(l.id, s.linkId))
            .innerJoin(a, eq(a.id, l.artifactId))
            .where(and(sql`${owned}`, or(...stopped)))
            .orderBy(asc(s.id))
            .limit(limit)
        ).map((one) => one.id)
      : [];
  const pending =
    publicIds.length === limit ||
    readers.length === limit ||
    linkIds.length === limit ||
    sessionIds.length === limit;
  if (publicIds.length + readers.length + linkIds.length + sessionIds.length === 0 && !pending) {
    return { outcome: "done", counts };
  }

  const owner = await ownerEntitlements(db.global, workspaceId, now);
  const stillPublic = (id: string) =>
    sql`exists (select 1 from ${a} where ${a.id} = ${id} and ${a.ownerId} = ${workspaceId} and ${a.accessMode} = 'public')`;
  const readerArtifacts = [...new Set(readers.map((one) => one.artifactId))];
  const readerMatch = (one: { artifactId: string; email: string }) =>
    and(eq(r.artifactId, one.artifactId), eq(r.email, one.email)) as SQL;
  const statements: BatchItem<"sqlite">[] = [
    enforceEvent(db, { workspaceId, publicIds, readers, linkIds, sessionIds, now }),
    ...publicIds.flatMap((id) =>
      markWebhookEvent(db, {
        entitlements: owner,
        ownerId: workspaceId,
        artifactId: id,
        type: "artifact.access_changed",
        actorId: null,
        access: "workspace",
        now,
        condition: stillPublic(id),
      }),
    ),
    ...publicIds.map((id) =>
      db
        .update(a)
        .set({
          accessMode: "workspace",
          policyGeneration: sql`${a.policyGeneration} + 1`,
          updatedAt: now,
        })
        .where(and(eq(a.id, id), eq(a.ownerId, workspaceId), eq(a.accessMode, "public"))),
    ),
    // A removed reader's sessions end on their next request: the generation moves.
    ...readerArtifacts.map((id) =>
      db
        .update(a)
        .set({ policyGeneration: sql`${a.policyGeneration} + 1`, updatedAt: now })
        .where(
          and(
            eq(a.id, id),
            eq(a.ownerId, workspaceId),
            or(
              ...readers
                .filter((one) => one.artifactId === id)
                .map((one) => sql`exists (select 1 from ${r} where ${readerMatch(one)})`),
            ),
          ),
        ),
    ),
    ...readers.map((one) => db.delete(r).where(readerMatch(one))),
    ...(linkIds.length > 0
      ? [
          db.delete(s).where(inArray(s.linkId, linkIds)),
          db
            .update(l)
            .set({ revokedAt: now })
            .where(and(inArray(l.id, linkIds), isNull(l.revokedAt))),
        ]
      : []),
    ...(sessionIds.length > 0 ? [db.delete(s).where(inArray(s.id, sessionIds))] : []),
  ];
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  counts.artifactsNarrowed = publicIds.length;
  counts.readersRemoved = readers.length;
  counts.linksRevoked = linkIds.length;
  counts.sessionsEnded = sessionIds.length;
  return { outcome: pending ? "pending" : "done", counts };
}

/**
 * The `policy.enforced` event of one step, first in its batch: the counts are what the step will
 * still change (read in the same statement), and nothing is recorded when that is nothing.
 */
function enforceEvent(
  db: RegionalDb,
  input: {
    workspaceId: string;
    publicIds: string[];
    readers: { artifactId: string; email: string }[];
    linkIds: string[];
    sessionIds: string[];
    now: number;
  },
): BatchItem<"sqlite"> {
  const none = sql`0`;
  const artifactsNarrowed =
    input.publicIds.length > 0
      ? sql`(select count(*) from ${a} where ${inArray(a.id, input.publicIds)} and ${a.ownerId} = ${input.workspaceId} and ${a.accessMode} = 'public')`
      : none;
  const readersRemoved =
    input.readers.length > 0
      ? sql`(select count(*) from ${r} where ${or(...input.readers.map((one) => and(eq(r.artifactId, one.artifactId), eq(r.email, one.email))))})`
      : none;
  const linksRevoked =
    input.linkIds.length > 0
      ? sql`(select count(*) from ${l} where ${inArray(l.id, input.linkIds)} and ${l.revokedAt} is null)`
      : none;
  const sessionsEnded =
    input.sessionIds.length + input.linkIds.length > 0
      ? sql`(select count(*) from ${s} where ${or(
          ...(input.sessionIds.length > 0 ? [inArray(s.id, input.sessionIds)] : []),
          ...(input.linkIds.length > 0 ? [inArray(s.linkId, input.linkIds)] : []),
        )})`
      : none;
  return auditEvent(
    db,
    {
      ownerId: input.workspaceId,
      kind: "policy.enforced",
      actor: { type: "system" },
      targetId: input.workspaceId,
      detail: { artifactsNarrowed: 0, readersRemoved: 0, linksRevoked: 0, sessionsEnded: 0 },
      computed: { artifactsNarrowed, readersRemoved, linksRevoked, sessionsEnded },
      now: input.now,
    },
    sql`(${artifactsNarrowed}) + (${readersRemoved}) + (${linksRevoked}) + (${sessionsEnded}) > 0`,
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

/**
 * Maintenance safety net: one step for each of the next workspaces with a policy, resuming from
 * the scan's cursor. A request that read a policy before it tightened, and wrote after its job
 * ran, is brought back in line here.
 */
export async function enforceWorkspacePolicies(
  db: RegionalDb,
  now: number,
  workspaces: number = WORKSPACE_POLICIES.scanWorkspaces,
): Promise<{ checked: number }> {
  const cursor = await cursorFor(db.global, SCAN);
  const rows = await db.global
    .select({ id: w.id })
    .from(w)
    .where(and(sql`${w.policy} is not null`, gt(w.id, cursor)))
    .orderBy(asc(w.id))
    .limit(workspaces);
  for (const one of rows) await enforceWorkspacePolicy(db, one.id, now);
  await saveCursor(db.global, SCAN, rows.length < workspaces ? "" : (rows.at(-1)?.id ?? ""), now);
  return { checked: rows.length };
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

export interface ApplyPoliciesResult {
  /** Policies set again. */
  applied: number;
  /** Already as exported, or the workspace is gone. */
  skipped: number;
  /** Workspaces with a policy the file does not list: the operator decides whether to lift it. */
  extra: string[];
}

/**
 * Sets the exported policies again after a D1 Time Travel restore, which rewinds them with the
 * workspace rows and could lift one an admin set after the restore point. Each change records
 * `policy.changed` with the operator as actor and writes the `workspace_policy` job, in one global
 * batch conditioned on the revision read. It never lifts a policy: a workspace with one the file
 * does not list is reported. Running it again changes nothing.
 */
export async function applyWorkspacePolicies(
  global: GlobalDb,
  items: readonly WorkspacePolicyExport[],
  now: number,
): Promise<ApplyPoliciesResult> {
  let applied = 0;
  let skipped = 0;
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
        .set({ policy: item.policy, policyRevision: row.revision + 1, updatedAt: now })
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
  return { applied, skipped, extra };
}
