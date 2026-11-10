// SCIM 2.0 provisioning for a workspace (premium plan E2, decision 0017). A workspace's admins
// create a SCIM token from the dashboard; the directory uses it at `/scim/v2` to add and remove
// the workspace's people. SCIM never creates a Portifact account: a person without one gets a
// pending membership (a `workspace_invitations` row with `source = 'directory'`, holding a seat)
// that becomes a membership at their first sign-in with that verified address and the current
// terms accepted. Every table here is global, next to the memberships. Writes are guarded D1
// batches: conditioned on the token still existing, the plan row the seat limit came from, the
// seats in use and the address's domain still verified, so a refused write writes nothing.
import {
  INVITATION_LIMITS,
  isScimTokenSecret,
  type LocaleCode,
  planRequiredMessage,
  SCIM,
  SCIM_TOKEN_SECRET_PREFIX,
  type ScimOverview,
  type ScimSettingsUpdate,
  type ScimTokenCreate,
  type ScimTokenView,
} from "@portifact/contracts";
import { type GlobalDb, hitRateLimit, schema } from "@portifact/db";
import {
  applyScimPatch,
  checkNoticeCapacity,
  emailDomain,
  entitlements,
  fail,
  hasFeature,
  lastUsedDue,
  lastUsedPeriodStart,
  newAuditEventId,
  normalizeEmail,
  ok,
  type Result,
  requireFeature,
  type ScimFilter,
  type ScimResult,
  type ScimUserInput,
  type ScimUserRecord,
  scimDomainAllowed,
  scimFail,
  scimNamesOf,
  serviceTokenExpired,
  serviceTokenExpiry,
} from "@portifact/domain";
import { and, asc, eq, gt, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type AuditActor, auditEvent } from "./audit.ts";
import { directoryNoticeJob } from "./directory-notices.ts";
import {
  emailHash,
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import {
  type InvitationSender,
  invitationTokenHash,
  newInvitationToken,
  seatLimit,
} from "./invitations.ts";
import { hex } from "./objects.ts";
import { hashSecret } from "./read-access.ts";
import { memberEvent, scoped, seatsUsedSql, stillAdmin } from "./workspaces.ts";

const st = schema.scimTokens;
const su = schema.scimUsers;
const ws = schema.workspaceScim;
const inv = schema.workspaceInvitations;
const m = schema.workspaceMembers;
const u = schema.users;
const wd = schema.workspaceDomains;
const FEATURE = "scim" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);

function newScimTokenId(): string {
  return `sc_${randomHex(16)}`;
}

function newScimUserId(): string {
  return `su_${randomHex(16)}`;
}

function newInvitationId(): string {
  return `inv_${randomHex(16)}`;
}

/** A fresh secret: the prefix and 32 random bytes in unpadded base64url (256 bits). */
export function newScimTokenSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${SCIM_TOKEN_SECRET_PREFIX}${encoded}`;
}

/** When a directory's pending membership written at `now` stops holding a seat. */
export function directoryPendingExpiry(now: number): number {
  return now + SCIM.pendingDays * DAY_MS;
}

async function planOf(global: GlobalDb, workspaceId: string, now: number) {
  const p = schema.ownerPlans;
  const [row] = await global
    .select({ plan: p.plan, seats: p.seats, validUntil: p.validUntil, overrides: p.overrides })
    .from(p)
    .where(eq(p.ownerId, workspaceId))
    .limit(1);
  return entitlements(row ?? null, now);
}

// Managing the directory's tokens and settings (dashboard session, admins) -------------------

type TokenRow = typeof st.$inferSelect;

function tokenView(row: TokenRow, creator: string | null, now: number): ScimTokenView {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: row.id,
    label: row.label,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
    createdBy: creator === null ? null : { name: creator },
    expired: serviceTokenExpired(row.expiresAt, now),
  };
}

async function tokensOf(global: GlobalDb, workspaceId: string, now: number) {
  const rows = await global
    .select({ token: st, creator: u.name })
    .from(st)
    .leftJoin(u, eq(u.id, st.createdBy))
    .where(eq(st.workspaceId, workspaceId))
    .orderBy(asc(st.createdAt), asc(st.id));
  return rows.map((row) => tokenView(row.token, row.creator, now));
}

async function invitationEmailsOn(global: GlobalDb, workspaceId: string): Promise<boolean> {
  const [row] = await global
    .select({ on: ws.invitationEmails })
    .from(ws)
    .where(eq(ws.workspaceId, workspaceId))
    .limit(1);
  return row?.on ?? false;
}

/**
 * The Directory sync section for an admin: the base URL, the tokens, the settings, the last sync
 * (the latest hour any token was used) and how many provisioned people have not signed in yet.
 * Reading needs no plan, so an admin can always see and revoke after a downgrade.
 */
export async function getScimOverview(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number; baseUrl: string },
): Promise<Result<ScimOverview>> {
  const scope = await scoped(global, input.userId, input.slug, "scim");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const tokens = await tokensOf(global, workspaceId, input.now);
  const [pending] = await global
    .select({ count: sql<number>`count(*)` })
    .from(inv)
    .where(
      and(
        eq(inv.workspaceId, workspaceId),
        eq(inv.source, "directory"),
        gt(inv.expiresAt, input.now),
      ),
    );
  const lastSync = tokens
    .map((token) => token.lastUsedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return ok({
    baseUrl: input.baseUrl,
    available: hasFeature(await planOf(global, workspaceId, input.now), FEATURE),
    tokens,
    limit: SCIM.tokensPerWorkspace,
    invitationEmails: await invitationEmailsOn(global, workspaceId),
    lastSyncAt: lastSync ?? null,
    pending: Number(pending?.count ?? 0),
  });
}

/**
 * Creates a SCIM token for an admin of a workspace whose plan includes `scim`. The secret is
 * returned once and never stored. The insert is conditioned on the caller still being an admin
 * and the workspace under the cap, so concurrent creates cannot pass it.
 */
export async function createScimToken(
  global: GlobalDb,
  input: { userId: string; slug: string; body: ScimTokenCreate; now: number },
): Promise<Result<{ token: ScimTokenView; secret: string }>> {
  const scope = await scoped(global, input.userId, input.slug, "scim");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const gate = requireFeature(await planOf(global, workspaceId, input.now), FEATURE);
  if (!gate.ok) return gate;
  const id = newScimTokenId();
  const secret = newScimTokenSecret();
  const tokenHash = await hashSecret(secret);
  const expiresAt = serviceTokenExpiry(input.now, input.body.expiresInDays);
  const count = sql`(select count(*) from ${st} where ${st.workspaceId} = ${workspaceId})`;
  const [inserted] = await global.batch([
    // Every column in schema order (AGENTS.md, insert ... select).
    global
      .insert(st)
      .select(
        sql`select ${id}, ${workspaceId}, ${input.body.label}, ${tokenHash}, ${input.userId}, ${input.now}, ${expiresAt}, null where ${stillAdmin(workspaceId, input.userId)} and ${count} < ${SCIM.tokensPerWorkspace}`,
      )
      .returning(),
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "scim_token.created",
        actor: { type: "user", id: input.userId },
        targetId: id,
        detail: { days: input.body.expiresInDays },
        now: input.now,
      },
      sql`exists (select 1 from ${st} where ${st.id} = ${id})`,
    ),
  ]);
  const row = inserted[0];
  if (!row) {
    const again = await scoped(global, input.userId, input.slug, "scim");
    if (!again.ok) return again;
    return fail(
      "quota_exceeded",
      `A workspace can have at most ${SCIM.tokensPerWorkspace} SCIM tokens. Revoke one first.`,
    );
  }
  const [creator] = await global
    .select({ name: u.name })
    .from(u)
    .where(eq(u.id, input.userId))
    .limit(1);
  return ok({ token: tokenView(row, creator?.name ?? null, input.now), secret });
}

function revokeStatements(
  global: GlobalDb,
  workspaceId: string,
  tokenId: string,
  actor: AuditActor,
  now: number,
  condition: SQL,
) {
  return [
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "scim_token.revoked",
        actor,
        targetId: tokenId,
        detail: {},
        now,
      },
      condition,
    ),
    // A restore must never bring a revoked token back.
    global
      .insert(schema.tombstones)
      .select(sql`select 'scim_token', ${tokenId}, ${now} where ${condition}`)
      .onConflictDoNothing(),
  ] as const;
}

/** Revokes a SCIM token for an admin, with its tombstone. Revoking needs no plan. */
export async function revokeScimToken(
  global: GlobalDb,
  input: { userId: string; slug: string; tokenId: string; now: number },
): Promise<Result<{ tokenId: string }>> {
  const scope = await scoped(global, input.userId, input.slug, "scim");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const mine = sql`exists (select 1 from ${st} where ${st.id} = ${input.tokenId} and ${st.workspaceId} = ${workspaceId}) and ${stillAdmin(workspaceId, input.userId)}`;
  const [, , deleted] = await global.batch([
    ...revokeStatements(
      global,
      workspaceId,
      input.tokenId,
      { type: "user", id: input.userId },
      input.now,
      mine,
    ),
    global
      .delete(st)
      .where(
        and(
          eq(st.id, input.tokenId),
          eq(st.workspaceId, workspaceId),
          stillAdmin(workspaceId, input.userId),
        ),
      )
      .returning({ id: st.id }),
  ]);
  if (deleted.length === 1) return ok({ tokenId: input.tokenId });
  const again = await scoped(global, input.userId, input.slug, "scim");
  return again.ok ? fail("not_found", "SCIM token not found.") : again;
}

/** Changes the workspace's SCIM settings, for an admin. Not gated: it only narrows emails. */
export async function updateScimSettings(
  global: GlobalDb,
  input: { userId: string; slug: string; body: ScimSettingsUpdate; now: number },
): Promise<Result<{ invitationEmails: boolean }>> {
  const scope = await scoped(global, input.userId, input.slug, "scim");
  if (!scope.ok) return scope;
  const workspaceId = scope.value.workspace.id;
  const current = await invitationEmailsOn(global, workspaceId);
  const next = input.body.invitationEmails;
  if (current === next) return ok({ invitationEmails: next });
  const admin = stillAdmin(workspaceId, input.userId);
  const [, written] = await global.batch([
    auditEvent(
      global,
      {
        ownerId: workspaceId,
        kind: "scim.changed",
        actor: { type: "user", id: input.userId },
        targetId: workspaceId,
        detail: { fields: ["invitationEmails"], invitationEmails: next },
        now: input.now,
      },
      admin,
    ),
    global
      .insert(ws)
      .select(sql`select ${workspaceId}, ${next ? 1 : 0}, ${input.now} where ${admin}`)
      .onConflictDoUpdate({
        target: ws.workspaceId,
        set: { invitationEmails: next, updatedAt: input.now },
      })
      .returning({ on: ws.invitationEmails }),
  ]);
  if (written.length === 0) {
    const again = await scoped(global, input.userId, input.slug, "scim");
    return again.ok ? fail("version_conflict", "The workspace changed meanwhile.") : again;
  }
  return ok({ invitationEmails: next });
}

// Authentication ----------------------------------------------------------------------------

/** The directory behind a request: its token and the token's workspace. */
export interface ScimCaller {
  tokenId: string;
  workspaceId: string;
}

export type ScimAuth =
  | ({ ok: true } & ScimCaller)
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "plan"; message: string };

/**
 * Authenticates a directory's bearer secret: one indexed read of the token with its workspace's
 * plan. Only a `pfsc_` secret is ever looked up, so a service token, an OAuth token or a session
 * never authenticates here. A revoked token, or one of a deleted workspace, is gone and answers
 * like an unknown one. `last_used_at` is written at most once an hour.
 */
export async function authenticateScimToken(
  global: GlobalDb,
  secret: string,
  now: number,
): Promise<ScimAuth> {
  if (!isScimTokenSecret(secret)) return { ok: false, reason: "invalid" };
  const p = schema.ownerPlans;
  const [row] = await global
    .select({
      id: st.id,
      workspaceId: st.workspaceId,
      expiresAt: st.expiresAt,
      lastUsedAt: st.lastUsedAt,
      plan: { plan: p.plan, seats: p.seats, validUntil: p.validUntil, overrides: p.overrides },
    })
    .from(st)
    .leftJoin(p, eq(p.ownerId, st.workspaceId))
    .where(eq(st.tokenHash, await hashSecret(secret)))
    .limit(1);
  if (!row) return { ok: false, reason: "invalid" };
  if (serviceTokenExpired(row.expiresAt, now)) return { ok: false, reason: "expired" };
  if (!hasFeature(entitlements(row.plan, now), FEATURE)) {
    return { ok: false, reason: "plan", message: planRequiredMessage(FEATURE) };
  }
  if (lastUsedDue(row.lastUsedAt, now)) {
    await global
      .update(st)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(st.id, row.id),
          or(isNull(st.lastUsedAt), lt(st.lastUsedAt, lastUsedPeriodStart(now))),
        ),
      );
  }
  return { ok: true, tokenId: row.id, workspaceId: row.workspaceId };
}

/**
 * Counts one request against the token's and the workspace's per-minute budgets in
 * `rate_limits`. True when both still allow it.
 */
export async function hitScimRateLimit(
  global: GlobalDb,
  caller: ScimCaller,
  now: number,
): Promise<boolean> {
  const rules: [string, { max: number; windowSeconds: number }][] = [
    [`scim:token:${caller.tokenId}`, SCIM.perTokenPerMinute],
    [`scim:workspace:${caller.workspaceId}`, SCIM.perWorkspacePerMinute],
  ];
  let allowed = true;
  for (const [key, rule] of rules) {
    const hit = await hitRateLimit(global.$client, key, rule.windowSeconds * 1000, now);
    if (hit.count > rule.max) allowed = false;
  }
  return allowed;
}

/**
 * Counts one failed authentication from `ip` (atomically, in `rate_limits`) and says whether the
 * IP is past `SCIM.failedAuthPerIp`. Keyed by IP only: a request that authenticates is never
 * counted or refused here, so this never locks a workspace's directory out.
 */
export async function hitScimAuthFailure(
  global: GlobalDb,
  ip: string,
  now: number,
): Promise<{ limited: boolean }> {
  const rule = SCIM.failedAuthPerIp;
  const hit = await hitRateLimit(
    global.$client,
    `scim:authfail:${ip}`,
    rule.windowSeconds * 1000,
    now,
  );
  return { limited: hit.count > rule.max };
}

/** The token a leaked secret belongs to, for the operator; never the secret itself. */
export async function findScimToken(
  global: GlobalDb,
  secret: string,
): Promise<{ id: string; workspaceId: string; label: string; expiresAt: number } | null> {
  if (!isScimTokenSecret(secret.trim())) return null;
  const [row] = await global
    .select({ id: st.id, workspaceId: st.workspaceId, label: st.label, expiresAt: st.expiresAt })
    .from(st)
    .where(eq(st.tokenHash, await hashSecret(secret.trim())))
    .limit(1);
  return row ?? null;
}

/** The operator's revocation of a SCIM token by ID, with its tombstone. Idempotent. */
export async function operatorRevokeScimToken(
  global: GlobalDb,
  tokenId: string,
  now: number,
): Promise<boolean> {
  const [found] = await global
    .select({ workspaceId: st.workspaceId })
    .from(st)
    .where(eq(st.id, tokenId))
    .limit(1);
  const exists = sql`exists (select 1 from ${st} where ${st.id} = ${tokenId})`;
  const results = await global.batch([
    ...revokeStatements(
      global,
      found?.workspaceId ?? "",
      tokenId,
      { type: "operator" },
      now,
      exists,
    ),
    global.delete(st).where(eq(st.id, tokenId)).returning({ id: st.id }),
  ]);
  return results[2].length === 1;
}

// The directory's users ---------------------------------------------------------------------

type UserRow = typeof su.$inferSelect;

function record(row: UserRow): ScimUserRecord {
  return {
    id: row.id,
    email: row.email,
    externalId: row.externalId,
    names: scimNamesOf(row.names),
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const notFound = () => scimFail<never>(404, "Resource not found.");

async function userRow(global: GlobalDb, caller: ScimCaller, id: string) {
  const [row] = await global
    .select()
    .from(su)
    .where(and(eq(su.id, id), eq(su.workspaceId, caller.workspaceId)))
    .limit(1);
  return row ?? null;
}

/** One user of this workspace's directory; another workspace's ID answers like a missing one. */
export async function getScimUser(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
): Promise<ScimResult<ScimUserRecord>> {
  const row = await userRow(global, caller, id);
  return row ? { ok: true, value: record(row) } : notFound();
}

/**
 * A page of the directory's users, oldest first, optionally filtered by equality on `userName`
 * or `externalId`. Bounded: at most `SCIM.maxPageSize` rows, over at most
 * `SCIM.usersPerWorkspace` rows of one workspace, through the workspace's indexes.
 */
export async function listScimUsers(
  global: GlobalDb,
  caller: ScimCaller,
  input: { filter: ScimFilter | null; startIndex: number; count: number },
): Promise<{ users: ScimUserRecord[]; total: number }> {
  const where = and(
    eq(su.workspaceId, caller.workspaceId),
    input.filter === null
      ? undefined
      : input.filter.attribute === "userName"
        ? eq(su.email, input.filter.value)
        : eq(su.externalId, input.filter.value),
  );
  const [total] = await global.select({ count: sql<number>`count(*)` }).from(su).where(where);
  const rows =
    input.count === 0
      ? []
      : await global
          .select()
          .from(su)
          .where(where)
          .orderBy(asc(su.createdAt), asc(su.id))
          .limit(input.count)
          .offset(input.startIndex - 1);
  return { users: rows.map(record), total: Number(total?.count ?? 0) };
}

/** What a write did: the resource, and the account whose sessions it ended, if any. */
export interface ScimWrite {
  user: ScimUserRecord;
  /** The account this write took out of the workspace and signed out; null otherwise. */
  ended: string | null;
}

export interface ScimDeps {
  /** Sends the invitation email to people provisioned without an account, when turned on. */
  sender: InvitationSender | null;
  /** The language of the invitation email: the person has no account to say theirs. */
  locale?: LocaleCode | null;
  /**
   * Ends every session of an account through Better Auth, so its hooks run. Called only after a
   * write removed that account's membership; without it the sessions stay pending.
   */
  endSessions?: ((accountId: string) => Promise<void>) | undefined;
}

function causeIncludes(error: unknown, text: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(text)) return true;
  }
  return false;
}

const LAST_ADMIN =
  "This person is the workspace's last admin and cannot be removed. Make another member an admin in Portifact first.";
const OUTSIDE_DOMAINS =
  "userName must be an address in one of the workspace's verified email domains.";
const SESSIONS_NOT_ENDED = "The person's sessions could not be ended. Retry.";

/** The token still exists and has not expired: every directory write is conditioned on it. */
function tokenHolds(caller: ScimCaller, now: number): SQL {
  return sql`exists (select 1 from ${st} where ${st.id} = ${caller.tokenId} and ${st.workspaceId} = ${caller.workspaceId} and ${st.expiresAt} > ${now})`;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** The address's domain is still one the workspace verified. */
function domainHolds(workspaceId: string, email: string): SQL {
  return sql`exists (select 1 from ${wd} where ${wd.workspaceId} = ${workspaceId} and ${wd.domain} = ${domainOf(email)} and ${wd.state} = 'verified')`;
}

async function verifiedDomainsOf(global: GlobalDb, workspaceId: string): Promise<string[]> {
  const rows = await global
    .select({ domain: wd.domain })
    .from(wd)
    .where(and(eq(wd.workspaceId, workspaceId), eq(wd.state, "verified")));
  return rows.map((row) => row.domain);
}

/** The account with this address, by its lowercase email; every account's email is verified. */
async function accountOf(global: GlobalDb, email: string) {
  const [row] = await global
    .select({ id: u.id })
    .from(u)
    .where(sql`lower(${u.email}) = ${email}`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * The workspace's member whose address is `email`, only while its domain is one the workspace
 * verified: a directory speaks for addresses at its proven domains, never for anyone else.
 */
async function memberByEmail(global: GlobalDb, workspaceId: string, email: string) {
  const [row] = await global
    .select({ id: m.userId })
    .from(m)
    .innerJoin(u, eq(u.id, m.userId))
    .where(
      and(
        eq(m.workspaceId, workspaceId),
        sql`lower(${u.email}) = ${email}`,
        domainHolds(workspaceId, email),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The account a directory user stands for, read when the batch runs: the linked one, or else a
 * member of the workspace with the user's address, only at a domain the workspace verified.
 */
function linkedAccountSql(workspaceId: string, userId: string, email: string): SQL {
  return sql`coalesce((select ${su.userId} from ${su} where ${su.id} = ${userId}), (select ${m.userId} from ${m} inner join ${u} on ${u.id} = ${m.userId} where ${m.workspaceId} = ${workspaceId} and lower(${u.email}) = ${email} and ${domainHolds(workspaceId, email)}))`;
}

/** This request's claim on the directory row: the rest of its batch holds only with it. */
function claimed(id: string, writeId: string): SQL {
  return sql`exists (select 1 from ${su} where ${su.id} = ${id} and ${su.writeId} = ${writeId})`;
}

/**
 * Takes the linked account out of the workspace, for a deactivation or a deletion (decision
 * 0017), only when it is a member: its event, tombstones of its group memberships (the cascade
 * deletes them) and of the membership (`workspace_member`, so a restore cannot bring it back), a
 * `workspace_removals` row so single sign-on does not either, the `sessions_pending` mark that
 * makes this removal end the account's sessions, then the membership. The account is read
 * through the directory row, which the batch's first statement links. The last-admin trigger
 * refuses the whole batch when the person is the last admin.
 */
function memberRemoval(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
  condition: SQL,
  now: number,
): BatchItem<"sqlite">[] {
  const W = caller.workspaceId;
  const gm = schema.workspaceGroupMembers;
  const account = sql`(select ${su.userId} from ${su} where ${su.id} = ${id})`;
  const memberWhere = sql`${m.workspaceId} = ${W} and ${m.userId} = ${account}`;
  const isMember = sql`exists (select 1 from ${m} where ${memberWhere}) and ${condition}`;
  return [
    // Columns in schema order: id, owner, at, kind, actor type, actor, target, artifact, detail.
    // The role and the member come from the row, so the event is written from SQL.
    global
      .insert(schema.auditEvents)
      .select(
        sql`select ${newAuditEventId()}, ${W}, ${now}, 'member.removed', 'directory', ${caller.tokenId}, ${m.userId}, null, json_object('role', ${m.role}) from ${m} where ${memberWhere} and ${condition}`,
      ),
    global
      .insert(schema.tombstones)
      .select(
        sql`select 'workspace_group_member', ${gm.id}, ${now} from ${gm} where ${gm.workspaceId} = ${W} and ${gm.userId} = ${account} and ${isMember}`,
      )
      .onConflictDoNothing(),
    global
      .insert(schema.tombstones)
      .select(sql`select 'workspace_member', ${W} || ':' || ${account}, ${now} where ${isMember}`)
      .onConflictDoUpdate({
        target: [schema.tombstones.kind, schema.tombstones.id],
        set: { deletedAt: now },
      }),
    global
      .insert(schema.workspaceRemovals)
      .select(sql`select ${W}, ${account}, ${now} where ${isMember}`)
      .onConflictDoUpdate({
        target: [schema.workspaceRemovals.workspaceId, schema.workspaceRemovals.userId],
        set: { removedAt: now },
      }),
    global.update(su).set({ sessionsPending: true }).where(sql`${su.id} = ${id} and ${isMember}`),
    global.delete(m).where(sql`${memberWhere} and ${condition}`),
  ];
}

/**
 * Withdraws the directory's pending membership for `email`, with its event and a
 * `workspace_invitation` tombstone so a restore cannot bring it back. An admin's invitation to
 * the same address is never touched.
 */
function pendingRemoval(
  global: GlobalDb,
  caller: ScimCaller,
  email: string,
  condition: SQL,
  now: number,
): BatchItem<"sqlite">[] {
  const W = caller.workspaceId;
  const pending = sql`${inv.workspaceId} = ${W} and ${inv.email} = ${email} and ${inv.source} = 'directory' and ${condition}`;
  return [
    global
      .insert(schema.auditEvents)
      .select(
        sql`select ${newAuditEventId()}, ${W}, ${now}, 'member.invitation_revoked', 'directory', ${caller.tokenId}, ${inv.id}, null, '{}' from ${inv} where ${pending} and ${inv.expiresAt} > ${now}`,
      ),
    global
      .insert(schema.tombstones)
      .select(sql`select 'workspace_invitation', ${inv.id}, ${now} from ${inv} where ${pending}`)
      .onConflictDoNothing(),
    global.delete(inv).where(pending),
  ];
}

/**
 * Ends the sessions a removal left pending, then clears the mark. A failure leaves it, so the
 * directory's retry ends them; a write that removed nobody finds no mark and ends nothing.
 */
async function endPendingSessions(
  global: GlobalDb,
  id: string,
  endSessions: ScimDeps["endSessions"],
): Promise<ScimResult<string | null>> {
  const [row] = await global
    .select({ userId: su.userId, pending: su.sessionsPending })
    .from(su)
    .where(eq(su.id, id))
    .limit(1);
  if (!row?.pending || row.userId === null || !endSessions) return { ok: true, value: null };
  try {
    await endSessions(row.userId);
  } catch {
    // Only the event: never the account.
    console.log(JSON.stringify({ event: "scim_sessions_not_ended" }));
    return scimFail(503, SESSIONS_NOT_ENDED);
  }
  await global
    .update(su)
    .set({ sessionsPending: false })
    .where(and(eq(su.id, id), eq(su.userId, row.userId)));
  return { ok: true, value: row.userId };
}

/** What a write starts from: the stored directory user, or null for a create. */
interface Current {
  row: UserRow | null;
}

/**
 * Applies what the directory says about one user. A create, or a change of `userName`, needs the
 * new address at one of the workspace's verified domains whatever `active` says; a deactivation
 * of an unchanged address needs it too unless the row is already linked to an account through an
 * earlier valid provisioning (so a lapsed domain never keeps a provisioned person in).
 *
 * `explicit` is a provisioning the directory asked for in so many words: a create, or turning
 * `active` from false to true for someone not held by their own leaving. Only an explicit one
 * lifts a removal by hand and the single sign-on block; a routine sync never brings back someone
 * removed by hand, and someone who left comes back only through a new create after a delete.
 */
async function writeUser(
  global: GlobalDb,
  deps: ScimDeps,
  caller: ScimCaller,
  current: Current,
  input: ScimUserInput,
  now: number,
): Promise<ScimResult<ScimWrite>> {
  const W = caller.workspaceId;
  const next = { ...input, userName: normalizeEmail(input.userName) };
  const previous = current.row;
  const verified = await verifiedDomainsOf(global, W);
  const inDomain = scimDomainAllowed(next.userName, verified);
  const renamed = previous === null || previous.email !== next.userName;
  const linkedBefore = previous?.userId ?? null;
  if (!inDomain && (renamed || next.active || linkedBefore === null)) {
    return scimFail(400, OUTSIDE_DOMAINS, "invalidValue");
  }
  if (renamed) {
    const [taken] = await global
      .select({ id: su.id })
      .from(su)
      .where(and(eq(su.workspaceId, W), eq(su.email, next.userName)))
      .limit(1);
    if (taken) return scimFail(409, "A user with this userName already exists.", "uniqueness");
  }
  const id = previous?.id ?? newScimUserId();
  const writeId = randomHex(16);
  const explicit =
    previous === null || (!previous.active && next.active && previous.removal !== "self");
  const held = !explicit && previous !== null && previous.removedAt !== null;
  const provision = next.active && !held;
  const linked = linkedBefore ?? (previous ? await memberByEmail(global, W, previous.email) : null);
  const account = provision ? (linked ?? (await accountOf(global, next.userName))) : null;
  const [memberRow] = account
    ? await global
        .select({ role: m.role })
        .from(m)
        .where(and(eq(m.workspaceId, W), eq(m.userId, account)))
        .limit(1)
    : [];
  const live = provision
    ? await global
        .select({ id: inv.id, source: inv.source })
        .from(inv)
        .where(and(eq(inv.workspaceId, W), eq(inv.email, next.userName), gt(inv.expiresAt, now)))
    : [];
  const directoryRow = live.find((row) => row.source === "directory");
  // A membership for an account that is not a member, or a pending row for an address without
  // one; either takes a seat unless a live invitation for the address already holds it (an
  // admin's or the directory's: the address counts once).
  const joins = provision && account !== null && !memberRow;
  const pends = provision && account === null;
  const takesSeat = (joins || pends) && live.length === 0;
  const { limit, guard: planUnchanged } = await seatLimit(global, W, now);
  let base = provision
    ? sql`${tokenHolds(caller, now)} and ${domainHolds(W, next.userName)} and ${planUnchanged}`
    : tokenHolds(caller, now);
  if (takesSeat) base = sql`${base} and ${seatsUsedSql(W, now, true)} < ${limit}`;
  const statements: BatchItem<"sqlite">[] = [];
  if (previous === null) {
    const room = sql`(select count(*) from ${su} where ${su.workspaceId} = ${W}) < ${SCIM.usersPerWorkspace}`;
    statements.push(
      global
        .insert(su)
        // Columns in schema order: id, workspace, email, external ID, names, active, user,
        // removed at, removal, sessions pending, created, updated, write ID.
        .select(
          sql`select ${id}, ${W}, ${next.userName}, ${next.externalId}, ${JSON.stringify(next.names)}, ${next.active ? 1 : 0}, ${account}, null, null, 0, ${now}, ${now}, ${writeId} where ${base} and ${room}`,
        )
        .onConflictDoNothing(),
    );
  } else {
    statements.push(
      global
        .update(su)
        .set({
          email: next.userName,
          externalId: next.externalId,
          names: next.names,
          active: next.active,
          // Deactivating links the member it removes, so a later reactivation finds them.
          userId: account === null ? linkedAccountSql(W, id, previous.email) : account,
          removedAt: explicit ? null : su.removedAt,
          removal: explicit ? null : su.removal,
          updatedAt: now,
          writeId,
        })
        .where(and(eq(su.id, id), eq(su.workspaceId, W), eq(su.writeId, previous.writeId), base)),
    );
  }
  const mine = claimed(id, writeId);
  const actor: AuditActor = { type: "directory", id: caller.tokenId };
  if (previous && previous.email !== next.userName) {
    // A pending row under the address the directory used before goes with the change.
    statements.push(...pendingRemoval(global, caller, previous.email, mine, now));
  }
  if (!next.active) {
    statements.push(...memberRemoval(global, caller, id, mine, now));
    statements.push(...pendingRemoval(global, caller, next.userName, mine, now));
  }
  if (explicit && account !== null) {
    statements.push(
      global
        .delete(schema.workspaceRemovals)
        .where(
          and(
            eq(schema.workspaceRemovals.workspaceId, W),
            eq(schema.workspaceRemovals.userId, account),
            mine,
          ) as SQL,
        ),
    );
  }
  if (joins && account !== null) {
    const notMember = sql`not exists (select 1 from ${m} where ${m.workspaceId} = ${W} and ${m.userId} = ${account})`;
    const activeAccount = sql`not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${account})`;
    const notRemoved = sql`not exists (select 1 from ${schema.workspaceRemovals} where ${schema.workspaceRemovals.workspaceId} = ${W} and ${schema.workspaceRemovals.userId} = ${account})`;
    const adds = sql`${mine} and ${notMember} and ${activeAccount} and ${notRemoved}`;
    statements.push(
      memberEvent(
        global,
        { workspaceId: W, memberId: account, now, actor },
        "member.joined",
        { role: "member", via: "directory" },
        adds,
      ),
      // The person is told they were added (decision 0017): a job in this batch, on its own
      // condition, sent by the jobs Worker.
      directoryNoticeJob(global, W, account, adds, now),
      global
        .insert(m)
        // Columns in schema order: workspace, user, role, created at, updated at.
        .select(sql`select ${W}, ${account}, 'member', ${now}, ${now} where ${adds}`)
        .onConflictDoNothing(),
      // The directory's own pending row for the address is consumed; an admin's invitation stays
      // for the person to accept, with its role.
      global
        .delete(inv)
        .where(
          sql`${inv.workspaceId} = ${W} and ${inv.email} = ${next.userName} and ${inv.source} = 'directory' and exists (select 1 from ${m} where ${m.workspaceId} = ${W} and ${m.userId} = ${account}) and ${mine}`,
        ),
    );
  }
  let invitation: { token: string; expiresAt: number } | null = null;
  if (pends) {
    const invitationId = newInvitationId();
    const token = newInvitationToken();
    const expiresAt = directoryPendingExpiry(now);
    if (!directoryRow) {
      invitation = { token, expiresAt };
      statements.push(
        auditEvent(
          global,
          {
            ownerId: W,
            kind: "member.provisioned",
            actor,
            targetId: invitationId,
            detail: { role: "member", emailDomain: emailDomain(next.userName) },
            now,
          },
          mine,
        ),
      );
    }
    statements.push(
      global
        .insert(inv)
        // Columns in schema order: id, workspace, email, role, token hash, invited by, created,
        // expires, source. Only the directory's own row: an admin's invitation to the address is
        // a different row (the unique index includes the source) and never changes here.
        .select(
          sql`select ${invitationId}, ${W}, ${next.userName}, 'member', ${await invitationTokenHash(token)}, null, ${now}, ${expiresAt}, 'directory' where ${mine}`,
        )
        .onConflictDoUpdate({
          target: [inv.workspaceId, inv.email, inv.source],
          set: directoryRow
            ? { expiresAt: sql`excluded.expires_at` }
            : {
                id: sql`excluded.id`,
                role: sql`excluded.role`,
                tokenHash: sql`excluded.token_hash`,
                invitedBy: sql`excluded.invited_by`,
                createdAt: sql`excluded.created_at`,
                expiresAt: sql`excluded.expires_at`,
              },
        }),
    );
  }
  try {
    await global.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (error) {
    if (causeIncludes(error, "sole_workspace_admin")) {
      return scimFail(400, LAST_ADMIN, "mutability");
    }
    if (causeIncludes(error, "UNIQUE constraint failed: scim_users")) {
      return scimFail(409, "A user with this userName already exists.", "uniqueness");
    }
    throw error;
  }
  const [row] = await global.select().from(su).where(eq(su.id, id)).limit(1);
  if (!row || row.writeId !== writeId) {
    return refusal(
      global,
      caller,
      { current, takesSeat, userName: next.userName, provisioning: provision },
      now,
    );
  }
  const ended = await endPendingSessions(global, id, deps.endSessions);
  if (!ended.ok) return ended;
  if (invitation) {
    await sendInvitation(
      global,
      deps,
      W,
      next.userName,
      invitation.token,
      invitation.expiresAt,
      now,
    );
  }
  return { ok: true, value: { user: record(row), ended: ended.value } };
}

/** Why a write's batch changed nothing: the token, the seats, the domain or a concurrent write. */
async function refusal(
  global: GlobalDb,
  caller: ScimCaller,
  why: { current: Current; takesSeat: boolean; userName: string; provisioning: boolean },
  now: number,
): Promise<ScimResult<never>> {
  const [token] = await global
    .select({ id: st.id })
    .from(st)
    .where(and(eq(st.id, caller.tokenId), gt(st.expiresAt, now)))
    .limit(1);
  if (!token) return scimFail(401, "The SCIM token is no longer valid.");
  if (why.takesSeat) {
    const [seats] = await global.all<{ used: number }>(
      sql`select ${seatsUsedSql(caller.workspaceId, now, true)} as used`,
    );
    const { limit } = await seatLimit(global, caller.workspaceId, now);
    if (Number(seats?.used ?? 0) >= limit) {
      return scimFail(
        403,
        `The workspace uses all of its ${limit} seats. Free a seat in Portifact or ask for more, then retry.`,
      );
    }
  }
  // Only a provisioning depends on the domain; anything else that changed nothing lost a race.
  if (
    why.provisioning &&
    !scimDomainAllowed(why.userName, await verifiedDomainsOf(global, caller.workspaceId))
  ) {
    return scimFail(400, OUTSIDE_DOMAINS, "invalidValue");
  }
  if (why.current.row === null) {
    const [taken] = await global
      .select({ id: su.id })
      .from(su)
      .where(and(eq(su.workspaceId, caller.workspaceId), eq(su.email, why.userName)))
      .limit(1);
    if (taken) return scimFail(409, "A user with this userName already exists.", "uniqueness");
    return scimFail(
      400,
      `The workspace's directory already holds ${SCIM.usersPerWorkspace} users. Delete some first.`,
      "tooMany",
    );
  }
  return scimFail(409, "The user changed meanwhile. Read it again and retry.");
}

/**
 * The invitation email for a person provisioned without an account, when the workspace turned
 * it on. Best effort: the pending membership stands whatever happens here (the person becomes a
 * member at their first sign-in anyway), so a full month, a suppressed address, a rate limit or a
 * failed send only means no email.
 */
async function sendInvitation(
  global: GlobalDb,
  deps: ScimDeps,
  workspaceId: string,
  email: string,
  token: string,
  expiresAt: number,
  now: number,
): Promise<void> {
  if (!deps.sender || !(await invitationEmailsOn(global, workspaceId))) return;
  if (!checkNoticeCapacity(await emailsSentInCycle(global, now)).ok) return;
  if (await isEmailSuppressed(global, email, now)) return;
  const limits: [string, { max: number; windowSeconds: number }][] = [
    [`invitations:workspace:${workspaceId}`, INVITATION_LIMITS.perWorkspacePerDay],
    [`invitations:recipient:${await emailHash(email)}`, INVITATION_LIMITS.perRecipientPerDay],
  ];
  for (const [key, rule] of limits) {
    const hit = await hitRateLimit(global.$client, key, rule.windowSeconds * 1000, now);
    if (hit.count > rule.max) return;
  }
  const [workspace] = await global
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  try {
    await deps.sender.send({
      to: email,
      token,
      workspaceName: workspace?.name ?? "",
      inviterName: "",
      role: "member",
      expiresAt,
      locale: deps.locale ?? null,
    });
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(global, { email, reason: "provider", now });
      return;
    }
    // Only the event: never the address or the workspace.
    console.log(JSON.stringify({ event: "scim_invitation_not_sent" }));
    return;
  }
  await recordEmailsSent(global, now);
}

/** `POST /Users`: a new directory user; an existing `userName` answers 409 `uniqueness`. */
export async function createScimUser(
  global: GlobalDb,
  deps: ScimDeps,
  caller: ScimCaller,
  input: ScimUserInput,
  now: number,
): Promise<ScimResult<ScimWrite>> {
  return writeUser(global, deps, caller, { row: null }, input, now);
}

/** `PUT /Users/:id`: replaces what the directory said about the user. */
export async function replaceScimUser(
  global: GlobalDb,
  deps: ScimDeps,
  caller: ScimCaller,
  id: string,
  input: ScimUserInput,
  now: number,
): Promise<ScimResult<ScimWrite>> {
  const row = await userRow(global, caller, id);
  if (!row) return notFound();
  return writeUser(global, deps, caller, { row }, input, now);
}

/** `PATCH /Users/:id`: applies the operations to the stored user, then writes it like a PUT. */
export async function patchScimUser(
  global: GlobalDb,
  deps: ScimDeps,
  caller: ScimCaller,
  id: string,
  body: unknown,
  now: number,
): Promise<ScimResult<ScimWrite>> {
  const row = await userRow(global, caller, id);
  if (!row) return notFound();
  const patched = applyScimPatch(
    {
      userName: row.email,
      externalId: row.externalId,
      active: row.active,
      names: scimNamesOf(row.names),
    },
    body,
  );
  if (!patched.ok) return patched;
  return writeUser(global, deps, caller, { row }, patched.value, now);
}

/**
 * `DELETE /Users/:id`: the person leaves the workspace as on a deactivation, their sessions end if
 * this (or an earlier, failed) removal took them out, and only then is the directory's copy of
 * them deleted with a `scim_user` tombstone, so a failure to end sessions leaves a row the
 * directory's retry finds again. Accounts are reached only through the row's link or an address
 * at a verified domain, so a lapsed domain deletes the row without touching anyone unlinked.
 * Deleting again answers 404.
 */
export async function deleteScimUser(
  global: GlobalDb,
  caller: ScimCaller,
  id: string,
  now: number,
  endSessions: (accountId: string) => Promise<void>,
): Promise<ScimResult<{ ended: string | null }>> {
  const row = await userRow(global, caller, id);
  if (!row) return notFound();
  const W = caller.workspaceId;
  const writeId = randomHex(16);
  const mine = claimed(id, writeId);
  const statements: BatchItem<"sqlite">[] = [
    // The claim, which also links the member it removes so the statements below find them.
    global
      .update(su)
      .set({ userId: linkedAccountSql(W, id, row.email), active: false, updatedAt: now, writeId })
      .where(and(eq(su.id, id), eq(su.workspaceId, W), tokenHolds(caller, now))),
    ...memberRemoval(global, caller, id, mine, now),
    ...pendingRemoval(global, caller, row.email, mine, now),
  ];
  try {
    await global.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (error) {
    if (causeIncludes(error, "sole_workspace_admin")) {
      return scimFail(400, LAST_ADMIN, "mutability");
    }
    throw error;
  }
  const [after] = await global
    .select({ writeId: su.writeId })
    .from(su)
    .where(eq(su.id, id))
    .limit(1);
  if (!after) return notFound();
  if (after.writeId !== writeId) {
    return refusal(
      global,
      caller,
      { current: { row }, takesSeat: false, userName: row.email, provisioning: false },
      now,
    );
  }
  const ended = await endPendingSessions(global, id, endSessions);
  if (!ended.ok) return ended;
  await global.batch([
    global
      .insert(schema.tombstones)
      .select(sql`select 'scim_user', ${id}, ${now} where ${mine}`)
      .onConflictDoNothing(),
    global.delete(su).where(and(eq(su.id, id), eq(su.writeId, writeId))),
  ]);
  return { ok: true, value: { ended: ended.value } };
}

// Signing in --------------------------------------------------------------------------------

/**
 * Turns the directory's pending memberships for a signed-in account's address into memberships
 * (decision 0017), at sign-in, after the terms hook let the session through. Only while the
 * directory still has the person active and not held by a removal, the address's domain is still
 * one the workspace verified, no removal block stands, the account is not being deleted and the
 * workspace has a seat for members (the pending row already held one). Always `member`: an
 * admin's invitation beside it still needs the person's acceptance to give its role. Recorded as
 * `member.joined` with `via: "directory"`, by the person. At most one row per workspace, 10 read.
 * Idempotent.
 */
export async function claimDirectoryMemberships(
  global: GlobalDb,
  input: { userId: string; now: number },
): Promise<number> {
  const [account] = await global
    .select({ email: u.email, verified: u.emailVerified })
    .from(u)
    .where(eq(u.id, input.userId))
    .limit(1);
  if (!account?.verified) return 0;
  const email = normalizeEmail(account.email);
  const rows = await global
    .select({ id: inv.id, workspaceId: inv.workspaceId })
    .from(inv)
    .where(and(eq(inv.email, email), eq(inv.source, "directory"), gt(inv.expiresAt, input.now)))
    .limit(10);
  let joined = 0;
  for (const row of rows) {
    const W = row.workspaceId;
    const { limit, guard } = await seatLimit(global, W, input.now);
    const directory = sql`exists (select 1 from ${su} where ${su.workspaceId} = ${W} and ${su.email} = ${email} and ${su.active} = 1 and ${su.removedAt} is null)`;
    const pending = sql`exists (select 1 from ${inv} where ${inv.id} = ${row.id} and ${inv.expiresAt} > ${input.now})`;
    const member = sql`exists (select 1 from ${m} where ${m.workspaceId} = ${W} and ${m.userId} = ${input.userId})`;
    const notRemoved = sql`not exists (select 1 from ${schema.workspaceRemovals} where ${schema.workspaceRemovals.workspaceId} = ${W} and ${schema.workspaceRemovals.userId} = ${input.userId})`;
    const activeAccount = sql`not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${input.userId})`;
    const joins = sql`${pending} and ${directory} and ${domainHolds(W, email)} and ${notRemoved} and ${activeAccount} and not ${member} and ${seatsUsedSql(W, input.now, false)} < ${limit} and ${guard}`;
    const [, inserted] = (await global.batch([
      memberEvent(
        global,
        {
          workspaceId: W,
          memberId: input.userId,
          now: input.now,
          actor: { type: "user", id: input.userId },
        },
        "member.joined",
        { role: "member", via: "directory" },
        joins,
      ),
      global
        .insert(m)
        // Columns in schema order: workspace, user, role, created at, updated at.
        .select(
          sql`select ${W}, ${input.userId}, 'member', ${input.now}, ${input.now} where ${joins}`,
        )
        .onConflictDoNothing()
        .returning({ userId: m.userId }),
      global
        .update(su)
        .set({ userId: input.userId })
        .where(
          and(eq(su.workspaceId, W), eq(su.email, email), member, domainHolds(W, email)) as SQL,
        ),
      global.delete(inv).where(and(eq(inv.id, row.id), member) as SQL),
    ])) as [unknown, unknown[], unknown, unknown];
    if (inserted.length > 0) joined += 1;
  }
  return joined;
}

/**
 * Deletes what the directory told Portifact about people who never got an account: rows with no
 * account link, no pending membership left (the pending row expired after `SCIM.pendingDays`
 * without a write from the directory) and no write since. A maintenance scan; returns the rows.
 */
export async function pruneDirectoryUsers(global: GlobalDb, now: number): Promise<number> {
  const stale = now - SCIM.pendingDays * DAY_MS;
  const deleted = await global
    .delete(su)
    .where(
      sql`${su.userId} is null and ${su.updatedAt} < ${stale} and not exists (select 1 from ${inv} where ${inv.workspaceId} = ${su.workspaceId} and ${inv.email} = ${su.email} and ${inv.expiresAt} > ${now})`,
    )
    .returning({ id: su.id });
  return deleted.length;
}
