// The account deletion code (docs/legal.md, "Leaving without accepting"; docs/security.md,
// "Identity"): how a person whose account has not accepted the current terms proves they hold it
// now and deletes it, without a sign-in (every sign-in records an acceptance) and without
// accepting. These are its rules; the services apply them with D1 and the app sends the email.
import { ACCOUNT_DELETION_CODE } from "@portifact/contracts";
import { needsTermsAcceptance } from "./terms.ts";

/**
 * Whether an account may ask for and use a deletion code: only while it has not accepted the
 * current terms. An account that accepted them deletes itself from Settings, with a recent
 * sign-in, so this path never adds a second way for it.
 */
export function mayLeaveWithCode(acceptedVersion: string | null | undefined): boolean {
  return needsTermsAcceptance(acceptedVersion);
}

/** The largest multiple of 1,000,000 below 2^32: draws at or above it are thrown away. */
const UNBIASED_LIMIT = 4_294_000_000;

/**
 * Six digits from uniformly random 32-bit draws, without the bias a plain remainder would give.
 * `draw` returns a random unsigned 32-bit integer (crypto.getRandomValues in the services).
 */
export function deletionCodeFrom(draw: () => number): string {
  for (;;) {
    const value = draw() >>> 0;
    if (value < UNBIASED_LIMIT) return String(value % 1_000_000).padStart(6, "0");
  }
}

/** When a code issued at `now` stops working. */
export function deletionCodeExpiresAt(now: number): number {
  return now + ACCOUNT_DELETION_CODE.codeTtlSeconds * 1000;
}

/**
 * Whether a stored code can still be tried: not expired and attempts left. The services' SQL
 * claims a code on exactly these conditions (`redeemableSql`).
 */
export function deletionCodeRedeemable(
  code: { expiresAt: number; attempts: number },
  now: number,
): boolean {
  return code.expiresAt > now && code.attempts < ACCOUNT_DELETION_CODE.allowedAttempts;
}
