# Operations

How the operator handles abuse reports and suspensions (plan section 13), how storage is verified and a database backup restored (plan section 10), and the budget alerts and protection (plan section 12). There is no operator web UI: every operator action runs from the operator's machine through the operator tool.

## Why a local tool and not an operator account

The operator tool (`apps/jobs/scripts/operator.ts`) talks to the production D1 database through a Wrangler remote binding, authenticated with the deploy credentials. That was chosen over an allowlisted operator account in the dashboard because:

- No new privileged route exists on `portifact.com`. A stolen dashboard session, an XSS in the dashboard or a bug in a route guard cannot reach a suspension endpoint, because there is none.
- The credential is the one that can already deploy and migrate the database, so it adds no new secret and no new trust: whoever holds it could change the data anyway.
- Every command calls the same services in `packages/services/src/moderation.ts` that the tests cover, so suspensions follow the same guarded, idempotent writes as everything else, and each one is recorded in `lifecycle_events` (`suspended`, `reinstated`) and in `suspensions`.

## Running it

From the repository root, with `CLOUDFLARE_API_TOKEN` set to a token with D1 edit access on the account (or after `wrangler login`):

```bash
bun run --cwd apps/jobs operator reports                     # open reports, oldest first
bun run --cwd apps/jobs operator show-artifact <id>          # state, access, owner and account suspension
bun run --cwd apps/jobs operator suspend-artifact <id> --reason phishing --report <report-id> --note "what was checked"
bun run --cwd apps/jobs operator resolve-report <report-id> actioned
bun run --cwd apps/jobs operator reinstate-artifact <id>
bun run --cwd apps/jobs operator suspend-account <user-id|email> --reason malware
bun run --cwd apps/jobs operator reinstate-account <user-id|email>
bun run --cwd apps/jobs operator storage-report [--limit N]          # what the storage reconciliation found
bun run --cwd apps/jobs operator export-tombstones --out <file>      # before restoring a backup
bun run --cwd apps/jobs operator apply-tombstones --file <file>      # after restoring a backup
```

`--local` runs against the local D1 state of `wrangler dev` in `apps/app` instead (apply the migrations there first with `wrangler d1 migrations apply portifact-control --local --persist-to apps/app/.wrangler/state`). The remote binding is defined in `apps/jobs/operator.wrangler.jsonc`, which is never deployed. Reasons are the `AbuseReason` values in `packages/contracts/src/moderation.ts`.

Report text is untrusted: the tool prints each report on one plain line and never prints the reporter's email (it says `has-email`); read it from D1 only when replying.

## What a suspension does

- An artifact is suspended from `active` or `archived`. It stops being served at once in every channel: delivery on `portifact.dev` answers it like a missing artifact, fresh read-session claims stop working on the next request (the Worker reads the state on every request), `/read/<id>` issues no handoff, readers get no download links and annotations are closed to visitors. The owner can still see it, export it and delete it, but cannot publish to it, change its access, renew, restore or roll it back.
- The owner sees `state: "suspended"` and `suspension.reason` in the API, MCP, CLI `info` and the dashboard, which explains it and points to `abuse@portifact.com`. The operator's note is never shown.
- A suspended artifact does not hold an active slot (triggers in `0010_moderation_triggers.sql`). Reinstating puts it back in the state it had; an artifact that was active goes to the archive instead when the account has no free slot.
- Suspending an account suspends every active or archived artifact it owns, each with its own row that points at the account suspension, and refuses new publishes. Reinstating the account reinstates exactly those artifacts; an artifact suspended on its own stays suspended. The account can still sign in, export its data and delete itself.
- Suspending twice, or two operators at once, keeps one open suspension (a unique index on open suspensions per target).

## Reports

Reports arrive through `POST /api/v1/reports` from the report form at `app.portifact.com/report` (linked from the landing footer and from `/__portifact/report` on every artifact origin). They are limited per IP, per artifact and globally (`REPORT_LIMITS`), and only reports about artifacts that exist are stored; the answer is the same either way. Aim to respond within 48 hours, as the legal pages promise. Mail to `abuse@portifact.com` is the other channel.

## Budget alerts and protection

Cloudflare's budget alerts only inform, so Portifact protects its own budget. Every 15 minutes the jobs Worker (`apps/jobs/src/budget.ts`) measures the cycle (the calendar month in UTC), projects its spend at the reference prices in `REFERENCE_PRICES` (`packages/domain/src/budget.ts`), stores the result in the single `platform_budget` row and records alerts in `budget_alerts`. Counters are extrapolated linearly from what the cycle used so far (at least one day counts as elapsed); stored bytes are a gauge assumed to stay for the whole cycle. CPU time, logs and taxes are not measured: the budget's margin covers them.

| Projected spend | Level        | What happens                                                                                                                                                                                                                              |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US$25           | `alert25`    | Alert to the operator.                                                                                                                                                                                                                    |
| US$50           | `alert50`    | Alert; review the largest consumers (D1 `objects` and `account_usage`, Cloudflare's analytics).                                                                                                                                           |
| US$75           | `slow75`     | Alert and `stop_new_artifacts`: publishes that create an artifact answer `capacity_unavailable`; updates still work.                                                                                                                      |
| US$100          | `protect100` | Alert and the plan's steps in order, each from its own spend: `block_uploads` (US$100, every new upload refused), `pause_annotation_writes` (US$110), `tighten_public_traffic` (US$125), `limit_protected_traffic` (US$150, last resort). |

Reaching a global admission limit (800 GB stored, 2 M class A operations, 20 M Worker requests or 20,000 emails in the cycle) adds `stop_new_artifacts` and `block_uploads` whatever the spend, and records an `admission_<metric>` alert. Reads, exports, deletion, access reduction, renewal, restore and rollback keep working at every level, comment moderation and deletion too, and nothing is ever deleted to contain costs. The traffic steps use the per-IP Workers Rate Limiting bindings in `apps/content/wrangler.jsonc` (120 requests per minute for public traffic, 240 for protected; calibrate with real traffic); the content Worker reads the protection at most once a minute and fails open. While uploads are blocked or new artifacts are braked, every account's usage reports a `capacity` block, which the dashboard shows as a notice and the CLI and MCP report like any other block.

Each alert is recorded once per kind and cycle. Without email configured, alerts stay "not emailed" and are visible with the commands below and in the jobs Worker's logs (`budget_alert` events). A failed analytics query never lifts protection: counters it missed keep their last values of the cycle.

```bash
bun run --cwd apps/jobs operator budget                      # state, projection, metrics, protection and this cycle's alerts
bun run --cwd apps/jobs operator budget-alerts --limit 20    # recorded alerts, newest first
bun run --cwd apps/jobs operator budget-override protect100 --steps 2 --note "traffic spike under review"
bun run --cwd apps/jobs operator budget-override none --hours 12 --note "projection wrong after a migration"
bun run --cwd apps/jobs operator budget-override clear
```

An override replaces the automatic decision at once, in both directions, until `--hours` passes or it is cleared; `--steps` (1 to 4) says how many protection steps a `protect100` override applies. It can be set before the first measurement. The note is required and only the operator sees it.

### Cloudflare analytics

The jobs Worker measures R2 operations and storage, Worker requests and D1 rows through Cloudflare's GraphQL Analytics API (`apps/jobs/src/analytics.ts`). In production the `portifact-jobs` Worker has both settings below, so the collector runs on every budget run; without either of them it stays off and the projection uses only what D1 knows (the bytes of every stored object and the objects created this cycle, one class A upload each).

| Name                 | Kind   | Value                                                                                                                           |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `CF_ANALYTICS_TOKEN` | Secret | A Cloudflare API token with only **Account > Account Analytics > Read** on the Portifact account. No edit permission is needed. |
| `CF_ACCOUNT_ID`      | Secret | The account ID the token can read.                                                                                              |

Rotate or set them with `wrangler secret put <NAME> --name portifact-jobs` from `apps/jobs`, piping the value so it never appears in the shell history. The collector queries `r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`, `workersInvocationsAdaptive` and `d1AnalyticsAdaptiveGroups` on `https://api.cloudflare.com/client/v4/graphql`. The account also hosts other projects, so each dataset is filtered to Portifact's resources (`PORTIFACT_RESOURCES`: the `portifact-artifacts` bucket, the `portifact-app`, `portifact-content` and `portifact-jobs` Workers and the `portifact-control` database); keep that list in sync when a Worker, bucket or database is renamed or added. The plan's included amounts are per account, so the projection credits all of them to Portifact and can understate its share of the invoice when other projects use them too. The collector's errors report only the HTTP status or the number of GraphQL errors; `operator budget` shows `analytics failed` when the last query failed, and the counters it missed keep their last values of the cycle.

### Alert emails (optional)

Alert emails are a no-op until the `portifact-jobs` Worker has a `send_email` binding named `BUDGET_EMAIL` and the vars `BUDGET_ALERT_TO` (the operator's address) and `BUDGET_ALERT_FROM` (a sender verified in Cloudflare Email Service). With all three, each run emails the cycle's alerts that were not emailed yet and marks them; a failed send is retried on the next run.

## Account deletions

Deletions need no operator action: the request removes the user at once and the scheduled jobs finish the rest (see "Account deletion" in [security.md](security.md)). `select * from account_deletions` lists the ones still in progress.

## Traffic quota

An account whose artifacts served 1 million requests or 25 GB in the current UTC month gets 429 on all of them until the next month (`TRAFFIC_LIMITS`; see "Access control" in [security.md](security.md)). Its counters are in `traffic_counters`, one row per account and month, for example `select owner_id, requests, bytes from traffic_counters where cycle_start = <month start in ms> order by bytes desc limit 20` to see the largest consumers during a budget review. There is no operator command to raise or reset a counter: a quota exception is a product decision, not an operation. Counters older than the previous month are pruned by the maintenance job.

## Maintenance and the outbox

State changes that need follow-up work write a job to the `outbox` table in the same D1 batch (`packages/services/src/outbox.ts`): `purge_artifact` when an artifact is claimed for purging (deletion by its owner, the six-month purge, account deletion, re-applied tombstones), `account_deletion` with a deletion request, and `delete_objects` with the R2 keys whose rows a release just deleted. Every 15 minutes the jobs Worker runs the maintenance scans, relays due rows to the `portifact-jobs` queue and reconciles a slice of storage. The consumer deletes a row once its job is done; a job whose row is gone is already done, a purge whose artifact is no longer in the `purging` state and generation it was claimed with is stale and dropped, and a `delete_objects` job keeps any key that has a row again. A row still there an hour after it was sent is sent again.

`select topic, subject, attempts, dispatched_at from outbox order by id` shows what is pending. Rows with many attempts point at a job that keeps failing; the Worker logs `job_failed` with the topic and the error message. The scans in `runMaintenance` still archive, purge, prune and finish deletions on their own, so a queue outage only delays the work.

## Storage reconciliation

Each scheduled run checks the next 50 object rows against R2 and the next 100 R2 objects under `objects/` against D1, resuming where the previous run stopped (`maintenance_cursors`). It records in `storage_findings`, and never deletes:

- `missing`: a verified object row whose R2 object is gone. Versions that reference it serve errors for that file. Look for a restore that brought back rows of bytes deleted after the restore point; if the artifact must keep the file, its owner publishes it again.
- `size_mismatch`: the R2 object has another size than the row. Treat it as corruption and ask the owner to publish again.
- `orphan`: an R2 object at least 24 hours old that no row references, for example after a restore to a point before it was uploaded, or a delete that never ran. If a restore is not the cause, delete it with `npx wrangler r2 object delete portifact-artifacts/<key> --remote`. Do not delete orphans right after a restore until the reconciliation has seen the restored rows: they may be the only copy of bytes the restored database references.

A finding disappears once a later pass sees the key fine again or no longer sees it at all. A full pass takes `rows / 50` and `objects / 100` runs of 15 minutes.

## Restoring a backup

The database backup is D1 Time Travel (30 days on Workers Paid). R2 is not rewound, so a restore can bring back rows of artifacts and accounts deleted since, and lose the tombstones that recorded those deletions. Re-applying the tombstones afterwards deletes them again. With the deploy credentials, from the repository root:

1. Note the current state so the restore can be undone: `npx wrangler d1 time-travel info portifact-control` prints the current bookmark.
2. Export what the restore must not bring back from the live database: `bun run --cwd apps/jobs operator export-tombstones --out tombstones.jsonl`. The file lists tombstones, account deletions in progress and artifacts already claimed for purging, one JSON object per line. It holds user and artifact IDs: keep it out of the repository and delete it when done.
3. Restore: `npx wrangler d1 time-travel restore portifact-control --timestamp <RFC 3339 time>` (or `--bookmark <bookmark>`).
4. Re-apply the tombstones: `bun run --cwd apps/jobs operator apply-tombstones --file tombstones.jsonl`. It stores the markers as tombstones, claims every artifact that has a tombstone or belongs to a tombstoned account for purging, and deletes every tombstoned account the restore brought back the way a deletion request does, each with its outbox job. Running it again changes nothing. Without `--file` it applies the tombstones the restored database still has.
5. The jobs Worker purges the claimed artifacts and finishes the deletions within the next runs. Check with `select count(*) from artifacts where state = 'purging'` and `select * from account_deletions`.
6. Run `storage-report` after a full reconciliation pass and handle `missing` and `orphan` findings as described above.

If the live database cannot be read for step 2, restore to the latest point that can, export from it, then restore to the point you need and apply. Migrations applied after the restore point are rewound too: apply them again with `wrangler d1 migrations apply portifact-control --remote` before step 4.
