// "SSO required" (decision 0021): which single sign-on provider a workspace's requirement names,
// read in the same statement as the membership and the policy, so applying it costs no read. The
// requirement binds only while that provider can sign people in: the row exists, it serves a
// verified email domain, and the workspace's plan includes `sso`, the same conditions the sign-in
// itself checks (`signInProvider` in sso.ts). Any of them lapsing suspends it; nothing is read
// unless the stored policy requires SSO.
import type { GlobalDb } from "@portifact/db";
import { schema } from "@portifact/db";
import { entitlements, type OwnerPlanRecord, requireFeature } from "@portifact/domain";
import { sql } from "drizzle-orm";

const so = schema.workspaceSso;
const wd = schema.workspaceDomains;
const op = schema.ownerPlans;

/** Whether the stored policy of the workspace row in scope requires single sign-on. */
const requiresSso = sql`coalesce(json_extract(${schema.workspaces.policy}, '$.ssoRequired'), 0) = 1`;

/**
 * The provider's ID when it serves at least one verified domain of its workspace, or null; and
 * the workspace's plan row as JSON. Both null unless the policy requires single sign-on. Columns
 * of a select that joins `workspaces`.
 */
export function ssoRequirementColumns() {
  const workspaceId = schema.workspaces.id;
  return {
    ssoProvider: sql<
      string | null
    >`case when ${requiresSso} then (select ${so.id} from ${so} where ${so.workspaceId} = ${workspaceId} and exists (select 1 from ${wd} where ${wd.workspaceId} = ${so.workspaceId} and ${wd.state} = 'verified' and (' ' || ${so.domains} || ' ') like ('% ' || ${wd.domain} || ' %'))) end`,
    ssoPlan: sql<
      string | null
    >`case when ${requiresSso} then (select json_object('plan', ${op.plan}, 'seats', ${op.seats}, 'validUntil', ${op.validUntil}, 'overrides', ${op.overrides}) from ${op} where ${op.ownerId} = ${workspaceId}) end`,
  };
}

/** The plan row `ssoRequirementColumns` read, as the plan rules take it. */
function planRecord(json: string | null): OwnerPlanRecord | null {
  if (json === null) return null;
  try {
    const row = JSON.parse(json) as Record<string, unknown>;
    const overrides =
      typeof row.overrides === "string" ? (JSON.parse(row.overrides) as unknown) : row.overrides;
    return {
      plan: String(row.plan),
      seats: Number(row.seats),
      validUntil: typeof row.validUntil === "number" ? row.validUntil : null,
      overrides: overrides ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The provider a requirement binds to now, from the columns `ssoRequirementColumns` read: its ID
 * while it can sign people in, null otherwise (no provider, no verified domain it serves, or a
 * plan without `sso`), which suspends the requirement.
 */
export function usableSsoProvider(
  row: { ssoProvider: string | null; ssoPlan: string | null },
  now: number,
): string | null {
  if (row.ssoProvider === null) return null;
  return requireFeature(entitlements(planRecord(row.ssoPlan), now), "sso").ok
    ? row.ssoProvider
    : null;
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
  const [row] = await global.all<{ ssoProvider: string | null; ssoPlan: string | null }>(
    sql`select (select ${so.id} from ${so} where ${so.workspaceId} = ${workspaceId} and exists (select 1 from ${wd} where ${wd.workspaceId} = ${so.workspaceId} and ${wd.state} = 'verified' and (' ' || ${so.domains} || ' ') like ('% ' || ${wd.domain} || ' %'))) as ssoProvider, (select json_object('plan', ${op.plan}, 'seats', ${op.seats}, 'validUntil', ${op.validUntil}, 'overrides', ${op.overrides}) from ${op} where ${op.ownerId} = ${workspaceId}) as ssoPlan`,
  );
  return row ? usableSsoProvider(row, now) : null;
}
