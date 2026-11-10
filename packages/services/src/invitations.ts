// Invitations to a workspace (premium plan T1): sent by an admin to an email address, valid for a
// week, accepted or declined only by a signed-in account whose verified email is that address.
// Only a SHA-256 of the token is stored; the token is only in the email. An invitation never
// creates an account, so the terms acceptance and the human check of signing up still apply. A
// pending invitation holds a seat until it expires, and accepting takes a seat only while the
// workspace has one free, so of two concurrent accepts for the last seat exactly one succeeds.
import { INVITATION_LIMITS, type LocaleCode, type WorkspaceRole } from "@portifact/contracts";
import { type GlobalDb, hitRateLimit, schema } from "@portifact/db";
import {
  checkInvitee,
  checkNoticeCapacity,
  checkSeat,
  emailDomain,
  entitlements,
  fail,
  invitationExpiry,
  MISSING_INVITATION,
  newAuditEventId,
  normalizeEmail,
  ok,
  type Result,
} from "@portifact/domain";
import { and, asc, eq, gt, lte, type SQL, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import { actorOn } from "./actors.ts";
import { auditEvent, withdrawAuditEvent } from "./audit.ts";
import {
  emailHash,
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import { hex } from "./objects.ts";
import {
  memberEvent,
  missingWorkspace,
  regionOf,
  type Seats,
  seatsUsedSql,
  stillAdmin,
  type UserWorkspace,
  workspaceBySlug,
  workspaceSeats,
} from "./workspaces.ts";

const inv = schema.workspaceInvitations;
const m = schema.workspaceMembers;
const w = schema.workspaces;

/** What the invitation email needs; the token is only ever in this message. */
export interface InvitationMessage {
  to: string;
  token: string;
  workspaceName: string;
  inviterName: string;
  role: WorkspaceRole;
  expiresAt: number;
  /** The inviter's account language: the invited person may have no account yet. */
  locale: LocaleCode | null;
}

/** Sends invitation emails; throws `RecipientSuppressedError` when the provider refuses the address. */
export interface InvitationSender {
  send(message: InvitationMessage): Promise<void>;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A new invitation token: 32 random bytes, base64url. */
export function newInvitationToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function invitationTokenHash(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

function newInvitationId(): string {
  return `inv_${hex(crypto.getRandomValues(new Uint8Array(16)).buffer)}`;
}

async function adminScope(global: GlobalDb, userId: string, slug: string) {
  const workspace = await workspaceBySlug(global, slug);
  if (!workspace) return missingWorkspace();
  const actor = await actorOn(global, userId, workspace.id);
  if (!actor) return missingWorkspace();
  if (actor.role !== "admin") {
    return fail<never>("forbidden", "Only the workspace's admins manage members and invitations.");
  }
  return ok(workspace);
}

export interface InviteInput {
  userId: string;
  slug: string;
  email: string;
  role: WorkspaceRole;
  now: number;
}

/**
 * The seat limit of a workspace at `now`, with a condition that holds only while its plan row is
 * the one read: a write that takes a seat is conditioned on it, so a plan lowered or removed
 * between the read and the batch makes it a no-op instead of applying the old limit.
 */
export async function seatLimit(global: GlobalDb, workspaceId: string, now: number) {
  const p = schema.ownerPlans;
  const [row] = await global
    .select({
      plan: p.plan,
      seats: p.seats,
      validUntil: p.validUntil,
      overrides: p.overrides,
      updatedAt: p.updatedAt,
    })
    .from(p)
    .where(eq(p.ownerId, workspaceId))
    .limit(1);
  const guard = row
    ? sql`exists (select 1 from ${p} where ${p.ownerId} = ${workspaceId} and ${p.updatedAt} = ${row.updatedAt})`
    : sql`not exists (select 1 from ${p} where ${p.ownerId} = ${workspaceId})`;
  return { limit: entitlements(row ?? null, now).seats, guard };
}

/** Pending invitations to this address that a new one would replace. */
function replacedSql(workspaceId: string, email: string, now: number): SQL {
  return sql`(select count(*) from ${inv} where ${inv.workspaceId} = ${workspaceId} and ${inv.email} = ${email} and ${inv.expiresAt} > ${now})`;
}

function notSent(reason: "suppressed") {
  // Only the reason: never the address or the workspace.
  console.log(JSON.stringify({ event: "invitation_not_sent", reason }));
}

/**
 * Invites an address to a workspace and emails it the link, for an admin. Refused for a member's
 * address, a full month of emails (the same guard as expiry notices), a workspace without a free
 * seat and past the rate limits (per workspace, per admin and per recipient, the last keyed by a
 * hash of the address). A new invitation to the same address replaces the pending one in the
 * same statement, so a refused one keeps the earlier. A suppressed address gets the same answer
 * as any other, so admins cannot probe suppression: the invitation is stored, nothing is sent
 * and it expires unanswered. A send that fails for another reason withdraws it. Every email sent
 * is counted. The batch holds only while the caller is still an admin and the plan row is the
 * one the seat limit came from.
 */
export async function inviteMember(
  global: GlobalDb,
  input: InviteInput,
  sender: InvitationSender,
): Promise<Result<InvitationRow>> {
  const scope = await adminScope(global, input.userId, input.slug);
  if (!scope.ok) return scope;
  const workspace = scope.value;
  const email = normalizeEmail(input.email);

  const [member] = await global
    .select({ userId: m.userId })
    .from(m)
    .innerJoin(schema.users, eq(schema.users.id, m.userId))
    .where(and(eq(m.workspaceId, workspace.id), sql`lower(${schema.users.email}) = ${email}`))
    .limit(1);
  if (member) return fail("invalid_input", "That address already belongs to a member.");
  if (!checkNoticeCapacity(await emailsSentInCycle(global, input.now)).ok) {
    return fail(
      "capacity_unavailable",
      "Portifact sent all the invitation emails it can this month. Try again next month.",
    );
  }

  const { limit, guard: planUnchanged } = await seatLimit(global, workspace.id, input.now);
  const replaced = replacedSql(workspace.id, email, input.now);
  const [seat] = await global.all<{ used: number }>(
    sql`select ${seatsUsedSql(workspace.id, input.now, true)} - ${replaced} as used`,
  );
  const free = checkSeat(Number(seat?.used ?? 0), limit);
  if (!free.ok) return free;

  const client = global.$client;
  const limits: [string, { max: number; windowSeconds: number }][] = [
    [`invitations:workspace:${workspace.id}`, INVITATION_LIMITS.perWorkspacePerDay],
    [`invitations:admin:${input.userId}`, INVITATION_LIMITS.perAdminPerHour],
    [`invitations:recipient:${await emailHash(email)}`, INVITATION_LIMITS.perRecipientPerDay],
  ];
  let limited = false;
  for (const [key, rule] of limits) {
    const hits = await hitRateLimit(client, key, rule.windowSeconds * 1000, input.now);
    if (hits.count > rule.max) limited = true;
  }
  if (limited) return fail("rate_limited", "Too many invitations. Wait a while and try again.");

  const token = newInvitationToken();
  const id = newInvitationId();
  const eventId = newAuditEventId();
  const expiresAt = invitationExpiry(input.now);
  const tokenHash = await invitationTokenHash(token);
  const [inserted] = await global.batch([
    global
      .insert(inv)
      // Columns in schema order: id, workspace, email, role, token hash, invited by, created, expires.
      .select(
        sql`select ${id}, ${workspace.id}, ${email}, ${input.role}, ${tokenHash}, ${input.userId}, ${input.now}, ${expiresAt} where ${seatsUsedSql(workspace.id, input.now, true)} - ${replaced} < ${limit} and ${stillAdmin(workspace.id, input.userId)} and ${planUnchanged}`,
      )
      .onConflictDoUpdate({
        target: [inv.workspaceId, inv.email],
        set: {
          id: sql`excluded.id`,
          role: sql`excluded.role`,
          tokenHash: sql`excluded.token_hash`,
          invitedBy: sql`excluded.invited_by`,
          createdAt: sql`excluded.created_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      })
      .returning({ id: inv.id }),
    // Inviting someone again lifts an earlier removal for single sign-on (decision 0016).
    global
      .delete(schema.workspaceRemovals)
      .where(
        sql`${schema.workspaceRemovals.workspaceId} = ${workspace.id} and ${schema.workspaceRemovals.userId} in (select ${schema.users.id} from ${schema.users} where lower(${schema.users.email}) = ${email}) and exists (select 1 from ${inv} where ${inv.id} = ${id})`,
      ),
    // After the upsert, on the invitation it wrote (its ID is new to this request): the role and
    // the address's domain, never the address.
    auditEvent(
      global,
      {
        id: eventId,
        ownerId: workspace.id,
        kind: "member.invited",
        actor: { type: "user", id: input.userId },
        targetId: id,
        detail: { role: input.role, emailDomain: emailDomain(email) },
        now: input.now,
      },
      sql`exists (select 1 from ${inv} where ${inv.id} = ${id})`,
    ),
  ]);
  if (inserted.length === 0) {
    const again = await adminScope(global, input.userId, input.slug);
    if (!again.ok) return again;
    const now = await seatLimit(global, workspace.id, input.now);
    const [current] = await global.all<{ used: number }>(
      sql`select ${seatsUsedSql(workspace.id, input.now, true)} - ${replaced} as used`,
    );
    const seats = checkSeat(Number(current?.used ?? 0), now.limit);
    return seats.ok
      ? fail("version_conflict", "The workspace changed meanwhile. Try again.")
      : (seats as Result<never>);
  }

  const [inviter] = await global
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  const invitation = {
    id,
    email,
    role: input.role,
    invitedBy: inviter?.name ?? null,
    createdAt: input.now,
    expiresAt,
  };
  if (await isEmailSuppressed(global, email, input.now)) {
    notSent("suppressed");
    return ok(invitation);
  }
  try {
    await sender.send({
      to: email,
      token,
      workspaceName: workspace.name,
      inviterName: inviter?.name ?? "",
      role: input.role,
      expiresAt,
      locale: (await loadSettings(global, input.userId)).locale,
    });
  } catch (error) {
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(global, { email, reason: "provider", now: input.now });
      notSent("suppressed");
      return ok(invitation);
    }
    // The invitation is withdrawn, and so is its event: it never stood.
    await global.batch([
      global.delete(inv).where(and(eq(inv.id, id), eq(inv.tokenHash, tokenHash))),
      withdrawAuditEvent(global, eventId),
    ]);
    throw error;
  }
  await recordEmailsSent(global, input.now);
  return ok(invitation);
}

/** A workspace's pending invitations and its seats, for an admin. */
export async function listInvitations(
  global: GlobalDb,
  input: { userId: string; slug: string; now: number },
): Promise<Result<{ items: InvitationRow[]; seats: Seats }>> {
  const scope = await adminScope(global, input.userId, input.slug);
  if (!scope.ok) return scope;
  const items = await global
    .select({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: schema.users.name,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    })
    .from(inv)
    .leftJoin(schema.users, eq(schema.users.id, inv.invitedBy))
    .where(and(eq(inv.workspaceId, scope.value.id), gt(inv.expiresAt, input.now)))
    .orderBy(asc(inv.email));
  return ok({ items, seats: await workspaceSeats(global, scope.value.id, input.now) });
}

/** Revokes a pending invitation, for an admin; its link stops working and its seat is free. */
export async function revokeInvitation(
  global: GlobalDb,
  input: { userId: string; slug: string; invitationId: string; now?: number | undefined },
): Promise<Result<{ revoked: true }>> {
  const scope = await adminScope(global, input.userId, input.slug);
  if (!scope.ok) return scope;
  const where = and(
    eq(inv.id, input.invitationId),
    eq(inv.workspaceId, scope.value.id),
    stillAdmin(scope.value.id, input.userId),
  ) as SQL;
  const [, deleted] = await global.batch([
    auditEvent(
      global,
      {
        ownerId: scope.value.id,
        kind: "member.invitation_revoked",
        actor: { type: "user", id: input.userId },
        targetId: input.invitationId,
        detail: {},
        now: input.now ?? Date.now(),
      },
      sql`exists (select 1 from ${inv} where ${where})`,
    ),
    global.delete(inv).where(where).returning({ id: inv.id }),
  ]);
  if (deleted.length === 1) return ok({ revoked: true });
  const again = await adminScope(global, input.userId, input.slug);
  return again.ok ? fail("not_found", "Invitation not found.") : again;
}

export interface IncomingInvitation {
  id: string;
  workspace: { slug: string; name: string };
  role: WorkspaceRole;
  invitedBy: string | null;
  expiresAt: number;
}

async function account(global: GlobalDb, userId: string) {
  const [row] = await global
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row ?? null;
}

/** The pending invitations addressed to the signed-in account's verified email. */
export async function listIncomingInvitations(
  global: GlobalDb,
  input: { userId: string; now: number },
): Promise<IncomingInvitation[]> {
  const user = await account(global, input.userId);
  if (!user?.emailVerified) return [];
  const rows = await global
    .select({
      id: inv.id,
      slug: w.slug,
      name: w.name,
      role: inv.role,
      invitedBy: schema.users.name,
      expiresAt: inv.expiresAt,
    })
    .from(inv)
    .innerJoin(w, eq(w.id, inv.workspaceId))
    .leftJoin(schema.users, eq(schema.users.id, inv.invitedBy))
    .where(and(eq(inv.email, normalizeEmail(user.email)), gt(inv.expiresAt, input.now)))
    .orderBy(asc(w.name));
  return rows.map(({ slug, name, ...rest }) => ({ ...rest, workspace: { slug, name } }));
}

/** Names an invitation: the token from the email's link, or its ID from the invitee's list. */
export type InvitationKey = { token: string } | { invitationId: string };

async function findInvitation(global: GlobalDb, key: InvitationKey) {
  const where =
    "token" in key
      ? eq(inv.tokenHash, await invitationTokenHash(key.token))
      : eq(inv.id, key.invitationId);
  const [row] = await global
    .select({
      id: inv.id,
      workspaceId: inv.workspaceId,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
    })
    .from(inv)
    .where(where)
    .limit(1);
  return row ?? null;
}

async function inviteeScope(
  global: GlobalDb,
  input: { userId: string; key: InvitationKey; now: number },
) {
  const invitation = await findInvitation(global, input.key);
  if (!invitation) return fail<never>("not_found", MISSING_INVITATION);
  const user = await account(global, input.userId);
  if (!user) return fail<never>("not_found", MISSING_INVITATION);
  const allowed = checkInvitee(invitation, user, input.now);
  if (!allowed.ok) return allowed;
  return ok(invitation);
}

/**
 * Accepts an invitation for the signed-in account whose verified email it was sent to: one batch
 * adds the membership with the invited role, only while the invitation is still pending and the
 * workspace has a free seat, and deletes the invitation once the membership exists. A second
 * accept finds no invitation.
 */
export async function acceptInvitation(
  global: GlobalDb,
  input: { userId: string; key: InvitationKey; now: number },
): Promise<Result<UserWorkspace>> {
  const found = await inviteeScope(global, input);
  if (!found.ok) return found;
  const invitation = found.value;
  const { limit, guard: planUnchanged } = await seatLimit(
    global,
    invitation.workspaceId,
    input.now,
  );
  const pending = sql`exists (select 1 from ${inv} where ${inv.id} = ${invitation.id} and ${inv.expiresAt} > ${input.now})`;
  const member = sql`exists (select 1 from ${m} where ${m.workspaceId} = ${invitation.workspaceId} and ${m.userId} = ${input.userId})`;
  const active = sql`not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${input.userId})`;
  const joins = sql`${pending} and ${active} and not ${member} and ${seatsUsedSql(invitation.workspaceId, input.now, false)} < ${limit} and ${planUnchanged}`;
  const [, inserted, deleted] = (await global.batch([
    // Before the insert, on its own condition: a retried accept finds the member and records nothing.
    memberEvent(
      global,
      {
        workspaceId: invitation.workspaceId,
        memberId: input.userId,
        now: input.now,
        actor: { type: "user", id: input.userId },
      },
      "member.joined",
      { role: invitation.role },
      joins,
    ),
    global
      .insert(m)
      // Columns in schema order: workspace, user, role, created at, updated at.
      .select(
        sql`select ${invitation.workspaceId}, ${input.userId}, ${invitation.role}, ${input.now}, ${input.now} where ${joins}`,
      )
      .onConflictDoNothing()
      .returning({ userId: m.userId }),
    global
      .delete(inv)
      .where(and(eq(inv.id, invitation.id), member))
      .returning({ id: inv.id }),
  ])) as [unknown, unknown[], unknown[]];
  if (inserted.length === 0 && deleted.length === 0) {
    const still = await findInvitation(global, { invitationId: invitation.id });
    if (!still || still.expiresAt <= input.now) return fail("not_found", MISSING_INVITATION);
    // The seats or the plan changed meanwhile: answer from what holds now.
    const now = await seatLimit(global, invitation.workspaceId, input.now);
    const [current] = await global.all<{ used: number }>(
      sql`select ${seatsUsedSql(invitation.workspaceId, input.now, false)} as used`,
    );
    const seats = checkSeat(Number(current?.used ?? 0), now.limit);
    return seats.ok
      ? fail("version_conflict", "The workspace changed meanwhile. Try again.")
      : (seats as Result<never>);
  }
  const [row] = await global
    .select({
      id: w.id,
      slug: w.slug,
      name: w.name,
      region: w.region,
      createdAt: w.createdAt,
      role: m.role,
    })
    .from(m)
    .innerJoin(w, eq(w.id, m.workspaceId))
    .where(and(eq(m.workspaceId, invitation.workspaceId), eq(m.userId, input.userId)))
    .limit(1);
  if (!row) return fail("not_found", MISSING_INVITATION);
  return ok({ ...row, region: regionOf(row) });
}

/** Declines an invitation, for the account it was sent to; its seat is free again. */
export async function declineInvitation(
  global: GlobalDb,
  input: { userId: string; key: InvitationKey; now: number },
): Promise<Result<{ declined: true }>> {
  const found = await inviteeScope(global, input);
  if (!found.ok) return found;
  const deleted = await global
    .delete(inv)
    .where(eq(inv.id, found.value.id))
    .returning({ id: inv.id });
  return deleted.length === 1 ? ok({ declined: true }) : fail("not_found", MISSING_INVITATION);
}

/** Deletes invitations that expired (a maintenance scan); an expired one already holds no seat. */
export async function pruneExpiredInvitations(global: GlobalDb, now: number): Promise<number> {
  const deleted = await global.delete(inv).where(lte(inv.expiresAt, now)).returning({ id: inv.id });
  return deleted.length;
}
