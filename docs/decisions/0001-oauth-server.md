# 0001 OAuth authorization server

- Status: accepted for phase 0, pending verification with real clients after deployment
- Date: 2026-11-08
- Spike: [spikes/oauth-server](../../spikes/oauth-server)

## Context

Portifact needs one authorization server, inside the `apps/app` Worker on `app.portifact.com`, for three kinds of callers:

1. People signing in to the dashboard with Google, GitHub or an email OTP, with sessions in D1. Better Auth with Drizzle is already the planned identity layer.
2. The CLI, a public client without a secret, using the device authorization grant (RFC 8628) so it works in remote terminals. Its tokens carry the scopes `artifacts:read`, `artifacts:write`, `artifacts:share`, `artifacts:delete`, `annotations:read`, `annotations:write` and `annotations:moderate`, can be revoked, and may later be restricted to specific artifacts.
3. Remote MCP clients (Claude Code, Claude.ai and Claude Desktop, Codex) at `https://app.portifact.com/mcp`, following the MCP authorization specification revision 2026-07-28: OAuth 2.1 with PKCE, protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), resource indicators (RFC 8707) with audience validation, `iss` in the authorization response (RFC 9207) and client registration.

On client registration, the 2026-07-28 revision says authorization servers and clients SHOULD support Client ID Metadata Documents (CIMD) and MAY support dynamic client registration (DCR), which it marks as deprecated and kept for backwards compatibility. What the target clients do today:

- Claude (claude.ai, Desktop, mobile and Claude Code share one OAuth client implementation) uses CIMD only when the server metadata advertises both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`, and otherwise falls back to DCR. Hosted apps redirect to `https://claude.ai/api/mcp/auth_callback`. Claude Code publishes its document at `https://claude.ai/oauth/claude-code-client-metadata` with `http://localhost/callback` and `http://127.0.0.1/callback`, and binds a per-session port, so the server must match both loopback hosts with any port. Claude requires a 401 to start sign-in, uses only the first entry of `authorization_servers`, appends `offline_access` when the server lists it, sends form-encoded token requests and gives token endpoints 10 seconds (30 for refresh).
- Codex chooses CIMD under the same two conditions and falls back to DCR, or uses a configured client ID. Its default callback is `http://127.0.0.1/callback` on a variable port, and it validates `iss` before exchanging the code. Its documentation does not say whether it sends `resource`.

Sources: [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Claude connector authentication](https://claude.com/docs/connectors/building/authentication), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Options

### A: Better Auth as identity and authorization server

Better Auth 1.7 ships the authorization server as plugins over the same database as identity:

- `@better-auth/oauth-provider`: OAuth 2.1 and optional OIDC, PKCE, RFC 8414 metadata, DCR (RFC 7591), registered resources with per-client links (RFC 8707), revocation (RFC 7009), introspection (RFC 7662), refresh token rotation, consent records and `iss` in responses.
- `oauthDeviceAuthorization()` from the same package: RFC 8628 on top of Better Auth's device authorization plugin, issuing real OAuth tokens (scoped, audience bound, introspectable) instead of first-party session tokens.
- `@better-auth/cimd`: CIMD with an `mcp-2026-07-28` validation profile. It needs an application-owned fetch transport.
- `@better-auth/mcp`: a convenience wrapper over the provider for a single MCP resource with JWT verification. Not needed here, because Portifact has two resources and validates opaque tokens in process.

Storage is the Better Auth adapter, so D1 directly or through Drizzle, in the same database as users and sessions.

### B: `@cloudflare/workers-oauth-provider` with Better Auth only for sign-in

Cloudflare's library (1.2.4) is a focused OAuth 2.1 framework for Workers with very complete MCP coverage: CIMD, DCR, RFC 9728 resource servers, RFC 8707, RFC 9207, token exchange (RFC 8693), consent page helpers and experimental Enterprise-Managed Authorization. It leaves sign-in and the consent page to the application, so Better Auth would still run for identity. Its storage is a KV namespace (`OAUTH_KV`), with tokens stored as hashes and grant props encrypted. It has no device authorization grant.

## Evaluation

| Criterion                                     | A: Better Auth plugins                                                                                                                                     | B: workers-oauth-provider plus Better Auth                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Device grant for the CLI (RFC 8628)           | Built in, issues OAuth tokens through the same issuance path                                                                                               | Not implemented. Needs a custom grant and token store outside the library, which breaks the one-server goal                   |
| MCP authorization 2026-07-28                  | Metadata, PKCE S256 only, RFC 8707, RFC 9207, CIMD with the MCP profile, DCR. RFC 9728 metadata is served by our own route                                 | Complete, including an RFC 9728 resource server class and consent helpers                                                     |
| Client registration that Claude and Codex use | CIMD and DCR both proven in the spike, including Claude Code's document with `localhost` and `127.0.0.1` on any port                                       | CIMD and DCR                                                                                                                  |
| Storage                                       | D1, same database and adapter as identity                                                                                                                  | KV only. A second store next to D1, eventually consistent across locations, 60 second minimum TTL                             |
| Revocation                                    | Opaque tokens checked in D1 on every request: effective on the next request (tested)                                                                       | Hash deleted in KV: propagation across locations can take up to about 60 seconds                                              |
| Audience validation                           | Tokens carry the resources they were issued for; our guard rejects other or missing audiences (tested)                                                     | Built in for its resource server                                                                                              |
| Identity integration                          | Native: sessions, users and consent share one model                                                                                                        | Two systems. Better Auth sessions must be bridged into `completeAuthorization()`, and user deletion must clean both stores    |
| Consent screen                                | Our page in `apps/web`, calling `/oauth2/consent` with a signed query                                                                                      | Our page, with helpers that describe the client safely                                                                        |
| Custom code                                   | Protected resource metadata routes, a resource guard, a small in-process introspection plugin, a CIMD fetch transport, the consent, login and device pages | All of A's pages, the session bridge, a complete device grant and its token store, KV cleanup, and deletion across two stores |
| Maintenance                                   | Large, very active project with frequent patch releases (1.7.0 to 1.7.18 between August and November 2026). Fast moving: pin versions and read changelogs  | Maintained by Cloudflare, steady 1.x releases, narrow scope                                                                   |
| Workers fit                                   | Runs in workerd with `nodejs_compat`; the spike bundle is about 3.0 MiB raw and 513 KiB gzip                                                               | Built for Workers                                                                                                             |

## Decision

Use Better Auth as the single authorization server: `@better-auth/oauth-provider` with `oauthDeviceAuthorization()` for the CLI, `@better-auth/cimd` for MCP clients that identify with a metadata document, DCR kept on for clients that fall back to it, and the same D1 database and adapter as identity.

Issue opaque access tokens (`disableJwtPlugin: true`) and validate them in process in the same Worker through a server-only endpoint that calls the provider's `validateAccessToken`, so revocation, client disabling and expiry take effect on the next request. Register two resources, `https://app.portifact.com/api/v1` for the CLI and `https://app.portifact.com/mcp` for MCP clients, and require every protected request to present a token whose audience contains that exact resource.

`@cloudflare/workers-oauth-provider` is not chosen because it has no device grant and stores state in KV. Building both outside it would leave two token stores and two authorization paths, which the plan rules out.

## What the spike proves

The spike in `spikes/oauth-server` runs in workerd through `@cloudflare/vitest-plugin` against local D1 with the real Better Auth plugins. Its tests cover:

- Authorization server metadata at the RFC 8414 path for the issuer, with the device, registration and revocation endpoints, S256 only, the CIMD signals Claude and Codex look for, and `authorization_response_iss_parameter_supported`.
- Protected resource metadata for both resources and the 401 challenge with `resource_metadata` and the baseline scope.
- The device flow end to end with email OTP sign-in and a simulated approval on the verification page: pending, approval, issuance, single redemption under three concurrent polls, denial, slow down, expiry, another user unable to approve, another client unable to redeem, and refused scopes.
- Authorization code with PKCE after DCR: consent, `iss` and `state` in the callback, wrong verifier, missing challenge, code replay, unregistered redirect URI and a resource the client is not linked to.
- CIMD with Claude Code's document shape: both loopback hosts on arbitrary ports, an undeclared redirect URI and a document whose `client_id` does not match its URL.
- Audience validation: an API token is rejected at `/mcp`, an MCP token at the API, and a token issued without any resource is rejected everywhere.
- Scopes with a 403 `insufficient_scope` challenge naming the needed scope, revocation of access and refresh tokens, refresh token rotation, expiry after an hour, and hashed token storage in D1.

Coverage of the spike source is 100% of lines and branches.

## Consequences

- The identity layer and the authorization server are one dependency. Better Auth upgrades need care: pin exact versions in `apps/app`, keep `minimumReleaseAge`, and rerun the authorization test suite on every upgrade.
- `apps/app` adds the Better Auth schema through Drizzle and drizzle-kit instead of the spike's generated SQL, and passes the Drizzle adapter over the control D1 database.
- The issuer is `https://app.portifact.com/api/auth`, Better Auth's base URL with its base path. Its metadata lives at `/.well-known/oauth-authorization-server/api/auth`, which `apps/app` must route to Better Auth. If a real client fails on a path issuer, the base path can move.
- Each API or MCP request costs several D1 reads (token, client, session, user). This is the price of immediate revocation. Measure it in phase 2; if it matters, cache the client and resource rows or use D1 read replication, never cache the token decision across requests.
- Access tokens from the authorization code flow are tied to the browser session that approved them: signing out of the dashboard makes them inactive, and the client recovers by refreshing. Device flow tokens have no browser session and survive sign-out. The dashboard's token list and the "sign out everywhere" action must account for this.
- Better Auth issues a token without an audience when a client sends no `resource`, and a token requested without `resource` at the token endpoint keeps the resource from the authorization request. Resource servers must always check the audience, as the spike's guard does. Requiring `resource` at the authorization server is a possible later hardening.
- `clientRegistrationDefaultResources` links every new client to the MCP resource, including clients created by an operator. To keep the CLI on the API only, seed its client and resource link with a migration instead of the admin endpoint, which also needs an operator session.
- A device-only client still needs one redirect URI in its record, because the schema requires it. The CLI client uses an unused loopback URI.
- DCR clients can register for every allowed scope; the consent page decides what is granted. Per the MCP security guidance, the consent page must show the client name, the CIMD domain when there is one, the redirect URI's hostname with a warning for loopback, and the requested scopes, and must escape everything that came from the client and refuse framing.
- The CIMD plugin asks for a transport that resolves DNS once and pins the address. Workers cannot pin addresses. The spike relies on the `global_fetch_strictly_public` compatibility flag, refuses redirects and allows only HTTPS. Treat this as a residual risk and keep the fetch budget limits of the plugin.
- D1 has no interactive transactions. The device code redemption uses an atomic conditional delete and survived concurrent polls in the spike. Better Auth notes a non-atomic window when it invalidates a refresh token family after reuse; accept it for now and recheck in later releases.
- Per-artifact token restrictions are not provided by either library. Design them in phase 2 in `packages/domain`, keyed by the grant (for example the token's `referenceId`, set from consent), and enforce them in the same guard that checks audience and scope.
- The plan's sections 3 and 15 list this choice as pending; the maintainer's `docs/plan.md` should record the decision.

## To verify after deployment

These need a deployed staging Worker and the real clients, which the spike cannot reach:

1. Claude Code connects through CIMD: discovery from the 401, path-inserted metadata for the `/api/auth` issuer, `localhost` callback on its session port, `iss` validation, token exchange and refresh on 401.
2. Claude.ai and Claude Desktop connect through CIMD or DCR with `https://claude.ai/api/mcp/auth_callback`, and Anthropic's egress range reaches every endpoint within the 10 second limit.
3. Codex connects through CIMD with its ChatGPT-hosted document and `127.0.0.1` callback, falls back to DCR with `--oauth-client-registration dcr`, and whether it sends `resource` in both requests.
4. Step-up from a 403 `insufficient_scope` on a real MCP tool adds a scope without losing the earlier ones in each client.
5. The `global_fetch_strictly_public` flag blocks metadata fetches to private ranges and to the Worker's own zone in production.
6. Real sign-in with Google and GitHub, and OTP delivery through Cloudflare Email Service, in front of the same authorization server.
7. D1 latency of in-process introspection under load, and the token endpoint staying well under the clients' timeouts.
8. The compatibility matrix the plan asks for, with the client versions tested.
