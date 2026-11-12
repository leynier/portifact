// Test doubles for the services' outside boundaries: Cloudflare and DNS (custom domains, email
// domain proofs) and an OpenID Connect identity provider (single sign-on). Tests and the e2e
// stack only; never imported by a deployed Worker.
export * from "./fake-domains.ts";
export * from "./fake-github-issuer.ts";
export * from "./fake-idp.ts";
export * from "./fake-issue-trackers.ts";
