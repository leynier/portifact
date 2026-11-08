import { type AccessMode, LIMITS } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * grant access; `forbidden` means the signed-in account has no access.
 */
export function canRead(policy: AccessPolicy, viewer: Viewer | null): Result<true> {
  if (policy.mode === "public") return ok(true);
  if (!viewer) return fail("unauthenticated", "Sign in to open this artifact.");
  if (viewer.userId === policy.ownerId) return ok(true);
  if (policy.mode === "authenticated") return ok(true);
  const readers = new Set(policy.readers);
  if (viewer.verifiedEmails.some((email) => readers.has(email))) return ok(true);
  return fail("forbidden", "Your account does not have access to this artifact.");
}

/** Only the owner manages an artifact: publishing, access, renewal, restore and deletion. */
export function canManage(policy: AccessPolicy, viewer: Viewer | null): Result<true> {
  if (!viewer) return fail("unauthenticated", "Sign in to manage this artifact.");
  if (viewer.userId !== policy.ownerId) return fail("forbidden", "Only the owner can do this.");
  return ok(true);
}

/** New accounts cannot make artifacts public during their first days (abuse protection). */
export function checkAccessChange(
  mode: AccessMode,
  accountCreatedAt: Date,
  now: Date,
): Result<true> {
  if (mode !== "public") return ok(true);
  const ageMs = now.getTime() - accountCreatedAt.getTime();
  if (ageMs < LIMITS.publicAccessMinAccountAgeDays * DAY_MS) {
    return fail(
      "account_too_new_for_public",
      `Accounts can make artifacts public after ${LIMITS.publicAccessMinAccountAgeDays} days.`,
    );
  }
  return ok(true);
}
