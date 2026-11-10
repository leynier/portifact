// Share link rules (premium plan P4, decision 0008): when a link is active, when it opens, how
// long its session lasts, and when password attempts need the human check or are locked. Pure:
// the services apply them with D1, and the content Worker checks the plan per request.
import { SHARE_LINKS, SHARE_OPEN_LIMITS } from "@portifact/contracts";
import { type Entitlements, hasFeature } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

const SECOND_MS = 1000;
const DAY_MS = 86_400_000;

/** Messages of the entry; one for every link that does not open, so none tells them apart. */
export const SHARE_MESSAGES = {
  unavailable: "This share link has expired, was revoked or does not exist.",
  passwordRequired: "This link needs a password.",
  refused: "The password is wrong, or the link expired or was revoked.",
  humanCheck: "Confirm you are human to try the password again.",
  locked: "Too many wrong passwords. Try again later.",
} as const;

export interface ShareLinkRecord {
  expiresAt: number | null;
  revokedAt: number | null;
}

export type ShareLinkStatus = "active" | "expired" | "revoked";

export function shareLinkStatus(link: ShareLinkRecord, now: number): ShareLinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt <= now) return "expired";
  return "active";
}

/**
 * Checks a requested expiry: in the future and at most `SHARE_LINKS.maxExpiryDays` ahead. Null
 * (no expiry) is allowed.
 */
export function checkShareExpiry(expiresAt: number | null, now: number): Result<number | null> {
  if (expiresAt === null) return ok(null);
  if (expiresAt <= now) return fail("invalid_input", "expiresAt: Choose a time in the future.");
  if (expiresAt > now + SHARE_LINKS.maxExpiryDays * DAY_MS) {
    return fail(
      "invalid_input",
      `expiresAt: A link can last at most ${SHARE_LINKS.maxExpiryDays} days.`,
    );
  }
  return ok(expiresAt);
}

/** What decides whether a link opens now. */
export interface ShareOpening {
  link: ShareLinkRecord;
  /** The artifact is active, unexpired, has a current version and is not suspended. */
  servable: boolean;
  /** The artifact owner's plan, never the visitor's or the creator's. */
  owner: Entitlements;
}

/**
 * A link opens only while it is active, its artifact is servable and the owner's plan includes
 * share links. A plan that loses the feature pauses every link of the owner without deleting
 * any; they open again when the feature returns.
 */
export function shareLinkOpens(opening: ShareOpening, now: number): boolean {
  return (
    shareLinkStatus(opening.link, now) === "active" &&
    opening.servable &&
    hasFeature(opening.owner, "shareLinks")
  );
}

/** When a link session that starts at `now` ends: 12 hours, or the link's expiry if sooner. */
export function shareSessionExpiry(linkExpiresAt: number | null, now: number): number {
  const longest = now + SHARE_LINKS.sessionTtlSeconds * SECOND_MS;
  return linkExpiresAt === null ? longest : Math.min(longest, linkExpiresAt);
}

/** The start of the UTC day of `at`: the coarse "last used" the owner sees. */
export function shareUsedDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/**
 * Password attempts counted in the current window, this one included: per token, per IP and per
 * token and IP together. They are counted atomically before the password is checked, so
 * parallel attempts see different counts.
 */
export interface PasswordAttempts {
  token: number;
  ip: number;
  tokenIp: number;
}

export type PasswordGate = "allowed" | "human_check" | "locked";

/**
 * Whether a password attempt may be checked. `locked` only for one token from one IP past its
 * limit, or for a token past its ceiling (which takes that many solved human checks to reach),
 * so nobody can cheaply lock other people out of a link. Past the earlier thresholds, per token
 * or per IP, the attempt needs a solved human check, which a visitor with the right password
 * passes. The token's counter is keyed by its hash, so unknown tokens are gated like real ones.
 */
export function passwordGate(attempts: PasswordAttempts): PasswordGate {
  if (
    attempts.tokenIp > SHARE_OPEN_LIMITS.tokenIpLockAfter ||
    attempts.token > SHARE_OPEN_LIMITS.tokenCeiling
  ) {
    return "locked";
  }
  if (
    attempts.token > SHARE_OPEN_LIMITS.tokenHumanCheckAfter ||
    attempts.ip > SHARE_OPEN_LIMITS.ipHumanCheckAfter
  ) {
    return "human_check";
  }
  return "allowed";
}
