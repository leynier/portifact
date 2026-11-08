// Sign-in code delivery refusals the auth pages show. Kept free of imports so the login page can
// use them without bundling the schemas (`@portifact/contracts/email-delivery`).

/**
 * Error code when a sign-in code is not sent because earlier mail to the address bounced
 * permanently or was reported as spam (docs/security.md, "Identity").
 */
export const EMAIL_SUPPRESSED = "email_suppressed";
