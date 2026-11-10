# 0009 Webhooks

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan P6 (`webhooks` in `PLANS`, Pro and above)

## Question

Paid owners want their artifacts' activity (new comments, resolved threads, new versions, expiries and access changes) in their own systems and chat rooms. That means Portifact sends HTTP requests to URLs its users choose, from Workers that share a Cloudflare account with other projects. How does it deliver events reliably without becoming a proxy into anything an outside client could not reach, without leaking more than the owner may read, and without letting one owner spend the platform's budget?

## What a webhook is

A webhook belongs to an owner (a personal space or a workspace), is managed by the owner's admins only, and subscribes to a set of event types for every artifact of that owner. It has an HTTPS URL, a format (`generic`, `slack` or `discord`) and, for `generic`, a signing secret. At most 10 per owner (`WEBHOOK_LIMITS.perOwner`, a safety cap, not a plan value).

Events: `comment.created` (a new thread or a reply), `thread.resolved`, `artifact.published` (a new version, a rollback included), `artifact.expiring` (scheduled at the same moment as the expiry notice) and `artifact.access_changed` (the mode, the reader list, indexing or embedding changed; the bar and comment visibility do not count, as they do not move the policy generation). A test event (`webhook.test`) is sent on request and cannot be subscribed to.

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

Checked against Cloudflare's documentation on 2026-11-10:

- **Same zone and same account.** By default a Worker's `fetch` to a host in its own zone goes to the zone's origin, "ignoring any Workers mapped to the URL" and "bypassing Cloudflare security settings" (compatibility flags, `global_fetch_strictly_public`). A Worker that fetches another Worker of the same account is answered with error 1042 unless the caller enables that flag, and even then a `workers.dev` URL of the same account is refused. With `global_fetch_strictly_public` the platform "will strictly route requests as if they were made on the public Internet", so a request to the same zone "will loop back to the" front door "and will be treated like a request from the Internet". The jobs Worker turns the flag on: a delivery to any host, including a zone or Worker of another project on the account, is handled exactly like a request from an outside client, with that zone's WAF, Access and routing.
- **Private and special addresses.** Outbound TCP sockets refuse "Cloudflare IPs, `localhost`, and private network IPs" (TCP sockets documentation). The `fetch` documentation does not say the same about HTTP, and community answers from Cloudflare staff say `fetch` does not allow direct IP access. A Worker has no route into anyone's private network except through explicit bindings (Tunnels, VPC services, Hyperdrive), none of which the jobs Worker has. Because the `fetch` behavior for a DNS name that resolves to a private address is not documented, Portifact does not rely on it: it refuses IP literals and internal names itself and treats DNS rebinding to a private address as an open risk to verify on staging (below).
- **Ports.** `fetch` from a Worker reaches standard HTTP ports; Portifact allows only 443 anyway.
- **Redirects.** `fetch` follows redirects unless told otherwise; deliveries use `redirect: "manual"` and treat any 3xx as a failure, so a receiver cannot bounce a delivery to a host that would fail validation.

## Design

### Validating a URL (`checkWebhookUrl`, `packages/domain/src/webhooks.ts`)

Pure and table tested. The URL is parsed with the WHATWG parser, which already turns every IPv4 notation (decimal `2130706433`, hex `0x7f.1`, octal `0177.0.0.1`, short forms) into a dotted address and IPv6 into brackets, so the checks run on the canonical host:

- at most 2,048 characters, `https:` only, no user name or password, no port other than 443 (`:443` is normalized away), no fragment;
- the host is a DNS name: not an IPv4 address in any notation (every label numeric, or a last label the parser read as a number), not an IPv6 literal (brackets, IPv4-mapped included), no trailing dot (`localhost.`), at most 253 characters, at least two labels, each 1 to 63 characters of `a-z`, `0-9` and `-` not at either end, and an alphabetic top-level label. Internationalized names arrive as punycode (`xn--`), which is accepted; full-width dots and letters are normalized by the parser and then checked like any other host;
- not a reserved or internal suffix: `localhost`, `local`, `localdomain`, `internal`, `intranet`, `lan`, `home`, `corp`, `private`, `home.arpa`, `arpa`, `test`, `invalid`, `onion`, `alt` and `example` (the bare TLD);
- not Portifact's hosts (`portifact.com`, `portifact.dev`, `portifact.test` and their subdomains), and not Cloudflare's own service hosts (`workers.dev`, `pages.dev`, `cloudflare.com`, `cloudflareaccess.com`, `cloudflarestorage.com`, `r2.dev`, `cloudflareclient.com` and their subdomains). Other customers' `workers.dev` receivers are refused too: any outside client could reach them, but the same-account `workers.dev` refusal above means a receiver there may silently fail, and Portifact's own account must never be one hop away;
- a `slack` webhook must be `https://hooks.slack.com/services/...` and a `discord` one `https://discord.com/api/webhooks/...` (or `discordapp.com`), so the unsigned chat formats only ever go to those services.

The check runs at creation and again before every attempt. A webhook whose stored URL no longer passes (a rule was tightened) is disabled with the reason `invalid_url` and nothing is sent.

### Storage and secrets

- `webhooks` (migration 0034): ID (`wh_` and 32 hex characters), owner, host (kept in clear for display and logs), the URL and the signing secret sealed with AES-256-GCM, the ID of the key that sealed them, format, events as a bit set, created, disabled (time and reason: `manual`, `failures`, `gone` or `invalid_url`) and the count of consecutive failed attempts.
- The URL is sealed too, because a Slack or Discord URL is a posting credential. Lists, the export, the operator tool, logs and the delivery log show only the host. Nothing ever returns the URL after creation.
- The secret is 32 random bytes, shown once in the create response as `whsec_` and base64 (the Standard Webhooks format), never again. It must be stored recoverably because Portifact signs with it, so it is encrypted, not hashed. Creation takes no idempotency key, as with share links: a stored replay would keep the secret in D1. A retried create makes a second webhook, which the admin removes.
- The sealing key is derived with HKDF-SHA-256 from the Worker secret `WEBHOOK_KEY` (at least 32 characters), on both `portifact-app` (seals at creation) and `portifact-jobs` (opens to deliver). Each value's additional data binds it to its webhook ID and its purpose (`url` or `secret`), so a value copied to another row or column does not open. The key ID is the first 16 hex characters of an HMAC of a fixed label with the derived key, so a value always names the key that sealed it. Without `WEBHOOK_KEY`, creating a webhook answers `503 capacity_unavailable` and deliveries wait in the outbox (the job throws and is retried).
- **Rotation**: set the new value as `WEBHOOK_KEY` and the old one as `WEBHOOK_KEY_PREVIOUS` on `portifact-jobs` first, then `WEBHOOK_KEY` on `portifact-app`. The jobs Worker opens values with either key and its maintenance run re-seals up to 200 webhooks a run with the current key (`rewrapWebhookSecrets`, counted in the run's log line as `webhookKeysRewrapped` and `webhookKeysLeft`). Once `webhookKeysLeft` is 0, delete `WEBHOOK_KEY_PREVIOUS`. A leaked signing secret is rotated by the owner: add a new webhook, switch the receiver, remove the old one.

### Recording an event (the write side, `packages/services/src/webhook-activity.ts`)

The write that causes an event adds two statements to its own batch, conditioned like its other writes on the claim or the old state, so the event exists exactly when the write does and costs no extra round trip:

1. an upsert into `webhook_events` (pending, one row per webhook, artifact and event type) for every enabled webhook of the owner subscribed to the type, adding to `count`, keeping the first and last time, the latest version number, access mode or expiry, and the acting user only while every write in the row was by the same person on the owner side;
2. an `outbox` job (`webhook_delivery`, subject the webhook) for each of those webhooks that has no fresh job waiting, available 60 seconds later (`WEBHOOK_LIMITS.coalesceMs`).

Every write in the window lands in the same pending rows and the same job, so a burst of comments becomes one delivery per webhook with a count. Nothing is added when the owner's entitlements, already loaded with the artifact, lack `webhooks`: the annotation writes take them from `load`, `commitPublish` and `updateAccess` join `owner_plans` into a read they already make, and `rollbackArtifact` already resolves them. Without a subscribed, enabled webhook the statements match no row and write nothing. The expiry scan adds the same two statements to the batch that schedules the expiry notice (it is not a request path; it reads the owners' plans once per run). Writes never check budget protection or the daily cap, so a delivery problem can never refuse or slow the write.

The outbox relay moves from the 15-minute schedule to its own one-minute schedule on the jobs Worker (one indexed D1 read a minute), so a delivery arrives one to two minutes after the first write of a burst; the maintenance scans stay every 15 minutes.

### Delivering (`deliverWebhook`, `packages/services/src/webhooks.ts`)

Each run of a `webhook_delivery` job:

1. Reads the webhook and the owner's plan. A missing webhook is done. A disabled webhook, or an owner whose plan no longer includes `webhooks`, drops its pending events and sends nothing; the webhook itself stays, and works again when the plan returns or an admin enables it.
2. Defers the job by 15 minutes, keeping its events, while budget protection includes `block_uploads` (the first step at US$100) or the jobs Worker has `WEBHOOKS_PAUSED` set (the emergency stop).
3. Defers the job to the next UTC day while the owner has used `WEBHOOK_LIMITS.attemptsPerOwnerPerDay` (1,000) delivery attempts today, recording one `skipped` entry (`daily_cap`) per webhook and day.
4. On its first run, claims up to 50 pending rows (`WEBHOOK_LIMITS.eventsPerDelivery`) into a delivery: a guarded update writes the delivery (its ID, `whd_` and 32 hex characters, its events and its creation time) into the job's own payload, and in the same batch subtracts the claimed counts from the pending rows, deleting those that reach zero, conditioned on that update. Activity that arrives meanwhile keeps its own counts and has its own job. A run that loses the claim does nothing.
5. Claims the attempt (a guarded update of the payload's attempt and start time, taken over only when an earlier attempt started more than 5 minutes ago), so a duplicate queue message or an overlapping relay never sends the same attempt twice at once.
6. Opens the URL and the secret, validates the URL again, renders the body and sends one `POST` with `redirect: "manual"`, a 10-second timeout and no cookies or credentials. It reads at most 4 KiB of the response and cancels the rest; nothing of the response is kept but its status.
7. Records the attempt in `webhook_deliveries` (delivery ID, attempt, time, outcome, HTTP status or an error kind: `timeout`, `network`, `redirect`, `invalid_url`, `daily_cap`) and, in the same batch: on a 2xx, resets the failure count and closes the job; on a retryable failure (network, timeout, 408, 429, 5xx) with attempts left, moves the job to `now + delay` (1 minute, 5 minutes, 30 minutes, 2 hours, then 6 hours: six attempts in about 9 hours); otherwise closes it. Every failed attempt adds to the consecutive failure count, and the webhook is disabled (`failures`) at 15 (`WEBHOOK_LIMITS.disableAfterFailures`), or at once (`gone`) on a 410. The reason, the time and the last attempts stay visible in the list and the delivery log, and an admin enables it again, which resets the count.

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

`artifact.published` adds `version` (the latest number), `artifact.access_changed` adds `access` (the mode), `artifact.expiring` adds `expiresAt`; `actor` is `null` unless every write in the window was by one person on the owner side (the user of a personal space, or a workspace's admins and editors, checked again when the delivery is built). The test event has `"artifact": null`. Never comment text, quotes, targets, thread or message IDs, reader or author emails, reader names, the reader list, or anything a reader wrote. An admin of the owner can read all of this through the API, so a webhook never receives more than its managers could.

Slack (`{"text": …}`) and Discord (`{"content": …, "allowed_mentions": {"parse": []}}`) get one English line per event, such as "3 new comments on <link|Q3 plan>", with no actor and no IDs, artifact names escaped for each service (Slack's `&`, `<` and `>`; Discord's Markdown, masked links and mentions, with mentions also disabled by `allowed_mentions`) and the message capped at the service's limit. They are unsigned, because those services do not verify signatures; their URL is the credential.

### Signing (generic only)

[Standard Webhooks](https://www.standardwebhooks.com/): headers `webhook-id` (the delivery ID), `webhook-timestamp` (Unix seconds) and `webhook-signature: v1,<base64 HMAC-SHA-256>` over `<id>.<timestamp>.<body>` with the secret's bytes (the base64 after `whsec_`). A receiver recomputes it over the raw body, compares in constant time and refuses timestamps more than 5 minutes off, which stops replays of captured deliveries; existing Standard Webhooks libraries verify it as is. The recipe is in the skill and tested in `packages/services/test/webhooks.test.ts`.

### Who manages webhooks

A new role action, `webhooks`, given to admins only: editors and members get `forbidden`, a non-member what a missing owner gives, and another owner's webhook ID answers `not_found`. The interfaces act on the caller's personal space until workspaces can be chosen; the services take an `Actor` and are tested on workspace owners. Every operation is `artifacts:share` in the API and MCP: a webhook sends the owner's activity to a third party, which is at least as sensitive as sharing, and listing shows sharing configuration. Creating, enabling and sending a test need `webhooks` in the owner's plan (`plan_required` otherwise); listing, the delivery log, disabling, changing the events of a disabled webhook and removing never do. The MCP tools that create, enable or test a webhook tell the agent to ask the user first, and `create_webhook` says the secret is for the user's receiver only.

### Lifecycle and restores

- Removing a webhook deletes it with its pending events and log (foreign keys) and writes a `webhook` tombstone in the same batch. `exportTombstones` exports them and `applyTombstones` deletes the webhooks a restore brought back, so a removed destination never receives again. Its outbox job finds no webhook and ends.
- Account deletion deletes the account's webhooks in the deletion request's batch and again as it finishes (which also covers a deletion a restore re-applied). Workspace deletion does not exist yet; when it lands it must delete the workspace's webhooks the same way.
- The maintenance run prunes the delivery log after 7 days (`WEBHOOK_LIMITS.logDays`), in bounded batches.
- A plan that loses `webhooks` stops deliveries without deleting anything: writes stop recording events and jobs drop what was pending. The list shows each webhook as `paused` with the reason.
- The account export lists the webhooks (ID, host, format, events, state and dates), never the URL or the secret.

## Alternatives rejected

- **Sending from the app Worker right after the write**: the request would wait on a third party, a hostile receiver could hold it open, and retries would still need the outbox. The jobs Worker has no route, which also keeps deliveries away from every request path.
- **One delivery per event**: a busy review would send hundreds of requests a minute per webhook. Coalescing per minute bounds subrequests by webhooks and minutes, not by comments.
- **Hashing the secret**: Portifact must sign, so it needs the secret. Asymmetric signatures (Ed25519) would let Portifact keep only a private key per webhook, which is the same storage problem, and few receivers verify them.
- **Showing the URL after creation**: Slack and Discord URLs are credentials; the host is enough to recognize a webhook.
- **Resolving the host and checking its addresses before sending**: Workers have no DNS API, a resolution over DNS-over-HTTPS can differ from what `fetch` connects to (rebinding), and it would add a subrequest per delivery. Portifact relies on the platform for addresses and documents the gap.
- **A new OAuth scope (`webhooks:manage`)**: least privilege, but every client would need new consent and the CLI's client record a migration, for a set of operations that is sharing in substance. `artifacts:share` already marks the operations an agent must ask about.
- **A plan-valued cap**: the per-owner cap and the daily attempt cap are safety caps; Team and Enterprise can get more through `overrides` later if needed.

## Open risks

- **DNS to private addresses.** Portifact does not resolve hosts, so a public name whose records point at `127.0.0.1`, `10.0.0.0/8` or a link-local address reaches whatever `fetch` from Cloudflare's edge reaches there. Workers run in Cloudflare's network with no route into customers' private networks, and same-account routing is closed by `global_fetch_strictly_public`, but the `fetch` documentation does not state what happens. Verify on staging (a test name pointing at private and loopback addresses, expected to fail) before granting the first paid plan, and record the result here.
- **Abuse of third parties.** An owner can point a webhook at any public HTTPS endpoint. The daily cap (1,000 attempts per owner), coalescing, the 10-webhook cap, the fixed body shape and the disabling after failures bound what one owner can send; suspending the account stops its activity and the operator can stop all deliveries at once.
- **Delivery order and timing.** Deliveries are at least once and can arrive out of order (a retry after a later delivery); receivers use `id` and the event times.
- **English chat text.** Slack and Discord lines are English only for now; translating them needs the owner's language at send time.
- **Restore gaps.** A restore brings back pending events and jobs from the restore point (possibly a repeated delivery, with the same IDs) and loses webhooks created since; a removed webhook stays removed through its tombstone.
