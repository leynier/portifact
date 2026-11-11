# 0019 Audit streams

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan E3, second half, first part (`auditExport` in `PLANS`, Enterprise). Retention policies for artifacts and comments are not part of this record.

## Question

Enterprise customers keep their audit trail in a SIEM. The file export (`GET /api/v1/audit/export`) gives them the log on request; they also want it continuously, without polling, without gaps they do not hear about and without Portifact touching the paths that write events. How does Portifact deliver an owner's audit log to an HTTPS endpoint the customer runs, in order and without silent loss, reusing what webhooks already proved, and within the per-region and cost rules of decision 0005?

## Decision

A stream is its own destination, not a webhook event type. Portifact reads the owner's audit events after a stored position in each database the owner's events live in and posts them in batches, moving the position only after the endpoint answered 2xx. Delivery is at least once, ordered per database and never skips: a consumer keeps each event ID once. A position that falls behind retention is reported as a gap, never hidden.

### Why not a webhook event

A SIEM needs every event, in order, with no loss it is not told about. Webhook events are coalesced per artifact and type, best effort (dropped after their retries or when a webhook is disabled), one request per window, and carry a summary of activity, not the record. Making the audit log one more event type would either weaken those guarantees for the log or strengthen them for every webhook. A stream reuses the webhook machinery (below) with its own delivery state.

### What a stream is

- Per owner (a personal space or a workspace), at most 2 (`AUDIT_STREAM.perOwner`, a safety cap). A label, an HTTPS URL (only the host is shown after it is set), a signing secret (shown once at creation and at each rotation, never returned again), a state (`active`, `paused`, `attention`) with the reason (`manual`, `plan`, `failures`, `invalid_url`, `key_unavailable`), a position per database, failure counters, the last gap reported and a pending test.
- `audit_streams` and `audit_stream_deliveries` are regional (`TABLE_HOMES`), next to the owner's webhooks: the job that delivers runs in the owner's region with the region's database (decision 0005, "Two-region audit"), the stream's deletion goes with the owner's other regional rows, and an EU workspace's stream never leaves the EU database. The global position is a column of the same regional row: positions are times (below), so a restore of either database never makes a position point past events that still exist.

### Positions, order and the settle window

An event's position is `(at, id)`, the order the reader and the export use, oldest first for a stream. `at` is the `now` of the request or run that wrote the event, not its commit time, and the event ID is random, so an event can commit after a later one was already read. Reading only events older than `AUDIT_STREAM.settleMs` (20 minutes) closes that window: a write commits within one Worker invocation of its `now` (at most 15 minutes for the jobs Worker's scheduled run and queue consumer), so no event can appear behind a position once it is settled. This is what makes "never skipping" true without touching the audit write path: `auditEvent` and every batch that records an event are unchanged (no statement, read or round trip added), and the pinned counts in `write-costs.test.ts` did not move.

Each database (the owner's regional one and the global one, `GLOBAL_AUDIT_KINDS`) has its own position and its own batches, each named in the `portifact-audit-source` header (`regional` or `global`). Order is guaranteed within a source. Across sources a consumer can assume only that each event carries its time: merging the two sources by `at` and `id` gives the log's order for everything already received, and with one region both sources are the same database, read for disjoint kinds, so no event is sent twice through two sources.

Rejected: positions by SQLite `rowid`. Rows are numbered in commit order, which would avoid the settle window, but `rowid` is reused when the newest row is deleted (an invitation's withdrawn event, an owner's erased events, a retention sweep on a quiet database), so a position could point past an event that does not exist yet. An `AUTOINCREMENT` column would fix that but changes every `insert ... select` that writes an event (they list every column), which the scope forbids.

### Delivering

The jobs Worker delivers; nothing else fetches a stream's URL. A stream's job (`audit_stream` outbox topic, subject the stream) is its chain: each run sends what is settled and moves its own row to its next time, `now` while more is waiting (after `batchesPerRun` requests), `idleMs` (5 minutes) when caught up, the backoff after a failure, or the next UTC day at the daily cap. It ends only when the stream stops delivering (paused, attention, removed, the plan lapsed, switched off). Creating and resuming a stream write its first job in their own batch.

The maintenance scan `maintainAuditStreams` is the safety net: per region and run, one batch that prunes at most 500 delivery log rows past 7 days and gives a job to at most 100 streams that should have one and have none (`armPerRun`). It runs from the jobs Worker only while streams are switched on. Per 15-minute invocation streams add, per region, that one batch and the key re-seal scan (`rewrapAuditStreamKeys`: one read and one count, plus one update per stream sealed with a retired key, at most 100), so at most 3 calls per region when no key rotates, whatever the number of owners or streams. The scan's count is pinned in `scan-costs.test.ts`; `runMaintenance`'s is unchanged.

One run of the job: reads the stream with its owner's plan (one joined read with one database, two with a separate one), checks the switch, the state and the plan (a lapsed plan pauses the stream with the reason `plan`, keeps its position and records `audit_stream.paused`), waits while `WEBHOOKS_PAUSED` or budget protection holds deliveries (15 minutes, like webhooks), claims the run on its outbox row (one run at a time, taken over after 5 minutes), opens the URL and secrets, checks the URL again (`checkWebhookUrl`), sends a pending test, then up to 4 batches. A batch reads at most 500 settled events of one source after its position, presents them as the reader does (`presentAuditEvents`, the export's `auditJsonLine`), counts one request in the owner's daily counter, posts, and on a 2xx moves that source's position in one batch with its log row, conditioned on the position it read. Bounded worst case per run: about 40 D1 calls (4 batches of a read, at most five presentation reads, the counter and the write, plus the stream, protection, claim and test).

The queue consumer runs stream jobs concurrently with webhook deliveries and issues and alongside the batch's other jobs, so a slow endpoint holds only its own job (10-second timeout, held even if the network ignores the abort signal), never a purge, a deletion or a notice.

### What is sent

The body is JSON Lines (`application/jsonl; charset=utf-8`, where a webhook sends `application/json`), at most 500 events and 512 KiB per request (the first event always goes). Each event line is exactly what the Audit page, the API and the export show (`AuditEventView`, written by `auditJsonLine`): kind, time, actor and target by display name and opaque ID, artifacts by name only while still the owner's (`artifactNames`), the kind's detail, which `AUDIT_DETAILS` already limits to counts, enums, booleans, versions, hosts and email domains. Never comment text, content, labels the reader does not show, tokens, secrets, URLs, full addresses or IPs. Two control lines carry a `record` field and are not events: `{"record":"gap","source","from","to","reason":"retention"}` and the test record `{"record":"test","id","at","stream"}`. Delivering never records an audit event, so a stream never feeds itself.

### Signing and idempotency

The same scheme and headers as webhooks (decision 0009, Standard Webhooks), so one verifier serves both: `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA-256 of id.timestamp.body>` with the secret's bytes. `webhook-id` and `idempotency-key` hold the batch key, `asb_` and a SHA-256 of the stream, the source and the first and last positions, the same on every retry of the same batch; `portifact-audit-stream` names the stream, so a receiver tells a stream from a webhook by that header and the content type. A rotation keeps the previous secret signing next to the new one for 24 hours (space-separated signatures, which Standard Webhooks verifiers accept), so the endpoint switches without losing a request.

### Failures

A 2xx delivers. Any 3xx is a failure (`redirect`, never followed); a 4xx or 5xx is `refused` with its status class; a connection error is `unreachable`, or `certificate` when the error names TLS; a timeout is `timeout`. Nothing of the response is kept but its status class (at most 4 KiB is read, then cancelled). The next request waits for the endpoint's `Retry-After` on a 429 or 503 (bounded to 1 minute to 6 hours), otherwise 1 minute, 5 minutes, 30 minutes, 2 hours, then every 6 hours. After 72 hours of failing without a success the platform pauses the stream with the state `attention` and the reason `failures`, records `audit_stream.paused` and ends the job; the admin fixes the endpoint, sends a test and resumes, and the stream goes on from its position. A URL that no longer passes the checks, or a value sealed with a key the Worker no longer holds, pauses it the same way (`invalid_url`, `key_unavailable`).

A daily request cap per owner (2,000 a UTC day, `rate_limits` key `audit-stream:attempts:<owner>:<day>`, counted before the send) bounds what one owner can spend; it is keyed by owner, so removing and creating streams never resets it. Creating (10 a day), testing (10 an hour) and changes that seal or resume (20 a day) are counted per owner the same way.

### Retention and gaps

The retention sweep is never held back for a stream. When a position is older than the owner's retention cutoff (rounded down to the hour, so a retry within the hour keeps its batch), the events between were or will be deleted: the next batch of that source starts with a gap line from the position to the cutoff, the stream goes on from the cutoff, and the stream row keeps the gap for the dashboard. Events still in that range (the sweep runs every 15 minutes) are past retention and are not sent either.

### Starting point

A new stream starts from now by default: its positions are its creation time, so events written before it are not sent and its own `audit_stream.created` event is the first. It may instead start from the oldest event still kept: the positions are empty, and the backfill goes through the same bounded batches, cap and job, oldest first.

### Who and where

- Only admins (role action `audit`, the one that reads the log: whoever may read the whole log may send it out, and a narrower action would buy nothing because the log is admin-only already). Editors and members get `forbidden`, a non-member what a missing workspace gives, another owner's stream ID answers like a missing one. A service token never reaches `audit` (`TOKEN_ACTIONS`).
- Only the dashboard session, at `/api/v1/audit/streams` with `?workspace=<slug>`, for every route including the list. The CLI's `credentials:manage` token does not manage streams, unlike webhooks: a stream sends the entire log of the space out of Portifact for as long as it exists, which is more than a webhook's activity summaries, there is no CLI command to use it, and the session check keeps the decision with a person in the dashboard. Rejected: reading a stream's state through bearer tokens, MCP or `portifact audit stream`. That a stream exists, where it points (its host) and who changed it are already in the log itself (`audit_stream.*` events, readable with `artifacts:read` like the rest of the log), so agents and scripts can see it without a new surface, and leaving the routes session-only means no parity table to keep in step. With no CLI or MCP surface the skill does not change.
- Creating, a new URL, resuming and testing need `auditExport` and then `audit` in the owner's plan (`plan_required` names the export first, as the file export does); reading the list and the log, pausing, renaming, rotating the secret and removing never do. A lapsed plan pauses delivery and keeps the rows; resuming after the plan returns continues from the position, subject to the gap rule.
- Switched off with webhooks: nothing is created or delivered unless both Workers have `WEBHOOKS_ENABLED="true"` and `WEBHOOK_KEY`. Without them creating, a new URL, resuming, rotating and testing answer `capacity_unavailable` ("Audit streams are not available yet."), the list says `serviceAvailable: false`, the dashboard shows nothing, jobs end without sending and the scan arms nothing. The deployed configuration sets neither ([releasing.md](../releasing.md), "Webhooks" and "Audit streams").
- For an `eu` owner the list says `euOwner: true` and the dashboard tells the admin that the endpoint may be outside the EU and that what it receives leaves the EU.

### Sealing

The URL and the secrets are sealed with the webhook key (`seal` and `open` in `webhook-keys.ts`, AES-256-GCM under `WEBHOOK_KEY`), bound to the stream's ID and column, as webhooks are. The jobs Worker re-seals streams of a retired key with the current one per region (`rewrapAuditStreamKeys`); the app Worker accepts `WEBHOOK_KEY_PREVIOUS` too, only so an admin can change a stream sealed before a rotation while the re-seal is still running.

### Audit events about streams

`audit_stream.created` (host, start), `audit_stream.changed` (host and which of label, URL, secret or state changed), `audit_stream.removed` (host) by the admin, and `audit_stream.paused` (host, reason) by the system, each in the batch of its change on its own condition. They are regional kinds. Details never hold the URL, its path, the label or the secret.

### What goes with an owner

Account deletion deletes the account's streams in both of its batches (the request and every run of its job) and clears who created a workspace's stream; workspace deletion deletes them in `deleteWorkspace` and `advanceWorkspaceDeletion`. Their log and jobs go with them (foreign key, and a job whose stream is gone is done). Removing a stream writes an `audit_stream` tombstone (with one database in the removal's batch, with a separate one globally first), which `exportTombstones` exports and `applyTombstones` re-applies in every region together with the streams of tombstoned owners, so a D1 Time Travel restore never brings a destination back. A restore that rewinds a position makes the stream send again what it had sent since (the consumer drops repeated IDs); it never skips, because positions are times and every later event is newer. A restore that rewinds the events but not the position loses nothing that was not already delivered. The account export lists streams by ID, label, host, state and creation time, never the URL, the secret or a position.

## Alternatives rejected

- **A webhook event type** (above).
- **Writing a mark or job on the audit write path** (a per-owner "has new events" row, or an outbox job with every event): it adds a statement to every batch that records an event, which the scope forbids, and the settle window plus the job's own cadence already bound the latency.
- **A scan that delivers**: one scheduled invocation would wait on customers' endpoints; deliveries belong in the queue consumer, beside webhooks, where a slow endpoint holds only its own job.
- **A stream row in the global database**: the job runs in the owner's region, and its deletion and backups are regional; with time positions the global source's position does not need to live next to the global events.
- **One position across both databases**: a merged order needs both databases' next events at once and still cannot order an event committed late in one against the other; two positions keep each source simple and exact.
- **Sending tests from the app Worker**: only the jobs Worker fetches user URLs; a test waits for the next run (within a minute through the relay).

## Open risks

- **Latency.** An event reaches the endpoint 20 to about 26 minutes after it happened (the settle window, the idle interval and the relay). Shortening the window needs a commit-ordered sequence on the audit table, which means changing the write path.
- **A writer slower than the window.** The settle window assumes a write commits within 20 minutes of its `now`. A request that held its `now` longer (a Worker invocation cannot today) could write behind a position. Nothing in Portifact does so; a future long-running writer must take its `now` at write time.
- **The platform behaviours of decision 0009** (DNS to private addresses, same-account reach, `CF-Worker`) apply to streams exactly as to webhooks; the same release checks cover both.
- **The receiver's view across sources.** A consumer that needs one total order must merge the two sources by time; this is documented for customers.
