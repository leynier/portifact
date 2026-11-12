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

/**
 * The scopes whose operations a person's OAuth token (the CLI, MCP clients) may still use while
 * the account has not accepted the current terms: reading and downloading, which is how a person
 * takes their data out (`portifact export`, `pull`, `annotations export`) before deciding. Every
 * operation of another scope is refused with `terms_not_accepted` until the account accepts in
 * the dashboard (docs/legal.md, "API and MCP clients"). Every operation of these two scopes only
 * reads; a new operation that changes anything must not take one of them.
 */
export const TERMS_EXEMPT_SCOPES: readonly string[] = ["artifacts:read", "annotations:read"];

/**
 * Whether an operation that needs `scopes` stays available to an account without the current
 * terms. An operation that needs no scope (who the token belongs to) does.
 */
export function usableWithoutCurrentTerms(scopes: readonly string[]): boolean {
  return scopes.every((scope) => TERMS_EXEMPT_SCOPES.includes(scope));
}

/**
 * What a person's token is told when the account must accept the current terms first. It names
 * where to do it and says that no app or agent can do it for them.
 */
export function termsRefusalMessage(
  appOrigin: string,
  options: { version?: string; agent?: boolean } = {},
): string {
  const message = `This Portifact account has not accepted the current terms (version ${options.version ?? TERMS_VERSION}). Its holder must open ${appOrigin} in a browser, review the terms and select Agree and continue; no app or agent can accept them for the holder. Reading and downloading keep working until then.`;
  // An MCP client's agent reads it: it must hand the decision to the person, never make it.
  return options.agent
    ? `${message} Ask the user to do it, and do not retry until they say they have.`
    : message;
}
