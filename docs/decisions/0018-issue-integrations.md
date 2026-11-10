# 0018 Issue integrations: GitHub Issues and Linear from comment threads

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan T7 (`integrations` in `PLANS`, Team and above), first delivery: GitHub Issues and Linear. Slack and Jira are not part of it.

## Question

The owner side of an artifact wants to turn a comment thread into an issue in the tracker the team already uses, without copying text by hand. That means Portifact holds a credential that acts at another service, sends there words other people wrote in Portifact, and calls a third party from its Workers. How does it do that without a credential that leaks or outlives its owner, without sending more than the person chose (or anything they cannot see), and without opening a new way to reach arbitrary hosts?

## What a connection is

A connection belongs to an owner (a personal space or a workspace) and is managed by its admins only (new role action `integrations`). It has a service (`github` or `linear`), a label, a credential sealed at rest, the identity the service reported for the credential, and a bounded list of allowed targets: GitHub repositories as `owner/repo` (at most 10, `INTEGRATION_LIMITS.targetsPerConnection`), or Linear team IDs with the team names Linear reports. At most 5 connections per owner (`perOwner`), 20 created per owner and day, 30 checks against the service per owner and hour; these are safety caps in `rate_limits` keyed by owner, so removing and creating connections never resets them.

### The credential an admin pastes

Portifact has no OAuth app at GitHub or Linear, and creating one is the maintainer's decision. So a connection uses a credential the owner's admin pastes:

- GitHub: a fine-grained personal access token limited to the chosen repositories with **Issues: Read and write** and nothing else (Metadata stays read-only, as GitHub requires). The Integrations page gives the exact steps.
- Linear: a personal API key; where Linear lets the key be limited, only to creating issues in the listed teams.

The trade-off is plain and the page says it: the credential acts as the person (or bot account) that made it, so issues appear as created by that identity, and anything that identity may do the credential may do, within the scopes the admin chose. An OAuth app would change three things later, without changing the data model's shape: issues could appear as created by "Portifact on behalf of" the person, tokens would be short-lived and refreshed, and revoking the app at GitHub or Linear would revoke every connection at once. It would also need a client secret held by Portifact and a callback route. None of it is built.

GitHub App installation tokens were considered and are not a fit for a pasted credential: they expire after one hour, so a connection made with one works for an hour and then needs attention. Supporting GitHub Apps properly means Portifact holding the app's private key and minting installation tokens, which is the OAuth-app work above.

The credential is checked before anything is stored: GitHub `GET /user` (the identity) and `GET /repos/{owner}/{repo}` for every target (reachable, issues turned on); Linear one GraphQL query for `viewer` and `teams` (the identity and every team's name). Write access cannot be checked without writing (neither service reports what a fine-grained token or an API key may write), so it is proven by the first issue; a refusal then marks the connection for attention (below). "Test" runs the same check again and reports in plain words what failed (`IntegrationCheckProblem`: refused credential, missing permission, unreachable target, issues turned off, rate limited, service unavailable), each a localized message in the dashboard.

### Sealing

The credential is sealed with AES-256-GCM under a key derived with HKDF from a new Worker secret, `INTEGRATIONS_KEY`, bound to the connection's ID (a value copied to another row does not open), with the key's ID stored beside it (`packages/services/src/integration-keys.ts`). It is never returned, never logged and never in an export; Portifact shows only its last four characters (`credential_hint`) and the identity.

A new key rather than `WEBHOOK_KEY` with another purpose label, for the reasons single sign-on gave for `SSO_KEY` (decision 0016): a GitHub token or a Linear key acts as a person at another service, which is a different blast radius from a webhook URL; the two rotate, leak and switch on independently; and a webhook key rotation never touches credentials. Both the app Worker (it seals, and opens to test) and the jobs Worker (it opens to create issues) hold it. Rotation works like webhooks': set the new value as `INTEGRATIONS_KEY` and the old one as `INTEGRATIONS_KEY_PREVIOUS` on the jobs Worker, then `INTEGRATIONS_KEY` on the app Worker; the maintenance run re-seals up to 200 connections per region and run (`rewrapIntegrationKeys`, logged as `integrationKeysRewrapped` and `integrationKeysLeft`). A credential sealed with a key the Workers no longer hold marks its connection `key_unavailable`, which the admins see.

### Who manages connections

Only the dashboard session. `/api/v1/integrations/connections` refuses every bearer token, the Portifact CLI's `credentials:manage` one included, and there is no MCP tool or CLI command for it. This is stricter than webhooks (decision 0003's addendum lets the CLI manage webhooks): a webhook sends Portifact's own event summaries to a destination, while a connection holds a credential that acts as a person at another service. Pasting that credential into a terminal history or an agent's context is the leak this rule avoids, and the dashboard is where the least-privilege steps are shown next to the field. Listing connections' labels and targets (never the credential, the hint or the identity) is `GET /api/v1/integrations`, `artifacts:read`, role action `issues` (admins and editors), with the MCP tool `list_integrations` and `portifact integrations`, as group names are listed (decision 0014).

Creating and changing a connection need `integrations` in the owner's plan, after authorization; reading, testing and removing never do. A lapsed plan keeps every row and stops issues.

## Creating an issue from a thread

`POST /api/v1/artifacts/:id/annotations/threads/:threadId/issue` (scope `annotations:moderate`, an `Idempotency-Key`), the MCP tool `create_issue_from_thread` (the same scope) and `portifact issue`; the dashboard offers it in the viewer's thread menu. `annotations:moderate` because sending a thread out of Portifact is an owner-side action on comments, like moderating them, and only the owner side can do it.

- **Who**: the owner side of the artifact (admins and editors of its owner, role action `issues`). A participant who reads the thread gets `forbidden`; anyone who cannot read it gets what a missing thread gives. **Not a service token**: `issues` is not in `TOKEN_ACTIONS`, and a token never reads comments (decision 0011), so it answers like a missing artifact. The issue text is people's words; a credential that cannot read them should not be able to send them.
- **Which thread**: only one the caller reads now, through `readableThread` in `packages/services/src/annotations.ts`, the same authorization and comment scope as every read path (`findThread`). A hidden thread answers exactly like a missing one.
- **The plan**: the artifact owner's, from the entitlements already loaded with the artifact, never the caller's.
- **Caps**: at most 5 issues per thread that are not failed, 200 requested per owner and UTC day (`rate_limits`).

### What is sent

The person edits the **title** (prefilled from the artifact's name). The **body** is built by `issueBody` in `packages/domain/src/integrations.ts` from parts the person turns on or off in the dialog, which shows a preview made by the same function:

| Part          | Default | What it is                                                                                           |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Link          | on      | Portifact's own URL to the thread in the viewer, built from IDs and the thread's validated page path |
| Artifact name | on      | The artifact's name as inert text                                                                    |
| Quote         | off     | The anchor's quoted text, when the thread quotes text                                                |
| First message | off     | The thread's first message, when it is visible                                                       |

The quote and the first message are off by default because they are other people's words leaving Portifact. Every body ends with `Sent from Portifact. Reference: ti_…`, the request's ID, which is how a lost answer is found (below).

**Never sent**: reader email addresses, the artifact's content, other messages of the thread, approval review notes, anything the caller cannot see.

Comment text is untrusted. It goes out as plain text: normalized (NFC), C0 and C1 controls, bidi controls, zero-width and other invisible characters removed, line breaks unified, bounded (500 characters of quote, 3,000 of message, by code point, with an ellipsis), and placed in a fenced code block longer than any run of backticks inside it, which GitHub and Linear render literally: no `@user` mention, `#123` reference, link, image, HTML or heading in it does anything. The artifact's name goes in a code span the same way. The domain has table tests and property tests with hostile text for this.

The body is built when the job sends, from the thread as it is then: an edit made meanwhile is what is sent, a message hidden or deleted meanwhile is left out, and the comment text is never copied into another table. The dialog says so.

**EU residency**: for an owner in the `eu` region (decision 0005), the list says `euResidency: true` and the dialog says that what is sent goes to GitHub or Linear, outside the EU.

### Sending

The request's own batch writes the `thread_issues` row (with a per-request `write_id`) and its `thread_issue` outbox job conditioned on that row, under the conditions that the connection is still the owner's and usable, the thread still the artifact's and the artifact still the owner's (a transfer in between means the role was decided on another owner), and the thread has room. A retry with the same `(requested_by, idempotency_key)` answers the same request. Nothing is sent from the request: only the jobs Worker calls GitHub or Linear for an issue.

The job (`runThreadIssue`, `packages/services/src/thread-issues.ts`):

1. Ends a request whose switch is off, whose connection is gone or needs attention, or whose owner's plan lost `integrations`, with that reason; nothing is sent.
2. Claims the attempt (one run at a time; taken over only after 5 minutes), counts it against the owner's daily attempts (1,000, `rate_limits`; past it, waits for the next UTC day) and opens the credential.
3. **Before every attempt after the first**, looks for an issue an earlier attempt created whose answer was lost: on GitHub among the repository's 30 most recent issues (`GET /repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc`, a list, not the search index, which lags), on Linear with `issues(filter: { team, description: { contains: "Reference: ti_…" } })`. If found it records that issue; if the lookup itself fails, the attempt is retried later and nothing is created on a guess.
4. Otherwise creates it (`POST /repos/{owner}/{repo}/issues`, or Linear's `issueCreate`).
5. On success, records the key (`#123`, or `ENG-42`) and the URL **after validating it**: HTTPS on the service's own web host (`github.com`, `linear.app`), no user, port, query or fragment, and on GitHub exactly an issue of the chosen repository with the returned number. It clears the title and writes `issue.created` to the audit log in the same batch, on the attempt's claim.
6. On failure: a 401 (or Linear's authentication error) fails the request with `credential_rejected` and marks the connection `credential_rejected` for its admins, with one `integration.failing` event; 403, 404 and 410 are `target_unreachable`, unless the answer says it is a rate limit; 408, 429, 5xx, timeouts and network errors are retried after 1, 5, 30 and 120 minutes (five attempts in about 2.5 hours), then `service_unavailable`; a redirect, an answer over 256 KiB, an unreadable one or an issue URL that fails validation is `invalid_response`; anything else `rejected`. The person who asked sees the failure on the thread with a plain reason.

Every call goes only to a fixed API origin (`INTEGRATION_API`: `https://api.github.com`, `https://api.linear.app/graphql`), never a host from input, and is checked again right before it is sent with the same rules as webhooks (`checkPublicHttpsUrl`, which includes `CLOUDFLARE_HOSTS` and Portifact's own hosts) plus the exact origin; `redirect: "manual"`, a 10-second timeout, a bounded read. GitHub Enterprise Server and self-hosted anything are out of scope: a host the customer chooses is the SSRF surface decision 0009 had to bound with release checks, and this delivery does not open it.

One exception to "only the jobs Worker calls out": checking a credential (connecting, changing the credential or the targets, Test) runs on the app Worker, synchronously, because the admin is waiting for the answer in the form. It goes only to the same two fixed origins with the same checks, carries no comment text, and is limited per owner. Webhooks never needed this, because a webhook's URL can be anything; here the destinations are constants.

### What the thread shows

`AnnotationThreadView.issues`: every created issue (service, target name, key and URL), to whoever sees the thread, and the caller's own requests still pending or failed with the reason. The links are read in the same D1 call as the thread's messages, so no read path gains a round trip.

## Data and regions

Both new tables are an owner's data and live in the owner's region (`TABLE_HOMES`): `integration_connections` (regional, like webhooks) and `thread_issues` (regional, with the thread, cascading from the thread and the artifact). The job runs on the region's database; tombstones are global and written first (the global-first rule of decision 0005), then the regional batch deletes the row. The services' `two-regions.test.ts` runs the whole flow for an EU workspace with the strict region guard.

- **Removing a connection** writes an `integration_connection` tombstone (global) first, then deletes the row with its `integration.removed` event (regional). `exportTombstones` exports it and `applyTombstones` deletes connections a restore brought back, and those of tombstoned accounts and workspaces, so a removed credential never acts again. A retry after a failed regional batch finds the tombstone already there.
- **Account deletion** deletes the account's connections and clears `created_by` on workspaces' connections and `requested_by` on issue requests, in both batches (`regionalDeletion`). **Workspace deletion** deletes the workspace's connections in `deleteWorkspace` and again as `advanceWorkspaceDeletion` finishes.
- **Issue links** go with the thread and the artifact by foreign key. A removed connection keeps the links of issues it created; its pending requests fail.
- **The account export** lists the account's connections by service, label, identity and target names, never the credential.

## Audit

`integration.connected` (the service and the number of targets), `integration.changed` (which of label, credential and targets changed, as booleans and a count), `integration.removed` (the service), `integration.failing` (the service and the reason; by the admin who tested, or the system when the job found it) and `issue.created` (the service, the repository or Linear team ID, and which of the four parts were included as booleans; never the title, the text or the URL), each through `auditEvent` in the change's own batch. `issue.created` is written when the issue exists, by the job, with the person who asked as the actor; a request that fails records nothing.

## Switched off

Nothing is reachable unless the Workers have `INTEGRATIONS_ENABLED="true"` and `INTEGRATIONS_KEY`. Without them the connection routes and creating an issue answer `503 capacity_unavailable` ("Integrations are not available yet."), the list is empty with `serviceAvailable: false`, the dashboard shows no sidebar link, no page content and no "Create issue", and a job that finds the switch off fails its request with `unavailable` and sends nothing. `integrations` stays out of `AVAILABLE_PLAN_FEATURES`. The release checks are in [releasing.md](../releasing.md) ("Integrations").

## Alternatives rejected

- **An OAuth app now**: the right end state, but creating apps at GitHub and Linear is the maintainer's decision, and it needs secrets and callback routes; the pasted credential ships the behavior and keeps the data model.
- **Managing connections from the CLI**: a pasted credential would sit in shell history and agent transcripts.
- **Storing the body at request time**: it would copy other people's words into a second table that deletion and moderation would have to chase. The job builds the body from the live thread instead.
- **Searching GitHub's index for the reference**: the search index lags by minutes, so a retry could miss the issue it just created; the recent-issues list does not lag.
- **Sending from the app Worker right after the request**: a slow service would hold the request, and retries would need the outbox anyway.

## Open risks

- **Duplicates after a lost answer**: the job looks before every retry, but on GitHub only among the 30 most recent issues of the repository; if more than 30 issues are created there between two attempts (minutes apart), a lost one can be missed and a second issue created. On Linear the filter has no such window.
- **The credential's reach**: a fine-grained token can be given more than Issues; Portifact cannot see a token's permissions, and the steps are the only guard. An over-scoped token is still used only for the calls above.
- **Linear's error shapes**: the classification reads GraphQL error extensions as Linear documents them; an unexpected shape is `rejected`, not retried. Release check.
- **Identity**: issues appear as created by the credential's account, which may be a person who later leaves the team; the admin replaces the credential.

## Next

- One way only in this delivery: Portifact creates the issue and links it. No syncing back, no webhooks from GitHub or Linear, no resolving a thread when its issue closes, no comment mirroring.
- An OAuth app (or a GitHub App with an installation flow) for each service.
- Slack and Jira.
