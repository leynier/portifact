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
  EMAIL_SUPPRESSED_MESSAGE,
  fail,
  invitationExpiry,
  MISSING_INVITATION,
  normalizeEmail,
  ok,
  type Result,
} from "@portifact/domain";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { loadSettings } from "./account-settings.ts";
import { actorOn } from "./actors.ts";
import {
  emailsSentInCycle,
  isEmailSuppressed,
  RecipientSuppressedError,
  recordEmailsSent,
  suppressEmail,
} from "./email.ts";
import { hex } from "./objects.ts";
import { ownerEntitlements } from "./plans.ts";
import {
  missingWorkspace,
  regionOf,
  type Seats,
  seatsUsedSql,
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
 * Invites an address to a workspace and emails it the link, for an admin. Refused for a member's
 * address, a suppressed address, a full month of emails (the same guard as expiry notices), a
 * workspace without a free seat and past the rate limits (per workspace and per admin). A new
 * invitation to the same address replaces the pending one. When the email cannot be sent the
 * invitation is withdrawn, so nothing pending exists that nobody received. Every email sent is
 * counted.
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
  if (await isEmailSuppressed(global, email, input.now)) {
    return fail("email_suppressed", EMAIL_SUPPRESSED_MESSAGE);
  }
  if (!checkNoticeCapacity(await emailsSentInCycle(global, input.now)).ok) {
    return fail(
      "capacity_unavailable",
      "Portifact sent all the invitation emails it can this month. Try again next month.",
    );
  }

  const limit = (await ownerEntitlements(global, workspace.id, input.now)).seats;
  const replaced = sql`(select count(*) from ${inv} where ${inv.workspaceId} = ${workspace.id} and ${inv.email} = ${email} and ${inv.expiresAt} > ${input.now})`;
  const [seat] = await global.all<{ used: number; replaced: number }>(
    sql`select ${seatsUsedSql(workspace.id, input.now, true)} as used, ${replaced} as replaced`,
  );
  const used = Number(seat?.used ?? 0) - Number(seat?.replaced ?? 0);
  const free = checkSeat(used, limit);
  if (!free.ok) return free;

  const client = global.$client;
  const perWorkspace = INVITATION_LIMITS.perWorkspacePerDay;
  const perAdmin = INVITATION_LIMITS.perAdminPerHour;
  const workspaceHits = await hitRateLimit(
    client,
    `invitations:workspace:${workspace.id}`,
    perWorkspace.windowSeconds * 1000,
    input.now,
  );
  const adminHits = await hitRateLimit(
    client,
    `invitations:admin:${input.userId}`,
    perAdmin.windowSeconds * 1000,
    input.now,
  );
  if (workspaceHits.count > perWorkspace.max || adminHits.count > perAdmin.max) {
    return fail("rate_limited", "Too many invitations. Wait a while and try again.");
  }

  const token = newInvitationToken();
  const id = newInvitationId();
  const expiresAt = invitationExpiry(input.now);
  const [, inserted] = (await global.batch([
    global.delete(inv).where(and(eq(inv.workspaceId, workspace.id), eq(inv.email, email))),
    global
      .insert(inv)
      // Columns in schema order: id, workspace, email, role, token hash, invited by, created, expires.
      .select(
        sql`select ${id}, ${workspace.id}, ${email}, ${input.role}, ${await invitationTokenHash(token)}, ${input.userId}, ${input.now}, ${expiresAt} where ${seatsUsedSql(workspace.id, input.now, true)} < ${limit} and exists (select 1 from ${w} where ${w.id} = ${workspace.id})`,
      )
      .returning({ id: inv.id }),
  ])) as [unknown, unknown[]];
  if (inserted.length === 0) return checkSeat(limit, limit) as Result<never>;

  const [inviter] = await global
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  const withdraw = () => global.delete(inv).where(eq(inv.id, id));
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
    await withdraw();
    if (error instanceof RecipientSuppressedError) {
      await suppressEmail(global, { email, reason: "provider", now: input.now });
      return fail("email_suppressed", EMAIL_SUPPRESSED_MESSAGE);
    }
    throw error;
  }
  await recordEmailsSent(global, input.now);
  return ok({
    id,
    email,
    role: input.role,
    invitedBy: inviter?.name ?? null,
    createdAt: input.now,
    expiresAt,
  });
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
  input: { userId: string; slug: string; invitationId: string },
): Promise<Result<{ revoked: true }>> {
  const scope = await adminScope(global, input.userId, input.slug);
  if (!scope.ok) return scope;
  const deleted = await global
    .delete(inv)
    .where(and(eq(inv.id, input.invitationId), eq(inv.workspaceId, scope.value.id)))
    .returning({ id: inv.id });
  return deleted.length === 1 ? ok({ revoked: true }) : fail("not_found", "Invitation not found.");
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
  const limit = (await ownerEntitlements(global, invitation.workspaceId, input.now)).seats;
  const pending = sql`exists (select 1 from ${inv} where ${inv.id} = ${invitation.id} and ${inv.expiresAt} > ${input.now})`;
  const member = sql`exists (select 1 from ${m} where ${m.workspaceId} = ${invitation.workspaceId} and ${m.userId} = ${input.userId})`;
  const active = sql`not exists (select 1 from ${schema.accountDeletions} where ${schema.accountDeletions.userId} = ${input.userId})`;
  const [inserted, deleted] = (await global.batch([
    global
      .insert(m)
      // Columns in schema order: workspace, user, role, created at, updated at.
      .select(
        sql`select ${invitation.workspaceId}, ${input.userId}, ${invitation.role}, ${input.now}, ${input.now} where ${pending} and ${active} and not ${member} and ${seatsUsedSql(invitation.workspaceId, input.now, false)} < ${limit}`,
      )
      .onConflictDoNothing()
      .returning({ userId: m.userId }),
    global
      .delete(inv)
      .where(and(eq(inv.id, invitation.id), member))
      .returning({ id: inv.id }),
  ])) as [unknown[], unknown[]];
  if (inserted.length === 0 && deleted.length === 0) {
    const still = await findInvitation(global, { invitationId: invitation.id });
    if (!still || still.expiresAt <= input.now) return fail("not_found", MISSING_INVITATION);
    return checkSeat(limit, limit) as Result<never>;
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
