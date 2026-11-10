# 0016 Single sign-on for workspaces with OpenID Connect, switched off

- Status: accepted for the first delivery (OIDC only); SAML and "SSO required" open
- Date: 2026-11-10
- Builds on: [0001](0001-oauth-server.md) (Better Auth), [0004](0004-workspace-model.md) (workspace model, SSO spike), [0010](0010-workspace-access-modes.md) (verified email domains)

## Context

Premium plan E1 gives an Enterprise workspace single sign-on (feature `sso` in `PLANS`). Decision 0004 chose `@better-auth/sso` without the organization plugin and left open how SAML keeps "no account or session without the current terms accepted", and listed what to verify before shipping: a wrangler-built bundle, samlify's `node:crypto` use and newer Better Auth versions.

## Decision

1. **OpenID Connect only.** SAML stays unbuilt: no SAML endpoint exists, and the route inventory test (`apps/app/test/sso.test.ts`) proves every SAML and provider-administration path of the plugin answers 404.
2. **Own OIDC flow over Better Auth, not `@better-auth/sso`.** A small Better Auth plugin (`apps/app/src/auth/sso.ts`, about 300 lines) with two endpoints, `POST /sign-in/sso` and `GET /sso/callback/:providerId`, built on Better Auth's public OAuth helpers: `generateState`/`parseState` (state bound to a signed cookie and a verification row, PKCE verifier, ID token nonce), `createAuthorizationURL`, `handleOAuthUserInfo` (account creation and linking through the same database hooks as every method) and `setSessionCookie`. `jose` (already shipped inside Better Auth, MIT) verifies the ID token. The plugin is not used because of the numbers below, because it stores the client secret in plain JSON in its own table, and because its discovery only works for issuers in the global `trustedOrigins`.
3. **The provider speaks only for the workspace's verified domains.** `workspace_sso` (global, one per workspace) lists which of the workspace's `verified` `workspace_domains` it serves; they are re-read at every sign-in (`liveSsoDomains`), so a domain that lapses stops its addresses at once. The ID token's `email` must be in a live domain (exact match, never a subdomain), and an identity already linked to an account whose address left the domains is refused (`checkSsoIdentity`). The provider's `email_verified` claim is never read: the domain proof is what vouches for the address, so the account is created or linked as verified and Better Auth's linking joins an existing account only with the same address (`allowDifferentEmails: false`, `requireLocalEmailVerified`). An identity provider asserting someone else's address inside its own domain is the customer's own domain and allowed; outside it, refused with `sso_email_outside_domain`, before anything is created or linked.
4. **Terms and human check unchanged.** The callback is a top-level GET, so the `SameSite=Lax` acceptance and human-check cookies arrive: a new account needs both, an account on an old terms version is refused until it accepts, and the login page's SSO step sits under a notice that names single sign-on (`login.termsNoticeSso`) with the same conditions and links.
5. **Membership.** After the account and session exist and before the session cookie is handed over, `joinWorkspaceThroughSso` adds the person as `member` (or with the role of a pending invitation to their address, which is consumed), in one batch conditioned on a free seat (members plus pending invitations, their own invitation's seat being the one they take) and on the plan row read, recorded as `member.joined` with `via: "sso"`. An existing member keeps their role. A full workspace deletes the new session and sends the person back to the login page with `sso_workspace_full`; the account stays (it accepted the terms). Removing a person at the identity provider does not remove them in Portifact: that is SCIM (E2).
6. **Configuration.** Admins only (role action `sso`), only through the dashboard session (`/api/v1/workspaces/:slug/sso`, `PUT`, `DELETE`, `POST /test`), never a bearer token, an MCP tool or a CLI command. The issuer is a public https URL (the webhook rule `checkPublicHttpsUrl`, extracted from `checkWebhookUrl`), checked by discovery on every save and test: issuer equal to the document's, every endpoint passing the same rule, the code flow offered, PKCE S256 not ruled out, an asymmetric signature algorithm listed. Every call to the provider follows no redirect, takes at most 5 seconds and reads at most 64 KiB (`fetchSsoJson`), and the Worker's `global_fetch_strictly_public` keeps private addresses out at the network. The issuer of a saved provider cannot change: a new issuer is a new provider with a new ID, so identities of one issuer never sign in through another (`accounts.provider_id` is `sso:<id>`). The client secret is sealed with AES-256-GCM under `SSO_KEY` (HKDF, bound to the workspace and the column, `SSO_KEY_PREVIOUS` during a rotation), never returned or logged. A separate key from `WEBHOOK_KEY` so the two features rotate, leak and switch on independently. Creating and changing need `sso` in the workspace's plan; removing never does; a lapsed plan stops sign-ins and keeps the row.
7. **Switched off.** Nothing is reachable unless the app Worker has `SSO_ENABLED="true"`, which no `wrangler.jsonc` sets: the sign-in endpoints and the login page's lookup answer 404, the provider routes `capacity_unavailable`, the dashboard section hides itself and the login page sends an email code as before.
8. **Login page disclosure.** `POST /api/auth/sso/lookup` answers only `{ sso: boolean }` for an address: whether its domain is verified by some workspace with a live provider. It never names the workspace or the provider; the domain itself already implies an organization. It is limited per IP (60 an hour), like the other login endpoints.
9. **Audit.** `sso.created` (issuer host and the number of domains), `sso.changed` (which fields) and `sso.removed`, global, never the client ID or secret; `member.joined` gains `via`.
10. **Deletion and restore.** The provider goes with its workspace (foreign key). Removing it deletes the row and the identities linked through it and writes a `workspace_sso` tombstone in the same batch; `applyTombstones` deletes both again after a D1 Time Travel restore. Account deletion removes the linked identity (Better Auth's `accounts` cascade from `users`).

## Bundle numbers

Measured with `wrangler deploy --dry-run` of `apps/app` on 2026-11-10:

| Build                                   | Upload      | Gzip        |
| --------------------------------------- | ----------- | ----------- |
| `develop` before this change            | 5,531.5 KiB | 1,087.7 KiB |
| With `@better-auth/sso` 1.7.18 imported | 7,000.4 KiB | 1,373.6 KiB |
| This change (own OIDC plugin, `jose`)   | 5,575.8 KiB | 1,099.0 KiB |

This change adds 44 KiB (11 KiB gzip) and no SAML or XML library. The plugin would add about 1,469 KiB (286 KiB gzip) and bundles `samlify`, `xml-crypto`, `@xmldom/xmldom` and `node:crypto`'s `X509Certificate` even with SAML unused: its package has a single entry point that imports SAML at the top, so no subpath brings only OIDC. `jose` is already in the bundle through Better Auth.

## SAML: open question for the maintainer

SAML's assertion consumer is a cross-site `POST` from the identity provider, so the browser never sends the `SameSite=Lax` cookies `__Host-pf_terms` and `__Host-pf_human` (decision 0004, section 5, run). A new person could not get an account, and every SAML user would be locked out after a `TERMS_VERSION` change. The options:

- **(a) Pending sign-in and a first-party finish.** The ACS verifies the assertion, stores a short-lived, single-use pending sign-in (keyed by a random ID in a `SameSite=Lax` cookie it sets on the 303) and redirects to a first-party page on `app.portifact.com`; that page shows the sign-in-wrap notice and a "Continue" button that records the acceptance and the human check and completes the sign-in. Keeps the legal rule exactly as for every other method; costs a custom endpoint and one extra click for new people and after a terms change.
- **(b) SAML only for accounts on the current terms.** The ACS signs in only existing accounts that accepted the current version, and refuses others with a page that sends them through another method (email code) to accept first. Simple, but a new person cannot join through SAML alone, which is most of what an enterprise wants.
- **(c) `SameSite=None` on the acceptance cookies.** Weakens both cookies (any site could make a browser carry them) for every sign-in method. Not recommended.

**Recommendation: (a).** It keeps "no account or session without the current terms accepted" and the human check identical for every method, and the pending record is the same pattern as the read handoff. It needs a lawyer's confirmation that a click on the first-party page after the identity provider is a valid acceptance, like the sign-in-wrap today.

## "SSO required": left out of this delivery

A setting that makes a workspace's members act on it only with a session that came from its SSO cannot be enforced cleanly yet: roles are decided only in `resolveActor`/`actorOn`, which know the user but not the session, and the OAuth access tokens of the CLI and MCP are bound to a session only indirectly. Enforcing it would mean carrying the session's sign-in method and age into every actor resolution (a claim on the session row read in the same query) and deciding what a token minted before the setting, a service token and an MCP client get. Shipping a setting that only the dashboard honors would be worse than none, so it is not built. It returns with SCIM (E2) or on its own record.

## What was not verified

No real identity provider was used: every test runs the fake provider in `@portifact/services/testing` (`FakeIdentityProvider`, RS256 with WebCrypto), and the e2e stack serves it at `login.sso-e2e.example.com`. Okta, Microsoft Entra ID and Google Workspace must be checked before turning it on ([releasing.md](../releasing.md), "SSO").

A sign-in started by an OAuth client (an MCP client's authorization request on the login page) lands on the dashboard after single sign-on instead of continuing the client's request; the person connects the client again and it finds the session. Carrying the signed request through the identity provider is left for later.
