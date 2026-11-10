// Verified email domains of a workspace (premium plan T2, decision 0010). Admins claim a domain,
// publish a TXT record holding the claim's fresh token and verify it; the jobs Worker re-checks
// verified domains daily and removes one after three missed checks in a row. A domain is verified
// by at most one workspace at a time, and a workspace takes one over only once the previous
// holder's record is gone from the same DNS answer. The read path asks only whether the viewer's
// exact domain is verified by the owner.
import {
  type AccessAudience,
  type AccessMode,
  type EmailDomainRemovalReason,
  isWorkspaceId,
  WORKSPACE_DOMAINS,
} from "@portifact/contracts";
import { type GlobalDb, schema } from "@portifact/db";
import {
  type Actor,
  checkEmailDomainAllowed,
  displayDomain,
  domainClaimExpiry,
  type Entitlements,
  emailDomainOf,
  fail,
  normalizeEmailDomain,
  ok,
  type PublicSuffixInfo,
  type Result,
  recheckDueBefore,
  recheckOutcome,
  recordHolds,
  requireFeature,
} from "@portifact/domain";
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { parse } from "tldts";
import { type AuditActor, auditEvent } from "./audit.ts";
import type { TxtLookup } from "./cloudflare-hostnames.ts";
import { ownerEntitlements } from "./plans.ts";
import { scoped, stillAdmin, type WorkspaceRow } from "./workspaces.ts";

const wd = schema.workspaceDomains;
const t = schema.tombstones;

export type WorkspaceDomainRow = typeof schema.workspaceDomains.$inferSelect;

/** DNS for email domain proofs: the custom domains' DNS over HTTPS client, or a fake in tests. */
export interface EmailDomainDeps {
  txt: TxtLookup;
}

/** Where a domain sits in the Public Suffix List (ICANN and private sections), from `tldts`. */
export function publicSuffixOf(domain: string): PublicSuffixInfo | null {
  const parsed = parse(domain, { allowPrivateDomains: true });
  if (!parsed.publicSuffix || parsed.isIp) return null;
  return {
    suffix: parsed.publicSuffix,
    icann: parsed.isIcann === true,
    private: parsed.isPrivate === true,
  };
}

const missingDomain = () => fail<never>("not_found", "Domain not found.");
const changedMeanwhile = () =>
  fail<never>("version_conflict", "The domain changed meanwhile. Reload and try again.");

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newDomainId(): string {
  return `wd_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** A fresh 128-bit token per claim, in hex: the value of a public TXT record. */
function newToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

async function domainsOf(global: GlobalDb, workspaceId: string): Promise<WorkspaceDomainRow[]> {
  return global.select().from(wd).where(eq(wd.workspaceId, workspaceId)).orderBy(asc(wd.domain));
}

async function domainRow(global: GlobalDb, workspaceId: string, id: string) {
  const [row] = await global
    .select()
    .from(wd)
    .where(and(eq(wd.id, id), eq(wd.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

const recordName = (domain: string) => `${WORKSPACE_DOMAINS.recordLabel}.${domain}`;

export interface DomainList {
  workspace: WorkspaceRow;
  domains: WorkspaceDomainRow[];
  /** The plan includes `workspaces`, so domains can be added and verified. */
  available: boolean;
}

/** A workspace's email domains, for its admins. */
export async function listWorkspaceDomains(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<DomainList>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const owner = await ownerEntitlements(global, workspace.id, input.now);
  return ok({
    workspace,
    domains: await domainsOf(global, workspace.id),
    available: requireFeature(owner, "workspaces").ok,
  });
}

/**
 * Claims a domain for a workspace, for an admin on a plan with `workspaces`. Answers the same
 * whether or not another workspace holds it. Adding a domain the workspace already claims returns
 * that claim, with a fresh token and expiry if the old one lapsed.
 */
export async function addWorkspaceDomain(
  global: GlobalDb,
  input: { userId: string; slug: string; domain: string; now: number; ownHosts?: string[] },
): Promise<Result<WorkspaceDomainRow>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const gate = requireFeature(
    await ownerEntitlements(global, workspace.id, input.now),
    "workspaces",
  );
  if (!gate.ok) return gate;
  const normalized = normalizeEmailDomain(input.domain);
  if (!normalized.ok) return normalized;
  const domain = normalized.value;
  const allowed = checkEmailDomainAllowed(domain, publicSuffixOf, input.ownHosts ?? []);
  if (!allowed.ok) return allowed;

  const [existing] = await global
    .select()
    .from(wd)
    .where(and(eq(wd.workspaceId, workspace.id), eq(wd.domain, domain)))
    .limit(1);
  if (existing) {
    if (existing.state === "verified" || existing.expiresAt > input.now) return ok(existing);
    // A lapsed claim gets a new token: the old record proves nothing about it.
    const [renewed] = await global
      .update(wd)
      .set({ token: newToken(), expiresAt: domainClaimExpiry(input.now), createdAt: input.now })
      .where(
        and(
          eq(wd.id, existing.id),
          eq(wd.state, "pending"),
          eq(wd.token, existing.token),
          stillAdmin(workspace.id, input.userId),
        ),
      )
      .returning();
    return renewed ? ok(renewed) : changedMeanwhile();
  }

  const id = newDomainId();
  const cap = WORKSPACE_DOMAINS.perWorkspace;
  await global
    .insert(wd)
    // Columns in schema order. The cap and the caller's role are checked by the insert itself.
    .select(
      sql`select ${id}, ${workspace.id}, ${domain}, ${displayDomain(input.domain, domain)}, ${newToken()}, 'pending', ${input.now}, ${domainClaimExpiry(input.now)}, null, null, 0, null where (select count(*) from ${wd} where ${wd.workspaceId} = ${workspace.id}) < ${cap} and ${stillAdmin(workspace.id, input.userId)}`,
    )
    .onConflictDoNothing();
  const row = await domainRow(global, workspace.id, id);
  if (row) return ok(row);
  const again = await scoped(global, input.userId, input.slug, "members");
  if (!again.ok) return again;
  if ((await domainsOf(global, workspace.id)).length >= cap) {
    return fail("quota_exceeded", `A workspace can have at most ${cap} email domains.`);
  }
  return changedMeanwhile();
}

/**
 * Verifies a pending claim from its TXT record. When another workspace holds the domain verified
 * and its own record is still in the answer, the proof is refused; when it is gone, the same batch
 * removes the other workspace's domain (with a tombstone) and verifies this one.
 */
export async function verifyWorkspaceDomain(
  global: GlobalDb,
  deps: EmailDomainDeps,
  input: { userId: string; slug: string; domainId: string; now: number },
): Promise<Result<WorkspaceDomainRow>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const row = await domainRow(global, workspace.id, input.domainId);
  if (!row) return missingDomain();
  if (row.state === "verified") return ok(row);
  const gate = requireFeature(
    await ownerEntitlements(global, workspace.id, input.now),
    "workspaces",
  );
  if (!gate.ok) return gate;
  if (row.expiresAt <= input.now) {
    return fail("invalid_input", "This claim expired. Add the domain again for a new record.");
  }
  let values: string[];
  try {
    values = await deps.txt(recordName(row.domain));
  } catch {
    return fail("capacity_unavailable", "DNS could not be checked right now. Try again shortly.");
  }
  if (!recordHolds(values, row.token)) {
    return fail(
      "invalid_input",
      "The TXT record was not found with this domain's value. DNS changes can take a while to appear; try again later.",
    );
  }
  const [holder] = await global
    .select({ id: wd.id, token: wd.token, workspaceId: wd.workspaceId })
    .from(wd)
    .where(
      and(eq(wd.domain, row.domain), eq(wd.state, "verified"), ne(wd.workspaceId, workspace.id)),
    )
    .limit(1);
  if (holder && recordHolds(values, holder.token)) {
    return fail(
      "version_conflict",
      "Another workspace still proves this domain in its DNS. Remove its record first.",
    );
  }

  const claimLive = and(
    sql`exists (select 1 from ${wd} as "claim" where "claim"."id" = ${row.id} and "claim"."state" = 'pending' and "claim"."token" = ${row.token} and "claim"."expires_at" > ${input.now})`,
    stillAdmin(workspace.id, input.userId),
  ) as SQL;
  const provable = and(
    eq(wd.id, row.id),
    eq(wd.state, "pending"),
    eq(wd.token, row.token),
    sql`${wd.expiresAt} > ${input.now}`,
    stillAdmin(workspace.id, input.userId),
    sql`not exists (select 1 from ${wd} as "other" where "other"."domain" = ${row.domain} and "other"."state" = 'verified')`,
  ) as SQL;
  const verify = global
    .update(wd)
    .set({
      state: "verified",
      verifiedAt: input.now,
      checkedAt: input.now,
      failedChecks: 0,
      problem: null,
    })
    .where(provable)
    .returning();
  // Recorded right before the update, on the update's own condition.
  const verifiedEvent = auditEvent(
    global,
    {
      ownerId: workspace.id,
      kind: "email_domain.verified",
      actor: { type: "user", id: input.userId },
      targetId: row.id,
      detail: { domain: row.domain },
      now: input.now,
    },
    sql`exists (select 1 from ${wd} where ${provable})`,
  );
  try {
    let verified: WorkspaceDomainRow | undefined;
    if (holder) {
      // The previous holder lost its record: its domain goes, with a tombstone, on this claim.
      const holderRow = and(
        eq(wd.id, holder.id),
        eq(wd.token, holder.token),
        eq(wd.state, "verified"),
      ) as SQL;
      const rows = (
        await global.batch([
          removedEvent(
            global,
            { id: holder.id, workspaceId: holder.workspaceId, domain: row.domain },
            { type: "system" },
            "claimed",
            input.now,
            sql`exists (select 1 from ${wd} where ${holderRow} and ${claimLive})`,
          ),
          global
            .insert(t)
            .select(
              sql`select 'workspace_domain', ${wd.id}, ${input.now} from ${wd} where ${holderRow} and ${claimLive}`,
            )
            .onConflictDoNothing(),
          global.delete(wd).where(and(holderRow, claimLive)),
          verifiedEvent,
          verify,
        ])
      )[4];
      verified = rows[0];
    } else {
      [, [verified]] = await global.batch([verifiedEvent, verify]);
    }
    if (verified) return ok(verified);
  } catch (error) {
    // The partial unique index refused a second verified holder a race let through.
    if (isUniqueViolation(error)) return changedMeanwhile();
    throw error;
  }
  const again = await scoped(global, input.userId, input.slug, "members");
  if (!again.ok) return again;
  const current = await domainRow(global, workspace.id, row.id);
  if (current?.state === "verified") return ok(current);
  return changedMeanwhile();
}

/**
 * The audit event of a verified domain going away, in the batch that deletes it. A claim that was
 * never proved granted nothing, so `condition` holds only for a verified row.
 */
function removedEvent(
  global: GlobalDb,
  row: { id: string; workspaceId: string; domain: string },
  actor: AuditActor,
  reason: EmailDomainRemovalReason,
  now: number,
  condition: SQL,
) {
  return auditEvent(
    global,
    {
      ownerId: row.workspaceId,
      kind: "email_domain.removed",
      actor,
      targetId: row.id,
      detail: { domain: row.domain, reason },
      now,
    },
    condition,
  );
}

/** Removes a domain, for an admin, with a tombstone so a restore cannot bring it back. */
export async function removeWorkspaceDomain(
  global: GlobalDb,
  input: { userId: string; slug: string; domainId: string; now: number },
): Promise<Result<true>> {
  const found = await scoped(global, input.userId, input.slug, "members");
  if (!found.ok) return found;
  const { workspace } = found.value;
  const row = await domainRow(global, workspace.id, input.domainId);
  if (!row) return missingDomain();
  const target = and(
    eq(wd.id, row.id),
    eq(wd.workspaceId, workspace.id),
    stillAdmin(workspace.id, input.userId),
  ) as SQL;
  const [, , deleted] = await global.batch([
    removedEvent(
      global,
      row,
      { type: "user", id: input.userId },
      "removed",
      input.now,
      sql`exists (select 1 from ${wd} where ${target} and ${wd.state} = 'verified')`,
    ),
    global
      .insert(t)
      .select(sql`select 'workspace_domain', ${wd.id}, ${input.now} from ${wd} where ${target}`)
      .onConflictDoNothing(),
    global.delete(wd).where(target).returning({ id: wd.id }),
  ]);
  if (deleted.length > 0) return ok(true);
  const again = await scoped(global, input.userId, input.slug, "members");
  return again.ok ? ok(true) : again;
}

export interface RecheckResult {
  checked: number;
  removed: number;
  /** Lookups that failed and were not counted as misses. */
  unavailable: number;
  expiredClaims: number;
}

/**
 * The scheduled re-check: drops lapsed claims, then looks up to `limit` verified domains due for
 * a check. Each result is written conditioned on the `checked_at` it read, so overlapping runs
 * count a day once. A resolver failure is not a miss; the last allowed miss removes the domain.
 */
export async function recheckEmailDomains(
  global: GlobalDb,
  deps: EmailDomainDeps,
  now: number,
  limit: number = WORKSPACE_DOMAINS.recheckBatch,
): Promise<RecheckResult> {
  const expired = await global
    .delete(wd)
    .where(
      inArray(
        wd.id,
        global
          .select({ id: wd.id })
          .from(wd)
          .where(and(eq(wd.state, "pending"), lte(wd.expiresAt, now)))
          .limit(limit),
      ),
    )
    .returning({ id: wd.id });
  const due = await global
    .select()
    .from(wd)
    .where(
      and(
        eq(wd.state, "verified"),
        or(isNull(wd.checkedAt), lt(wd.checkedAt, recheckDueBefore(now))),
      ),
    )
    .orderBy(asc(wd.checkedAt))
    .limit(limit);
  const result: RecheckResult = {
    checked: 0,
    removed: 0,
    unavailable: 0,
    expiredClaims: expired.length,
  };
  for (const row of due) {
    let values: string[];
    try {
      values = await deps.txt(recordName(row.domain));
    } catch {
      result.unavailable++;
      continue;
    }
    const unchanged = and(
      eq(wd.id, row.id),
      eq(wd.state, "verified"),
      row.checkedAt === null ? isNull(wd.checkedAt) : eq(wd.checkedAt, row.checkedAt),
    ) as SQL;
    const outcome = recheckOutcome(row.failedChecks, recordHolds(values, row.token));
    result.checked++;
    if (outcome.kind === "remove") {
      const [, , deleted] = await global.batch([
        removedEvent(
          global,
          row,
          { type: "system" },
          "record_missing",
          now,
          sql`exists (select 1 from ${wd} where ${unchanged})`,
        ),
        global
          .insert(t)
          .select(sql`select 'workspace_domain', ${wd.id}, ${now} from ${wd} where ${unchanged}`)
          .onConflictDoNothing(),
        global.delete(wd).where(unchanged).returning({ id: wd.id }),
      ]);
      result.removed += deleted.length;
      continue;
    }
    await global
      .update(wd)
      .set(
        outcome.kind === "ok"
          ? { checkedAt: now, failedChecks: 0, problem: null }
          : { checkedAt: now, failedChecks: outcome.failedChecks, problem: "txt_missing" },
      )
      .where(unchanged);
  }
  return result;
}

/**
 * What `canRead` needs for a `domain` artifact: whether the owner's plan includes `workspaces`
 * and the owner's verified domains among the viewer's. Reads nothing for any other mode, for an
 * owner side or member (the role already admits them), without the feature or without a usable
 * verified address: one indexed read otherwise.
 */
export async function policyDomains(
  global: GlobalDb,
  input: {
    mode: AccessMode;
    ownerId: string;
    actor: Actor | null;
    verifiedEmails: readonly string[];
    entitlements: Entitlements;
  },
): Promise<{ featureAvailable: boolean; verified: string[] } | undefined> {
  if (input.mode !== "domain" || !isWorkspaceId(input.ownerId)) return undefined;
  const featureAvailable = requireFeature(input.entitlements, "workspaces").ok;
  if (!featureAvailable || input.actor?.ownerId === input.ownerId) {
    return { featureAvailable, verified: [] };
  }
  const domains = [
    ...new Set(input.verifiedEmails.map(emailDomainOf).filter((d): d is string => d !== null)),
  ];
  if (domains.length === 0) return { featureAvailable, verified: [] };
  const rows = await global
    .select({ domain: wd.domain })
    .from(wd)
    .where(
      and(eq(wd.workspaceId, input.ownerId), eq(wd.state, "verified"), inArray(wd.domain, domains)),
    );
  return { featureAvailable, verified: rows.map((row) => row.domain) };
}

/** Who the workspace modes reach on an owner, for the people managing an artifact's access. */
export async function accessAudience(
  global: GlobalDb,
  ownerId: string,
  owner: Entitlements,
): Promise<AccessAudience | null> {
  if (!isWorkspaceId(ownerId)) return null;
  const [members] = await global
    .select({ count: sql<number>`count(*)` })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, ownerId));
  const verified = await global
    .select({ domain: wd.domain })
    .from(wd)
    .where(and(eq(wd.workspaceId, ownerId), eq(wd.state, "verified")))
    .orderBy(asc(wd.domain));
  return {
    members: Number(members?.count ?? 0),
    domains: verified.map((row) => row.domain),
    featureAvailable: requireFeature(owner, "workspaces").ok,
  };
}
