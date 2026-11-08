import { TERMS_VERSION } from "@portifact/contracts";

/**
 * Whether an account must accept the terms before it gets a session: it never accepted them,
 * or it accepted a version that is no longer current.
 */
export function needsTermsAcceptance(
  acceptedVersion: string | null | undefined,
  currentVersion: string = TERMS_VERSION,
): boolean {
  return acceptedVersion !== currentVersion;
}
