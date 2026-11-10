# Operations

How the operator handles abuse reports and suspensions (plan section 13), how storage is verified and a database backup restored (plan section 10), the budget alerts and protection (plan section 12), the email quota and suppressions (plan section 17), and owners' plans (premium plan section 3, F1 and F2). There is no operator web UI: every operator action runs from the operator's machine through the operator tool.

## Why a local tool and not an operator account

The operator tool (`apps/jobs/scripts/operator.ts`) talks to the production D1 database through a Wrangler remote binding, authenticated with the deploy credentials. That was chosen over an allowlisted operator account in the dashboard because:

- No new privileged route exists on `portifact.com`. A stolen dashboard session, an XSS in the dashboard or a bug in a route guard cannot reach a suspension endpoint, because there is none.
- The credential is the one that can already deploy and migrate the database, so it adds no new secret and no new trust: whoever holds it could change the data anyway.
- Every command calls the same services in `packages/services/src/moderation.ts` that the tests cover, so suspensions follow the same guarded, idempotent writes as everything else, and each one is recorded in `lifecycle_events` (`suspended`, `reinstated`) and in `suspensions`.

## Running it

From the repository root, with `CLOUDFLARE_API_TOKEN` set to a token with D1 edit access on the account (or after `wrangler login`):

The script runs on Node (`--experimental-transform-types`), not Bun: Wrangler refuses remote bindings under Bun, whose `fetch` ignores the dispatcher Miniflare routes them through.

```bash
bun run --cwd apps/jobs operator reports                     # open reports, oldest first
bun run --cwd apps/jobs operator show-artifact <id>          # state, access, owner and account suspension
bun run --cwd apps/jobs operator suspend-artifact <id> --reason phishing --report <report-id> --note "what was checked"
bun run --cwd apps/jobs operator resolve-report <report-id> actioned
bun run --cwd apps/jobs operator reinstate-artifact <id>
bun run --cwd apps/jobs operator suspend-account <user-id|email> --reason malware
bun run --cwd apps/jobs operator reinstate-account <user-id|email>
bun run --cwd apps/jobs operator storage-report [--limit N]          # what the storage reconciliation found
bun run --cwd apps/jobs operator export-tombstones --out <absolute file>   # before restoring a backup
bun run --cwd apps/jobs operator apply-tombstones --file <absolute file>   # after restoring a backup
bun run --cwd apps/jobs operator email-suppressions                  # addresses that get no sign-in codes
bun run --cwd apps/jobs operator lift-email-suppression <email>
bun run --cwd apps/jobs operator plan <user-id|email>                # row, effective plan, usage against limits and columns
bun run --cwd apps/jobs operator set-plan <user-id|email> pro [--seats N] [--until 2027-01-31] [--note "why"] [--overrides '<json>']
bun run --cwd apps/jobs operator remove-plan <user-id|email>         # back to free
bun run --cwd apps/jobs operator export-plans --out <absolute file>  # before restoring a backup
bun run --cwd apps/jobs operator apply-plans --file <absolute file>  # after restoring a backup
```

`--local` runs against the local D1 state of `wrangler dev` in `apps/app` instead (apply the migrations there first with `wrangler d1 migrations apply portifact-control --local --persist-to apps/app/.wrangler/state`). The remote binding is defined in `apps/jobs/operator.wrangler.jsonc`, which is never deployed. `--config <file>` uses the `DB` binding of another Wrangler configuration instead, for example a scratch database in a backup drill; never edit `operator.wrangler.jsonc` to point it elsewhere. `bun run --cwd apps/jobs` runs the script in `apps/jobs`, so relative paths (`--config`, `--out`, `--file`) resolve from there, not from the repository root: pass absolute paths. Reasons are the `AbuseReason` values in `packages/contracts/src/moderation.ts`.

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

Reaching a global admission limit (800 GB stored, 2 M class A operations, 20 M Worker requests or 20,000 emails in the cycle) adds `stop_new_artifacts` and `block_uploads` whatever the spend, and records an `admission_<metric>` alert. Reads, exports, deletion, access reduction, renewal, restore and rollback keep working at every level, comment moderation and deletion too, and nothing is ever deleted to contain costs. The traffic steps limit each visitor IP to `PROTECTION_TRAFFIC_LIMITS` (`packages/domain/src/budget.ts`: 120 requests per minute for public traffic, 240 for protected; calibrate with real traffic), counted exactly by the `TrafficLimiter` Durable Object of the content Worker (one object per IP and kind of traffic, a fixed window in memory, reached only while a traffic step applies); an isolate remembers a refused visitor until their window ends, so a flood is refused without a Durable Object request each time. The content Worker reads the protection at most once a minute and fails open, logging `budget_protection_unreadable` when the state cannot be read and `traffic_limiter_failed` when the limiter cannot answer. Workers Rate Limiting is not used for this: its counts are approximate per location, and on 2026-11-08 a deployed 240-a-minute binding refused none of 1,200 protected requests a minute from one IP (see [workers-sdk#16097](https://github.com/cloudflare/workers-sdk/issues/16097)). While uploads are blocked or new artifacts are braked, every account's usage reports a `capacity` block, which the dashboard shows as a notice and the CLI and MCP report like any other block.

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

The jobs Worker measures R2 operations and storage, Worker requests and D1 rows through Cloudflare's GraphQL Analytics API (`apps/jobs/src/analytics.ts`). In production the `portifact-jobs` Worker has both settings below, so the collector runs on every budget run; without either of them it stays off and the projection uses only what D1 knows (the bytes of every stored object and the objects created this cycle, one class A upload each). Emails always come from D1 (`email_counters`), with or without analytics.

| Name                 | Kind   | Value                                                                                                                           |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `CF_ANALYTICS_TOKEN` | Secret | A Cloudflare API token with only **Account > Account Analytics > Read** on the Portifact account. No edit permission is needed. |
| `CF_ACCOUNT_ID`      | Secret | The account ID the token can read.                                                                                              |

Rotate or set them with `wrangler secret put <NAME> --name portifact-jobs` from `apps/jobs`, piping the value so it never appears in the shell history. The collector queries `r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`, `workersInvocationsAdaptive` and `d1AnalyticsAdaptiveGroups` on `https://api.cloudflare.com/client/v4/graphql`. The account also hosts other projects, so each dataset is filtered to Portifact's resources (`PORTIFACT_RESOURCES`: the `portifact-artifacts` bucket, the `portifact-app`, `portifact-content` and `portifact-jobs` Workers and the `portifact-control` database); keep that list in sync when a Worker, bucket or database is renamed or added. The plan's included amounts are per account, so the projection credits all of them to Portifact and can understate its share of the invoice when other projects use them too. The collector's errors report only the HTTP status or the number of GraphQL errors; `operator budget` shows `analytics failed` when the last query failed, and the counters it missed keep their last values of the cycle.

### Alert emails (optional)

Alert emails need the `portifact-jobs` Worker's `send_email` binding `BUDGET_EMAIL` and the vars `BUDGET_ALERT_TO` (the operator's address) and `BUDGET_ALERT_FROM` (a sender verified in Cloudflare Email Service); without any of them they are a no-op. `apps/jobs/wrangler.jsonc` sets all three: alerts go to `hello@portifact.com`, which Email Routing forwards to the operator (like `abuse@`, `privacy@` and `legal@`), from `noreply@portifact.com`. Changing the operator's inbox is a routing change, not a deploy. With all three, each run emails the cycle's alerts that were not emailed yet and marks them; a failed send is retried on the next run. The email (`budgetAlertEmail` in `packages/emails`) has an HTML version and a plain-text alternative with the projection, level, protection in effect, the new alerts and the `operator budget` command; `bun run --cwd packages/emails preview` shows it.

## Email quota and suppressions

Sign-in codes stop for the rest of the month once `SIGN_IN_EMAILS_PER_CYCLE` (19,900) emails were sent in the UTC month, below the 20,000-email admission limit so codes alone never stop publishing; the login page then suggests Google or GitHub. The daily budget (600 codes) normally keeps the month far below it. `operator budget` shows the cycle's `emails`, counted as they are sent (`email_counters`).

Addresses whose mail bounced permanently or was reported as spam get no more codes (see "Identity" in [security.md](security.md)). Cloudflare Email Service reports them through the `portifact-email-events` queue (set up in [releasing.md](releasing.md)), and a send it refuses because its own list holds the address is recorded too. The person sees an explanation that points to Google, GitHub and `privacy@portifact.com`.

```bash
bun run --cwd apps/jobs operator email-suppressions [--limit N]     # suppressions in effect: id, masked hint, reason, dates
bun run --cwd apps/jobs operator lift-email-suppression <email>     # after checking with the person that the address works now
```

Only the masked hint is stored, so lifting needs the address from the person who wrote in. Lifting ours does not lift Cloudflare's: if sends still fail (the next request records a `provider` suppression again), remove the address from the sending domain's suppression list in the Cloudflare dashboard (Email Service, Suppressions) or through its API, unless the entry is `read_only` (complaints and missing mailboxes usually are; only Cloudflare Support can review those). A complaint means the person marked our mail as spam: lift it only at their request. The consumer logs `email_event` (type, event ID, outcome), `email_event_malformed` and `email_event_failed`; malformed events are dropped and failed ones retried up to 5 times, after which Cloudflare's own suppression still blocks sends and the next refused send records it.

## Expiry notices

An active artifact archives 30 days after its last publish or renewal. Three days before (`EXPIRY_NOTICE.windowMs` in `packages/domain/src/expiry-notices.ts`), its owner gets an email, in their language (`account_settings.locale`, English when they chose none), listing every artifact of theirs that expires within the window, each with its address, its expiry in UTC and a link to its page in the dashboard to renew it, plus a link to Settings to turn the notices off (`account_settings.expiry_notices`, on by default and part of the account export).

- The maintenance scan (`scheduleExpiryNotices`, `packages/services/src/expiry-notices.ts`) picks up to 25 owners a run whose artifacts are due and who did not turn notices off, and for each writes one `expiry_notice` outbox job (subject: the owner; payload: the artifacts and the expiry each was scheduled for) and marks the artifacts (`artifacts.expiry_notice_for`, the expiry notified, and `expiry_notice_at`) in one batch conditioned on the artifacts still being due, so overlapping runs schedule each expiry once. A publish, a rollback or a renewal sets a new `expires_at`, which is due for its own notice.
- An owner gets at most one notice a day (`ownerCooldownMs`), so artifacts that enter the window hours apart go out together; every artifact still gets at least two days of warning.
- The consumer claims the job by deleting its row before sending, so a duplicate or concurrent delivery sends nothing: notices are sent at most once. Before sending it drops artifacts renewed, archived or expired since, and skips (logging `expiry_notice_skipped` with a reason and a count, never the address) when the account is gone, the owner turned notices off, the address is suppressed or the cycle's notice emails are spent (`NOTICE_EMAILS_PER_CYCLE`, 14,900: notices stop 5,000 emails before sign-in codes do). A refusal because Email Service's list holds the address records a `provider` suppression. Any other failure puts the job back in the outbox for the next run and logs `job_failed`; only a Worker dying between the claim and the send loses a notice.
- Every notice sent is counted in `email_counters` like sign-in codes. The `portifact-jobs` Worker sends through its `send_email` binding `EMAIL` from `noreply@portifact.com`, with `APP_ORIGIN` and `CONTENT_DOMAIN` in its `vars` for the links.

`select owner_id, count(*) from artifacts where expiry_notice_at > <ms a day ago> group by owner_id` shows who was notified in the last day. There is no operator command to resend a notice.

## Account deletions

Deletions need no operator action: the request removes the user at once and the scheduled jobs finish the rest (see "Account deletion" in [security.md](security.md)). `select * from account_deletions` lists the ones still in progress.

## Traffic quota

An account whose artifacts served its plan's traffic in the current UTC month (1 million requests or 25 GB on `free`, the plan of every account without an `owner_plans` row; `PLANS` in `packages/contracts/src/plans.ts`) gets 429 on all of them until the next month ( see "Access control" in [security.md](security.md)). Its counters are in `traffic_counters`, one row per account and month, for example `select owner_id, requests, bytes from traffic_counters where cycle_start = <month start in ms> order by bytes desc limit 20` to see the largest consumers during a budget review. There is no operator command to raise or reset a counter; a higher quota comes with a plan (see "Plans" below). Counters older than the previous month are pruned by the maintenance job.

## Plans

Every owner has a plan (`free`, `pro`, `team` or `enterprise`, `PLANS` in `packages/contracts/src/plans.ts`); without an `owner_plans` row it is `free`, exactly the limits every account had before plans. Payment does not exist yet: the operator tool is the only way to grant, change or remove a plan, and there is no web route, API endpoint, MCP tool or CLI command for it, nor may there be one. A future billing webhook writes the same row through the same service.

- `set-plan <owner> <plan>` grants or changes it (`setOwnerPlan`, `packages/services/src/plans.ts`): `--seats` multiplies Team and Enterprise's per-seat limits, `--until` (an ISO date, UTC) ends it, after which the owner reads as `free`, `--note` records why, and `--overrides` takes JSON such as `{"limits":{"activeArtifacts":5000},"features":{"sso":true}}`, totals applied after seats (an Enterprise contract). It refuses an unknown plan, seats outside 1 to 10,000, an end in the past, invalid overrides, and accounts that do not exist or are being deleted. It records `granted_by` as `operator`.
- The grant writes the row and the four limit columns the database's CHECK constraints compare usage against (`account_usage.active_limit` and `bytes_limit`, `annotation_usage.messages_limit` and `bytes_limit`) in one batch, creating the usage rows if the owner has none yet, so a later publish or comment finds the plan's limits. A column is never set below what the owner already uses: it holds the larger of the plan's limit and the usage. The rules that admit new work read the plan, not the columns, so the columns are only the safety net against races.
- `remove-plan <owner>` deletes the row and lowers the columns toward the free values in the same batch; `plan <owner>` shows the row, the effective plan (an expired plan shows as `free`), the features and each usage against its limit and column.
- The maintenance scan `alignPlanLimits` (`alignedPlanLimits` in the `maintenance` log line) brings the columns back in line for owners whose plan expired, was removed or lowered, or whose usage fell: up to 50 owners a run, reading only owners with a plan row or a column off the free values and writing only those out of line, each conditioned on the plan row it read being unchanged.
- A lower plan never deletes or hides anything. Above its limits, new artifacts, restores, updates that add storage and new comments are refused with `quota_exceeded`, naming the plan's limit where the owner reads the message (comments say only that the owner has no room, because the commenter is someone else). Reading, listing, exporting, downloading, deleting, archiving, reducing access, renewing and rolling back keep working; a rollback is not held to the per-artifact size, since the version already fit the plan it was published under.

Safety caps that are not plan tiers stay constants: files per version, publishes and new files per 24 hours, open uploads, readers per artifact, the boundaries' file, offset and anchor cap (`LIMITS.fileBytesCap`, 5 GB, above every plan's per-artifact size) and the artifacts one expiry notice lists (`EXPIRY_NOTICE_ARTIFACTS_MAX`, 1,000). Archive months, version retention and access log retention are carried in `PLANS` but not applied yet. Budget protection does not look at plans.

## Maintenance and the outbox

State changes that need follow-up work write a job to the `outbox` table in the same D1 batch (`packages/services/src/outbox.ts`): `purge_artifact` when an artifact is claimed for purging (deletion by its owner, the six-month purge, account deletion, re-applied tombstones), `account_deletion` with a deletion request, `delete_objects` with the R2 keys whose rows a release just deleted, `erase_access_events` when an artifact is purged or an account is deleted (it deletes their rows from the separate `portifact-access` database), `expiry_notice` when the maintenance scan schedules an owner's expiry notice (see "Expiry notices" below), and `abort_multipart` when an upload session with multipart uploads closes (it aborts the R2 uploads not completed and deletes their staging copies under `uploads/`, which the storage reconciliation does not scan). Every 15 minutes the jobs Worker runs the maintenance scans, relays due rows to the `portifact-jobs` queue and reconciles a slice of storage. The consumer deletes a row once its job is done; a job whose row is gone is already done, a purge whose artifact is no longer in the `purging` state and generation it was claimed with is stale and dropped, and a `delete_objects` job keeps any key that has a row again. A row still there an hour after it was sent is sent again.

`select topic, subject, attempts, dispatched_at from outbox order by id` shows what is pending. Rows with many attempts point at a job that keeps failing; the Worker logs `job_failed` with the topic and the error message. The scans in `runMaintenance` still archive, purge, prune and finish deletions on their own, so a queue outage only delays the work.

## Access logs

Openings of artifacts by signed-in visitors live in the `portifact-access` D1 database (see "Access logs" in [security.md](security.md)). Each scheduled run prunes rows older than 30 days (`prunedAccessEvents` in the `maintenance` log line, or `failed` with an `access_log_prune_failed` line; the rest of the run goes on). Only the artifact's owner reads them through the product; there is no operator command, and a visitor's request about their own entries goes through `privacy@portifact.com`: `npx wrangler d1 execute portifact-access --remote --command "select artifact_id, opened_at from access_events where user_id = '<id>'"` lists them, and deleting the account erases them. The database is not part of the control database's Time Travel restore: restoring `portifact-control` does not bring access log rows back, and the erase jobs of re-applied tombstones delete any rows of resurrected accounts or artifacts again. It has its own Time Travel, but restoring it would bring back entries that were erased, so do not.

## Storage reconciliation

Each scheduled run checks the next 50 object rows against R2 and the next 100 R2 objects under `objects/` against D1, resuming where the previous run stopped (`maintenance_cursors`). It records in `storage_findings`, and never deletes:

- `missing`: a verified object row whose R2 object is gone. Versions that reference it serve errors for that file. Look for a restore that brought back rows of bytes deleted after the restore point; if the artifact must keep the file, its owner publishes it again.
- `size_mismatch`: the R2 object has another size than the row. Treat it as corruption and ask the owner to publish again.
- `orphan`: an R2 object at least 24 hours old that no row references, for example after a restore to a point before it was uploaded, or a delete that never ran. If a restore is not the cause, delete it with `npx wrangler r2 object delete portifact-artifacts/<key> --remote`. Do not delete orphans right after a restore until the reconciliation has seen the restored rows: they may be the only copy of bytes the restored database references.

A finding disappears once a later pass sees the key fine again or no longer sees it at all. A full pass takes `rows / 50` and `objects / 100` runs of 15 minutes.

## Restoring a backup

The database backup is D1 Time Travel (30 days on Workers Paid). R2 is not rewound, so a restore can bring back rows of artifacts and accounts deleted since, and lose the tombstones that recorded those deletions. Re-applying the tombstones afterwards deletes them again. With the deploy credentials, from the repository root:

1. Note the current state so the restore can be undone: `npx wrangler d1 time-travel info portifact-control` prints the current bookmark.
2. Export what the restore must not bring back from the live database: `bun run --cwd apps/jobs operator export-tombstones --out "$HOME/portifact-tombstones.jsonl"`. The file lists tombstones, account deletions in progress and artifacts already claimed for purging, one JSON object per line. It holds user and artifact IDs: write it outside the repository (a relative path lands in `apps/jobs`, which is not ignored) and delete it when done.
3. Restore: `npx wrangler d1 time-travel restore portifact-control --timestamp <RFC 3339 time>` (or `--bookmark <bookmark>`). It asks for confirmation (there is no `--yes`; without a terminal Wrangler proceeds on its own), cancels queries in flight and prints a bookmark that undoes it; note that one too.
4. Re-apply the tombstones: `bun run --cwd apps/jobs operator apply-tombstones --file "$HOME/portifact-tombstones.jsonl"`. It stores the markers as tombstones, claims every artifact that has a tombstone or belongs to a tombstoned account for purging, and deletes every tombstoned account the restore brought back the way a deletion request does, each with its outbox job. Running it again changes nothing. Without `--file` it applies the tombstones the restored database still has.
5. The jobs Worker purges the claimed artifacts and finishes the deletions within the next runs; an account deletion stays pending until its artifacts are purged, so it finishes one run after them. Check with `select count(*) from artifacts where state = 'purging'` and `select * from account_deletions`.
6. Run `storage-report` after a full reconciliation pass and handle `missing` and `orphan` findings as described above.

Plans are rewound too: `owner_plans` and the limit columns go back to the restore point, consistent with each other, so the database stays correct but plans granted, changed or removed since are lost or back. Plans are not tombstones, so they have their own export: in step 2 also run `export-plans --out "$HOME/portifact-plans.jsonl"` (one JSON object per plan, with owner IDs and notes: keep it outside the repository and delete it when done), and after step 4 run `apply-plans --file "$HOME/portifact-plans.jsonl"`. It grants each exported plan again through the same service, which sets the limit columns, skips plans that ended and accounts that are gone or being deleted (so run it after `apply-tombstones`), and lists owners that have a plan the file does not, which the restore brought back; remove each with `remove-plan` if it was removed after the export. It never removes a plan by itself. Running it again changes nothing.

If the live database cannot be read for step 2, restore to the latest point that can, export from it, then restore to the point you need and apply. Migrations applied after the restore point are rewound too: apply them again with `wrangler d1 migrations apply portifact-control --remote` before step 4. A restore to before migration 0027 also rewinds the per-row limit columns of `account_usage` and `annotation_usage`; reapplying it gives every row the free plan's defaults again, and `apply-plans` sets the granted plans' columns again.

### Backup drill

Rehearse the restore on a scratch database, never on `portifact-control`. With the deploy credentials:

1. `npx wrangler d1 create portifact-drill-<date>`, then a Wrangler configuration outside the repository with a `DB` binding to it (`"remote": true`, `migrations_dir` pointing at `packages/db/migrations`) and `npx wrangler d1 migrations apply portifact-drill-<date> --remote -c <that file>`.
2. Seed it through the services (users, active and archived artifacts with versions and objects, annotation threads), for example with a throwaway Node script that binds the configuration with `getPlatformProxy` and a local R2 bucket. The publish commit uses the Workers-only `crypto.DigestStream`, so such a script needs a small polyfill on Node.
3. `npx wrangler d1 time-travel info portifact-drill-<date>` for the bookmark, then delete as production does: an artifact deleted by its owner, an account deletion left in progress, and an account deletion finished by its jobs.
4. Follow "Restoring a backup" with `--config <that file>` on every operator command and the scratch database's name in the Wrangler commands. Check that the restore brings the deleted rows back without their tombstones, that `apply-tombstones` claims the resurrected artifacts and deletes the accounts again, that a second run reports `0 restored, 0 artifact(s) claimed for purging, 0 account(s) deleted again`, and that the outbox jobs finish the purge.
5. Delete the database (`npx wrangler d1 delete portifact-drill-<date>`), the configuration, the export and any local state.

Results of 2026-11-08 (Wrangler 4.158.0, Node 24, an empty database plus the seed):

| Step                             | Time  | Result                                                                                                                                                           |
| -------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create the database              | 1.4 s |                                                                                                                                                                  |
| Apply the 19 migrations          | 4.2 s |                                                                                                                                                                  |
| Seed through the services        | 10 s  | 4 users, 6 artifacts (4 active, 2 archived), 6 versions, 7 objects, 2 threads with 3 messages                                                                    |
| `time-travel info`               | 1.1 s | Bookmark recorded                                                                                                                                                |
| Deletions                        | 2.9 s | 3 tombstones (2 artifacts, 1 account), 1 deletion in progress, 2 artifacts `purging`                                                                             |
| `export-tombstones`              | 3.4 s | 6 markers (4 artifacts, 2 accounts)                                                                                                                              |
| `time-travel restore --bookmark` | 1.8 s | All 6 artifacts and 4 users back as seeded; tombstones, deletions and outbox empty                                                                               |
| `apply-tombstones --file`        | 3.4 s | 6 restored, 4 artifacts claimed for purging, 2 accounts deleted again, with 4 `purge_artifact` and 2 `account_deletion` jobs; untouched rows stayed as they were |
| `apply-tombstones --file` again  | 3.1 s | Nothing changed                                                                                                                                                  |
| Outbox jobs, two passes          | 5.4 s | 4 artifacts purged; both account deletions pending on the first pass and finished on the second; the deleted account's thread erased; outbox empty               |

What did not work as documented, fixed in this document and the tool: the export command wrote its file to `apps/jobs/` instead of the repository root, because `bun run --cwd` runs the script there and relative paths resolve from it (the directory is not ignored, so the IDs could be committed); the operator tool could only reach production or the local state, so `--config` was added for drills; and `time-travel restore` has no `--yes`. Each operator command opens a remote binding first, which accounts for most of its 3 seconds. R2 was a local bucket in the drill, so the storage reconciliation's findings after a restore were not exercised.
