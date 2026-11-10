import { type AccessMode, type CommentScope, isWorkspaceId, LIMITS } from "@portifact/contracts";
import { type Actor, actsForOwner } from "./actor.ts";
import { emailDomainOf } from "./email-domains.ts";
import { fail, ok, type Result } from "./result.ts";

const MINUTE_MS = 60 * 1000;

export interface AccessPolicy {
  mode: AccessMode;
  ownerId: string;
  /** Lowercased email addresses allowed in `restricted` mode. */
  readers: readonly string[];
  /**
   * For `domain` (decision 0010): whether the owner's plan includes `workspaces`, and the owner's
   * verified email domains (normalized A-labels; the services pass only the one matching the
   * viewer, if any). Absent, no domain grants anything.
   */
  domains?: { featureAvailable: boolean; verified: readonly string[] } | undefined;
  /**
   * Groups (decision 0014): whether the owner's plan includes `workspaces`, and the groups the
   * artifact lists that the viewer belongs to (the services pass only those, read from the
   * global membership). Absent, no group grants anything.
   */
  groups?: GroupMatch | undefined;
}

/** The groups listed on an artifact that the viewer is a member of, with their exceptions. */
export interface GroupMatch {
  featureAvailable: boolean;
  matched: readonly { id: string; commentVisibility: CommentScope | null }[];
}

/** The viewer as established by the session; never from request input. */
export interface Viewer {
  userId: string;
  /** Lowercased, verified email addresses of the account. */
  verifiedEmails: readonly string[];
}

/**
 * Decides whether a viewer may read an artifact. `unauthenticated` means signing in could
 * grant access; `forbidden` means the signed-in account has no access. `actor` is the viewer's
 * role on the artifact's owner (from `resolveActor`), null when they have none: an admin or
 * editor of the owner reads every artifact of it, as the owner of a personal space always has.
 * Readers listed by email are not members and keep reading through the list, in `restricted`
 * only. `workspace` admits every member of the owning workspace, whatever the plan; `domain`
 * admits members and, while the owner's plan includes `workspaces`, verified addresses at one of
 * its verified email domains, matched exactly (decision 0010). A `restricted` artifact of a
 * workspace also admits the workspace's members who belong to a group it lists, while the plan
 * includes `workspaces` (decision 0014); groups never apply to a personal artifact.
 */
export function canRead(
  policy: AccessPolicy,
  viewer: Viewer | null,
  actor: Actor | null,
): Result<true> {
  if (policy.mode === "public") return ok(true);
  if (!viewer) return fail("unauthenticated", "Sign in to open this artifact.");
  if (actor?.userId === viewer.userId && actsForOwner(actor, policy.ownerId)) return ok(true);
  if (policy.mode === "authenticated") return ok(true);
  if (policy.mode === "restricted") {
    const readers = new Set(policy.readers);
    if (viewer.verifiedEmails.some((email) => readers.has(email))) return ok(true);
    if (groupAdmits(policy, viewer, actor)) return ok(true);
    return refused();
  }
  // `workspace` and `domain` name a workspace's people; a personal owner has none (an artifact
  // moved out keeps only its owner side until the transfer's reset is visible).
  if (!isWorkspaceId(policy.ownerId)) return refused();
  if (isMember(policy.ownerId, viewer, actor)) return ok(true);
  if (policy.mode === "domain" && policy.domains?.featureAvailable) {
    const verified = new Set(policy.domains.verified);
    if (viewer.verifiedEmails.some((email) => verified.has(emailDomainOf(email) ?? ""))) {
      return ok(true);
    }
  }
  return refused();
}

const refused = () =>
  fail<never>("forbidden", "Your account does not have access to this artifact.");

/**
 * A listed group admits only members of the owning workspace (the membership the role came
 * from), and only while the plan includes `workspaces`: a lapsed plan makes groups grant nothing,
 * never wider (decision 0014).
 */
function groupAdmits(policy: AccessPolicy, viewer: Viewer, actor: Actor | null): boolean {
  if (!isWorkspaceId(policy.ownerId) || !isMember(policy.ownerId, viewer, actor)) return false;
  return policy.groups?.featureAvailable === true && policy.groups.matched.length > 0;
}

function isMember(ownerId: string, viewer: Viewer, actor: Actor | null): boolean {
  return actor?.userId === viewer.userId && actor.ownerId === ownerId;
}

/** New accounts cannot make artifacts public during their first minutes (abuse protection). */
export function checkAccessChange(
  mode: AccessMode,
  accountCreatedAt: Date,
  now: Date,
): Result<true> {
  if (mode !== "public") return ok(true);
  const ageMs = now.getTime() - accountCreatedAt.getTime();
  if (ageMs < LIMITS.publicAccessMinAccountAgeMinutes * MINUTE_MS) {
    return fail(
      "account_too_new_for_public",
      `Accounts can make artifacts public ${LIMITS.publicAccessMinAccountAgeMinutes} minutes after they are created.`,
    );
  }
  return ok(true);
}
