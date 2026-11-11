// "SSO required" (decision 0021): which single sign-on provider a workspace's requirement names,
// and whether it can sign people in, decided in SQL from data that is the same on every Worker:
// the provider row exists, it serves a verified email domain, and the workspace's plan includes
// `sso` (the conditions the sign-in itself checks, `signInProvider` in sso.ts). It is read in the
// same statement as the membership and the policy, so applying it costs no read, and the same
// expression decides the suspension state every write that can change it records. Nothing is
// evaluated unless the stored policy requires SSO.
import { PLAN_NAMES, PLANS } from "@portifact/contracts";
import type { Db, GlobalDb } from "@portifact/db";
import { schema } from "@portifact/db";
import { type SQL, sql } from "drizzle-orm";
import { type AuditActor, auditEvent } from "./audit.ts";

const so = schema.workspaceSso;
const wd = schema.workspaceDomains;
const op = schema.ownerPlans;
const ws = schema.workspaces;

/** The plans that include `sso` in `PLANS`, for the SQL twin of `entitlements`. */
const SSO_PLANS = PLAN_NAMES.filter((name) => PLANS[name].features.includes("sso"));

/**
 * Whether an owner's plan includes `sso` at `now`, as SQL: the twin of `entitlements` for this one
 * feature (no row, an expired `valid_until` or a plan without it read as without; an override of
 * `features.sso` wins). `test/sso-required.test.ts` checks it agrees with `entitlements` on a
 * table of plan rows. Overrides are validated when the operator writes them.
 */
export function planHasSsoSql(ownerId: SQL | typeof ws.id | string, now: number): SQL {
  return sql`exists (select 1 from ${op} where ${op.ownerId} = ${ownerId} and (${op.validUntil} is null or ${op.validUntil} > ${now}) and (case json_type(${op.overrides}, '$.features.sso') when 'true' then 1 when 'false' then 0 else ${op.plan} in ${SSO_PLANS} end))`;
}

/**
 * The workspace's provider ID while it can sign people in, as SQL: null without a provider,
 * without a verified domain it serves or without `sso` in the plan.
 */
export function usableProviderSql(workspaceId: SQL | typeof ws.id | string, now: number): SQL {
  return sql`(select ${so.id} from ${so} where ${so.workspaceId} = ${workspaceId} and exists (select 1 from ${wd} where ${wd.workspaceId} = ${so.workspaceId} and ${wd.state} = 'verified' and (' ' || ${so.domains} || ' ') like ('% ' || ${wd.domain} || ' %')) and ${planHasSsoSql(workspaceId, now)})`;
}

/** Whether the stored policy of the workspace row in scope requires single sign-on. */
const requiresSso = sql`coalesce(json_extract(${ws.policy}, '$.ssoRequired'), 0) = 1`;

/**
 * The usable provider's ID, null unless the policy requires single sign-on: a column of a select
 * that joins `workspaces` (`actorOn`'s membership query, the workspace list).
 */
export function ssoRequirementColumns(now: number) {
  return {
    ssoProvider: sql<
      string | null
    >`case when ${requiresSso} then ${usableProviderSql(ws.id, now)} end`,
  };
}

/**
 * The workspace's provider when it can sign people in now, whatever its policy: what saving "SSO
 * required" checks, and the Policies page shows. One read of the global database.
 */
export async function workspaceSsoProvider(
  global: GlobalDb,
  workspaceId: string,
  now: number,
): Promise<string | null> {
  const [row] = await global.all<{ provider: string | null }>(
    sql`select ${usableProviderSql(workspaceId, now)} as provider`,
  );
  return row?.provider ?? null;
}

/** What changed whether the requirement can be met, for the audit event. */
export type SsoSuspensionCause = "domain" | "plan" | "provider" | "scan";

/**
 * The statements that record a workspace's "SSO required" entering or leaving suspension
 * (decision 0021), for the end of the batch of the write that may cause it (a domain removed or
 * verified, a provider changed, a plan changed) and for the scan that notices a plan expiring. They
 * compare the stored state (`workspaces.sso_suspended`) with the usable provider as the batch
 * leaves it, write `policy.sso_suspended` or `policy.sso_resumed` by the system, and update the
 * state, all conditioned on the policy still requiring it and the state actually changing, so a
 * retried or concurrent write records one event per transition. Placed after the causing statement.
 */
export function ssoSuspensionStatements(
  global: Db,
  input: { workspaceId: string; now: number; cause: SsoSuspensionCause; actor?: AuditActor },
) {
  const usable = usableProviderSql(input.workspaceId, input.now);
  const stored = (suspended: 0 | 1) =>
    sql`exists (select 1 from ${ws} where ${ws.id} = ${input.workspaceId} and ${requiresSso} and ${ws.ssoSuspended} = ${suspended})`;
  const entering = sql`${stored(0)} and ${usable} is null`;
  const leaving = sql`${stored(1)} and ${usable} is not null`;
  const event = (kind: "policy.sso_suspended" | "policy.sso_resumed", condition: SQL) =>
    auditEvent(
      global,
      {
        ownerId: input.workspaceId,
        kind,
        actor: input.actor ?? { type: "system" },
        targetId: input.workspaceId,
        detail: { cause: input.cause },
        now: input.now,
      },
      condition,
    );
  return [
    event("policy.sso_suspended", entering),
    event("policy.sso_resumed", leaving),
    global
      .update(ws)
      .set({ ssoSuspended: sql`case when ${usable} is null then 1 else 0 end` })
      .where(
        sql`${ws.id} = ${input.workspaceId} and ${requiresSso} and ${ws.ssoSuspended} <> (case when ${usable} is null then 1 else 0 end)`,
      ),
  ] as const;
}

/**
 * The safety net for the suspension state (decision 0021): finds the workspaces whose "SSO
 * required" state no longer matches whether their provider can sign people in, which only a
 * plan's `valid_until` passing does without a write (every other cause records its transition in
 * its own batch), and records each with `ssoSuspensionStatements` (`cause: "scan"`). One read per
 * run; a batch only per workspace that changed, at most `limit`.
 */
export async function syncSsoRequirementStates(
  global: GlobalDb,
  now: number,
  limit = 50,
): Promise<{ changed: number }> {
  const rows = await global
    .select({ id: ws.id })
    .from(ws)
    .where(
      sql`${requiresSso} and ${ws.ssoSuspended} <> (case when ${usableProviderSql(ws.id, now)} is null then 1 else 0 end)`,
    )
    .orderBy(ws.id)
    .limit(limit);
  for (const row of rows) {
    await global.batch([
      ...ssoSuspensionStatements(global, { workspaceId: row.id, now, cause: "scan" }),
    ]);
  }
  return { changed: rows.length };
}
