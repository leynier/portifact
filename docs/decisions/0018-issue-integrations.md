# 0018 Issue integrations: GitHub Issues and Linear from comment threads

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan T7 (`integrations` in `PLANS`, Team and above), first delivery: GitHub Issues and Linear. Jira Cloud is the addendum "Jira" (2026-11-11). Slack is not part of it.

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

Checking a credential can take up to eleven calls of up to ten seconds, so the caller's role is decided again after it, just before the write (`stillManages`). With one database (the default region, production today) the write also holds only while the caller is still a workspace admin, as a condition inside its batch (`stillAdmin`'s condition, through `bothSides`). With a separate regional database (the EU) the condition cannot name the global membership table, so the re-check before the batch is all there is: an admin removed in the milliseconds between that read and the regional batch can still store or change a connection. Removal of the connection by the other admins, and the tombstone, then take it out. A Test, and the job's 401, mark or clear a connection only while it still holds the credential that was checked (its `revision` and sealed value), so a credential pasted meanwhile is never overwritten or marked by an answer about the old one. The credential check is limited per owner (30 an hour) and per admin across owners (20 an hour).

## Creating an issue from a thread

`POST /api/v1/artifacts/:id/annotations/threads/:threadId/issue` (scope `annotations:moderate`, an `Idempotency-Key`), the MCP tool `create_issue_from_thread` (the same scope) and `portifact issue`; the dashboard offers it in the viewer's thread menu. `annotations:moderate` because sending a thread out of Portifact is an owner-side action on comments, like moderating them, and only the owner side can do it.

- **Who**: the owner side of the artifact (admins and editors of its owner, role action `issues`). A participant who reads the thread gets `forbidden`; anyone who cannot read it gets what a missing thread gives. **Not a service token**: `issues` is not in `TOKEN_ACTIONS`, and a token never reads comments (decision 0011), so it answers like a missing artifact. The issue text is people's words; a credential that cannot read them should not be able to send them.
- **Which thread**: only one the caller reads now, through `readableThread` in `packages/services/src/annotations.ts`, the same authorization and comment scope as every read path (`findThread`). A hidden thread answers exactly like a missing one.
- **The plan**: the artifact owner's, from the entitlements already loaded with the artifact, never the caller's.
- **Caps**: at most 5 issues per thread that are not failed, 200 requested per owner and UTC day (`rate_limits`). The daily count is taken before the regional batch (the counter is global, so it cannot be in that batch) and given back when the batch inserts nothing, so an idempotent retry of the same request or a lost race costs nothing.

### What is sent

The person edits the **title** (prefilled from the artifact's name). It is made inert too (`issueTitle`): GitHub renders code spans and issue references in titles, so backticks, `#` before a digit, `@` before a name and the hyphen of `GH-123` become look-alike characters that render as text. The **body** is built by `issueBody` in `packages/domain/src/integrations.ts` from parts the person turns on or off in the dialog, which shows a preview made by the same function:

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

1. Ends a request, with that reason and nothing sent, whose switch is off, whose connection is gone or needs attention, whose target the connection no longer allows (`target_removed`), whose artifact moved to another owner (`artifact_moved`; a transfer also fails the pending requests in its own batch), whose requester no longer acts for the owner or whose account is gone (`requester_left`, decided with `actorOn` and `actsForOwner`), whose thread the requester no longer reads (`thread_gone`, through `readableThread`; the owner side's comment scope is every thread, so this is the same check every read path makes), that reached five attempts, or whose owner's plan lost `integrations`. The claim itself also refuses a sixth attempt, so nothing can requeue it past that.
2. Claims the attempt (one run at a time; taken over only after 5 minutes), counts it against the owner's daily attempts (1,000, `rate_limits`; past it, waits for the next UTC day) and opens the credential.
3. **Before every attempt after the first**, looks for an issue an earlier attempt created whose answer was lost: on GitHub among the repository's 30 most recent issues (`GET /repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc`, a list, not the search index, which lags), only issues (never pull requests) opened by the connection's own account, the oldest match first, so someone who copies the reference into their own issue cannot get it linked, on Linear with `issues(filter: { team, description: { contains: "Reference: ti_…" } })`. If found it records that issue; if the lookup itself fails, the attempt is retried later and nothing is created on a guess.
4. Otherwise creates it (`POST /repos/{owner}/{repo}/issues`, or Linear's `issueCreate`).
5. On success, records the key (`#123`, or `ENG-42`) and the URL **after validating it**: HTTPS on the service's own web host (`github.com`, `linear.app`), no user, port, query or fragment, and on GitHub exactly an issue of the chosen repository with the returned number, on Linear the issue with the identifier Linear returned. It clears the title and writes `issue.created` to the audit log in the same batch, on the attempt's claim.
6. On failure: a 401 (or Linear's authentication error) fails the request with `credential_rejected` and marks the connection `credential_rejected` for its admins, with one `integration.failing` event; 403, 404 and 410 are `target_unreachable`, unless the answer says it is a rate limit (GitHub's primary limit in its headers, its secondary limit by `Retry-After` or by a message naming the rate limit, which is retried); 408, 429, 5xx, timeouts and network errors are retried after 1, 5, 30 and 120 minutes (five attempts in about 2.5 hours), then `service_unavailable`; a redirect, an answer over 256 KiB, an unreadable one or an issue URL that fails validation is `invalid_response`; anything else `rejected`. The person who asked sees the failure on the thread with a plain reason.

Every call goes only to a fixed API origin (`INTEGRATION_API`: `https://api.github.com`, `https://api.linear.app/graphql`), never a host from input, and is checked again right before it is sent with the same rules as webhooks (`checkPublicHttpsUrl`, which includes `CLOUDFLARE_HOSTS` and Portifact's own hosts) plus the exact origin; `redirect: "manual"`, a 10-second timeout, a bounded read. GitHub Enterprise Server and self-hosted anything are out of scope: a host the customer chooses is the SSRF surface decision 0009 had to bound with release checks, and this delivery does not open it.

One exception to "only the jobs Worker calls out": checking a credential (connecting, changing the credential or the targets, Test) runs on the app Worker, synchronously, because the admin is waiting for the answer in the form. It goes only to the same two fixed origins with the same checks, carries no comment text, and is limited per owner. Webhooks never needed this, because a webhook's URL can be anything; here the destinations are constants.

### What the thread shows

`AnnotationThreadView.issues`: every created issue (service, target name, key and URL), to whoever sees the thread (external readers included: a private repository's name and an issue number are shown to them by design, and the dialog says so), and the caller's own requests still pending or failed with the reason. The links are read in the same D1 call as the thread's messages, so no read path gains a round trip.

## Data and regions

Both new tables are an owner's data and live in the owner's region (`TABLE_HOMES`): `integration_connections` (regional, like webhooks) and `thread_issues` (regional, with the thread, cascading from the thread and the artifact). The job runs on the region's database; tombstones are global and written first (the global-first rule of decision 0005), then the regional batch deletes the row. The services' `two-regions.test.ts` runs the whole flow for an EU workspace with the strict region guard.

- **Removing a connection** writes an `integration_connection` tombstone (global) first, then deletes the row with its `integration.removed` event (regional). `exportTombstones` exports it; after `applyTombstones` stores the markers, `applyIntegrationTombstones` reads the tombstoned connection, account and workspace IDs from the global database a page of 90 at a time and deletes, in every region, the connections a restore brought back, so a removed credential never acts again (the operator's `apply-tombstones` runs both). A retry after a failed regional batch finds the tombstone already there.
- **Account deletion** deletes the account's connections and clears `created_by` on workspaces' connections and `requested_by` on issue requests, in both batches (`regionalDeletion`). **Workspace deletion** deletes the workspace's connections in `deleteWorkspace` and again as `advanceWorkspaceDeletion` finishes.
- **Issue links** go with the thread and the artifact by foreign key. A removed connection keeps the links of issues it created; its pending requests fail.
- **The account export** lists the account's connections by service, label, identity and target names, never the credential.

## Audit

`integration.connected` (the service and the number of targets), `integration.changed` (which of label, credential and targets changed, as booleans and a count), `integration.removed` (the service), `integration.failing` (the service and the reason; by the admin who tested, or the system when the job found it) and `issue.created` (the service, the repository or Linear team ID, and which of the four parts were included as booleans; never the title, the text or the URL; the audit rule allows this target: only admins read the log, they already see connections' targets, and where data left is the fact that matters), each through `auditEvent` in the change's own batch. `issue.created` is written when the issue exists, by the job, with the person who asked as the actor; a request that fails records nothing.

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

- One way only in this delivery: Portifact creates the issue and links it. No syncing back, no webhooks from GitHub, Linear or Jira, no resolving a thread when its issue closes, no comment mirroring.
- An OAuth app (or a GitHub App with an installation flow, or an Atlassian OAuth 2.0 app) for each service.
- Slack.

## Addendum: Jira (2026-11-11)

Jira Cloud joins GitHub and Linear as a third service (`jira` in `INTEGRATION_SERVICES`), with the same rules as above unless this section says otherwise: admins manage connections only through the dashboard session (role action `integrations`), the owner side creates issues (role action `issues`, never a token), only the jobs Worker calls Jira to create, the app Worker calls it only to check a credential being entered, every check in "Sending" and "Checked again" applies, removal writes the same tombstone, deletion and transfers behave the same, and it ships under the same switch. Jira Server and Data Center are out of scope, as GitHub Enterprise Server is.

### No host from input: Atlassian's gateway

A Jira Cloud site is `<name>.atlassian.net`, a host the customer chooses, and the rule "every call goes to a fixed origin" holds only if Portifact never calls it. It does not: Atlassian serves every site's REST API through its gateway, `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`, and API tokens with scopes must be used there. Atlassian's page on API tokens says "You need to call the Atlassian API to use API tokens with scopes for Jira" with the base `https://api.atlassian.com/ex/jira/{cloudId}` and Basic authentication with the account's email and the token ([Manage API tokens for your Atlassian account](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)); the page on service accounts says their tokens "must always use the Platform API Gateway URLs beginning with api.atlassian.com" ([Manage API tokens for service accounts](https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/)). So:

- `INTEGRATION_API.jira` is `https://api.atlassian.com`, a constant. The site is named only by its cloud ID, a UUID validated by `JiraCloudId` and placed in the path by `jiraApiUrl`. `checkIntegrationCall` adds, for Jira, that the path is exactly `/ex/jira/<uuid>/rest/api/3/<segments of letters, digits, _ / ->`, so a call can reach only one site's Jira REST API version 3, never another Atlassian product or endpoint on the gateway.
- The admin finds the cloud ID by opening `https://<site>.atlassian.net/_edge/tenant_info` in their own browser (it answers `{"cloudId": "…"}`); Portifact never calls the site. Atlassian's documentation shows `{cloudId}` without saying how to find it; `_edge/tenant_info` is the widely used way (community reports, not an official page). Release check.
- A token without scopes ("classic") is meant for the site URL and is not supported: the page tells the admin to create a token with scopes, and one without them fails the check with `credential_rejected`.

### The credential: email and token, sealed together

Basic authentication needs the token's account email. The email is part of the credential: `jiraCredential` puts `{ account, token }` in the one sealed value (`INTEGRATIONS_KEY`, bound to the connection), so it is never stored in the clear, never returned (the view has the token's last four characters as the hint, never the email), never in audit details, the export or logs. A new token is accepted only with its email (`IntegrationUpdate.account`, refused alone and refused for other services). The identity shown is the `displayName` Jira's `myself` reports, as GitHub's login and Linear's name are.

Scopes: the page asks for exactly `read:jira-user` (`GET myself`), `read:jira-work` (`GET project/{key}`, `GET search/jql`) and `write:jira-work` (`POST issue`), as Jira's OpenAPI document lists them for those operations ([swagger-v3.v3.json](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json), `x-atlassian-oauth2-scopes`; the granular equivalents are `read:user:jira`, `read:project:jira`, `read:issue-type:jira`, `read:issue-details:jira`, `write:issue:jira` and those the document lists with them). `GET serverInfo` needs no scope. Whether the token-creation page offers these classic scopes for a scoped token, or only granular ones, could not be verified without an Atlassian account; release check.

### The check

`checkCredential` for Jira makes `2 + n` calls (`n` ≤ 10 projects), all to the gateway:

1. `GET serverInfo`: its `baseUrl` must be exactly `https://<site>.atlassian.net` for the site the admin typed (`jiraBaseUrlIsSite`). This proves the cloud ID belongs to the site, so the links Portifact builds point at the Jira the calls went to; otherwise `site_mismatch` ("The cloud ID does not belong to that Jira site"). An unknown cloud ID (404) is `site_mismatch` too.
2. `GET myself`: the identity; 401 is `credential_rejected`, 403 `missing_permission`.
3. `GET project/{key}` for each project key: its name (shown as the target's name) and its issue types, from which `jiraIssueType` picks the type Portifact creates (`Task` when there is one, otherwise the first standard type, never a subtask or an epic level). A project with none is `issues_disabled` ("it has no standard issue type"). The issue type ID is kept in the stored targets JSON for the job and never shown.

The site name and cloud ID are stored in two nullable columns (`integration_connections.site` and `cloud_id`, migration 0065, `ALTER TABLE ADD COLUMN`, no rebuild); they cannot change: another site is another connection. The connection's view carries `site` (the name, not a secret) for its admins; the owner side's list never does.

### The issue's link

Jira's create answer is `{ id, key, self }`, and `self` is an API URL, not the issue's page. 0018 builds issue URLs in the domain, never from an answer, and Jira follows: `checkIssueKey` accepts the returned key only as `<PROJECT>-<number>` in the target project, and `jiraIssueUrl` builds `https://<site>.atlassian.net/browse/<KEY>` from the stored site and that key, which `checkIssueUrl` then checks (HTTPS, host exactly the stored site, path exactly `/browse/<KEY>`). The site name is a customer-chosen host, accepted here because it is only ever rendered as a link and never fetched by any Worker; it is one DNS label checked by `JiraSiteName`, and serverInfo proved it was the site behind the cloud ID when the connection was checked. That proof does not last on its own (Atlassian lets a site change its URL), so it is asked again (below, "When the site changes its address"). A Jira site with a custom domain still answers on its `atlassian.net` name, which is what `baseUrl` reports.

### When the site changes its address

A cloud ID can stop serving the stored name, for example when an admin of the Jira site changes its URL. Links built from the old name would then point at a site that is not that Jira (or nobody's, until someone takes the name), and every reader of the thread sees them. So:

- **Test** asks `serverInfo` again (it is the check's first call). A `baseUrl` that names anything but the stored site marks the connection `site_mismatch` (`IntegrationAttention`), through the same guarded write as a refused credential (`markAttention`: only the credential that was checked, one `integration.failing` event with reason `site_mismatch`, in the dashboard's and the CLI's audit summaries). Requests are then refused ("its Jira site changed its address"), and pending ones end with the failure `site_changed`. Only connecting the site again with its current name fixes it: the site cannot be changed on a connection, because another name is another site. A later Test that finds the stored name again clears the mark.
- **The job** asks `serverInfo` once more on the **first attempt** of each issue, right before `POST issue`: one more call per issue (the first attempt costs two calls, `GET serverInfo` and `POST issue`). A mismatch marks the connection like Test and ends the request with `site_changed`, creating nothing; a failure of that call is classified like any other (retried, or the connection marked on a 401). **Retries do not ask again** (a retry is already the search plus, when nothing was found, the create): a site renamed between the first attempt and a retry, within the 2.5 hours of retries, can still get one issue linked to the old name. The next request, or an admin's Test, catches it.

### What is sent: Atlassian Document Format

Jira's `description` is Atlassian Document Format (ADF), not Markdown. `issueSections` (domain) decides once what an issue says from the parts the person left on; `issueBody` writes those sections as Markdown (GitHub, Linear) and `issueDocument` as ADF (Jira), so "`issueBody` is the only builder of what is sent" becomes "the two writers of `issueSections` are the only builders", one per format, and they cannot say different things. The document uses only `paragraph`, `text`, `codeBlock` (language `text`) and `rule`, with two marks: `code` on the artifact's name and `link` on Portifact's own thread URL. The quote and the first message are the single text node of a `codeBlock`, which by ADF's rules takes no marks ([codeBlock](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/codeBlock/)), after the same cleaning and bounds as for the other services: nothing in them can become a link, mention, media, smart card, macro or formatting. A property test checks that no other node type or mark is ever written and that the only `href` is Portifact's. The dashboard previews the document (`issueDocumentText`) built by the same function. The title goes as `summary`, made inert by `issueTitle` like for every service.

### Finding a lost issue: bounded JQL

Before every retry the job searches `GET search/jql` (the current endpoint; `GET search` is being removed) with `maxResults` 30 and only the `description` and `created` fields, and the query built by `jiraFindJql`: `project = "<KEY>" AND creator = currentUser() AND created >= -1d ORDER BY created DESC`. The only value in it is the validated project key, quoted by `jqlString` (backslashes and quotes escaped, controls refused); nothing the person typed ever enters JQL. `creator` is the account that created the issue and cannot be changed (unlike the reporter), so someone who copies the reference into their own issue cannot get it linked, as with GitHub's author check; among the results the job takes the oldest whose description's text (`adfPlainText`, bounded) holds the reference line and whose `created` (from the answer, parsed by `jiraTimestamp`, compared in code because JQL dates read in the account's time zone) is not earlier than the request's own creation time, less `INTEGRATION_LIMITS.lookupSkewMs` (two minutes of clock skew between Portifact and Jira).

What remains: `creator = currentUser()` stops other accounts, not someone with "Edit issues" who pastes a pending request's `Reference: ti_…` into another issue the connection's own account created **after** the request (within the day and the retry window); a retry would link that issue. GitHub's author check has the same gap. Searching by an issue property Portifact sets at creation would close it, but Jira indexes entity properties for JQL only when an app declares them (a Connect `jiraEntityProperties` module or the Forge `jira:entityProperty` module, [Jira entity properties](https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/)), which a pasted token cannot do. The reference is never shown outside the issue body and the thread's own view, so a person must see a pending request's ID and act within its retry window. Jira's search is eventually consistent ("recent updates might not be immediately visible"; most appear within seconds, per [Search and reconcile](https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/)); the first retry is a minute after the lost answer, but a slower index could miss it and create a second issue. `reconcileIssues` does not help, since it needs the lost issue's ID. Open risk, like GitHub's 30-issue window.

### A project's issue type

The check keeps, per project, the issue type to create (`jiraIssueType`). If a Jira admin later removes that type, every issue in the project fails with `rejected` (Jira answers 400). Recovery is a Test: it reads each project's issue types again (it already calls `GET project/{key}`), saves the current ones, and says in plain words which projects changed (`IntegrationTestResult.refreshed`, "Portifact now creates issues in ENG with the project's current issue type"). A save that runs the check (a new credential or new targets) also stores what it read. A save that changes only the label runs no check and refreshes nothing.

### Answers and failures

The classification of 0018 applies unchanged: 401 `credential_rejected` (and the connection marked), 403/404/410 `target_unreachable`, 408/429/5xx, timeouts and network errors retried, 3xx, oversized or unreadable answers `invalid_response`, other 4xx (such as a project whose create screen requires another field) `rejected`. A 429 or 403 with `Retry-After` is a rate limit, retried.

### Audit, EU and data

`issue.created` carries `service: "jira"` and the project key as its target (`JiraProjectKey` in the detail's union): a short identifier the admins who read the log already see on the connection, and where the data went is the fact the log is for. Never the site, the email or the URL. `integration.*` events are unchanged (service and counts). For an EU owner the dialog says what is sent goes to Jira, outside the EU: Portifact cannot know where a customer's Atlassian site keeps data, and the call crosses Atlassian's global gateway. Atlassian is the customer's chosen destination, not Portifact's processor, as GitHub and Linear are ([legal.md](../legal.md), "Pending changes").

### Costs (pinned in tests)

- Connecting or testing: `2 + n` calls to the gateway (`n` projects), the same D1 calls as the other services.
- Asking for an issue: the same 5 D1 round trips and one batch of 2 as GitHub and Linear (`integrations-jira.test.ts`).
- The job: two calls on the first attempt (`GET serverInfo`, then `POST issue`; was one before the site re-check); two (`GET search/jql`, then `POST issue`) on a retry that finds nothing, one when it finds the lost issue.

### Released clients

Every released CLI (v0.30.0 to v0.39.0) validates responses with the contracts it shipped with, whose `IntegrationChoice.service` and `ThreadIssueView.service` were the closed list `github`, `linear`. Those versions fail with `server_error` on any Jira data: `portifact annotations` (list, show, export) on an artifact with a thread that has a Jira issue, for every reader of it, and `portifact integrations` for a space with a Jira connection; MCP clients are unaffected (the server builds their answers). From this change on, the response side is tolerant: `service` is any lowercase name (`IntegrationServiceName`) and `ThreadIssueView.failure` any lowercase reason; the CLI prints an unknown service and reason as they come, the dashboard shows "Another service" and a neutral reason. Inputs keep the strict enums. Jira (and `site_changed`) must therefore be switched on only after a CLI release that includes this change is out, and the release notes say which versions fail meanwhile ([releasing.md](../releasing.md), "Integrations"). The next service needs no such wait.

### Release checks

In [releasing.md](../releasing.md), "Integrations": the token page's scopes, `_edge/tenant_info`, serverInfo's `baseUrl` for a site with a custom domain, the ADF rendering of hostile text, the error shapes, search lag after a lost answer, and no redirects.
