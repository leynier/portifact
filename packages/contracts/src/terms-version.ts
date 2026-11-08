// Kept free of imports so the auth pages can use it without bundling the schemas
// (`@portifact/contracts/terms-version`).

/**
 * Version of the Terms of Service, Privacy Policy and Acceptable Use Policy, as their effective
 * date. The three pages show it, the login page sends it, and accounts store the version they
 * accepted. Changing it asks every account to accept again at its next sign-in.
 */
export const TERMS_VERSION = "2026-11-08";

/** Error code when a sign-in or a session needs the current terms to be accepted first. */
export const TERMS_NOT_ACCEPTED = "terms_not_accepted";
