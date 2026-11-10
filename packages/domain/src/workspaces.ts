// Workspace rules (premium plan T1, decision 0004): seats, the last admin, invitations and
// transfers. Pure; the services apply them in D1 batches and the database repeats the ones a race
// could break (the last admin, the target's limits).
import {
  INVITATION_LIMITS,
  type Region,
  WorkspaceName,
  type WorkspaceRole,
  WorkspaceSlug,
} from "@portifact/contracts";
import { normalizeEmail } from "./email.ts";
import { formatSize } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** When an invitation sent at `now` stops being valid. */
export function invitationExpiry(now: number): number {
  return now + INVITATION_LIMITS.ttlDays * DAY_MS;
}

/**
 * Whether one more seat can be taken: members and pending invitations count, external readers do
 * not. A workspace whose plan expired has the free plan's single seat, so it adds nobody until it
 * is back under the cap; nobody is ever removed for being over it.
 */
export function checkSeat(used: number, limit: number): Result<true> {
  if (used < limit) return ok(true);
  return fail(
    "seats_exhausted",
    `The workspace uses all of its ${limit} seat${limit === 1 ? "" : "s"}. Remove a member or revoke an invitation, or ask the operator for more seats.`,
  );
}

const lastAdmin = (doing: string) =>
  fail<never>(
    "sole_workspace_admin",
    `You cannot ${doing} the workspace's only admin. Make another member an admin first.`,
  );

/** Whether a member's role may change: the last admin cannot be demoted. */
export function checkRoleChange(
  current: WorkspaceRole,
  next: WorkspaceRole,
  admins: number,
): Result<true> {
  if (current === "admin" && next !== "admin" && admins <= 1) return lastAdmin("demote");
  return ok(true);
}

/** Whether a member may be removed, or leave: the last admin cannot. */
export function checkRemoval(role: WorkspaceRole, admins: number, leaving: boolean): Result<true> {
  if (role === "admin" && admins <= 1) {
    return leaving
      ? fail(
          "sole_workspace_admin",
          "You are the workspace's only admin. Make another member an admin before you leave, or ask Portifact at hello@portifact.com to delete the workspace.",
        )
      : lastAdmin("remove");
  }
  return ok(true);
}

/** What the invited person sees for an invitation that is not theirs, expired or used. */
export const MISSING_INVITATION = "This invitation does not exist, expired or was already used.";

/**
 * Whether the signed-in account may accept or decline an invitation: only its verified email may,
 * and only before it expires. Anything else answers like a missing invitation, so a link reveals
 * nothing to someone else.
 */
export function checkInvitee(
  invitation: { email: string; expiresAt: number },
  account: { email: string; emailVerified: boolean },
  now: number,
): Result<true> {
  if (
    !account.emailVerified ||
    normalizeEmail(account.email) !== normalizeEmail(invitation.email) ||
    invitation.expiresAt <= now
  ) {
    return fail("not_found", MISSING_INVITATION);
  }
  return ok(true);
}

/** Slugs no workspace may take. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["personal"]);

/** Validates the operator's input for a new workspace. */
export function checkNewWorkspace(input: {
  slug: string;
  name: string;
}): Result<{ slug: string; name: string }> {
  const slug = WorkspaceSlug.safeParse(input.slug);
  if (!slug.success) {
    return fail(
      "invalid_input",
      "The slug must be 1 to 40 lowercase letters, digits or inner hyphens.",
    );
  }
  // `personal` names the personal space wherever a slug is accepted (the CLI's --workspace).
  if (RESERVED_SLUGS.has(slug.data)) {
    return fail("invalid_input", `The slug ${slug.data} is reserved.`);
  }
  const name = WorkspaceName.safeParse(input.name);
  if (!name.success) return fail("invalid_input", "The name must be 1 to 100 characters.");
  return ok({ slug: slug.data, name: name.data });
}

/**
 * Whether the artifact's current version fits the target plan's per-artifact size, the same
 * limit and message a publish there would meet.
 */
export function checkTransferSize(versionBytes: number, artifactBytes: number): Result<true> {
  if (versionBytes > artifactBytes) {
    return fail(
      "quota_exceeded",
      `An artifact version can be at most ${formatSize(artifactBytes)}.`,
    );
  }
  return ok(true);
}

/** States an artifact can be moved in: not while it is drafted, suspended or being purged. */
const TRANSFERABLE = new Set(["active", "archived"]);

/** Whether an artifact may move from one owner to another. */
export function checkTransfer(
  artifact: { state: string; ownerId: string },
  source: { region: Region },
  target: { ownerId: string; region: Region },
): Result<true> {
  if (artifact.ownerId === target.ownerId) {
    return fail("invalid_input", "The artifact is already in that space.");
  }
  if (source.region !== target.region) {
    return fail("invalid_input", "An artifact cannot move between regions.");
  }
  if (!TRANSFERABLE.has(artifact.state)) {
    return fail(
      "artifact_archived",
      "Only an active or archived artifact can move. Finish its first publish, or wait for a suspension to end.",
    );
  }
  return ok(true);
}
