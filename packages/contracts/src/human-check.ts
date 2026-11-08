// The human check (Cloudflare Turnstile) on account creation and on an account's first comments
// on other people's artifacts (plan section 13). Kept free of imports so the auth pages can use
// it without bundling the schemas (`@portifact/contracts/human-check`).

/**
 * Error code when an operation needs a solved human check first: creating an account, or one of
 * the first comments on another person's artifact. Clients that cannot show the challenge (CLI,
 * MCP) get it too; those comments must be posted from the review viewer.
 */
export const HUMAN_VERIFICATION_REQUIRED = "human_verification_required";

/** Origin that serves the Turnstile script and its challenge frame. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The Turnstile script, rendered explicitly by the page that needs it. */
export const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/** Name of the `<meta>` through which the app host gives its pages the public site key. */
export const TURNSTILE_SITE_KEY_META = "portifact-turnstile-site-key";

/** The `action` each widget declares, shown in Turnstile analytics. */
export const HUMAN_CHECK_ACTIONS = { signUp: "sign-up", comment: "comment" } as const;

/** Turnstile tokens are at most 2,048 characters. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
