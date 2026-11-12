# 0025 Slack integration: link previews from a workspace's own Slack app

- Status: accepted for delivery 1 (`feat(integrations): connect slack apps to workspaces`), built on the recommendations while the maintainer's questions stay open; delivery 2 (previews) proposed. What delivery 1 changed in this record is in "Delivery 1 as built".
- Date: 2026-11-11
- Feature: premium plan T7 (`integrations` in `PLANS`, Team and above), second delivery: Slack ("instalación por workspace, avisos a un canal, vista previa de enlaces"; "Tokens de terceros cifrados con un secreto del Worker. La vista previa solo muestra datos de artifacts públicos"). Builds on [decision 0018](0018-issue-integrations.md) (connections, sealed credentials, fixed origins, the switch) and [decision 0009](0009-webhooks.md) (the `slack` webhook format).

## Question

A team that works in Slack wants two things from Portifact there: notices in a channel when its artifacts change, and a preview when someone pastes a Portifact link. Webhooks already post one line per event to a Slack incoming webhook. A preview is different: Slack must call Portifact when a link is posted (an unauthenticated endpoint anyone on the internet can reach), Portifact must answer within Slack's time limit and then call Slack back with a credential that acts in the customer's Slack workspace. How does Portifact add that without holding a credential that reaches more than one customer, without a preview that shows anything about an artifact that is not public or tells anyone whether a private artifact exists, and without an endpoint whose cost an outsider controls?

## Decision in short

1. **Channel notices stay on webhooks.** The `slack` format of decision 0009 already does "avisos a un canal". The Slack app adds only what webhooks cannot do: link previews (unfurls).
2. **The customer's own Slack app, not Portifact's.** A workspace admin creates a Slack app from a manifest Portifact shows, installs it in their Slack workspace and pastes its bot token and signing secret into Portifact. Portifact owns no Slack app, no client secret and no OAuth callback. This keeps the maintainer's decision of 2026-11-11 for GitHub and Linear, and for Slack it is also the safer design (below), at the price of more steps for the customer.
3. **One connection per Slack app**, a row of the existing `integration_connections` (regional) with `service = 'slack'`, the token and the signing secret sealed together under `INTEGRATIONS_KEY`.
4. **One inbound endpoint per connection**, `POST https://app.portifact.com/integrations/slack/events/<region>/<connection id>`, which verifies Slack's signature with that connection's signing secret before it trusts a byte, answers at once, and does the preview after the answer (`waitUntil`) with no D1 write.
5. **A preview shows only the name and the type of a public, servable artifact of the connection's own owner.** Anything else gets no preview from Portifact, and every such case looks the same from Slack.

## What webhooks already do, and what the app adds

| Need                                   | Webhooks (decision 0009, `slack` format)                                                                        | This record                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Notices in a channel                   | Yes: one English line per event to a `hooks.slack.com/services/...` URL, coalesced per minute, capped per owner | Unchanged. The Slack page links to the Webhooks page and tells the admin how to add an incoming webhook to the same app |
| Installation per Slack workspace       | No: a webhook URL is per channel and per person who made it                                                     | Yes: one app, installed once, for the whole Slack workspace                                                             |
| Link previews                          | No: they need Slack to call Portifact and Portifact to call Slack back                                          | Yes                                                                                                                     |
| Notices posted by a bot to any channel | No                                                                                                              | No (left out, see "Rejected")                                                                                           |

Moving notices to a bot token (`chat:write` and `chat.postMessage`) would duplicate the webhook pipeline (coalescing, daily caps, the delivery log, disabling after failures) or teach webhooks a second kind of destination, and it would give the stored token the power to post in any channel the bot is in. An incoming webhook URL posts only to its one channel. Slack lets an admin add an incoming webhook to an app from its settings with no code and no OAuth flow, and it posts under the app's name and icon (Slack, "Sending messages using incoming webhooks"), so with this design a customer's notices and previews come from the same app in Slack anyway. The smallest design that satisfies the plan row is therefore: notices through the existing webhooks, previews through the new connection.

Webhooks are still switched off (decision 0009, "Switched off") because generic URLs need release checks about where `fetch` can reach. A `slack` webhook can only go to `hooks.slack.com`, so those checks do not concern it; whether to switch on the chat formats before the generic one is a maintainer question at the end, not part of this record.

## Who owns the Slack app

Two ways to get a credential that can unfurl in a customer's Slack workspace:

- **A. The customer's own app (recommended).** Portifact shows a manifest. The admin opens Slack's "create from manifest" link (Slack supports a prefilled `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded manifest>`), creates the app in their Slack workspace, installs it there, and pastes the bot token (`xoxb-…`) and the app's signing secret into Portifact.
- **B. Portifact's app, installed with OAuth.** Portifact creates one Slack app, activates public distribution (unlisted; Slack does not review unlisted apps), holds its client secret and signing secret, and runs an "Add to Slack" OAuth flow that stores one bot token per Slack workspace.

| Concern                              | A. Customer's app                                                                                                                                                          | B. Portifact's app                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What Portifact holds                 | Per connection: one bot token with `links:read` and `links:write`, one signing secret. Nothing shared between customers                                                    | The same bot tokens, plus one client secret and one signing secret that are the same for every customer                                                                                                         |
| What one leaked secret reaches       | One customer's Slack workspace, and only what two link scopes allow                                                                                                        | The signing secret forges events from every customer's workspace to Portifact; the client secret lets anyone run Portifact's OAuth exchange and refresh flows                                                   |
| Tying an inbound request to a tenant | Before parsing: the URL names the connection, whose own secret must sign the request                                                                                       | After verifying with the shared secret: the tenant comes from the body's `team_id`, so a bug in that lookup crosses tenants                                                                                     |
| Who can be impersonated              | Inside the customer's own Slack workspace, the bot is named whatever their admin chose; nothing crosses to another customer                                                | Portifact's name in every customer's Slack; a phishing "Add to Slack" link for a look-alike app is the classic attack, and a leaked client secret makes it worse                                                |
| Effort for the customer              | About ten minutes and six steps; the person needs permission to create and install apps in their Slack workspace (many companies restrict it and require approval)         | One click, still subject to the Slack workspace's app approval rules                                                                                                                                            |
| What Portifact must build            | Manifest builder, a form, the endpoint                                                                                                                                     | All of A, plus an OAuth callback route on `app.portifact.com`, `state` handling bound to the admin's session, the app's settings and secrets as deployment configuration, and a distribution checklist at Slack |
| When the manifest must change        | Every customer edits their app (Portifact shows the new manifest and which connections are on an old one); a new scope or unfurl domain needs a reinstall by each customer | Portifact edits its app once; a new scope or unfurl domain still needs each customer to reinstall                                                                                                               |
| Their own custom domains             | Possible later: the customer can add their custom hostname to their own app's unfurl domains                                                                               | Impossible: one app has at most five unfurl domains for every customer                                                                                                                                          |
| Who decides                          | Nothing new for the maintainer                                                                                                                                             | The maintainer creates and owns an app at Slack, accepts Slack's API terms for distributed apps, and keeps its secrets                                                                                          |

Recommendation: **A**. It keeps the 2026-11-11 decision, and for Slack it is not only the decision already taken but the more secure design: no secret Portifact holds is shared between customers, and the connection is known before the signature is checked, so a request can only ever be trusted with one tenant's secret. Its cost is the customer's effort and manifest drift, which matter when there are many Slack customers; B is the end state if that happens, and the data model below does not change for it (B would add an install route and fill the same row). Socket Mode is not an option for either (see "Rejected").

### The manifest

Built by one pure function (`slackManifest` in `packages/domain/src/slack.ts`) from the connection's endpoint URL and the deployment's domains, never from user input. The display name is fixed as `Portifact` (amended by delivery 1, item 8 of "Delivery 1 as built"): the admin renames the app in Slack's own settings, which is where two spaces connected to one Slack workspace are told apart. It carries a version number, `SLACK_MANIFEST_VERSION`, stored on the connection when it is completed, so the page can say which connections run an older manifest.

```json
{
  "_metadata": { "major_version": 2 },
  "display_information": { "name": "Portifact" },
  "features": {
    "bot_user": { "display_name": "Portifact", "always_online": false },
    "unfurl_domains": ["portifact.dev", "app.portifact.com"]
  },
  "oauth_config": { "scopes": { "bot": ["links:read", "links:write"] } },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://app.portifact.com/integrations/slack/events/default/ic_…",
      "bot_events": ["link_shared", "app_uninstalled", "tokens_revoked"]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

- **Scopes**: `links:read` (receive `link_shared`) and `links:write` (`chat.unfurl`), nothing else. The token cannot read messages, list channels or post. `app_uninstalled` and `tokens_revoked` need no scope (Slack, "app_uninstalled").
- **Unfurl domains**: Slack matches subdomains and paths of a registered domain (Slack, "Unfurling links in messages"), so `portifact.dev` covers every `<id>.portifact.dev`. At most five; two are used. Staging and the e2e stack use their own domains from configuration.
- **Token rotation off**: a rotated token expires after 12 hours and is refreshed with the client secret, which a pasted credential does not have, and rotation cannot be turned off once on (Slack, "Using token rotation"). A token starting with `xoxe.` is refused when pasted with a message saying so.
- **No organization-wide install** (`org_deploy_enabled: false`): an Enterprise Grid org-wide install spans several Slack workspaces under one token; the first delivery supports one Slack workspace per connection, and events that say `is_enterprise_install: true` are ignored.

## The connection

### What is stored

A row of `integration_connections` (regional, the owner's region, already in `TABLE_HOMES`), `service = 'slack'` (`INTEGRATION_SERVICES` gains `slack`):

| Column                        | Slack value                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credential_box`, `key_id`    | `{ "botToken": …, "signingSecret": … }` sealed as one value with AES-256-GCM under `INTEGRATIONS_KEY`, bound to the connection's ID (`sealCredential`) |
| `credential_hint`             | The token's last four characters                                                                                                                       |
| `identity`                    | The Slack workspace's name from `auth.test` (`team`)                                                                                                   |
| `targets`                     | `[]`: a preview has no target to choose                                                                                                                |
| `external_id` (new, nullable) | The Slack workspace's ID from `auth.test` (`team_id`), compared with every event                                                                       |
| `manifest_version` (new)      | `SLACK_MANIFEST_VERSION` at completion                                                                                                                 |
| `attention`                   | Gains `pending` (created, no credential yet) and `app_uninstalled`; `credential_rejected` and `key_unavailable` keep their meaning                     |

The key is `INTEGRATIONS_KEY`, not a new one: a Slack bot token is the same kind of secret as a GitHub token (it acts at a third party for the owner), rotates with it, and is opened by the same Workers. The rotation, the `key_unavailable` handling and `rewrapIntegrationKeys` apply unchanged.

Reusing the table, rather than a new `slack_connections`, means removal, tombstones (`integration_connection`), `applyIntegrationTombstones`, account and workspace deletion (`deleteOwnerConnections`), the export, the per-owner cap (5 connections of every service together) and the `rate_limits` caps all cover Slack with no new path. The issue paths must refuse a Slack connection: they already refuse a connection with `attention` set and a target it does not list, and a Slack row lists none; the implementation adds an explicit `service` check and a test that `create_issue_from_thread` with a Slack connection answers like a missing connection.

The two migrations' columns are nullable additions, so no table rebuild and no trigger to recreate.

### Creating it: two steps

The endpoint URL must be in the manifest before the app exists, and the token exists only after the app is installed, so a connection is made in two steps, both on the dashboard session only, both role action `integrations` (admins), both gated on the owner's `integrations` feature after authorization:

1. **Start** (`POST /api/v1/integrations/connections` with `{ service: "slack", label }`): writes a row with `attention = 'pending'` and an empty sealed value, counts against the 5 connections and the 20 creates per owner and day, and answers the manifest and the prefilled Slack link. Nothing is called. A pending row older than 24 hours is deleted by the maintenance run (it holds no credential, so no tombstone).
2. **Complete** (`PATCH /api/v1/integrations/connections/:id` with `{ botToken, signingSecret }`): validates the shapes (`xoxb-` and printable ASCII for the token, refusing `xoxe.`; the signing secret as Slack shows it, hexadecimal), checks the token with one `auth.test` call (below), and writes the sealed pair, `identity`, `external_id` and `manifest_version`, clearing `pending`, conditioned on the row's `revision` and on the caller still managing the owner (`stillManages`, as decision 0018). `auth.test` must answer `ok: true` with a `bot_id` (a user token is refused). Records `integration.connected`. The page then tells the admin to click "Verify" next to the Request URL in Slack's app settings; Slack requires that manual step for a URL set in a manifest (Slack, "App manifest reference", `request_url`). This order means the URL is verified only after Portifact holds the signing secret, so the verification request is checked like every other (release check 2 confirms Slack allows installing before the URL is verified).

The signing secret cannot be checked against Slack's API; a wrong one shows as a failed "Verify" in Slack, which the page says. A token and a secret from two different apps pass `auth.test` but every `chat.unfurl` then fails, which marks the connection for attention.

"Test" runs `auth.test` again. Changing the credential is the same `PATCH`. The credential checks count against decision 0018's limits (30 an hour per owner, 20 an hour per admin).

### Who manages and who lists

Exactly as decision 0018: managing is the dashboard session only, never a bearer token (not even the CLI's `credentials:manage`), no MCP tool and no CLI command, because the pasted values act at Slack. The owner side's listing (`GET /api/v1/integrations`, `artifacts:read`, MCP `list_integrations`, `portifact integrations`) leaves Slack connections out (amended by delivery 1): that listing is where the owner side picks a connection to create an issue, a Slack connection creates none, and every CLI up to v0.39.0 validates the listing with a closed enum of services (`github`, `linear`), so one Slack row in a space would make `portifact integrations` fail for that space. Only the admins' page lists them, with what it shows of any connection (label, service, Slack workspace name, the token's last four characters), never the token, the secret or the Slack workspace's ID. Reading, testing and removing are never gated on the plan.

### Removing it

Decision 0018's path, unchanged: the global `integration_connection` tombstone first, then the regional delete with `integration.removed`. After the delete, the app Worker calls `auth.revoke` once with the token it opened before the delete and kept only in memory (in `waitUntil`, failure only logged), so a copy of the sealed value in a backup is dead at Slack too. Revoking a bot token deactivates the bot user but does not uninstall the app (Slack, "auth.revoke"; uninstalling needs `apps.uninstall` with the client secret, which Portifact does not have), so the page tells the admin to delete the app in Slack as well. Account and workspace deletion delete the rows in both of their batches as today, without calling Slack (a deletion never waits on a third party); the token then survives only inside sealed backups, which need `INTEGRATIONS_KEY` to open.

After a D1 restore, `applyIntegrationTombstones` deletes the Slack connections a restore brought back like any other; a restored pending row is deleted by the 24-hour scan.

## The inbound endpoint

### Where

`POST https://app.portifact.com/integrations/slack/events/<region>/<connection id>`, on the app Worker because only `app.portifact.com` holds credentials (`portifact.dev` serves user content only). `<region>` is a value of `REGIONS` (`default`, later `eu`), so the endpoint reads one database by primary key with no directory lookup; a region never changes for an owner (decision 0005), so the URL never does. `<connection id>` matches `IntegrationConnectionId` (`ic_` and 32 hexadecimal characters, 128 random bits).

The route is added to the app host's routing (`apps/app/src/app-host.ts`), outside the dashboard routes and `/api/v1`: it reads no cookie, sends no CORS headers, answers `Cache-Control: no-store`, takes only `POST` and exists only while the switch is on (otherwise the app's ordinary 404).

### Order of checks

Every refusal after the path matched answers the same: `401`, empty body. Nothing says whether a region, a connection, a Slack workspace or an artifact exists.

1. Path shape, method, `Content-Type` (`application/json`), `Content-Length` and the body read capped at 64 KiB (`SLACK_LIMITS.bodyBytes`), and `X-Slack-Request-Timestamp` within 300 seconds of the Worker's clock (Slack's own recommendation). Failing any costs no D1 call.
2. One D1 read by primary key: the connection (`service = 'slack'`) with, in the one-database case, the owner's plan joined (`bothSides`, as the viewer lookup does). A missing or `pending` row computes the HMAC against a fixed dummy key, so the work done does not depend on whether the row exists, and refuses.
3. Opens the sealed pair and computes `v0=` and the hexadecimal HMAC-SHA-256 of `v0:<timestamp>:<raw body>` with the signing secret, compared in constant time with `X-Slack-Signature` (Slack, "Verifying requests from Slack"). A mismatch refuses. A key the Worker no longer holds refuses and marks `key_unavailable` (the existing rule), only when the row it read has no `attention` yet: this is the one write a request that is not verified can cause, it is true whoever sent the request, it happens at most once per connection, and every later request sees `attention` set and writes nothing.
4. Only now is the body parsed (a strict schema for the fields used, everything else ignored).
5. `url_verification`: answers `200` with `{"challenge": …}` as `application/json` and `nosniff`, the challenge accepted only as 1 to 100 characters of `[A-Za-z0-9_-]` (release check 2 records the real shape), so the endpoint never reflects arbitrary text.
6. `event_callback`: answers `200` with an empty body at once, and continues after the answer through `waitUntil`. Anything else verified (an unknown envelope type, an event type not subscribed): `200`, nothing done.

A verified request is always answered `200`, whatever happens next (plan lapsed, switch reaching the app later, a mismatched Slack workspace, an artifact that cannot be previewed), so Slack never retries what Portifact chose to ignore and never disables the subscription for it. Slack disables a subscription when more than 95% of attempts fail within an hour (Slack, "The Events API"); only refused, unsigned requests answer an error, and those are not Slack's.

### After the answer

For every `event_callback`, the envelope's `team_id` must equal `external_id`, and, when `authorizations` is present, its entry must have the same `team_id` and `is_enterprise_install: false`. Otherwise nothing is done and the outcome `team_mismatch` is logged. The signature already proves the app (the signing secret is per app); the team check ensures the token Portifact will use belongs to the Slack workspace the event came from.

- `app_uninstalled` and `tokens_revoked`: one batch sets `attention = 'app_uninstalled'` with one `integration.failing` event, conditioned on `attention is null` and the `revision` read, so a repeat writes nothing. Previews stop until an admin pastes a new token.
- `link_shared`: the preview (next section). Nothing is written.

The connection must also be usable when the work starts: switch on, `attention` null, the owner's entitlements including `integrations`. Otherwise nothing is done.

### Retries and idempotency

Slack retries a delivery up to three times when it gets no `2xx` within three seconds (immediately, after one minute, after five), with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason`. Portifact answers before doing the work, so retries should be rare, and a retry is processed like the first delivery: a second `chat.unfurl` for the same `unfurl_id` modifies the same attachments (Slack, "chat.unfurl"), and the uninstall write is guarded. No `event_id` is stored: deduplication would cost a D1 write per event for an effect that is already idempotent.

Replay: a captured request can be sent again within the five-minute window. It can only cause the same idempotent effect again. A replay store would be a write per event; it is not added.

### Abuse and cost

The endpoint is unauthenticated by nature. Its costs per request are fixed and small:

| Request                                                                  | D1 calls (one database) | D1 calls (separate regional database) | D1 writes | Subrequests |
| ------------------------------------------------------------------------ | ----------------------- | ------------------------------------- | --------- | ----------- |
| Wrong path, method, size, type or timestamp                              | 0                       | 0                                     | 0         | 0           |
| Unknown or pending connection, or bad signature                          | 1                       | 1                                     | 0         | 0           |
| A key the Worker no longer holds, first request for that connection      | 2 (read, batch)         | 2                                     | 1 batch   | 0           |
| `url_verification` (signed)                                              | 1                       | 1                                     | 0         | 0           |
| `link_shared` with no candidate link, or a connection that is not usable | 1                       | 2                                     | 0         | 0           |
| `link_shared` with candidate links                                       | 2                       | 3                                     | 0         | at most 1   |
| `link_shared` in delivery 1 (acknowledged and ignored)                   | 1                       | 1                                     | 0         | 0           |
| `app_uninstalled` or `tokens_revoked`, first                             | 2 (read, batch)         | 2 (read, batch)                       | 1 batch   | 0           |
| `app_uninstalled` or `tokens_revoked`, connection already marked         | 1                       | 1                                     | 0         | 0           |

No per-IP limit is added: a refused request costs at most one primary-key read and one HMAC, which is below what the app's existing anonymous routes cost, and a counter would itself be a D1 write per request. Cloudflare's network protection in front of the Worker is the volume control, as for every route. Signed traffic is bounded by Slack: at most 30,000 events per Slack workspace, app and hour (Slack, "The Events API"), and in practice by how many links people post.

## Calls to Slack

- **Origin**: only `https://slack.com/api/` (`INTEGRATION_API.slack`), three methods: `auth.test`, `chat.unfurl`, `auth.revoke`. Never a host from input. `checkIntegrationCall` gains the Slack origin and runs before every call.
- **Shape**: `POST`, `Authorization: Bearer <token>`, `Content-Type: application/json; charset=utf-8`, `redirect: "manual"` (a `3xx` is a failure), a 5-second timeout, at most 16 KiB of the answer read, which is parsed only for `ok`, `error` and, for `auth.test`, `team`, `team_id` and `bot_id`.
- **Which Worker**: the app Worker. `auth.test` runs while the admin waits (decision 0018's exception for credential checks); `chat.unfurl` and `auth.revoke` run in `waitUntil` after the answer. This is a second, deliberate exception to "only the jobs Worker calls a service": a preview is useful for seconds, changes no Portifact state and has nothing to keep consistent, so the outbox would add a D1 write per posted link and a delay of up to a minute (the relay's schedule) for nothing. The jobs Worker never calls Slack.
- **Retries**: none. A failed preview is dropped and logged; the person sees the link without a preview, as before. Slack's `ratelimited` (HTTP `429` with `Retry-After`) is dropped too. `chat.unfurl` is Tier 3, 50 or more a minute per Slack workspace (Slack, "chat.unfurl"), far above what people post.
- **Disabling**: `invalid_auth`, `not_authed`, `token_revoked`, `token_expired`, `account_inactive` and `missing_scope` mark the connection `credential_rejected` with one `integration.failing` event (the guarded write above, once); previews stop until an admin fixes it. Every other error (`cannot_unfurl_url`, which Slack also returns when the Slack workspace blocks the domain, timeouts, `5xx`) only logs, and nothing counts failures: there is no counter to write, and a connection with a good token and a bad day must not need an admin.

## The preview

### Which links

`slackArtifactLink(url, domains)` in `packages/domain/src/slack.ts`, pure and table tested, accepts exactly:

- `https://<id>.<content domain>/<anything>`, where `<id>` is one label matching `ArtifactId` and the port is absent or 443;
- `https://<app host>/view/<id>` and `https://<app host>/view/<id>/<anything>`.

Query and fragment are ignored, never parsed. Every other URL is ignored, never looked up and never logged: `/s#…` share links, `/read/<id>`, the dashboard, custom domains, other hosts. A share link's token is in its fragment, which keeps it out of HTTP requests, but the URL a person posts is message text, and Slack may include the fragment in the `link_shared` event's `url`; Portifact never matches, stores or logs it (release check 9 records what Slack sends). At most 5 links per event are considered (`SLACK_LIMITS.linksPerEvent`), the first 5 distinct artifact IDs.

### Which artifacts

One regional read: `select id, name, type, state, access_mode, expires_at, archived_at from artifacts where id in (…) and owner_id = <the connection's owner>`. An artifact is previewed only when all of these hold at that moment:

- its owner is the connection's owner;
- `access_mode = 'public'`;
- `effectiveState` is `active` (so not archived, expired, suspended, purging or deleted; suspension is a state, and an account's suspended artifacts are suspended rows).

That is exactly the rule by which the viewer shows an artifact to an anonymous visitor (`getViewerArtifact`), so "public" in a preview means what it means in the rest of Portifact. The bar, `indexable` and `embeddable` do not matter: a preview is neither an index nor a frame, and the link already works for anyone. A share link never makes anything previewable.

Only the connection's owner's artifacts: a preview of another owner's public artifact would show data that owner never chose to send to this Slack workspace, would need the directory and a second region's database, and would turn every Slack connection into a way to test other owners' IDs.

### What it shows

```json
{
  "unfurl_id": "<from the event>",
  "source": "<from the event>",
  "unfurls": {
    "<the url exactly as Slack sent it>": {
      "blocks": [
        { "type": "section", "text": { "type": "plain_text", "text": "Q3 plan", "emoji": false } },
        {
          "type": "context",
          "elements": [
            { "type": "plain_text", "text": "Markdown document on Portifact", "emoji": false }
          ]
        }
      ]
    }
  }
}
```

- **Name**: the artifact's name through `plainLine` (decision 0018's cleaner: NFC, control, bidi and invisible characters removed, one line), at most 150 code points with an ellipsis, `Untitled` when empty, then `&`, `<` and `>` escaped as Slack's formatting rules require (`slackEscape`, shared with the webhook lines), in a `plain_text` object with `emoji: false`. Slack documents link and mention parsing only for `mrkdwn` text and `emoji: false` keeps `:shortcodes:` as typed, so `<!channel>`, `<@U…>`, `*bold*`, `<https://x|y>` and `:emoji:` should show literally; the documentation does not say so of `plain_text` explicitly, which is why release check 7 proves it with hostile names (and records whether the escapes show as entities, in which case the escaping is dropped for `plain_text` only after that check).
- **Type**: one of three fixed English labels (`Website on Portifact`, `Markdown document on Portifact`, `Text document on Portifact`).
- **Never**: content, a description or first lines, the version, dates, the owner's or a workspace's name, the brand or logo, images of any kind, readers, comments, review status, view counts, the custom host.
- **Language**: English, like the webhook lines. A preview is shown to everyone in the channel, so the poster's `user_locale` is not the reader's; a per-connection language is left for later.
- `unfurl_id` and `source` target both posted messages and the composer's preview, the two cases Slack sends (Slack, "Unfurling links in messages").

### What is the same for every other link

Unknown ID, private artifact, another owner's artifact, archived, suspended, deleted: Portifact makes no call, so nothing Slack shows differs between them, and the poster cannot tell which it was. The only thing that varies is whether Portifact unfurls, which happens exactly for links anyone can open anyway. Slack's own behavior for a link no app unfurls (its classic preview, fetched from the URL as an anonymous visitor) is outside Portifact's control and unchanged by this record; release check 8 records it.

### When an artifact stops being public

Slack keeps a preview in the message it was added to. Portifact does not track where it unfurled (that would store channels and message timestamps of the customer's Slack, a write per preview and data the privacy page would have to explain), so it cannot take a preview back. What stays in Slack is a name and a type of something that was public; the link itself now refuses or asks for sign-in. New posts of the link get no preview. The Slack section of the Integrations page says this, and the access dialog's note on making an artifact public mentions previews in Slack.

## Regions

The connection lives in the owner's region, the endpoint reads only that region's database (plus the global plan when it is separate), and nothing about a Slack event is stored. For an EU owner the preview carries the artifact's name to Slack. A preview is not a notice Portifact sends on its own initiative (`noticeDetail` governs those): it answers a link a person posted, into a destination the owner's admin chose and connected, exactly as webhooks and issue integrations do (decision 0005's inventory: "Destinations the customer chooses, documented as leaving the region"). So the name is allowed, and the connection page says, for an EU owner (`euResidency: true` in the listing, as decision 0018), that previews send artifact names to Slack, outside the EU. If the maintainer prefers `noticeDetail` here (question 2), an EU preview shows only the type line and `An artifact on Portifact`.

## Plan, switch, audit and logs

- **Plan**: `integrations` (Team and above), checked after authorization when starting and completing a connection, and on every event from the entitlements the connection read joined. Listing, testing and removing are never gated. A lapsed plan keeps the row; events are acknowledged and ignored. `integrations` stays out of `AVAILABLE_PLAN_FEATURES` until the release checks pass.
- **Switch**: `SLACK_ENABLED="true"` on the app Worker, besides `INTEGRATIONS_ENABLED="true"` and `INTEGRATIONS_KEY`, so Slack can stay off after GitHub and Linear are on. Never in a `wrangler.jsonc`. Off: the endpoint does not exist (404), starting or completing a Slack connection answers `503 capacity_unavailable` ("Slack is not available yet."), the dashboard offers no Slack option, existing Slack rows are listed with `serviceAvailable: false`. The jobs Worker needs no new variable (it only re-seals and prunes pending rows).
- **Audit** (existing kinds, `service: "slack"`): `integration.connected` when a connection is completed (not when started; a pending row holds nothing), `integration.changed` (credential changed, as a boolean), `integration.removed`, `integration.failing` with the reason `credential_rejected`, `key_unavailable` or `app_uninstalled` (a new value of that enum). No Slack workspace name or ID, no channel, no user and no URL in any detail: Portifact never learns channel names (it never asks for them), and channel and user IDs identify people's conversations at another company. No event per preview: a preview changes nothing the owner has, and it carries only public data.
- **Logs**: one `logEvent` line per inbound request after the path matched, with the connection ID, `outcome` (`refused`, `verified`, `ignored`, `team_mismatch`, `unfurled`, `nothing_to_unfurl`, `slack_error`, `rate_limited`, `credential_rejected`, `timeout`), and the counts of candidate and unfurled links. Never a URL, a path, a challenge, a team, channel or user ID, a token, a secret, a signature or a body. `ALLOWED_FIELDS` gains these fields deliberately.
- **Privacy page** (`docs/legal.md`, "Pending changes", added by the first implementation pull request): a workspace's admins can connect a Slack app they create; Portifact then stores that app's bot token and signing secret (encrypted), and the Slack workspace's name and ID; when someone posts a link to one of the workspace's public artifacts in that Slack workspace, Slack sends Portifact the link, the channel, the poster's Slack user ID and the message's identifiers, which Portifact uses only to answer and never stores; Portifact sends Slack back the artifact's name and type; Slack is then a destination the customer chose, outside the EU for an EU workspace.

## Threat model

1. **A member or editor of the owner** (not an admin): cannot start, complete, change or see a connection's secrets (role action `integrations` is admins only, session only). Can post links in Slack like anyone; previews show only what the link already shows anyone. Can rename a public artifact to something hostile: see 6.
2. **An outsider who knows an endpoint URL** (it is in the customer's Slack app settings and may be shared): without the signing secret every request is refused at the cost in the table above. The connection ID is not a credential; the response and the work done are the same for a missing one. A captured request replayed within five minutes repeats an idempotent effect. The outsider can make the app Worker do at most one primary-key read and one HMAC per request.
3. **An admin of another company's Slack workspace**, or anyone who creates a Slack app with Portifact's manifest: their app sends events signed with their own secret. Pointed at a Portifact connection that is not theirs, every request fails the signature. To get previews they must own a Portifact connection, which means being an admin of a Portifact owner with the plan, and then they get previews of that owner's own public artifacts only. Pasting a token of a Slack workspace they do not control requires that token.
4. **Someone who learns the pasted bot token** (from the admin's clipboard, a screenshot, a leaked database copy with the key): `links:read` and `links:write` only. They cannot read messages or post; they could alter the previews of messages in that Slack workspace that contain links to the registered domains, if they also learn each message's channel and timestamp, for example to make a Portifact link's preview say something misleading. The admin revokes it by reinstalling the app or deleting it; Portifact's removal calls `auth.revoke`, which deactivates the bot user. The token never reaches the browser after it is pasted, the logs or the export.
5. **Someone who learns the signing secret**: can forge events for that one connection. Forged `link_shared` events make Portifact call `chat.unfurl` with the real token for URLs and `unfurl_id`s the forger invents; Slack refuses unfurls for URLs not in the message, and the content would be previews of that owner's public artifacts anyway. Forged `app_uninstalled` stops previews until an admin acts (an annoyance, recorded in the audit log). The admin rotates the secret in Slack ("Regenerate") and pastes the new one.
6. **A hostile artifact name** (an editor of the owner chooses it): `plainLine` removes controls and invisible characters and bounds it; `plain_text` with `emoji: false` renders it literally, so it cannot mention `@channel`, link elsewhere, impersonate formatting or inject blocks. JSON encoding is by `JSON.stringify` of a built object, never string concatenation. It can still say misleading words in plain text, as it can everywhere it is shown.
7. **A person in the customer's Slack probing IDs**: a preview appears only for public, active artifacts of the connection's owner, which the person could open anyway. IDs are 50 random bits; probing is noisy in Slack and learns nothing private.
8. **A Slack Connect channel shared with another company**: a link posted there is previewed for both companies (Slack sends the event to the installing workspace, whose `team_id` must match). The preview holds public data only. Release check 12 records the envelope's shape there.
9. **Slack, or something answering for `slack.com`**: TLS to a fixed origin, no redirects, a bounded read parsed for a few fields; a hostile answer can only make Portifact log an outcome or mark the connection for attention.
10. **A database copy or a restore**: the pair is sealed with `INTEGRATIONS_KEY` and bound to its row; removed connections stay removed through tombstones; removal also revoked the token at Slack.

Out of scope: an attacker with the Workers' secrets or deploy credentials; the customer's Slack admins changing their own app (they can make it do anything in their own Slack workspace without Portifact).

## Costs to pin in tests

`apps/app/test/slack-cost.test.ts` asserts, with the D1 call counter the GitHub OIDC cost test uses and a fake Slack:

- refused before the read (bad timestamp, size, path, type): 0 D1 calls, 0 subrequests;
- unknown connection, pending connection, bad signature: exactly 1 D1 call, 0 writes, 0 subrequests, and the same status and body for all three;
- a request for a connection whose key the Worker does not hold: the first 1 read and 1 guarded batch with one `integration.failing`, every later one exactly 1 read and 0 writes, and the same status and body as any other refusal;
- signed `url_verification`: 1 D1 call, 0 writes, 0 subrequests;
- signed `link_shared` with one public artifact of the owner: 2 D1 calls, 0 writes, 1 subrequest; with one database and a second region separately (`two-regions` setup): 3 calls;
- signed `link_shared` naming only a private artifact, another owner's artifact, an unknown ID and a share link: 2 D1 calls (1 when no link parses), 0 writes, 0 subrequests, and no difference in the request to Slack (none) between them;
- signed `app_uninstalled` twice: the first 1 read and 1 batch, the second 1 read only (amended by delivery 1: the row read is already marked); one `integration.failing` in total;
- completing a connection: exactly 1 subrequest (`auth.test`); removing: 1 subrequest (`auth.revoke`).

## Delivery

Two pull requests, each switched off, each with its tests (success, failure and permission paths, the two-region run with the strict guard, the audit coverage test), the docs and the skill notes it changes.

1. **`feat(integrations): connect slack apps to workspaces`**: `slack` in `INTEGRATION_SERVICES` and `INTEGRATION_API`, the migration (`external_id`, `manifest_version`), the new `attention` values, `slackManifest`, start and complete with `auth.test`, Test, removal with `auth.revoke`, the pending scan, the dashboard's Slack section (manifest, prefilled link, steps, the "Verify" instruction, the note on notices through webhooks, the EU note), the endpoint with signature verification, `url_verification`, `app_uninstalled` and `tokens_revoked`, the switch, logs, the security, operations, releasing and legal pending notes, and the `AGENTS.md` bullet. Release checks 1 to 6.
2. **`feat(integrations): preview public artifacts in slack`**: `slackArtifactLink`, the artifact read, the blocks, `chat.unfurl` in `waitUntil`, the cost test, the access dialog's note. Release checks 7 to 14.

Release checks for `docs/releasing.md` ("Slack"), against a Slack workspace the maintainer owns for testing and staging, never production:

1. **Manifest**: the prefilled link creates an app with exactly the two scopes, the three events and the two unfurl domains; `portifact.dev` matches `<id>.portifact.dev` links.
2. **Order and verification**: the app installs before the Request URL is verified; pasting the token and secret and then clicking "Verify" succeeds; record whether Slack signs `url_verification` and the challenge's shape. If Slack does not sign it, stop and amend this record before switching on.
3. **Wrong secret**: a connection with another app's signing secret fails "Verify", and its log line says `refused`.
4. **Rotation**: an app with token rotation on gives an `xoxe.` token, which the form refuses.
5. **Uninstall**: uninstalling the app marks the connection "Needs attention" with one `integration.failing`; record the order of `app_uninstalled` and `tokens_revoked`.
6. **Removal**: removing the connection revokes the token (`auth.test` with it fails afterwards).
7. **Preview**: `.dev` and `/view/` links to a public artifact show the name and type; names with `<!channel>`, `<@U…>`, `*bold*`, `<https://example.com|x>`, `:smile:`, bidi and zero-width characters render literally and notify nobody.
8. **Nothing else**: links to a private artifact, another owner's public artifact, an unknown ID, an archived and a suspended artifact get no Portifact preview, and Slack shows the same thing for all of them; record what that is (Slack's classic preview or none).
9. **Share links**: a posted `/s#…` link gets no call; record whether the event's `url` carries the fragment; the logs carry nothing of it.
10. **Composer**: the preview while typing works with `unfurl_id` and `source`.
11. **Retries**: a staging-only delay past three seconds makes Slack retry with `X-Slack-Retry-Num`, and the repeated `chat.unfurl` leaves one preview.
12. **Shared channels and Grid**: a Slack Connect channel previews with the installing workspace's `team_id`; an org-wide install, if a Grid sandbox is available, is ignored.
13. **Hosts and secrets**: the app Worker's subrequests go only to `slack.com`; no token, secret, URL, channel or user ID appears in either Worker's logs.
14. **Rate limit**: 60 links in a minute in one channel produce previews or `rate_limited` log lines, never a retry loop.

## Delivery 1 as built

What the first pull request settled differently from the text above, and why:

1. **The owner side's listing leaves Slack out** ("Who manages and who lists", amended above). Evidence: `git show v0.39.0:packages/contracts/src/integrations.ts` has `IntegrationChoice.service: IntegrationService`, `z.enum(["github", "linear"])`, and the CLI parses `GET /api/v1/integrations` with `IntegrationChoiceList`, so a Slack row would fail `portifact integrations` on every released CLI. `develop`'s contracts are tolerant (`IntegrationServiceName`), but the row would still be noise there: it has no targets and creates no issue. The issue paths refuse a Slack connection explicitly (`service` check), answering like a missing connection, through the API, MCP and the CLI alike.
2. **`INTEGRATION_SERVICES` keeps meaning issue trackers.** A new `CONNECTION_SERVICES` (`ConnectionService`) adds `slack` for connections, the admins' view, the export and the `integration.*` audit kinds; `thread_issues.service`, `issue.created` and every issue builder keep the narrower type, so the compiler refuses a Slack connection on an issue path. `INTEGRATION_API` gains `slack: "https://slack.com"`, and `checkIntegrationCall` allows only `/api/auth.test`, `/api/auth.revoke` and `/api/chat.unfurl`, without a query.
3. **No plan read on the endpoint in delivery 1.** Nothing delivery 1 does after a verified request needs the plan: `url_verification` answers Slack, and an uninstall is a fact about the app whatever the plan, so it is marked without reading it (a lapsed plan that comes back finds the connection correctly flagged). The plan join (`bothSides`) arrives with previews. So an uninstall costs the read and one batch with a separate regional database too (2, not 3), and a repeat costs only the read: the row it read already has `attention`, so nothing is written (the table above is amended).
4. **`attention` and the audit reason are two enums.** `IntegrationAttention` (the view and the column) has `pending`; `integration.failing`'s reason is `IntegrationFailingReason`, which does not, because a pending row never fails. `integration.connected` takes `targets: 0` for Slack.
5. **Small refusals made explicit.** A refresh token (`xoxe-`) is refused like a rotating access token (`xoxe.`). A pending connection takes only the bot token and secret together: a label alone, a `credential`, `targets` or `account` is refused, so nothing is recorded about a row that holds nothing. Test refuses a pending row, and a token that now answers for another Slack workspace fails Test without marking the connection. A `url_verification` whose challenge is outside the safe shape answers `200` with an empty body (verified, so never `401`). `Content-Length` may be absent; the body read is capped either way.
6. **Removal revokes only while Slack is switched on.** With `SLACK_ENABLED` unset nothing calls Slack, removal included; the row and its sealed value are still deleted at once.
7. **Log outcomes.** `slack_event` adds `uninstalled` and `failed` (an exception after the answer) to the outcomes listed; removal logs `slack_token_revoke` with Slack's answer class. The counts of candidate and unfurled links come with previews.
8. **The display name is fixed.** The manifest always names the app and its bot `Portifact`; no input reaches the manifest at all, so there is nothing to validate. An admin who connects two spaces to one Slack workspace renames each app in Slack (Basic Information, Display Information), and the Integrations page says so. The 35-character limit is Slack's and is enforced by Slack there.
9. **Removing a pending connection records nothing.** Like the 24-hour scan, it writes no audit event and no tombstone and calls nobody. Every removal is conditioned on the revision it read, so a connection completed (or a credential pasted) between the read and the delete is never deleted as what it was: the removal reads the row again and removes it as it is then, with its event, tombstone and revocation; a second change in between answers `version_conflict`.

Verified in Slack's documentation for delivery 1 (docs.slack.dev, read on 2026-11-12): request signing ("Verifying requests from Slack": `X-Slack-Signature` and `X-Slack-Request-Timestamp`, `v0:<timestamp>:<body>`, HMAC-SHA-256 with the signing secret as a UTF-8 key, hex digest prefixed `v0=`, five minutes, an HMAC compare function); `url_verification` (fields `type`, `challenge`, `token`; answer `200` with the challenge as plain text, form or JSON `{"challenge": …}`; "verify the request's authenticity" before answering, though that page does not say Slack signs it, which stays release check 2); `auth.test` (no scopes; `ok`, `team`, `team_id`, `bot_id`, errors including `invalid_auth`, `token_revoked`, `token_expired`, `account_inactive`, `ratelimited`; `POST` with the token in the `Authorization` header and a JSON body accepted; the page does not name the `Bearer` scheme); `auth.revoke` (deactivates the bot user, does not uninstall; `ok`, `revoked`); `app_uninstalled` (no scope; `team_id`, `api_app_id`, `authorizations` entries with `team_id` and `is_enterprise_install`); the app manifest (`display_information.name` at most 35 characters, at most 5 unfurl domains, `request_url` must be verified by hand in the app's settings, `org_deploy_enabled`, `socket_mode_enabled`, `token_rotation_enabled`); and the prefilled `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded JSON>` link ("Configuring apps with app manifests", "Sharing manifests").

## Rejected

- **Portifact's own Slack app with OAuth (B) now**: shared secrets across customers, an OAuth callback and an app owned by the maintainer at Slack; right later if customers' effort becomes the obstacle.
- **Socket Mode**: needs a long-lived WebSocket per app with an app-level token, refreshed every few hours by Slack, which a Worker would hold through a Durable Object per connection, always on, against the budget; Slack also keeps Socket Mode apps out of the Marketplace. HTTP needs nothing running.
- **Notices posted by the bot** (`chat:write`): duplicates the webhook pipeline and widens the token's power; incoming webhooks of the same app do it.
- **The outbox for previews**: a D1 write per posted link and up to a minute of delay, for an effect with no state.
- **Storing `event_id` to deduplicate retries, or a nonce table against replays**: a write per event for effects that are already idempotent.
- **Previews of any owner's public artifacts**: other owners never chose this Slack workspace, it needs cross-region reads, and it turns connections into ID probes.
- **Showing more** (description, first lines, an image, the brand, the version, the owner): each is either content or a fetch Slack would make from a user-content origin; the name and type say what the link is.
- **Requiring `indexable`**: a preview is not search indexing; the plan row's rule is public.
- **Retracting previews when access narrows**: would store where Portifact unfurled (channels and messages of another company's Slack).
- **A new table for Slack connections**: every deletion, tombstone, restore, export and cap path would need a twin.
- **A new key (`SLACK_KEY`)**: the same kind of credential as the issue integrations', opened by the same Workers.
- **Per-IP rate limiting of the endpoint**: a D1 write per request to protect a primary-key read.
- **User tokens and `user_auth_required` prompts**: they would let a preview show what a signed-in person may see, which is exactly what the plan forbids.

## What is left

- Custom domains: the customer could add their hostname to their own app's unfurl domains; the endpoint would then read `custom_domains` (global) for those links. Not in this delivery.
- B, Portifact's own app, if customers ask for one-click installation.
- A language per connection for the type line and the webhook lines.
- Enterprise Grid org-wide installs.
- Anything interactive (buttons, slash commands, comment notices in threads): each needs interactivity endpoints and more scopes, and a decision of its own.
- Jira, the last integration of T7.

## Questions for the maintainer

1. **Who owns the Slack app?** Recommendation: the customer's own app from a manifest (A), keeping the 2026-11-11 decision. Assumed meanwhile.
2. **May an EU owner's preview name the artifact?** Recommendation: yes, as for webhooks and issue integrations, with the EU note on the connection page; the alternative is `An artifact on Portifact`. Assumed: yes.
3. **Only the connection owner's artifacts?** Recommendation: yes. Assumed.
4. **Switch on `slack` and `discord` webhooks before generic ones?** Their URLs can only go to `hooks.slack.com` and `discord.com`, so decision 0009's reachability checks do not concern them, and that is how "avisos a un canal" reaches customers soonest. Recommendation: yes, as a separate small change after reviewing that path. Assumed meanwhile: notices wait for the webhook switch, as today.
5. **Which plan?** Recommendation: `integrations` (Team), as the plan row says; notices stay Pro through `webhooks`. Assumed.
6. **A test Slack workspace** for the release checks, owned by the maintainer. Needed before switching on.
