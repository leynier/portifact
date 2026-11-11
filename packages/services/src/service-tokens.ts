// Service tokens (premium plan T4, decision 0011): a workspace's credential for automation.
// Admins create, list and revoke them from the dashboard session only; the API authenticates
// them here and the services treat the token's ID as the acting user, whose role `actorOn`
// resolves from this table. Only the SHA-256 of a secret is stored.
import {
  isServiceTokenSecret,
  planRequiredMessage,
  SERVICE_TOKEN_SECRET_PREFIX,
  SERVICE_TOKENS,
  type ServiceTokenCreate,
  type ServiceTokenScope,
  type ServiceTokenView,
} from "@portifact/contracts";
import { type GlobalDb, schema } from "@portifact/db";
import {
  entitlements,
  fail,
  hasFeature,
  lastUsedDue,
  lastUsedPeriodStart,
  ok,
  type Result,
  requireFeature,
  restrictionColumns,
  restrictionOf,
  serviceTokenExpired,
  serviceTokenExpiry,
  storedTokenScopes,
} from "@portifact/domain";
import { and, asc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { type AuditActor, auditEvent } from "./audit.ts";
import { hashSecret } from "./read-access.ts";
import { scoped, stillAdmin } from "./workspaces.ts";

const t = schema.serviceTokens;
const FEATURE = "serviceTokens" as const;

const missingToken = () => fail<never>("not_found", "Service token not found.");

function newTokenId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `st_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A fresh secret: the prefix and 32 random bytes in unpadded base64url (256 bits). */
export function newServiceTokenSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${SERVICE_TOKEN_SECRET_PREFIX}${encoded}`;
}

type TokenRow = typeof t.$inferSelect;

function view(row: TokenRow, creator: string | null, now: number): ServiceTokenView {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: row.id,
    label: row.label,
    role: row.role,
    scopes: storedTokenScopes(row.scopes),
    restriction: restrictionOf(row.restriction, row.keyPrefix),
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
    createdBy: creator === null ? null : { name: creator },
    expired: serviceTokenExpired(row.expiresAt, now),
  };
}

async function tokensOf(global: GlobalDb, workspaceIds: string[], now: number) {
  if (workspaceIds.length === 0) return [];
  const rows = await global
    .select({ token: t, creator: schema.users.name })
    .from(t)
    .leftJoin(schema.users, eq(schema.users.id, t.createdBy))
    // A GitHub run's credential (decision 0024) is not an admin's token: listed with its rule.
    .where(and(inArray(t.workspaceId, workspaceIds), isNull(t.trustRuleId)))
    .orderBy(asc(t.createdAt), asc(t.id));
  return rows.map((row) => ({
    workspaceId: row.token.workspaceId,
    view: view(row.token, row.creator, now),
  }));
}

export interface ServiceTokenListing {
  items: ServiceTokenView[];
  available: boolean;
  limit: number;
}

/** The workspace's tokens, for its admins; never a secret. Listing needs no plan. */
export async function listServiceTokens(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<ServiceTokenListing>> {
  const scope = await scoped(global, input.userId, input.slug, "tokens");
  if (!scope.ok) return scope;
  const owner = await planOf(global, scope.value.workspace.id, input.now);
  return ok({
    items: (await tokensOf(global, [scope.value.workspace.id], input.now)).map((row) => row.view),
    available: hasFeature(owner, FEATURE),
    limit: SERVICE_TOKENS.perWorkspace,
  });
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

/**
 * Creates a token for an admin of the workspace whose plan includes `serviceTokens`. The secret
 * is returned once and never stored; creation takes no idempotency key, since a stored replay
 * would keep it. The insert is conditioned on the caller still being an admin and the workspace
 * under the cap, so concurrent creates cannot pass it.
 */
export async function createServiceToken(
  global: GlobalDb,
  input: { userId: string; slug: string; body: ServiceTokenCreate; now: number },
): Promise<Result<{ token: ServiceTokenView; secret: string }>> {
  const scope = await scoped(global, input.userId, input.slug, "tokens");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const gate = requireFeature(await planOf(global, workspaceId, input.now), FEATURE);
  if (!gate.ok) return gate;
  const id = newTokenId();
  const secret = newServiceTokenSecret();
  const tokenHash = await hashSecret(secret);
  const { restriction, keyPrefix } = restrictionColumns(input.body.restriction);
  const scopes = [...input.body.scopes].sort().join(" ");
  const expiresAt = serviceTokenExpiry(input.now, input.body.expiresInDays);
  const count = sql`(select count(*) from ${t} where ${t.workspaceId} = ${workspaceId} and ${t.trustRuleId} is null)`;
  const [inserted] = await global.batch([
    // Every column in schema order (AGENTS.md, insert ... select).
    global
      .insert(t)
      .select(
        sql`select ${id}, ${workspaceId}, ${input.body.label}, ${input.body.role}, ${scopes}, ${restriction}, ${keyPrefix}, ${tokenHash}, ${input.userId}, ${input.now}, ${expiresAt}, null, null, null where ${stillAdmin(workspaceId, input.userId)} and ${count} < ${SERVICE_TOKENS.perWorkspace}`,
      )
      .returning(),
    // Recorded only when the row above was written: the ID is this request's own.
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "service_token.created",
        actor: { type: "user", id: input.userId },
        targetId: id,
        detail: {
          scopes: [...input.body.scopes].sort(),
          restriction,
          days: input.body.expiresInDays,
        },
        now: input.now,
      },
      sql`exists (select 1 from ${t} where ${t.id} = ${id})`,
    ),
  ]);
  const row = inserted[0];
  if (!row) {
    const again = await scoped(global, input.userId, input.slug, "tokens");
    if (!again.ok) return again;
    return fail(
      "quota_exceeded",
      `A workspace can have at most ${SERVICE_TOKENS.perWorkspace} service tokens. Revoke one first.`,
    );
  }
  const [creator] = await global
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  return ok({ token: view(row, creator?.name ?? null, input.now), secret });
}

/**
 * Revokes a token: deletes it and writes a `service_token` tombstone in one batch, conditioned on
 * the caller still being an admin, so a restore never brings it back. Revoking needs no plan.
 */
export async function revokeServiceToken(
  global: GlobalDb,
  input: { userId: string; slug: string; tokenId: string; now: number },
): Promise<Result<{ tokenId: string }>> {
  const scope = await scoped(global, input.userId, input.slug, "tokens");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const mine = sql`exists (select 1 from ${t} where ${t.id} = ${input.tokenId} and ${t.workspaceId} = ${workspaceId}) and ${stillAdmin(workspaceId, input.userId)}`;
  const [, , deleted] = await global.batch([
    revokedEvent(
      global,
      workspaceId,
      input.tokenId,
      { type: "user", id: input.userId },
      input.now,
      mine,
    ),
    global
      .insert(schema.tombstones)
      .select(sql`select 'service_token', ${input.tokenId}, ${input.now} where ${mine}`)
      .onConflictDoNothing(),
    global
      .delete(t)
      .where(
        and(
          eq(t.id, input.tokenId),
          eq(t.workspaceId, workspaceId),
          stillAdmin(workspaceId, input.userId),
        ),
      )
      .returning({ id: t.id }),
  ]);
  if (deleted.length === 1) return ok({ tokenId: input.tokenId });
  const again = await scoped(global, input.userId, input.slug, "tokens");
  return again.ok ? missingToken() : again;
}

/** The audit event of a revocation, in its batch, while the token is still there. */
function revokedEvent(
  global: GlobalDb,
  workspaceId: string,
  tokenId: string,
  actor: AuditActor,
  now: number,
  condition: SQL,
) {
  return auditEvent(
    global,
    {
      ownerId: workspaceId,
      kind: "service_token.revoked",
      actor,
      targetId: tokenId,
      detail: {},
      now,
    },
    condition,
  );
}

/** What authenticating a secret gave: the token, or why it is refused. */
export type ServiceTokenAuth =
  | { ok: true; tokenId: string; workspaceId: string; scopes: ServiceTokenScope[] }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired"; expiresAt: number }
  | { ok: false; reason: "plan"; message: string };

/**
 * Authenticates a bearer secret (decision 0011, "Authentication"): one indexed read of the token
 * with its workspace's plan. Revoked tokens and tokens of deleted workspaces are gone, so they are
 * `invalid` like an unknown secret. `last_used_at` is written only when the stored time is from
 * an earlier hour, guarded in SQL so concurrent requests write it once: requests within the hour
 * add no D1 write.
 */
export async function authenticateServiceToken(
  global: GlobalDb,
  secret: string,
  now: number,
): Promise<ServiceTokenAuth> {
  if (!isServiceTokenSecret(secret)) return { ok: false, reason: "invalid" };
  const p = schema.ownerPlans;
  const [row] = await global
    .select({
      id: t.id,
      workspaceId: t.workspaceId,
      scopes: t.scopes,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt,
      plan: {
        plan: p.plan,
        seats: p.seats,
        validUntil: p.validUntil,
        overrides: p.overrides,
        grace: p.grace,
      },
    })
    .from(t)
    .leftJoin(p, eq(p.ownerId, t.workspaceId))
    .where(eq(t.tokenHash, await hashSecret(secret)))
    .limit(1);
  if (!row) return { ok: false, reason: "invalid" };
  if (serviceTokenExpired(row.expiresAt, now)) {
    return { ok: false, reason: "expired", expiresAt: row.expiresAt };
  }
  if (!hasFeature(entitlements(row.plan, now), FEATURE)) {
    return { ok: false, reason: "plan", message: planRequiredMessage(FEATURE) };
  }
  if (lastUsedDue(row.lastUsedAt, now)) {
    await global
      .update(t)
      .set({ lastUsedAt: now })
      .where(
        and(eq(t.id, row.id), or(isNull(t.lastUsedAt), lt(t.lastUsedAt, lastUsedPeriodStart(now)))),
      );
  }
  return {
    ok: true,
    tokenId: row.id,
    workspaceId: row.workspaceId,
    scopes: storedTokenScopes(row.scopes),
  };
}

/**
 * The tokens of every workspace the user administers, for the account export: never a secret or
 * its hash.
 */
export async function exportServiceTokens(
  global: GlobalDb,
  userId: string,
  now: number,
): Promise<{ workspace: string; token: ServiceTokenView }[]> {
  const m = schema.workspaceMembers;
  const admin = await global
    .select({ workspaceId: m.workspaceId, slug: schema.workspaces.slug })
    .from(m)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, m.workspaceId))
    .where(and(eq(m.userId, userId), eq(m.role, "admin")));
  const slugs = new Map(admin.map((row) => [row.workspaceId, row.slug]));
  return (await tokensOf(global, [...slugs.keys()], now)).map((row) => ({
    workspace: slugs.get(row.workspaceId) ?? row.workspaceId,
    token: row.view,
  }));
}

/** The token a leaked secret belongs to, for the operator; never the secret itself. */
export async function findServiceToken(
  global: GlobalDb,
  secret: string,
): Promise<{ id: string; workspaceId: string; label: string; expiresAt: number } | null> {
  if (!isServiceTokenSecret(secret.trim())) return null;
  const [row] = await global
    .select({ id: t.id, workspaceId: t.workspaceId, label: t.label, expiresAt: t.expiresAt })
    .from(t)
    .where(eq(t.tokenHash, await hashSecret(secret.trim())))
    .limit(1);
  return row ?? null;
}

/** The operator's revocation of a token by ID, with its tombstone. Idempotent. */
export async function operatorRevokeServiceToken(
  global: GlobalDb,
  tokenId: string,
  now: number,
): Promise<boolean> {
  const [found] = await global
    .select({ workspaceId: t.workspaceId })
    .from(t)
    .where(eq(t.id, tokenId))
    .limit(1);
  const exists = sql`exists (select 1 from ${t} where ${t.id} = ${tokenId})`;
  const [, , deleted] = await global.batch([
    // The workspace's admins see that Portifact revoked it; a token already gone records nothing.
    revokedEvent(global, found?.workspaceId ?? "", tokenId, { type: "operator" }, now, exists),
    global
      .insert(schema.tombstones)
      .values({ kind: "service_token", id: tokenId, deletedAt: now })
      .onConflictDoNothing(),
    global.delete(t).where(eq(t.id, tokenId)).returning({ id: t.id }),
  ]);
  return deleted.length === 1;
}
