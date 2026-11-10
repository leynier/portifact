import { type AccessMode, LIMITS } from "@portifact/contracts";
import { type Actor, actsForOwner } from "./actor.ts";
import { fail, ok, type Result } from "./result.ts";

const MINUTE_MS = 60 * 1000;

export interface AccessPolicy {
  mode: AccessMode;
  ownerId: string;
  /** Lowercased email addresses allowed in `restricted` mode. */
  readers: readonly string[];
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
 * Readers listed by email are not members and keep reading through the list.
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
  const readers = new Set(policy.readers);
  if (viewer.verifiedEmails.some((email) => readers.has(email))) return ok(true);
  return fail("forbidden", "Your account does not have access to this artifact.");
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
