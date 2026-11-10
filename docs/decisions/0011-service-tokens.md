# 0011 Service tokens and stable publish keys

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan T4 and the server side of T5 (`serviceTokens` in `PLANS`, Team and above; publish keys for every owner)

## Question

A workspace wants to publish from CI: a preview of every pull request, the docs of every merge. Today the only credentials are a person's dashboard session and the OAuth tokens issued to that person's clients ([decision 0001](0001-oauth-server.md)). A CI job holding a person's CLI token acts as that person everywhere (their personal space, every workspace they belong to, their account's credentials through `credentials:manage`), stops working when they leave, and is renewed by refreshing, so it never expires on its own. What credential lets a workspace publish without a person's login, survives people leaving, and can do as little as possible when it leaks? And how does a job that keeps no state update "the preview of pull request 123" without storing an artifact ID?

## Threat model

A service token lives in a CI secret store, so assume it leaks: a malicious pull request that prints the environment, a compromised action, a log, a laptop. The attacker then holds the secret and nothing else. Also considered:

1. **A member or editor of the workspace** trying to get more through a token than their role gives, or to keep access after being removed.
2. **The token itself** trying to reach credentials: minting or listing tokens, managing members, webhooks, branding, domains or plans, reading another owner's artifacts, the personal space of the admin who created it, or anything only a person may do (comments, the human check, the viewer, account settings).
3. **A restore** of D1 bringing back a revoked token.
4. **Secret scanners** (GitHub's, gitleaks) that should recognize a leaked token.
5. **Two CI jobs** publishing the same key at once.

Out of scope: an attacker who controls the workspace's admin account (they can mint tokens anyway), and the CI system's own security.

## Design

### The credential

- `service_tokens` (global database, next to workspaces): ID (`st_` and 32 hex characters, `ServiceTokenId`, a prefix no user, artifact or workspace ID has), the workspace (foreign key, cascading), a label (1 to 80 characters, no control characters), a role, a set of scopes, an optional restriction, the SHA-256 of the secret (unique), who created it (no foreign key, cleared when that account is deleted), created, expires and last used.
- **The secret** is `pfst_` followed by 43 base64url characters: 32 bytes from `crypto.getRandomValues`, 256 bits. Only its SHA-256 is stored; a fast hash is enough because the input has full entropy, as for share links. It is returned once, in the create response, and creation takes no idempotency key, since a stored replay would keep the secret in D1. The prefix makes it recognizable: the pattern is `pfst_[A-Za-z0-9_-]{43}`, and the repository's `.gitleaks.toml` adds it as a rule, so CI refuses a commit that holds one. Tests build tokens at run time and documents write `pfst_…`, so nothing committed matches. A provider's secret-scanning partnership can come later with the same pattern.
- **Expiry is required**: 1 to 366 days (`SERVICE_TOKENS.maxDays`), 90 by default. There is no refresh; a new token replaces an expiring one.
- **At most 20 tokens per workspace** (`SERVICE_TOKENS.perWorkspace`, a safety cap, not a plan value), enforced by the insert's own condition so concurrent creates cannot pass it. Expired tokens count until revoked, so the list stays small and nothing disappears without the admin seeing it.
- **Role**: `editor`, the only one (`SERVICE_TOKEN_ROLES`), never `admin`. Not `member` either: what a member may do, reading what is shared with them and commenting, needs a person, so a member token could do nothing; a read-only token is an editor token with only `artifacts:read`. It never appears as a member, holds no seat and receives nothing sent to members or admins.
- **Scopes**: chosen at creation from `artifacts:read`, `artifacts:write`, `artifacts:share` and `artifacts:delete` (`SERVICE_TOKEN_SCOPES`), at least one. `artifacts:read` and `artifacts:write` are the default. `artifacts:share` (change access, readers, the bar, share links) and `artifacts:delete` are offered unchecked, with a warning, because a leaked token with them could make the workspace's artifacts public or destroy them; a CI job that removes previews needs `artifacts:delete`, and the restriction below is how the admin keeps that from reaching anything else. The annotation scopes, `credentials:manage` and the account endpoints are never available: comments need a person, and credential power stays out of tokens ([decision 0003](0003-credentials-scope.md)).
- **Restriction** (optional): `own`, only artifacts the token created (`artifacts.created_by`); or `key`, only artifacts whose publish key starts with a prefix the admin chose (`pr-`, `docs/`), and every publish must carry such a key. Anything outside the restriction answers exactly like a missing artifact, and the artifact list leaves it out.

### What a token may do

The role decides what the token may do on the workspace, as for a person, and then a fixed allowlist narrows it (`TOKEN_ACTIONS` in `packages/domain/src/actor.ts`): read, list, publish, update, access, lifecycle, versions, rollback and usage. Everything else is refused with `forbidden` even when the role would allow it: comments and moderation, transfers in and out, members, the plan, policies, webhooks, branding, the access log and analytics (they hold visitors' emails and counts that a CI job does not need) and custom domains (refused in the service). Scopes are checked first, at the API boundary, exactly as for an OAuth token.

Two rules narrow the `access` action for a token, in the services (second review). Reading an artifact's policy needs only `artifacts:read`, and a token gets the readers' addresses and their comment exceptions there only when it also holds `artifacts:share` (`seesReaders`): the list is empty otherwise, so a leaked read-only token names nobody, for the reason the access log is refused. And a token never changes who sees comments (`commentVisibility`, `readerCommentVisibility`; `checkCommentVisibilityChange` answers `forbidden`): that decides what readers see of each other's comments, which is moderation.

### Authentication

A third way to resolve a caller of `/api/v1`, in `apps/app/src/api/access.ts`, next to the session and the OAuth bearer: an `Authorization: Bearer pfst_…` header. `authenticateServiceToken` (`packages/services/src/service-tokens.ts`) hashes the secret and reads the token with its workspace and the workspace's plan in one indexed query, then:

- unknown, malformed, revoked (the row is gone), or the workspace deleted (the row cascaded): `401 unauthenticated` with `WWW-Authenticate: Bearer error="invalid_token"`, "This service token is not valid. It may have been revoked.";
- past its expiry: `401 unauthenticated`, "This service token expired on <date>. Ask a workspace admin for a new one.";
- the workspace's plan lacks `serviceTokens` (lapsed, removed or lowered): `403 plan_required` with the shared `planRequiredMessage`;
- the route's scope not among the token's: `403 forbidden` with the `insufficient_scope` challenge an OAuth token gets.

Otherwise the caller is the token: its ID takes the place of the user ID everywhere the services take one. `actorOn` and `resolveActor` (`packages/services/src/actors.ts`), still the only place a role is decided, give a token ID a role only on its own workspace, from its row, and only on the artifacts its restriction reaches; on every other owner, and on the personal space its ID would name, it has none, so it gets exactly the missing answer. `resolveOwnerScope` gives a token without `?workspace=` its own workspace, and a slug naming any other workspace `not_found` like one that does not exist, so the CLI's `--workspace` is implied. The token is read on every request, so revoking it, its expiry, the workspace's deletion and a plan without the feature take effect on the next request. Custom domains get their own role action, `domains` (what `access` allowed before, for admins and editors), which tokens never hold.

A token is never a signed-in person: `checkReadAccess` (downloads and reads of documents shared with readers) never admits it, so `authenticated` artifacts of other owners stay closed and public artifacts of other owners are not read through it either; on its own workspace an editor token reads through its role.

**Not on the dashboard session.** The cookie path never accepts a token: a `pfst_` value in the session cookie is an unknown session, so the request answers 401 like one without credentials. **Not at MCP.** `/mcp` accepts only OAuth tokens issued for the MCP resource, which a service token is not: MCP is for agents acting for a person, and a CI job uses the CLI or the API. **Not at account-level routes.** The account endpoints are session-only and refuse bearer tokens; `/api/v1/tokens` and webhook management take `credentials:manage` through introspection, which a service token never passes; members and invitations are session-only.

### Last used, without a write per request

`last_used_at` is written at most once an hour per token: the authentication read already returns it, and only when it is older than the current hour does the request run one guarded update (`… where last_used_at is null or last_used_at < :hourStart`), so concurrent requests write it once. Requests within the hour add no D1 write. The dashboard shows it to the hour. The per-isolate batching of traffic metering was not needed: tokens are few and a CI job makes a burst of requests a few times a day.

### Who acts, and what refuses a token

Everything that records who did something stores the token's ID: a version's `author_id`, `lifecycle_events.actor_id` (access changes included), idempotency records (`operations.actor_id`, so a token's retries replay like a person's), `artifacts.created_by` and the pending webhook events. Webhook deliveries name the token by its label ("CI previews (service token)") when it acted alone in the window, as they name a person on the owner side. The audit log (T10) will do the same.

Rules that speak of a person refuse or ignore a token on purpose:

| Rule                                                        | With a token                                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comment authorship, replies, resolving, moderation          | Refused: no annotation scope can be granted, and the actor allowlist leaves out `comment` and `moderate`                                            |
| The human check                                             | Never reached: it guards account creation, first comments and share link passwords, none of which a token does                                      |
| Terms acceptance                                            | Not applicable: the admin who creates a token is signed in on the current terms; the token is the workspace's, not an account                       |
| Email notices (expiry, comments, invitations)               | Go to people only (`ownerRecipients`, comment participants); a token receives none and is nobody's recipient                                        |
| Account settings and defaults for new artifacts             | Ignored: they apply only in a personal space, and a token never has one                                                                             |
| Making an artifact public in the account's first 15 minutes | The age is the token's: a token less than 15 minutes old cannot make an artifact public                                                             |
| Suspension of the acting account                            | A token has no account; suspending the workspace's artifacts or the admins' accounts does not revoke it, so the operator revokes it (operations.md) |
| The viewer, review sessions, read handoffs, the access log  | Session only, never a token                                                                                                                         |
| Workspaces list                                             | `GET /api/v1/workspaces` lists only the token's own workspace, with its role                                                                        |
| The account's usage age (`publicAccessFrom`)                | The token's creation time                                                                                                                           |
| Transfers                                                   | Refused: a token cannot move content in or out of its workspace                                                                                     |

### Managing tokens

Only admins of the workspace (role action `tokens`), only through the dashboard session, at `GET`/`POST /api/v1/workspaces/:slug/service-tokens` and `DELETE /api/v1/workspaces/:slug/service-tokens/:id`, which refuse bearer tokens like the member routes. There is no MCP tool and no CLI command, and no bearer token reaches them, so a token can never mint, list or revoke tokens. Creating is gated on the workspace's plan (`requireFeature`, `plan_required`); listing and revoking never are, so an admin can always revoke after a downgrade. Each create and revoke is conditioned inside its batch on the caller still being an admin (`stillAdmin`), as member writes are.

Revoking deletes the row and writes a `service_token` tombstone in the same batch. `exportTombstones` exports them, and `applyTombstones` deletes every token with a tombstone and every token of a tombstoned workspace, so a restore never brings back a revoked token. Deleting a workspace deletes its tokens with the row (foreign key). An account deletion clears `created_by` on tokens it names; the tokens stay with the workspace, which is the point. The account export of an admin lists the tokens of their workspaces: ID, label, role, scopes, restriction, dates, never the secret or its hash.

### Stable publish keys

`publish --key <key>` (and `key` on `POST /api/v1/publishes` and the MCP publish tools) creates the artifact the first time and updates the same one every time after, so a job publishes "the preview of pull request 123" as `--key pr-123` without storing an ID. Available to people and tokens alike.

- **The key** is 1 to 128 characters of `A-Z a-z 0-9 . _ / -`, starting with a letter or digit (`PublishKey` in contracts), stored as given in `artifacts.external_key`.
- **Unique per owner while the artifact exists**: a partial unique index on `(owner_id, external_key)` for rows not `purging` or `deleted`. Deleting or purging an artifact releases its key at once (the row leaves the index), whatever started it (a delete, an account or workspace deletion, the archive's purge, a re-applied tombstone); an archived artifact keeps its key, and publishing to it answers `artifact_archived` until it is restored. The same key in two owners names two artifacts.
- **First publish and update**: `preparePublish` looks the key up in the target owner. Found, it is an update of that artifact based on its current version (the job did not read one, so the last publish wins); not found, a new artifact carries the key. Two concurrent first publishes both miss the lookup and both try to insert; the unique index refuses the second, which reads the key again and becomes an update of the first one's artifact, so they make one artifact. The second commit then sees the version it was based on replaced and answers `version_conflict`; the CLI prepares again once, which gives the second version. The existing idempotency of prepare is unchanged: the key is part of the request hash.
- **Find and delete**: `GET /api/v1/artifacts?key=<key>` (and `key` on MCP `list_artifacts`) returns that one artifact or none; `portifact delete --key <key> --yes` looks it up in the space and deletes it by ID through the normal delete, so the same scopes, roles, restriction and confirmation apply.
- A key never changes on an existing artifact and is not offered in the dashboard's publish form yet; the artifact views show it.

Second review, settled here:

- **A transfer into a space that already uses the key** is refused with `invalid_input` (the partial unique index, caught in `transferArtifact`); nothing moves. The mover deletes the other artifact, or publishes this one again without the key, first.
- **The prefix is compared as plain text**, case-sensitively: `pr` also reaches `prod-docs`, so a prefix should end in a separator (`pr-`, `docs/`), as the dashboard's hint shows. An artifact a person published under the prefix is within the token's reach too.
- **A restricted token can learn that a key is taken.** Publishing with a key another artifact holds outside the token's reach answers `not_found`, and with a free key it creates an artifact. Keys are names like `pr-123`, not secrets, each probe of a free key leaves an artifact an admin sees, and hiding the difference would mean refusing every keyed publish of an `own` token, so this is accepted.
- **The CLI withholds `PORTIFACT_TOKEN`** from the programs it starts (`git`, `gh`; `childEnvironment` in `packages/cli/src/child-env.ts`).

## Alternatives rejected

- **OAuth client credentials through Better Auth** (a confidential client per workspace): Better Auth 1.7's provider binds tokens to a user (`sub`), so a workspace credential would be a fake user, with sessions, terms and account rules that do not fit; client secrets rotate through Better Auth's client management endpoints, which stay closed (decision 0001); and every token would need introspection, an exchange and a refresh in CI for no gain over an opaque secret checked against D1 on every request.
- **GitHub Actions OIDC federation** (exchange the job's signed identity token for a short-lived Portifact token, bound to a repository and branch): removes stored secrets entirely and is the follow-up that T5's second delivery plans. It needs a trust configuration per workspace (issuer, audience, repository and ref claims), JWKS fetching and caching in the Worker, and a token exchange endpoint; it builds on this record's actor model rather than replacing it.
- **A person's CLI token in CI**: acts as the person everywhere, carries `credentials:manage`, refreshes forever and dies when they leave.
- **Hashing with a slow KDF**: the secret has 256 bits of entropy, so SHA-256 is enough and keeps the per-request check cheap; a slow hash would only cost CPU on every API call.
- **`admin` tokens**: a token could then manage members, webhooks and branding, which is exactly the standing power decision 0003 keeps away from bearer credentials.
- **Keys reused after deletion only once purged**: deleting starts the purge at once and the artifact is gone for its owner, so holding the key until the bytes are gone would break "the PR closed and reopened" for no benefit.

## Open risks

- **A leaked token works until revoked or expired.** Scopes, the restriction, the editor ceiling and the expiry bound it. The dashboard shows last used to the hour so an admin can spot use they did not expect; the operator can find a token from a leaked secret and revoke it (operations.md).
- **Last write wins on keyed publishes.** Two jobs publishing the same key race; one of them becomes the current version, the other a previous version (or fails with `version_conflict` after its retry). CI runs per pull request usually serialize.
- **No audit log yet.** Until T10, what a token did is visible only through the version authors, lifecycle events and webhooks; the audit log will record token creation, revocation and use.
- **Secret scanners outside this repository** do not know the prefix until a scanning partnership is registered.
- **Restore gaps.** Tokens created after the restore point are lost (their holders get 401 and the admin creates new ones); revoked ones stay revoked through their tombstones.
