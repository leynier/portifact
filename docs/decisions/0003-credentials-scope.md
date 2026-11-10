# 0003 Credentials scope for the CLI's token commands

- Status: accepted
- Date: 2026-11-09

## Context

The plan's CLI contract (section 6) includes `portifact tokens list | revoke TOKEN_ID`, and its API has a "Credenciales" group for the account's own tokens and connected clients. Section 5 asks for scopes for account and credentials separate from the product scopes, and says a token can never obtain more than it has.

Until now only the dashboard could see and disconnect connected apps, through the session-only `/api/v1/account/apps` endpoints, which refuse bearer tokens on purpose: no scope covered credential management, and a token must never list or revoke other credentials. The CLI authenticates only with OAuth bearer tokens from the device flow, so it needs a bearer path, and that path must not let a read-only token, or any MCP client's token, revoke other grants.

Two facts shape the identifier. Better Auth rotates refresh tokens and keeps no stable family ID, so a single token's row ID changes every hour as the CLI refreshes and cannot serve as a durable `TOKEN_ID`. And Better Auth has no API that revokes a user's grants for a client by anything other than the token value (`/oauth2/revoke`) or a browser session (`/oauth2/delete-consent`).

## Decision

- Add one OAuth scope, `credentials:manage`, outside the product scopes (`CREDENTIALS_SCOPE` in `packages/contracts`, not in `OAuthScope`). It allows listing and revoking the caller's own grants and nothing else.
- Only the first-party CLI can obtain it. The provider knows the scope (`ALL_SCOPES`), but registered and CIMD clients are limited to `REGISTRATION_SCOPES`, which leave it out, and the authorization server metadata advertises only those. The CLI's client record lists it (migration 0024), and `portifact login` requests it with the product scopes.
- Add `GET /api/v1/tokens` and `DELETE /api/v1/tokens/:clientId` (`apps/app/src/api/tokens.ts`). They accept only a bearer token for the API resource holding the scope; a session cookie alone gets the 401 challenge. The account endpoints stay session-only and unchanged.
- A token ID is the app's client ID, the stable unit the dashboard already shows: listing returns the dashboard's connected apps plus `current` for the caller's own client, and revoking runs the dashboard's `disconnectApp`, which deletes that app's access tokens, refresh tokens and consent for the account in one batch. Web and CLI therefore behave identically.
- Revoking the calling client is allowed and behaves like signing out on every device that uses it: the response says `current: true` and the CLI deletes its stored credentials.
- No MCP tool. MCP tokens have the MCP audience and cannot hold the scope, so an MCP client can never list or revoke credentials.

## Consequences

- Revoking `portifact-cli` signs the CLI out on every device of the account, because all CLI devices share one client. Per-device revocation would need a stable grant identifier that Better Auth does not keep; it can come later without changing the scope or the routes' shape.
- CLI logins made before this change lack the scope and get 403 `insufficient_scope`; the CLI tells the user to run `portifact login` again. Refreshing never adds scopes.
- A future third-party API client would need the scope listed in its own record, by migration, before it could manage credentials; registration can never grant it.
- `disconnectApp` deletes OAuth token rows directly, as the dashboard always did. Better Auth binds no hooks to OAuth token rows, so nothing is skipped; browser sessions are still ended only through Better Auth.
- The scope is hard to take back once CLIs hold it: removing it would need a migration on the client record and would break the commands for existing logins until they sign in again.

## Addendum: webhooks (2026-11-10)

A webhook ([decision 0009](0009-webhooks.md)) sends the account's activity to an address someone chose, and keeps sending after the app that created it is disconnected: revoking that app's tokens does not close it. That makes it a standing channel out of the account, closer to a credential than to a sharing setting, and it is held to the same rule as this decision: only the user's own tools manage it. Creating, changing, enabling, disabling, testing and removing a webhook take the dashboard session or a bearer token holding `credentials:manage` (which only the Portifact CLI's client record lists); `artifacts:share` and every other product scope are not enough, so no registered or CIMD client can, and MCP has only read tools. Listing webhooks and their deliveries stays `artifacts:read`, because it shows hosts, events and states, never URLs or secrets. Each webhook records where it was created (`dashboard` or the client ID).
