# 0009 Webhooks

- Status: accepted
- Date: 2026-11-10 (revised the same day after an independent security review)
- Feature: premium plan P6 (`webhooks` in `PLANS`, Pro and above)

## Question

Paid owners want their artifacts' activity (new comments, resolved threads, new versions, expiries and access changes) in their own systems and chat rooms. That means Portifact sends HTTP requests to URLs its users choose, from Workers that share a Cloudflare account with other projects. How does it deliver events reliably without becoming a proxy into anything an outside client could not reach, without leaking more than the owner may read, and without letting one owner spend the platform's budget?

## What a webhook is

A webhook belongs to an owner (a personal space or a workspace), is managed by the owner's admins only, and subscribes to a set of event types for every artifact of that owner. It has an HTTPS URL, a format (`generic`, `slack` or `discord`) and, for `generic`, a signing secret. At most 10 per owner (`WEBHOOK_LIMITS.perOwner`, a safety cap, not a plan value).

Events: `comment.created` (a new thread or a reply), `thread.resolved`, `artifact.published` (a new version, a rollback included), `artifact.expiring` (scheduled at the same moment as the expiry notice) and `artifact.access_changed` (the mode, the reader list, indexing or embedding changed; the bar and comment visibility do not count, as they do not move the policy generation). Added with approval reviews ([decision 0013](0013-approval-reviews.md)): `review.requested` (a new request, not reviewers added later) and `review.completed` (the version under review became approved or changes requested, once per version as `announce` records it). Each type's bit in `webhooks.events` is its position in `WEBHOOK_EVENTS` (`1 << index`); types are only ever appended, so every subscription stored before keeps its meaning, and migration `webhook_review_events` widened the column's CHECK from 31 to 127, rebuilding `webhooks` with its two child tables copied aside first (dropping the parent would have cascaded its implicit delete into pending events and the delivery log). An eighth type needs the CHECK widened again the same way; the column itself is a 64-bit integer, so the encoding has room for many more. A test event (`webhook.test`) is sent on request and cannot be subscribed to.

## Threat model

The attacker may be:

1. **An owner with a paid plan** who registers a URL to reach something that only Portifact's Workers could reach: private networks, `localhost`, Cloudflare's own services, other Workers or zones of the same Cloudflare account, Portifact's own hosts (to act with an internal path), or the metadata services of a cloud. Also an owner who uses deliveries to flood a third party, or to spend Portifact's budget (subrequests and CPU on the jobs Worker).
2. **A receiver**, the server behind the URL, which may be hostile or broken: slow, endless, huge, redirecting elsewhere, answering errors forever, or changing what its DNS name points at after creation.
3. **Someone who learns a webhook's URL**: a Slack or Discord incoming webhook URL is itself the credential to post into a channel, so listing, logging or exporting it leaks that credential.
4. **Someone who can post to the receiver** pretending to be Portifact, or who replays a captured delivery.
5. **A reader or member** whose activity becomes an event: their identity and their words must not leave through the owner's webhook beyond what the owner side already sees, and comment text never leaves at all.
6. **Someone with a copy of the database** (a leaked backup, a Time Travel restore): secrets must not be readable from D1 alone, and a restore must not bring back a webhook the owner removed.

Out of scope: an attacker with the Workers' secrets or deploy credentials, and the owner forwarding deliveries elsewhere on purpose.

## What the platform does and does not block

Checked against Cloudflare's documentation on 2026-11-10. What is documented is stated as such; what is not is listed as unverified, and the feature ships switched off until it is verified ("Switched off" below).

- **The Worker's own zone (documented).** By default a Worker's `fetch` to a host in its own zone goes to the zone's origin, "ignoring any Workers mapped to the URL" and "bypassing Cloudflare security settings". With the `global_fetch_strictly_public` compatibility flag, such a request "will loop back to the" front door "and will be treated like a request from the Internet". The jobs Worker turns the flag on. The jobs Worker has no route, so this only says what happens if it had one.
- **Other zones, Workers' custom domains, `cdn.cloudflare.net` names and tunnel hosts of the same account (unverified).** The flag's documentation covers requests to the Worker's own zone only. Whether a subrequest from a route-less Worker reaches another zone or Worker of the same account exactly as an outside client would is not documented; a same-account Worker fetch has been reported to fail with error 1042, which suggests special handling. This is not established, and it is one of the release checks.
- **The `CF-Worker` header (documented, with a gap).** Cloudflare adds `CF-Worker` to every Worker subrequest, set to "the name of the zone which owns the Worker" (Cloudflare HTTP headers reference). For a Worker without a zone the documentation does not say what it carries; it may be the account's `workers.dev` subdomain, which the other projects on the account share, so every receiver could learn it. That is an identifier, not a credential, but it ties Portifact to the account's other projects. Verifying it is one of the release checks.
- **Private and special addresses.** Outbound TCP sockets refuse "Cloudflare IPs, `localhost`, and private network IPs" (TCP sockets documentation). The `fetch` documentation does not say the same about HTTP, and community answers from Cloudflare staff say `fetch` does not allow direct IP access. A Worker has no route into anyone's private network except through explicit bindings (Tunnels, VPC services, Hyperdrive), none of which the jobs Worker has. Because the `fetch` behavior for a DNS name that resolves to a private address is not documented, Portifact does not rely on it: it refuses IP literals and internal names itself and treats DNS rebinding to a private address as an open risk to verify on staging (below).
- **Ports.** `fetch` from a Worker reaches standard HTTP ports; Portifact allows only 443 anyway.
- **Redirects.** `fetch` follows redirects unless told otherwise; deliveries use `redirect: "manual"` and treat any 3xx as a failure, so a receiver cannot bounce a delivery to a host that would fail validation.

## Design

### Validating a URL (`checkWebhookUrl`, `packages/domain/src/webhooks.ts`)

Pure and table tested. The URL is parsed with the WHATWG parser, which already turns every IPv4 notation (decimal `2130706433`, hex `0x7f.1`, octal `0177.0.0.1`, short forms) into a dotted address and IPv6 into brackets, so the checks run on the canonical host:

- at most 2,048 characters, `https:` only, no user name or password, no port other than 443 (`:443` is normalized away), no fragment;
- the host is a DNS name: not an IPv4 address in any notation (every label numeric, or a last label the parser read as a number), not an IPv6 literal (brackets, IPv4-mapped included), no trailing dot (`localhost.`), at most 253 characters, at least two labels, each 1 to 63 characters of `a-z`, `0-9` and `-` not at either end, and an alphabetic top-level label. Internationalized names arrive as punycode (`xn--`), which is accepted; full-width dots and letters are normalized by the parser and then checked like any other host;
- not a reserved or internal suffix: `localhost`, `local`, `localdomain`, `internal`, `intranet`, `lan`, `home`, `corp`, `private`, `home.arpa`, `arpa`, `test`, `invalid`, `onion`, `alt` and `example` (the bare TLD);
- not Portifact's hosts (`portifact.com`, `portifact.dev`, `portifact.test` and their subdomains), and not a Cloudflare-owned domain in `CLOUDFLARE_HOSTS` (`packages/domain/src/cloudflare-hosts.ts`, one place, each entry with the documentation page it comes from): Workers' and Pages' default hosts, R2, `cloudflare.com`, `cloudflare.net` (partial-setup `cdn.cloudflare.net` targets), tunnel hosts (`cfargotunnel.com`, `fed-cfargotunnel.com`, `trycloudflare.com`), the Zero Trust and WARP hosts, 1.1.1.1, Web Analytics, Images and Stream. It is a denylist: it covers what Cloudflare's documentation names on the date above, not every domain Cloudflare owns or will own, and a customer's own name pointing at a Cloudflare target still passes. That residual reach is why the feature ships switched off until the release checks pass;
- a `slack` webhook must be `https://hooks.slack.com/services/...` and a `discord` one `https://discord.com/api/webhooks/...` (or `discordapp.com`), so the unsigned chat formats only ever go to those services.

The check runs at creation and again before every attempt. A webhook whose stored URL no longer passes (a rule was tightened) is disabled with the reason `invalid_url` and nothing is sent.

### Storage and secrets

- `webhooks` (migration 0037): ID (`wh_` and 32 hex characters), owner, host (kept in clear for display and logs), the URL and the signing secret sealed with AES-256-GCM, the ID of the key that sealed them, format, events as a bit set, created, who created it and where (`dashboard` or the OAuth client, the Portifact CLI), disabled (time and reason: `manual`, `failures`, `gone`, `invalid_url`, `key_unavailable` or `unavailable`), the count of consecutive failed attempts, whether it is on probation, and how many times it was enabled again today.
- The URL is sealed too, because a Slack or Discord URL is a posting credential. Lists, the export, the operator tool, logs and the delivery log show only the host. Nothing ever returns the URL after creation.
- The secret is 32 random bytes, shown once in the create response as `whsec_` and base64 (the Standard Webhooks format), never again. It must be stored recoverably because Portifact signs with it, so it is encrypted, not hashed. Creation takes no idempotency key, as with share links: a stored replay would keep the secret in D1. A retried create makes a second webhook, which the admin removes.
- The sealing key is derived with HKDF-SHA-256 from the Worker secret `WEBHOOK_KEY` (at least 32 characters), on both `portifact-app` (seals at creation) and `portifact-jobs` (opens to deliver). Each value's additional data binds it to its webhook ID and its purpose (`url` or `secret`), so a value copied to another row or column does not open. The key ID is the first 16 hex characters of an HMAC of a fixed label with the derived key, so a value always names the key that sealed it. Without `WEBHOOK_KEY`, creating a webhook answers `503 capacity_unavailable` and deliveries wait in the outbox (the job throws and is retried).
- **Rotation**: set the new value as `WEBHOOK_KEY` and the old one as `WEBHOOK_KEY_PREVIOUS` on `portifact-jobs` first, then `WEBHOOK_KEY` on `portifact-app`. The jobs Worker opens values with either key and its maintenance run re-seals up to 200 webhooks a run with the current key (`rewrapWebhookSecrets`, counted in the run's log line as `webhookKeysRewrapped` and `webhookKeysLeft`). Once `webhookKeysLeft` is 0, delete `WEBHOOK_KEY_PREVIOUS`. Keep the previous key's value somewhere safe for at least 30 days after a rotation: a D1 Time Travel restore to before the rotation brings back values sealed with it, and they open only if `WEBHOOK_KEY_PREVIOUS` holds it again. A value sealed with a key the Worker no longer holds never throws in a loop: the delivery disables that webhook with the reason `key_unavailable`, which the owner sees, and ends the job; the owner removes it and adds it again. A leaked signing secret is rotated by the owner: add a new webhook, switch the receiver, remove the old one.

### Recording an event (the write side, `packages/services/src/webhook-activity.ts`)

The write that causes an event adds two statements to its own batch, conditioned like its other writes on the claim or the old state, so the event exists exactly when the write does and costs no extra round trip:

1. an upsert into `webhook_events` (pending, one row per webhook, artifact and event type) for every enabled webhook of the owner subscribed to the type, adding to `count`, keeping the first and last time, the latest version number, access mode or expiry, and the acting user only while every write in the row was by the same person on the owner side;
2. an `outbox` job (`webhook_delivery`, subject the webhook) for each of those webhooks that has no fresh job waiting, available 60 seconds later (`WEBHOOK_LIMITS.coalesceMs`).

Every write in the window lands in the same pending rows and the same job, so a burst of comments becomes one delivery per webhook with a count. Nothing is added when the owner's entitlements, already loaded with the artifact, lack `webhooks`: the annotation writes take them from `load`, `commitPublish` and `updateAccess` join `owner_plans` into a read they already make, and `rollbackArtifact` already resolves them. Without a subscribed, enabled webhook the statements match no row and write nothing. The expiry scan adds the same two statements to the batch that schedules the expiry notice (it is not a request path; it reads the owners' plans once per run). Writes never check budget protection or the daily cap, so a delivery problem can never refuse or slow the write.

The outbox relay moves from the 15-minute schedule to its own one-minute schedule on the jobs Worker (one indexed D1 read a minute), so a delivery arrives one to two minutes after the first write of a burst; the maintenance scans stay every 15 minutes.

### Delivering (`deliverWebhook`, `packages/services/src/webhooks.ts`)

Each run of a `webhook_delivery` job:

1. Reads the webhook and the owner's plan. A missing webhook is done. A job whose time has not come (a duplicate message of a retry that waits for its backoff) does nothing. With deliveries switched off, a disabled webhook, or an owner whose plan no longer includes `webhooks`, it drops the pending events and sends nothing; the webhook itself stays, and works again when the plan returns or an admin enables it.
2. Defers the job by 15 minutes, keeping its events, while budget protection includes `block_uploads` (the first step at US$100) or the jobs Worker has `WEBHOOKS_PAUSED` set (the emergency stop).
3. On its first run, claims up to 50 pending rows (`WEBHOOK_LIMITS.eventsPerDelivery`) into a delivery: a guarded update writes the delivery (its ID, `whd_` and 32 hex characters, its events and its creation time) into the job's own payload, and in the same batch subtracts the claimed counts from the pending rows, deleting those that reach zero, conditioned on that update. Activity that arrives meanwhile keeps its own counts and has its own job. A run that loses the claim does nothing.
4. Claims the attempt with a guarded update of the payload's attempt and start time, only once the job is due (`available_at <= now`) and taken over only when an earlier attempt started more than 5 minutes ago. A duplicate message therefore never sends an attempt early, and never sends one twice at once; the claim and the send are separate steps, so a run that dies after the claim leaves the attempt to be retried after the 5 minutes, which can repeat a delivery (at least once, same delivery ID).
5. Counts the attempt in a per-owner, per-UTC-day counter (`rate_limits`, key `webhook:attempts:<owner>:<day>`, one upsert that returns the new count) before sending. Past `WEBHOOK_LIMITS.attemptsPerOwnerPerDay` (1,000) the job waits for the next UTC day with one `skipped` entry (`daily_cap`) per webhook and day. The counter does not belong to any webhook, so removing and creating webhooks never resets it, and concurrent consumers cannot pass it.
6. Opens the URL and the secret, validates the URL again, renders the body and sends one `POST` with `redirect: "manual"`, a 5-second timeout and no cookies or credentials. It reads at most 4 KiB of the response and cancels the rest; nothing of the response is kept but its status.
7. Records the attempt in `webhook_deliveries` (delivery ID, attempt, time, outcome, HTTP status or an error kind: `timeout`, `network`, `redirect`, `invalid_url`, `key_unavailable`, `daily_cap`). On a 2xx it resets the failure count, ends the probation and closes the job. On a failure, one update adds to the consecutive failure count and decides the disable from the count it writes (`failures` at 15, `WEBHOOK_LIMITS.disableAfterFailures`, or at 3 while on probation; `gone` at once on a 410), so concurrent failures cannot step past the threshold; then a retryable failure (network, timeout, 408, 429, 5xx) with attempts left and a webhook still enabled moves the job to `now + delay` (1 minute, 5 minutes, 30 minutes, 2 hours, then 6 hours: six attempts in about 9 hours), and anything else closes it.
8. Enabling a webhook again is bounded too (`checkReenable` in the domain, numbers in `WEBHOOK_LIMITS`): not within an hour of an automatic disable (`failures`, `gone`), at most 3 times per webhook and UTC day, and at most 20 enables per owner and day. A re-enabled webhook is on probation: 3 failures in a row disable it again, until one delivery succeeds. Creating (20 per owner a day) and sending tests (20 per owner an hour) are counted per owner in the same counters.

The queue consumer runs the deliveries of a batch concurrently with each other and alongside the batch's other jobs, so a slow receiver holds only its own job, never a purge, a deletion or a notice in the same batch.

The same delivery ID goes with every attempt: in the `webhook-id` header and the body's `id`, so receivers drop duplicates. Retries re-sign with a fresh timestamp.

### What a delivery says

Generic (`application/json`):

```json
{
  "id": "whd_…",
  "webhookId": "wh_…",
  "createdAt": "2026-11-10T09:00:00.000Z",
  "test": false,
  "events": [
    {
      "type": "comment.created",
      "artifact": {
        "id": "…",
        "name": "Q3 plan",
        "url": "https://….portifact.dev/",
        "viewUrl": "https://app.portifact.com/view/…"
      },
      "count": 3,
      "firstAt": "…",
      "lastAt": "…",
      "actor": { "name": "Ada" }
    }
  ]
}
```

`artifact.published` adds `version` (the latest number), `artifact.access_changed` adds `access` (the mode), `artifact.expiring` adds `expiresAt`, and the review events add `version` and `review` (the status and the counts of reviewers, required approvals, approvals and changes requested, as the artifact list's `review` block, computed in the write's batch and stored in `webhook_events.review`, the latest of the window); `actor` is `null` unless every write in the window was by one person on the owner side (the user of a personal space, or a workspace's admins and editors, checked again when the delivery is built). The test event has `"artifact": null`. Never comment text, quotes, targets, thread or message IDs, reader or author emails, reader names, the reader list, or anything a reader wrote. An admin of the owner can read all of this through the API, so a webhook never receives more than its managers could.

`review.completed` never names anyone (`actor` is `null`), and no review event carries a reviewer's name or address or a note.

Slack (`{"text": …}`) and Discord (`{"content": …, "allowed_mentions": {"parse": []}}`) get one English line per event, such as "3 new comments on <link|Q3 plan>", with no actor and no IDs, artifact names escaped for each service (Slack's `&`, `<` and `>`; Discord's Markdown, masked links and mentions, with mentions also disabled by `allowed_mentions`) and the message capped at the service's limit. They are unsigned, because those services do not verify signatures; their URL is the credential.

### Signing (generic only)

[Standard Webhooks](https://www.standardwebhooks.com/): headers `webhook-id` (the delivery ID), `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA-256>` over `<id>.<timestamp>.<body>` with the secret's bytes (the base64 after `whsec_`). A receiver recomputes it over the raw body, compares in constant time and refuses timestamps more than 5 minutes off, which stops replays of captured deliveries; existing Standard Webhooks libraries verify it as is. The recipe is in the skill and tested in `packages/services/test/webhooks.test.ts`.

### Who manages webhooks

A new role action, `webhooks`, given to admins only: editors and members get `forbidden`, a non-member what a missing owner gives, and another owner's webhook ID answers `not_found`. The interfaces act on the caller's personal space, or on a workspace the request names: `?workspace=<slug>` on every `/api/v1/webhooks` route (the dashboard passes the space of its URL, the CLI the `--workspace` flag; the device's default workspace does not apply, a webhook being a standing channel), and the `workspace` argument of the two MCP read tools. The role, the plan gate and the per-owner counters (`webhook:create:<owner>` and the others) are the workspace's, so its admins share them and an admin's personal plan never stands in for it; a slug the caller is not a member of answers like a missing workspace.

A webhook keeps sending after the app that made it is disconnected, so it is a standing channel out of the account, like a credential ([decision 0003](0003-credentials-scope.md), addendum). Creating, changing, enabling, disabling, testing and removing one therefore take the dashboard session or a bearer token holding `credentials:manage`, which only the Portifact CLI's client record lists; no registered or CIMD client can, whatever scopes the user granted it (`artifacts:share` included). Listing webhooks and their deliveries (hosts, events, state; never URLs or secrets) takes `artifacts:read`, so an agent can see that webhooks exist. MCP offers only those two read tools, whose descriptions say webhooks are managed in the dashboard or the CLI. Each webhook records who created it and where (`dashboard`, or the client ID), shown in the dashboard and the CLI and kept in the export; deleting that person's account clears who, not where.

Creating, enabling and sending a test need `webhooks` in the owner's plan (`plan_required` otherwise); listing, the delivery log, disabling, changing the events of a disabled webhook and removing never do.

### Switched off

Three platform behaviours cannot be verified without real infrastructure: a public name resolving to a private, loopback or metadata address (the validator accepts names such as `127.0.0.1.nip.io`); same-account zones, Workers' custom domains, `cdn.cloudflare.net` names and tunnel hosts; and what `CF-Worker` reveals for the route-less jobs Worker. Until the release checks in [releasing.md](../releasing.md) ("Webhooks") pass, webhooks ship switched off: nothing is delivered unless the jobs Worker has `WEBHOOKS_ENABLED="true"` and `WEBHOOK_KEY`, and the app Worker offers them only with the same variable and key. Without them creating, enabling and testing answer `503 capacity_unavailable` ("Webhooks are not available yet."), the list says `serviceAvailable: false` and the dashboard shows the feature as unavailable, every delivery job drops its events, and the jobs Worker's maintenance run disables every enabled webhook with the reason `unavailable`, so writes record no events. The deployed configuration does not set the variable.

### Lifecycle and restores

- Removing a webhook deletes it with its pending events and log (foreign keys) and writes a `webhook` tombstone in the same batch. `exportTombstones` exports them and `applyTombstones` deletes the webhooks a restore brought back, so a removed destination never receives again. Its outbox job finds no webhook and ends.
- Account deletion deletes the account's webhooks in the deletion request's batch and again as it finishes (which also covers a deletion a restore re-applied). Workspace deletion does the same (`deleteWorkspace` and `advanceWorkspaceDeletion`), and `applyTombstones` removes the webhooks of tombstoned workspaces as it does for accounts. A transfer of an artifact between owners drops its events still waiting for the source's webhooks in the transfer's batch: a delivery only builds events for artifacts its webhook's owner still owns, so they would be dropped later anyway, and activity after the move goes to the target's webhooks. An expiry already notified under the source keeps its mark, so the target gets no `artifact.expiring` for it until the artifact has a new expiry; whoever moves an artifact manages both sides and sees its expiry.
- The maintenance run prunes the delivery log after 7 days (`WEBHOOK_LIMITS.logDays`), in bounded batches.
- A plan that loses `webhooks` stops deliveries without deleting anything: writes stop recording events and jobs drop what was pending. The list shows each webhook as `paused` with the reason.
- The account export lists the webhooks (ID, host, format, events, state and dates), never the URL or the secret.

## Alternatives rejected

- **Sending from the app Worker right after the write**: the request would wait on a third party, a hostile receiver could hold it open, and retries would still need the outbox. The jobs Worker has no route, which also keeps deliveries away from every request path.
- **One delivery per event**: a busy review would send hundreds of requests a minute per webhook. Coalescing per minute bounds subrequests by webhooks and minutes, not by comments.
- **Hashing the secret**: Portifact must sign, so it needs the secret. Asymmetric signatures (Ed25519) would let Portifact keep only a private key per webhook, which is the same storage problem, and few receivers verify them.
- **Showing the URL after creation**: Slack and Discord URLs are credentials; the host is enough to recognize a webhook.
- **Resolving the host and checking its addresses before sending**: Workers have no DNS API, a resolution over DNS-over-HTTPS can differ from what `fetch` connects to (rebinding), and it would add a subrequest per delivery. Portifact relies on the platform for addresses and documents the gap.
- **`artifacts:share` for managing webhooks** (this record's first version): any registered or CIMD client the user ever authorized for sharing could open a channel that outlives its disconnection. Managing now takes the dashboard or the CLI's `credentials:manage`.
- **A new OAuth scope (`webhooks:manage`)**: every client would need new consent and a migration of the CLI's record, for what `credentials:manage` already expresses: an operation only the user's own tools may do.
- **A separate queue for deliveries**: the cleanest isolation, but a new queue to create before deploy; running deliveries concurrently inside the batch with a 5-second timeout removes the head-of-line blocking without new infrastructure.
- **A plan-valued cap**: the per-owner cap and the daily attempt cap are safety caps; Team and Enterprise can get more through `overrides` later if needed.

## Open risks

- **DNS to private addresses.** Portifact does not resolve hosts, so a public name whose records point at `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254` or another special address reaches whatever `fetch` from Cloudflare's network reaches there. The documentation does not state what happens. Release check 1.
- **Same-account reach.** Whether a delivery reaches another zone, Worker custom domain, `cdn.cloudflare.net` name or tunnel of the account other than as an outside client would is undocumented, and the Cloudflare denylist is incomplete by nature. Release check 2.
- **`CF-Worker`.** May reveal the account's `workers.dev` subdomain to every receiver. Release check 3.
- **Abuse of third parties.** An owner can point a webhook at any public HTTPS endpoint. The daily cap (1,000 attempts per owner), coalescing, the 10-webhook cap, the fixed body shape and the disabling after failures bound what one owner can send; suspending the account stops its activity and the operator can stop all deliveries at once.
- **Delivery order and timing.** Deliveries are at least once and can arrive out of order (a retry after a later delivery); receivers use `id` and the event times.
- **English chat text.** Slack and Discord lines are English only for now; translating them needs the owner's language at send time.
- **Restore gaps.** A restore brings back pending events and jobs from the restore point (possibly a repeated delivery, with the same IDs) and loses webhooks created since; a removed webhook stays removed through its tombstone.
