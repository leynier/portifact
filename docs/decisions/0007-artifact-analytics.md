# 0007 Per-artifact analytics

- Status: accepted, implemented in P8 with the deviations under "Implementation" (spike S3 of the paid plans programme)
- Date: 2026-11-10
- Spike: [spikes/artifact-analytics](../../spikes/artifact-analytics)

## Question

Owners on a plan with the `analytics` feature will see, per artifact, page views per day and how many signed-in visitors opened it, without tracking anonymous visitors. Today traffic is metered per account only (`TrafficMeter` in `apps/content/src/traffic.ts`, one batched upsert per 5-second window per isolate), and delivery must never pay a D1 write per request. Where are the per-artifact numbers stored, how are they read, what exactly is a view, and what does the one-year access log of the paid plans (`accessLogRetentionDays: 365` in `PLANS`) change?

## Facts checked

Read in Cloudflare's documentation on 2026-11-10 unless marked as run. Nothing was run against Cloudflare.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                              | How                                                                                       | Source                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Analytics Engine: a Worker binds a dataset with `analytics_engine_datasets` (`binding`, `dataset`); the dataset is created on the first write. `writeDataPoint({ blobs, doubles, indexes })` is not awaited and writes in the background                                                                                                                                                                          | Read                                                                                      | [Get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)              |
| Analytics Engine limits: 250 data points per Worker invocation, up to 20 blobs and 20 doubles, one index of at most 96 bytes, 16 KB of blobs per data point. Data is kept three months; longer only on request through Cloudflare's Discord                                                                                                                                                                       | Read                                                                                      | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)                        |
| Analytics Engine samples at write time when one index gets data points "too quickly" (equitable sampling across index values) and again at read time when a query is complex (adaptive bit rate, coarser for longer ranges). Counts must be `sum(_sample_interval)`. The page says accuracy "depends on the total number of data points queried and their distribution" and gives no error bound for small counts | Read                                                                                      | [Sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)                    |
| Analytics Engine pricing on Workers Paid: 10 million data points written and 1 million read queries a month included, then US$0.25 per million written and US$1.00 per million queries. "Currently, you will not be billed"                                                                                                                                                                                       | Read                                                                                      | [Pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)                      |
| Analytics Engine is read only through the SQL API at `api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`, with a token that has Account, Account Analytics, Read. No latency from write to query is documented                                                                                                                                                                              | Read                                                                                      | [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)                      |
| Analytics Engine has no jurisdiction setting, no Regional Services support, and its Customer Metadata Boundary note says "Logs / Analytics not available outside US region". No page states where datasets are stored                                                                                                                                                                                             | Read                                                                                      | [Data localization compatibility](https://developers.cloudflare.com/data-localization/compatibility/) |
| In workerd, Miniflare's Analytics Engine binding has only `writeDataPoint`, which does nothing unless a remote dataset is configured; there is no local read path                                                                                                                                                                                                                                                 | Run (`test/analytics-engine.test.ts`) and read (Miniflare's `analytics-engine.worker.js`) | `spikes/artifact-analytics`                                                                           |
| D1 on Workers Paid: 25 billion rows read, 50 million rows written and 5 GB a month included, then US$0.001 per million rows read, US$1.00 per million rows written and US$0.75 per GB-month. An index adds a row written when a write includes its column                                                                                                                                                         | Read                                                                                      | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                  |
| D1 limits: 10 GB per database, 1 TB per account, 1,000 queries per invocation, 100 bound parameters per query                                                                                                                                                                                                                                                                                                     | Read                                                                                      | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                    |
| Local D1 reports `rows_written` with indexes counted: a first upsert of an `artifact_views` row writes 3 rows (the `WITHOUT ROWID` table and its two indexes), each later upsert that only adds to the counters writes 1. An `access_events` insert writes 5 rows with the owner index this design adds (4 today)                                                                                                 | Run (`test/record.test.ts`)                                                               | `spikes/artifact-analytics`                                                                           |
| `request.cf.botManagement` is "only set when using Cloudflare Bot Management", which Portifact does not have                                                                                                                                                                                                                                                                                                      | Read                                                                                      | [Request](https://developers.cloudflare.com/workers/runtime-apis/request/)                            |

## What was tried

`spikes/artifact-analytics` runs in workerd with a reduced control database and a reduced access database. Verified by running code (`bun run spike:artifact-analytics`, 47 tests, 100% of lines and 94% of branches):

1. **The counting rule** (`src/views.ts`, `pageView`): the viewer redirect is never a view and the viewer's frame load is, so one visit with the bar on counts once; with the bar off the top-level document counts; further pages of a site count as further page views; subresources, fetches, non-page files, `HEAD`, clients without fetch metadata, a sibling artifact's frame, `embed`, refusals, 404 and 429 never count; 200, 206 and 304 do; the owner's own visits with a session never count; nothing counts on a plan without analytics.
2. **The batching** (`src/meter.ts`, `ViewMeter`): views add up in memory per artifact and UTC day, one write is scheduled per window, a failed write is kept and merged into the next, and the log line names nothing. Twelve views from four isolates flushing at once read back as exactly 12 (4 signed in), and 2,000 views from eight isolates over five windows as exactly 2,000.
3. **The writes** (`src/record.ts`): one upsert per artifact and day, chunked at 200 statements per batch; the conflict only adds, so concurrent and retried batches add up; a CHECK refuses more signed-in views than views; pruning deletes by `expires_at` in bounded statements; a plan change moves an owner's expiries (a downgrade to 30 days followed by a prune removes what the new plan does not keep, other owners untouched); erasing an artifact deletes only its rows and reports `pending` when bounded rounds did not finish.
4. **The read** (`src/stats.ts`, `getArtifactStats`): every day of the range, zeros included; distinct visitors per day and over the range only for `restricted` artifacts (`null` for `public` and `authenticated`, even with old openings in the log); 404 `not_found` for anyone but the owner, a missing artifact and a purging one; `plan_required` without the feature; the range clamped to the retention and today, at most 366 days (`invalid_input` otherwise); expired rows never shown before the prune reaches them; four queries per read (one control lookup, the counters and one batch of two access log aggregates) whatever the traffic.

Mutation checks run by hand, each made at least one test fail: counting the viewer redirect, counting the owner, counting a sibling's frame, dropping the plan gate, an upsert that overwrites instead of adding, ignoring the expiry on read, letting a non-owner read, showing visitors for every access mode, dropping a failed batch and a downgrade that leaves expiries unchanged.

Only read, not run: everything against Cloudflare, Analytics Engine sampling and query latency, and the size of real rows on D1 (the sizes below are estimates).

## Recommended design

**Daily counters in the access database, written by the same batching as traffic; distinct signed-in visitors from the access log, only for `restricted` artifacts; no Analytics Engine.**

### 1 What a view is

`pageView` in `packages/domain` (prototyped in `src/views.ts`, with the full rule in its header) decides it in `serve`, after authorization, the traffic quota and budget protection, from the request's fetch metadata, the answer's status, whether it is a page, whether it is the viewer redirect, the session's visitor and the owner's plan, all of which `serve` already has. It reads and writes nothing itself. Its kinds are `anonymous` and `signedIn`.

Choices made on purpose: the frame's load is counted instead of the top-level redirect, so a visit that starts at a copied `/view/<id>` link counts too; another site's frame of an embeddable public artifact counts (the page is shown there) but a sibling artifact's frame does not (`frame-ancestors` keeps it from rendering, the same reason as `isPageLoad`); bots without fetch metadata are left out, and automated browsers that send it are not, so the numbers are an indicator, not an audit, as the access log already says of itself; the owner signed out on a public artifact with the bar off counts as anonymous because nothing tells them apart. A non-embeddable artifact framed by a hostile site is still served (the browser refuses to render it afterwards), so that site can add views; the traffic quota and the budget limiter cap what that costs, and the dashboard says counts can include automated traffic.

### 2 Storage

`artifact_views (artifact_id, day, owner_id, views, signed_in_views, expires_at)` in `portifact-access` (`packages/db/src/access-schema.ts`, a new access migration), primary key `(artifact_id, day)`, `WITHOUT ROWID`, indexes on `expires_at` and `owner_id`. It holds counts only: no visitor, no IP, no hash.

Why the access database and not the control database: the 10 GB cap of a D1 database stays away from identity and publishing data; pruning and erasure are already there (`pruneAccessEvents`, the `erase_access_events` job an artifact purge writes); and decision 0005 already gives each region its own access database, so EU workspaces keep their counters in the EU with no new resource. The cost is that the counters cannot share a batch with `traffic_counters`; they need not, because the two are independent sums, and a lost window loses the same thing in both.

The content Worker keeps one `ViewMeter` per isolate next to the `TrafficMeter` and flushes both in the same `waitUntil` timer, as two writes (`recordTraffic` to `DB`, `recordViews` to `ACCESS_DB`). `serve` hands it `{ artifactId, ownerId, at, kind, retentionDays }`; the plan is already in the artifact lookup (`findDeliveryArtifact` joins `owner_plans`), so counting adds no read. `recordViews` reads nothing from the control database: a batch held across a purge can recreate a counts-only row for a tombstoned ID, which is never shown and expires.

Retention: one number for the access log and the counters, `accessLogRetentionDays` from `entitlements`, so the Privacy Policy states one retention. Each row carries `expires_at` set when it is written (a day's counters: the day plus the retention plus one day; an opening: `opened_at` plus the retention). A plan change writes an `owner_retention` outbox job in the batch that changes `owner_plans`, and the job runs `setOwnerRetention` on the access database. The read also filters by `expires_at`, so a downgraded owner never sees what the new plan does not keep, even before the prune.

### 3 What can be shown

| Artifact        | Views | Signed-in views                                    | Distinct signed-in visitors                                                     |
| --------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `public`        | Yes   | Yes (a count of views with a session, no identity) | No                                                                              |
| `authenticated` | Yes   | Yes (every view has a session)                     | No                                                                              |
| `restricted`    | Yes   | Yes                                                | Yes, `count(distinct user_id)` from `access_events`, per day and over the range |

Distinct visitors of `public` and `authenticated` artifacts are left out on purpose. Counting them needs the visitors' IDs or a hash of them for at least a day, and the access log rule already explains why those artifacts never record who opened them: any site can send a signed-in visitor there without a click. A keyed hash or a sketch over IDs is still pseudonymous personal data while its key exists, so it would need the same Privacy Policy text and erasure paths as the log for a weaker number. IP addresses and their salted hashes are not used for anything. Anonymous visitors appear only inside `views`.

For a `restricted` artifact the owner already sees each reader in the access log, so a count reveals nothing more. A visitor who opens it on two days counts on each, and once in the range total. An artifact that was `restricted` and is now another mode shows `null`, even though its old openings are still in the log until they expire.

### 4 Reading

One service, `getArtifactStats` (prototyped), behind three adapters that return the same body:

- `GET /api/v1/artifacts/:id/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` (both optional, default the last 30 days; UTC days), scope `artifacts:read`, through `guarded`, owner only.
- MCP `get_artifact_stats` with the same scope in `TOOL_SCOPES` and a row in `test/mcp-parity.test.ts`.
- `portifact stats <id> [--days <n> | --from <date> --to <date>] [--json]`, and the `portifact` skill.

Body: `{ artifactId, from, to, days: [{ date, views, signedInViews, visitors }], totals: { views, signedInViews, visitors } }`, with `visitors` `null` where no log exists and a note that counts are not a complete audit. Errors: `not_found` (404) exactly like a missing artifact for anyone but the owner and for purging artifacts; `plan_required` (403, a new code F1's other features will share) without the feature; `invalid_input` for a range past 366 days or reversed. Archived and suspended artifacts keep their numbers for the owner, like the access log.

With workspaces (F3), the check becomes the actor's role on the owner: admins and editors read, as the access log will; `resolveActor` decides it in the service. The dashboard gets a Stats section on the artifact page and later a per-owner overview, which reads `artifact_views` by `owner_id` for the owner's artifacts in one query.

Cost per dashboard load: four D1 queries (one control lookup, one counter range, one batch of two aggregates for `restricted`), reading at most 367 counter rows and the openings of the range. At US$0.001 per million rows read that is under US$0.000001 per load.

### 5 The one-year access log

Today `pruneAccessEvents` deletes by `opened_at < now - 30 days`, one cutoff for everyone. With per-plan retention:

- `access_events` gains `expires_at` (a migration backfills `opened_at + 30 days`) and an index on `owner_id`; `recordOpenings` sets the expiry from the owner's plan, which it can read in the control query it already runs for the owner and state. The prune deletes by `expires_at`, and `getAccessLog` clamps to the owner's current retention instead of `accessLogCutoff`.
- Writes do not change: a new opening writes 5 rows with the new index (measured) whatever the retention. Storage grows up to 12 times for paid owners.
- Size, estimated at about 260 bytes per opening with its indexes: an owner with 10 `restricted` artifacts and 5 readers opening every other day keeps about 9,000 rows, 2.4 MB, a year; 1,000 such owners about 2.4 GB. A heavy owner (200 artifacts, 20 readers, two openings a day) keeps about 2.9 million rows, about 760 MB. The counters add about 180 bytes per artifact and day with views: 1.3 MB a year for an owner with 20 artifacts viewed daily, 33 MB at Pro's 500 active artifacts all viewed every day.
- The 10 GB cap of one database is the real limit, not the price (US$0.75 per GB-month past the account's 5 GB). The budget collector reads only the control database today (`PORTIFACT_RESOURCES.databaseId` in `apps/jobs/src/analytics.ts`); it must also watch `portifact-access`, with an alert well before 10 GB. If it gets close, the access database is split by owner (each owner in one shard, so still no batch spans two), the same seam the per-region access databases of decision 0005 already open.

### 6 What the texts must say

The Privacy Policy, in the section on owners' data and the access log:

- Owners on a paid plan see, per artifact, page views per day and how many of them came with a signed-in visitor; these are counts and identify nobody.
- For artifacts shared with listed people, the owner also sees how many distinct signed-in readers opened it per day; this comes from the access log, which already names those readers to the owner.
- Anonymous visitors are never identified: no IP address, cookie or identifier is stored for them.
- Retention: the access log and the counts are kept 30 days on the free plan and up to one year on paid plans; after a plan change the shorter retention applies to what was kept.
- Erasure: counts go with the artifact, openings with the artifact or the visitor's account, as today.

`docs/legal.md` gets a paragraph that keeps these in sync with `docs/security.md` and `PLANS`, and states whether the change takes a new `TERMS_VERSION`. It extends retention of data that names visitors (one year of the access log), so it is a material change by the rules there and goes in the wave's single bump (premium plan L4), with a lawyer's review.

`AGENTS.md`'s rule "traffic is per account, never per artifact" becomes: the quota and the budget stay per account; per-artifact views are counts in `artifact_views`, written only through the batching, read only through `getArtifactStats`.

## Cost

Inferred from the prices above; the volumes are assumptions, not measurements.

| Case                                                                                      | Views a month   | D1 rows written                         | Cost a month                                                      |
| ----------------------------------------------------------------------------------------- | --------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Pro at its full quota, every request a page view and each in its own window (upper bound) | 2,000,000       | About 2,000,000                         | US$2.00 past the account's included 50 million, otherwise nothing |
| Pro at its full quota, page views a fifth of requests                                     | 400,000         | At most 400,000, fewer as windows batch | Up to US$0.40 past the included rows                              |
| Pro at typical use (5% of quota)                                                          | 20,000          | At most 20,000                          | US$0.02 or less                                                   |
| Team at its full quota, per seat (3 million requests)                                     | Up to 3,000,000 | Up to 3,000,000                         | Up to US$3.00 per seat past the included rows                     |

The upper bound is a view arriving alone in its window on every isolate, which is what low, steady traffic does. It equals what `traffic_counters` already pays per request in the same case (one row per flush per owner), which the plan's cost model in section 8 does not include (its D1 term is reads only); this design at most doubles that term. Storage stays inside the included 5 GB until roughly a thousand paid owners at the sizes above. Reads are negligible.

## Effort

Inferred from recent PR sizes, not measured.

| Order | PR                                                                                                                                                                                                                                     | Size     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1     | Access database: `expires_at` and owner index on `access_events` with the backfill, `artifact_views`, prune by expiry, `getAccessLog` per plan, the `owner_retention` job on plan changes, the access database in the budget collector | 1.5 days |
| 2     | Content Worker: `pageView` in the domain, `ViewMeter` next to `TrafficMeter`, `recordViews`, the erase job extended to the counters, e2e checks that one viewer visit is one view                                                      | 1.5 days |
| 3     | Read: `getArtifactStats`, the contract, `/api/v1/artifacts/:id/stats`, `get_artifact_stats` with parity, `portifact stats`, the skill                                                                                                  | 1.5 days |
| 4     | Dashboard: Stats on the artifact page (chart, table alternative, the 8 languages), accessibility                                                                                                                                       | 1.5 days |
| 5     | Privacy Policy and `docs/legal.md`, `docs/security.md` ("Access logs" and a new "Artifact analytics"), the `AGENTS.md` traffic rule                                                                                                    | 0.5 day  |

About 5 PRs and 6.5 days. 1 comes first; 2 and 3 can run in parallel after it; 4 needs 3; 5 lands with the release that turns the feature on.

## Alternatives rejected

- **Workers Analytics Engine for the views.** It is cheap and its write is free of D1, but: data is kept three months and the plan keeps a year; sampling has no documented bound for small counts, so 12 views showing as 12 is not something the documentation promises; there is no way to read it in workerd, so the read path would be tested only against a fake; reading needs an account-wide token with Account Analytics Read in the app Worker, on a Cloudflare account that also hosts other projects; each dashboard load becomes an external call with undocumented latency; it has no jurisdiction, so EU workspaces' counters would sit wherever Cloudflare stores datasets (counts keyed by artifact ID may leave the region under decision 0005, but the EU promise reads better without it); and distinct visitors would still come from D1, so the numbers would live in two stores with two retentions. It stays a candidate for an operator-only, sampled overview of the whole platform.
- **Counters in the control database, in the same batch as `traffic_counters`.** One batch instead of two, but the counters and a one-year log grow in the database that holds identity and publishing, against its 10 GB cap, and pruning and erasure would be new code instead of extending the access database's.
- **A row per view, aggregated on read.** Exact and flexible, but one row per view is the write per request the rule forbids, only deferred to the flush, and storage grows with traffic instead of with artifacts and days.
- **Distinct visitors for `public` and `authenticated` artifacts with a hashed ID or IP, or a sketch.** See section 3: personal data under another name, for a number any site could inflate.
- **Counting the top-level redirect instead of the frame.** It misses every visit that starts at a copied viewer link and every page opened inside the frame.

## Open risks

- Counts can be inflated by automated browsers and by hostile sites framing an artifact; without Bot Management there is no cheap filter. The dashboard and the API say counts include automated traffic.
- The heavy-owner estimate shows a few large owners could fill the access database; the budget collector does not watch it yet, and splitting it is not prototyped.
- An evicted isolate loses up to one window of views, as it already loses traffic and openings; the numbers are slightly low, never high from that cause.
- The cost model in plan section 8 leaves out D1 writes; this design adds at most as many as traffic metering already costs in the worst case, which should be measured in production before the first paid plan is granted.
- The access log's one year is a material change for the Privacy Policy and needs the lawyer's review before it ships.
- UTC days: owners in other time zones see days that start at 00:00 UTC. Per-time-zone days would need hourly rows (24 times the storage) and are left out.

## Implementation

P8 shipped the design in one change. Where it differs from the text above:

- **The owner side of a workspace** is dropped when the batch is written, not in `pageView`: delivery knows only the visitor and the owner, so the meter keeps signed-in views per visitor until the write, and `recordViews` removes the admins and editors of a workspace owner with one membership read per workspace and batch. The personal owner is still dropped in `pageView`. `recordViews` therefore reads the global database once per workspace and batch; it still reads nothing about the artifact.
- **Plan expiry without a job.** Each row's `expires_at` (`retentionExpiry`) is capped at the plan's `valid_until` when the free retention is shorter, so a plan that runs out needs no `owner_retention` job. Grants and removals write the job as described.
- **Boundary.** Rows are kept through the instant they expire and pruned after, the access log's existing boundary.
- **Budget.** The collector adds the access database's rows read and written to the control database's (`databaseId_in`). It does not watch the size of either database: the budget has no storage metric for D1 yet, so the alert before 10 GB is still open.
- **Workspace deletion** does not exist yet, so only purges and account deletions erase.
- **Dashboard** shows the series in the artifact page's Activity section, with no per-owner overview.
