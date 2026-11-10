# 0004 Workspace model: own tables, Better Auth for identity and SSO sign-in

- Status: proposed
- Date: 2026-11-10
- Spike: [spikes/workspace-model](../../spikes/workspace-model) (S1 of the paid-plans plan)

## Context

The paid plans add workspaces (F3: an owner that is a workspace, with members, the roles `admin`, `editor` and `member`, and invitations), then SSO with SAML and OIDC per workspace (E1) and SCIM 2.0 (E2). An artifact's `owner_id` will hold a user ID or a workspace ID, and the role must always be resolved in `packages/services` from the membership, never in an adapter.

Identity is Better Auth 1.7.18, pinned exactly, on Workers with D1 through Drizzle, with only the endpoints in `apps/app/src/auth/routes.ts` reachable and every account and session gated by the terms and human-check hooks. The question: build workspaces on Better Auth's organization plugin (on which its SSO plugin builds), with its SSO and SCIM plugins, or on Portifact's own tables with Better Auth only for identity?

## What was tried

`spikes/workspace-model` runs in workerd through `@cloudflare/vitest-plugin`, over the real `packages/db` migrations plus one spike migration, with Better Auth configured like `apps/app` (Drizzle adapter, email OTP, the same account linking) and the real `termsHooks` and `humanHooks` imported from `apps/app`. It exercises the organization, SSO and SCIM plugins at 1.7.18, then the alternative: Portifact-owned `workspaces` and `workspace_members` with the SSO plugin and no organization plugin. 85 tests; samlify plays the SAML IdP inside workerd with a key and certificate `openssl` makes for each run, and a replaced `fetch` plays the OIDC IdP.

"Run" below means a test in the spike proves it; "read" means it comes from the 1.7.18 source or the npm registry only.

## Evidence

### 1. Packages and licenses (read)

| Plugin       | Package at 1.7.18                            | License | Notable dependencies                                                                                                                                             |
| ------------ | -------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization | `better-auth/plugins` (inside `better-auth`) | MIT     | none extra                                                                                                                                                       |
| SSO          | `@better-auth/sso`                           | MIT     | `samlify` 2.15.1 (MIT), `xml-crypto` 6.4.0 (MIT), `@xmldom/xmldom` (MIT), `@authenio/xml-encryption` (MIT), `fast-xml-parser` (MIT), `tldts` (MIT), `jose` (MIT) |
| SCIM         | `@better-auth/scim`                          | MIT     | `zod`, `@noble/hashes` (MIT)                                                                                                                                     |

All are in `AGPL_COMPATIBLE` and permissive, so they fit a commercial license too; no GPL or AGPL package enters the tree. 1.7.18 was published on 2026-11-05, past `minimumReleaseAge`. 1.7.19 (2026-11-10) and 1.8.0-beta.7 exist and were not evaluated.

### 2. Tables, D1 and workerd

- **Organization (run).** Three tables (`organizations`, `members`, `invitations`) and `sessions.active_organization_id` work on D1 with Drizzle in the repository's conventions (plural names, snake_case, millisecond dates); `schema.test.ts` checks every declared field. Workspace IDs can carry a `ws_` prefix through `advanced.database.generateId`. But its writes are separate statements: when the first member insert fails, the workspace row stays committed with no admin, and three concurrent adds of the same user create three memberships, because `members` has no unique key and D1 has no transaction around the check and the insert.
- **SSO (run).** One table, `sso_providers`, plus `domain_verified` when domain verification is on. OIDC sign-in works end to end in workerd (PKCE, nonce, ID token verified against the IdP's JWKS). SAML works too: the plugin verifies signed responses with samlify and `xml-crypto` 6.4.0 on `node:crypto` under `nodejs_compat`, rejects a tampered response and a replay, and requires timestamps when configured. `samlify`'s "schema validation" is only well-formedness through `fast-xml-parser` (read). One test-only obstacle: loaded file by file, the Workers test runner resolves samlify's `require("xml")` to samlify's own `build/src/xml.js`, so SP metadata fails with `xml_1.default is not a function`; bundling samlify into one file with esbuild, as wrangler does for a deployed Worker, fixes it. A deployed bundle was not built in the spike.
- **SCIM (run).** Seven tables for code-defined connections (nine with managed connections). The plugin refuses to start unless the adapter has native transactions, and D1 refuses `BEGIN` ("use the state.storage.transaction() ... APIs"), so with Drizzle's transactions every write fails with a 500. It works only with a fake transaction that gives no atomicity, which is how the spike reaches its endpoints. **The SCIM plugin cannot run on D1.**

### 3. Endpoints

`routes.test.ts` lists every endpoint the plugins register (organization 22, SSO 16, SCIM 17 method and path pairs at 1.7.18) and fails on any that `src/routes.ts` does not classify.

- Open if adopted: `POST /sign-in/sso` (browser, exact Origin), `GET /sso/callback/:providerId` (OIDC return), `POST /sso/saml2/sp/acs/:providerId` (SAML POST from the IdP, no app Origin possible; the plugin itself skips its origin check there), `GET /sso/saml2/sp/metadata` (public), and the SCIM `Users`, `Groups`, `Schemas`, `ResourceTypes` and `ServiceProviderConfig` routes as bearer-only endpoints with cookies stripped (a browser session never authenticates a SCIM call, run).
- Closed: every `/organization/*` endpoint (they take only the session cookie, so the CLI and MCP could not reach them and parity would break), SSO provider administration (`/sso/register` and the rest, which belong in `/api/v1`), domain verification (it needs `node:dns` `resolveTxt`; plan T2 verifies domains itself), the shared OIDC callback, SAML Single Logout, the ACS over GET, and SCIM managed-connection, decommission and reconcile endpoints.

### 4. Reading roles from the services (run)

One indexed read gives the role in either model (`resolveActor`, `resolveWorkspaceActor`), with a personal space resolving to its own user. With the plugin, the stored role is a comma-separated list and the plugin's built-in `owner`, `admin` and `member` stay valid next to custom roles: an admin could invite someone as `owner`, a role Portifact does not have, and the services must refuse it. Owned tables put a `CHECK` on the three roles and a composite primary key on (workspace, user).

### 5. SSO, terms, the human check and existing accounts (run)

- OIDC passes both hooks: a new account needs the terms and human-check cookies (refused with `terms_not_accepted` or `human_verification_required` otherwise), an account on an old terms version is refused until it accepts, and a returning user signs in without cookies. The OIDC callback is a top-level GET, so the `SameSite=Lax` cookies arrive.
- **SAML cannot create accounts and locks out users after a terms change.** The ACS is a cross-site POST, so the browser never sends `__Host-pf_terms` or `__Host-pf_human` (`SameSite=Lax`): a new user is refused with `terms_not_accepted`, and so is a returning user after a `TERMS_VERSION` bump. The hooks themselves work when the cookies reach the ACS. Existing users on the current terms sign in fine.
- With domain verification on, SSO refuses to start until the provider's domain is verified (401).
- **A workspace IdP must only speak for its verified domain.** Portifact never creates an account with an unverified email, and SAML has no `email_verified` claim, so SSO cannot rely on that flag. The spike adds a `validateUserInfo` rule: for SSO sources the email must be in the provider's verified domain. Without it, a workspace IdP creates an account for any address (`@gmail.example`, run) before its owner signs up; with it, that is refused with `sso_email_outside_domain`. With `trustEmailVerified: false`, Better Auth refuses to join an existing account outside the domain (`account not linked`), and joins one inside the verified domain without creating a duplicate.

### 6. SCIM deprovisioning and sessions (run)

Deactivating a user through SCIM removes the membership (through the application's `projection.reconcileUser`) and ends every session through `internalAdapter.deleteUserSessions`, which runs the session delete hooks (a recorder in `databaseHooks.session.delete.after` saw each one); oauth-provider's back-channel logout hangs on the same hook (read). Calling `(await auth.$context).internalAdapter.deleteUserSessions(userId)` from Portifact's own code does the same (run), which is what an own SCIM endpoint would use. Provisioning a new user fails twice over: SCIM creates the account with an unverified email (refused by Portifact's rule), and past that rule the terms hook refuses an account nobody accepted terms for. An address that already has an account is refused (409) unless the application links it explicitly through `identity.resolveUser`.

### 7. Upgrade risk (read, plus the spike's guards)

- SCIM was redesigned within a minor: 1.6.0 had one `scimProvider` table; 1.7.0 replaced it with ten tables and the native transaction requirement; 1.8.0-beta.7 keeps the 1.7 shape.
- Every plugin endpoint added later would be reachable only through the allowlist, but its behavior (merged default roles, provisioning, origin skips) would need review; the route inventory test makes the review mandatory.
- The SSO plugin pins Portifact to its table, its JSON config format, the `domainVerified` semantics, and `trustedOrigins`: OIDC discovery is refused for any IdP origin missing from Better Auth's global `trustedOrigins`, so providers must be registered with explicit endpoints or the list must become dynamic, which also widens redirect trust (run).
- `@better-auth/scim`'s plugin type is not assignable to `BetterAuthPlugin` under `exactOptionalPropertyTypes` in 1.7.18; the spike casts it.

## Decision

Build workspaces on Portifact's own tables, with Better Auth for identity and, later, for the SSO sign-in protocols only.

1. **Workspaces (F3).** `workspaces`, `workspace_members` (composite key, `CHECK` on the three roles), `workspace_invitations`, and later groups and domains, in `packages/db`, changed only by `packages/services` in D1 batches together with seats, audit events and the outbox. `Actor` is resolved from `workspace_members` in the services. Better Auth never sees them. Do not install the organization plugin.
2. **SSO (E1).** Use `@better-auth/sso` without the organization plugin for the OIDC and SAML flows, which work in workerd. Open only the four sign-in endpoints. Providers are administered through session-only `/api/v1` routes over the services (the spike registers through the plugin's API without `organizationId`, then binds the workspace and the verified domain); membership comes from `provisionUser` with `provisionUserOnEveryLogin` and an idempotent insert (run). Keep `trustEmailVerified: false`, domain verification on with its endpoints closed, and the domain rule in `validateUserInfo`. Bundle samlify in tests as the spike does. Before E1 ships, solve the SAML cookie problem below.
3. **SCIM (E2).** Do not use `@better-auth/scim` while identity is on D1. Implement SCIM 2.0 `Users` (and `Groups` for T3) as bearer-only routes over the services, writing membership in batches, and end sessions with `internalAdapter.deleteUserSessions` so the hooks run. Reconsider if Better Auth supports D1 batches or the identity store moves to a database with transactions.

## What it costs

- Portifact writes invitations (tokens, expiry, emails through `packages/emails`), member management and role checks itself. Most of that has to exist anyway as `/api/v1`, MCP tools and CLI commands for parity, which the plugin's cookie-only endpoints cannot give.
- SCIM 2.0 is Portifact's code: filters, PATCH semantics and provider quirks (Entra, Okta) that the plugin already handles. Estimate it as its own work item in E2.
- The SSO plugin stays a coupling point: its table, its config format and its upgrades, guarded by the schema and route inventory tests the spike adds.

## Alternative: the organization plugin

It runs on D1 and gives invitations, roles and SSO organization provisioning for free. It is not chosen because its writes are not atomic on D1 (orphan workspace and duplicate members, run), its endpoints are cookie-only and would have to stay closed, so the services would end up writing its tables directly anyway, its built-in roles leak past custom ones, and it adds an upgrade surface that F3's batches, quotas, audit and tombstones would depend on. Choosing it would also not bring the SCIM plugin, which cannot run on D1 either way.

## Open questions for the maintainer

1. **SAML and the terms.** Options: (a) the ACS stores a short-lived pending sign-in and redirects to a first-party page that records the acceptance and finishes it, (b) SAML only for accounts that already exist and are on the current terms, with a re-acceptance path outside SAML, or (c) `SameSite=None` on the acceptance cookies, which weakens them. (a) keeps the legal rule and needs a custom endpoint.
2. **Accounts created by SCIM.** "No account exists without the current terms accepted" ([legal.md](../legal.md)) forbids accounts a directory creates before the person signs in. Either SCIM only links and activates existing accounts and invitations, or the rule gains a dormant, unusable state until first sign-in; that is a legal decision.
3. **The human check for SSO and SCIM.** OIDC new accounts pass it like today, SAML hits the same cookie problem, and SCIM has no browser at all. Decide whether a verified-domain IdP or a directory exempts the check.

## Verify later

- A wrangler-built bundle with the SSO plugin in a real Worker (bundle size, samlify's `node:crypto` use, cold start).
- SAML against real IdPs (Okta, Entra ID, Google Workspace), including encrypted assertions, which the spike did not test.
- Better Auth 1.7.19 and 1.8 before E1, with the spike's schema and route tests.
