// GitHub Actions OIDC federation (premium plan T5, second delivery, decision 0024). Admins trust a
// GitHub repository by its numeric IDs from the dashboard session only; a run from it exchanges a
// verified ID token for a short-lived service token restricted to the repository's key namespace.
// The app verifies the token's signature and times (apps/app/src/auth/github-oidc.ts); this module
// applies the rule and writes the rows. Rules and credentials are global (decision 0005).
import {
  GITHUB_OIDC_ISSUER,
  GITHUB_TRUST,
  GITHUB_TRUST_EVENTS,
  GITHUB_TRUST_SCOPES,
  type GitHubTrustEvent,
  type GitHubTrustRuleCreate,
  type GitHubTrustRuleUpdate,
  type GitHubTrustRuleView,
  type GitHubTrustScope,
  githubKeyPrefix,
} from "@portifact/contracts";
import { type GlobalDb, schema } from "@portifact/db";
import {
  checkGitHubTrustRule,
  entitlements,
  fail,
  type GitHubClaims,
  type GitHubRefusal,
  githubClaimsVerdict,
  githubCredentialLabel,
  githubSetText,
  hasFeature,
  newAuditEventId,
  ok,
  type Result,
  requireFeature,
  storedGitHubEvents,
  storedGitHubScopes,
} from "@portifact/domain";
import { and, asc, eq, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import { auditEvent } from "./audit.ts";
import { hashSecret } from "./read-access.ts";
import { newServiceTokenSecret } from "./service-tokens.ts";
import { scoped, stillAdmin } from "./workspaces.ts";

const r = schema.githubTrustRules;
const st = schema.serviceTokens;
const FEATURE = "serviceTokens" as const;

const missingRule = () => fail<never>("not_found", "GitHub trust rule not found.");

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type RuleRow = typeof r.$inferSelect;

function view(row: RuleRow, creator: string | null, liveCredentials: number): GitHubTrustRuleView {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: row.id,
    repository: row.repository,
    repositoryId: row.repositoryId,
    repositoryOwnerId: row.repositoryOwnerId,
    events: storedGitHubEvents(row.events),
    ref: row.ref,
    environment: row.environment,
    scopes: storedGitHubScopes(row.scopes),
    keyPrefix: githubKeyPrefix(row.repositoryId),
    liveCredentials,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    createdBy: creator === null ? null : { name: creator },
    revision: row.revision,
  };
}

const liveCount = (now: number) =>
  sql<number>`(select count(*) from ${st} where ${st.trustRuleId} = ${r.id} and ${st.expiresAt} > ${now})`;

async function rulesOf(global: GlobalDb, workspaceId: string, now: number, ruleId?: string) {
  const rows = await global
    .select({ rule: r, creator: schema.users.name, live: liveCount(now) })
    .from(r)
    .leftJoin(schema.users, eq(schema.users.id, r.createdBy))
    .where(
      ruleId
        ? and(eq(r.workspaceId, workspaceId), eq(r.id, ruleId))
        : eq(r.workspaceId, workspaceId),
    )
    .orderBy(asc(r.createdAt), asc(r.id));
  return rows.map((row) => view(row.rule, row.creator, Number(row.live)));
}

async function planOf(global: GlobalDb, ownerId: string, now: number) {
  const p = schema.ownerPlans;
  const [row] = await global
    .select({
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
      grace: p.grace,
    })
    .from(p)
    .where(eq(p.ownerId, ownerId))
    .limit(1);
  return entitlements(row ?? null, now);
}

export interface GitHubTrustListing {
  items: GitHubTrustRuleView[];
  available: boolean;
  limit: number;
}

/** The workspace's rules, for its admins. Listing needs no plan and works while switched off. */
export async function listGitHubTrustRules(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<GitHubTrustListing>> {
  const scope = await scoped(global, input.userId, input.slug, "federation");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  return ok({
    items: await rulesOf(global, workspaceId, input.now),
    available: hasFeature(await planOf(global, workspaceId, input.now), FEATURE),
    limit: GITHUB_TRUST.perWorkspace,
  });
}

function detailOf(input: {
  repositoryId: string;
  repository: string;
  events: readonly GitHubTrustEvent[];
  scopes: readonly GitHubTrustScope[];
  ref: string | null;
  environment: string | null;
}) {
  return {
    repositoryId: input.repositoryId,
    repository: input.repository,
    events: storedGitHubEvents(githubSetText(GITHUB_TRUST_EVENTS, input.events)),
    scopes: storedGitHubScopes(githubSetText(GITHUB_TRUST_SCOPES, input.scopes)),
    ref: input.ref !== null,
    environment: input.environment !== null,
  };
}

const duplicateRule = () =>
  fail<never>("invalid_input", "This workspace already trusts that repository. Change its rule.");

/**
 * Trusts a repository, for an admin of a workspace whose plan includes service tokens. The insert
 * is conditioned on the caller still being an admin, the cap and the repository not being trusted
 * yet, so concurrent creates cannot pass either.
 */
export async function createGitHubTrustRule(
  global: GlobalDb,
  input: { userId: string; slug: string; body: GitHubTrustRuleCreate; now: number },
): Promise<Result<GitHubTrustRuleView>> {
  const scope = await scoped(global, input.userId, input.slug, "federation");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const gate = requireFeature(await planOf(global, workspaceId, input.now), FEATURE);
  if (!gate.ok) return gate;
  const checked = checkGitHubTrustRule(input.body);
  if (!checked.ok) return checked;
  const body = input.body;
  const id = newId("gtr_");
  const events = githubSetText(GITHUB_TRUST_EVENTS, body.events);
  const scopes = githubSetText(GITHUB_TRUST_SCOPES, body.scopes);
  const count = sql`(select count(*) from ${r} where ${r.workspaceId} = ${workspaceId})`;
  const taken = sql`exists (select 1 from ${r} where ${r.workspaceId} = ${workspaceId} and ${r.repositoryId} = ${body.repositoryId})`;
  const [inserted] = await global.batch([
    // Every column in schema order (AGENTS.md, insert ... select).
    global
      .insert(r)
      .select(
        sql`select ${id}, ${workspaceId}, ${body.repositoryId}, ${body.repositoryOwnerId}, ${body.repository}, ${events}, ${body.ref}, ${body.environment}, ${scopes}, ${input.userId}, ${input.now}, ${input.now}, 0 where ${stillAdmin(workspaceId, input.userId)} and ${count} < ${GITHUB_TRUST.perWorkspace} and not ${taken}`,
      )
      .returning(),
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "github_trust.created",
        actor: { type: "user", id: input.userId },
        targetId: id,
        detail: detailOf(body),
        now: input.now,
      },
      sql`exists (select 1 from ${r} where ${r.id} = ${id})`,
    ),
  ]);
  if (!inserted[0]) {
    const again = await scoped(global, input.userId, input.slug, "federation");
    if (!again.ok) return again;
    const [existing] = await global
      .select({ id: r.id })
      .from(r)
      .where(and(eq(r.workspaceId, workspaceId), eq(r.repositoryId, body.repositoryId)))
      .limit(1);
    if (existing) return duplicateRule();
    return fail(
      "quota_exceeded",
      `A workspace can trust at most ${GITHUB_TRUST.perWorkspace} GitHub repositories. Remove one first.`,
    );
  }
  const [created] = await rulesOf(global, workspaceId, input.now, id);
  return created ? ok(created) : missingRule();
}

function sameRule(row: RuleRow, body: GitHubTrustRuleUpdate): boolean {
  return (
    row.repository === body.repository &&
    row.repositoryId === body.repositoryId &&
    row.repositoryOwnerId === body.repositoryOwnerId &&
    row.events === githubSetText(GITHUB_TRUST_EVENTS, body.events) &&
    row.scopes === githubSetText(GITHUB_TRUST_SCOPES, body.scopes) &&
    row.ref === body.ref &&
    row.environment === body.environment
  );
}

/**
 * Changes a rule read at `revision`, gated on the plan. A change saves a new rule with a new ID
 * and removes the old one with the `github_trust_rule` tombstone a removal writes, in one batch
 * (decision 0024, "Review of the first version"): a D1 restore to before the change then brings
 * back a rule that `applyTombstones` removes, never the wider rule silently, and the old rule's
 * credentials end by the cascade. The batch is claimed by its audit event, whose ID is this
 * request's own and which is written only while the rule is the one read. A change that changes
 * nothing writes nothing.
 */
export async function updateGitHubTrustRule(
  global: GlobalDb,
  input: {
    userId: string;
    slug: string;
    ruleId: string;
    body: GitHubTrustRuleUpdate;
    now: number;
  },
): Promise<Result<GitHubTrustRuleView>> {
  const scope = await scoped(global, input.userId, input.slug, "federation");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const gate = requireFeature(await planOf(global, workspaceId, input.now), FEATURE);
  if (!gate.ok) return gate;
  const checked = checkGitHubTrustRule(input.body);
  if (!checked.ok) return checked;
  const body = input.body;
  const [current] = await global
    .select()
    .from(r)
    .where(and(eq(r.id, input.ruleId), eq(r.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return missingRule();
  if (current.revision !== body.revision) {
    return fail("version_conflict", "This rule changed since it was read. Reload and try again.");
  }
  if (sameRule(current, body)) {
    const [unchanged] = await rulesOf(global, workspaceId, input.now, current.id);
    return unchanged ? ok(unchanged) : missingRule();
  }
  const id = newId("gtr_");
  const eventId = newAuditEventId();
  const read: SQL = sql`exists (select 1 from ${r} where ${r.id} = ${current.id} and ${r.workspaceId} = ${workspaceId} and ${r.revision} = ${body.revision}) and ${stillAdmin(workspaceId, input.userId)} and not exists (select 1 from ${r} as "other" where "other"."workspace_id" = ${workspaceId} and "other"."repository_id" = ${body.repositoryId} and "other"."id" <> ${current.id})`;
  const claimed = sql`exists (select 1 from ${schema.auditEvents} where ${schema.auditEvents.id} = ${eventId})`;
  const events = githubSetText(GITHUB_TRUST_EVENTS, body.events);
  const scopes = githubSetText(GITHUB_TRUST_SCOPES, body.scopes);
  const [, , , inserted] = await global.batch([
    auditEvent(
      global,
      {
        id: eventId,
        ownerId: workspaceId,
        kind: "github_trust.changed",
        actor: { type: "user", id: input.userId },
        targetId: id,
        detail: detailOf(body),
        now: input.now,
      },
      read,
    ),
    global
      .insert(schema.tombstones)
      .select(sql`select 'github_trust_rule', ${current.id}, ${input.now} where ${claimed}`)
      .onConflictDoNothing(),
    // The old rule's credentials go by the cascade.
    global.delete(r).where(and(eq(r.id, current.id), claimed)),
    // Every column in schema order (AGENTS.md, insert ... select).
    global
      .insert(r)
      .select(
        sql`select ${id}, ${workspaceId}, ${body.repositoryId}, ${body.repositoryOwnerId}, ${body.repository}, ${events}, ${body.ref}, ${body.environment}, ${scopes}, ${current.createdBy}, ${current.createdAt}, ${input.now}, ${body.revision + 1} where ${claimed}`,
      )
      .returning({ id: r.id }),
  ]);
  if (inserted.length === 0) {
    const again = await scoped(global, input.userId, input.slug, "federation");
    if (!again.ok) return again;
    const [other] = await global
      .select({ id: r.id })
      .from(r)
      .where(and(eq(r.workspaceId, workspaceId), eq(r.repositoryId, body.repositoryId)))
      .limit(1);
    if (other && other.id !== current.id) return duplicateRule();
    return fail("version_conflict", "This rule changed since it was read. Reload and try again.");
  }
  const [changed] = await rulesOf(global, workspaceId, input.now, id);
  return changed ? ok(changed) : missingRule();
}

/**
 * Removes a rule: its audit event, a `github_trust_rule` tombstone (so a restore cannot bring the
 * trust back) and the delete, whose cascade ends its credentials at once, in one batch conditioned
 * on the caller still being an admin. Never gated on the plan, and works while switched off.
 */
export async function removeGitHubTrustRule(
  global: GlobalDb,
  input: { userId: string; slug: string; ruleId: string; now: number },
): Promise<Result<{ ruleId: string }>> {
  const scope = await scoped(global, input.userId, input.slug, "federation");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const [current] = await global
    .select({ repositoryId: r.repositoryId, repository: r.repository })
    .from(r)
    .where(and(eq(r.id, input.ruleId), eq(r.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return missingRule();
  const mine = sql`exists (select 1 from ${r} where ${r.id} = ${input.ruleId} and ${r.workspaceId} = ${workspaceId}) and ${stillAdmin(workspaceId, input.userId)}`;
  const [, , deleted] = await global.batch([
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "github_trust.removed",
        actor: { type: "user", id: input.userId },
        targetId: input.ruleId,
        detail: { repositoryId: current.repositoryId, repository: current.repository },
        now: input.now,
      },
      mine,
    ),
    global
      .insert(schema.tombstones)
      .select(sql`select 'github_trust_rule', ${input.ruleId}, ${input.now} where ${mine}`)
      .onConflictDoNothing(),
    global
      .delete(r)
      .where(
        and(
          eq(r.id, input.ruleId),
          eq(r.workspaceId, workspaceId),
          stillAdmin(workspaceId, input.userId),
        ),
      )
      .returning({ id: r.id }),
  ]);
  if (deleted.length === 1) return ok({ ruleId: input.ruleId });
  const again = await scoped(global, input.userId, input.slug, "federation");
  return again.ok ? missingRule() : again;
}

export type GitHubExchange =
  | {
      ok: true;
      secret: string;
      tokenId: string;
      workspace: string;
      expiresAt: number;
      keyPrefix: string;
      scopes: GitHubTrustScope[];
    }
  | { ok: false; reason: GitHubRefusal };

/** The used-token key: the SHA-256 of the issuer and the `jti`, never the raw value. */
export function usedTokenKey(jti: string): Promise<string> {
  return hashSecret(`${GITHUB_OIDC_ISSUER} ${jti}`);
}

/**
 * Issues a credential for a verified token's claims (decision 0024, "The exchange"): one read of
 * the workspace, the rule for the token's repository ID and the plan, then one batch. The batch
 * records the token as used in `github_used_tokens` with this request's own claim (a token already
 * there keeps its row, so the insert loses), then writes the credential and its
 * `github_trust.exchanged` event only when that insert won and the rule is still the one read.
 * Nothing cascades into the used tokens, so changing or removing a rule never makes a token
 * exchangeable again.
 */
export async function exchangeGitHubToken(
  global: GlobalDb,
  input: { slug: string; claims: GitHubClaims; now: number },
): Promise<GitHubExchange> {
  const { claims, now } = input;
  const p = schema.ownerPlans;
  const ws = schema.workspaces;
  const [row] = await global
    .select({
      workspaceId: ws.id,
      rule: {
        id: r.id,
        repositoryId: r.repositoryId,
        repositoryOwnerId: r.repositoryOwnerId,
        events: r.events,
        ref: r.ref,
        environment: r.environment,
        scopes: r.scopes,
        revision: r.revision,
        updatedAt: r.updatedAt,
      },
      plan: {
        plan: p.plan,
        seats: p.seats,
        validUntil: p.validUntil,
        overrides: p.overrides,
        grace: p.grace,
      },
    })
    .from(ws)
    .leftJoin(r, and(eq(r.workspaceId, ws.id), eq(r.repositoryId, claims.repositoryId)))
    .leftJoin(p, eq(p.ownerId, ws.id))
    .where(eq(ws.slug, input.slug))
    .limit(1);
  if (!row) return { ok: false, reason: "no_workspace" };
  const rule = row.rule;
  if (!rule?.id) return { ok: false, reason: "no_rule" };
  const verdict = githubClaimsVerdict(claims, {
    repositoryId: rule.repositoryId,
    repositoryOwnerId: rule.repositoryOwnerId,
    events: storedGitHubEvents(rule.events),
    ref: rule.ref,
    environment: rule.environment,
    savedAt: rule.updatedAt,
  });
  if (!verdict.ok) return verdict;
  if (!hasFeature(entitlements(row.plan ?? null, now), FEATURE)) {
    return { ok: false, reason: "plan" };
  }
  const scopes = storedGitHubScopes(rule.scopes);
  if (scopes.length === 0) return { ok: false, reason: "no_rule" };
  const id = newId("st_");
  const claim = newId("");
  const secret = newServiceTokenSecret();
  const tokenHash = await hashSecret(secret);
  const jtiHash = await usedTokenKey(claims.jti);
  const keyPrefix = githubKeyPrefix(claims.repositoryId);
  const expiresAt = now + GITHUB_TRUST.credentialMinutes * 60_000;
  const label = githubCredentialLabel(claims.repository, claims.runId);
  const u = schema.githubUsedTokens;
  // Kept until the token can no longer pass the time checks: its `exp` plus the skew accepted.
  const usedUntil = claims.expiresAt + GITHUB_TRUST.clockSkewSeconds * 1000;
  const won = sql`exists (select 1 from ${u} where ${u.jtiHash} = ${jtiHash} and ${u.claim} = ${claim})`;
  const still = sql`${won} and exists (select 1 from ${r} where ${r.id} = ${rule.id} and ${r.revision} = ${rule.revision})`;
  const [, inserted] = await global.batch([
    global.insert(u).values({ jtiHash, claim, expiresAt: usedUntil }).onConflictDoNothing(),
    // Every column in schema order. `last_used_at` is set now, so the hourly write never runs.
    global
      .insert(st)
      .select(
        sql`select ${id}, ${row.workspaceId}, ${label}, 'editor', ${scopes.join(" ")}, 'key', ${keyPrefix}, ${tokenHash}, null, ${now}, ${expiresAt}, ${now}, ${rule.id} where ${still}`,
      )
      .returning({ id: st.id }),
    // The credential itself is the actor, so the log shows it by its label while it exists.
    auditEvent(
      global,
      {
        ownerId: row.workspaceId,
        kind: "github_trust.exchanged",
        actor: { type: "user", id },
        targetId: rule.id,
        detail: {
          repositoryId: claims.repositoryId,
          repository: claims.repository,
          event: claims.eventName as GitHubTrustEvent,
          runId: claims.runId,
          runAttempt: claims.runAttempt,
        },
        now,
      },
      sql`exists (select 1 from ${st} where ${st.id} = ${id})`,
    ),
  ]);
  if (inserted.length === 0) return { ok: false, reason: "replayed" };
  return {
    ok: true,
    secret,
    tokenId: id,
    workspace: input.slug,
    expiresAt,
    keyPrefix,
    scopes,
  };
}

/**
 * Forgets used tokens that can no longer pass the exchange's time checks (`expires_at`, their
 * `exp` plus the accepted skew, has passed), at most `GITHUB_TRUST.prunePerRun` per run, oldest
 * first: one statement. A backlog drains over later runs.
 */
export async function pruneUsedGitHubTokens(global: GlobalDb, now: number): Promise<number> {
  const u = schema.githubUsedTokens;
  const due = global
    .select({ jtiHash: u.jtiHash })
    .from(u)
    .where(lt(u.expiresAt, now))
    .orderBy(asc(u.expiresAt))
    .limit(GITHUB_TRUST.prunePerRun);
  const deleted = await global
    .delete(u)
    .where(sql`${u.jtiHash} in (${due})`)
    .returning({ jtiHash: u.jtiHash });
  return deleted.length;
}

/**
 * Deletes credentials that expired more than `GITHUB_TRUST.pruneAfterMs` ago, at most
 * `GITHUB_TRUST.prunePerRun` per run, oldest first: one statement. Which ID tokens were used is
 * kept apart (`github_used_tokens`), so this prune never forgets one. A backlog drains over later
 * runs.
 */
export async function pruneFederatedCredentials(global: GlobalDb, now: number): Promise<number> {
  const due = global
    .select({ id: st.id })
    .from(st)
    .where(and(isNotNull(st.trustRuleId), lt(st.expiresAt, now - GITHUB_TRUST.pruneAfterMs)))
    .orderBy(asc(st.expiresAt))
    .limit(GITHUB_TRUST.prunePerRun);
  const deleted = await global.delete(st).where(sql`${st.id} in (${due})`).returning({ id: st.id });
  return deleted.length;
}
