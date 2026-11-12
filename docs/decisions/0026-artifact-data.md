# 0026 Artifact data: a database per artifact

- Status: proposed, third version. Design only: nothing is built, and `spikes/artifact-data` proves what "Claims and evidence" lists. The first version (commit `7a10518b`) and the second (commit `f63e150a`) each received an adversarial review that asked for a redesign; "Review findings" maps every finding of both to its answer. The product decisions are the maintainer's: [issue #194](https://github.com/leynier/portifact/issues/194), their answers to both reviews and to this record's questions. Only the plan limits remain open.
- Date: 2026-11-12
- Feature: issue #194, "give each artifact its own database". Not a premium plan feature: every plan gets it, with limits per plan.

## Question

An artifact is a static site today. The maintainer wants it to be able to be a small app: its JavaScript, running in a visitor's browser, stores and reads data that outlives the visit (forms, votes, lists, boards), and the owner and their agents read and write the same data through the API, the MCP server and the CLI, with SQL. How can Portifact give each artifact a database without letting a visitor reach another visitor's data, letting a page act as a person without their consent, letting one artifact reach another's, letting a hostile owner or visitor spend Portifact's budget without a bound, or breaking any rule the platform already keeps (regions, deletion, restore, holds, quotas, the three interfaces' parity)?

## Decisions taken by the maintainer

From the issue:

1. **Engine.** Real SQLite in Cloudflare Durable Objects with the SQLite storage backend, in the jurisdiction of the owner's region.
2. **Two doors.** The page uses a document API and never sends SQL. The owner side (admins and editors of the owner and their agents) uses the document API plus SQL, read and write, from the first release.
3. **Identity.** The page learns an opaque per-artifact ID and the display name, never the email (narrowed by 17).
4. **Who writes from the page.** The owner decides per artifact; by default signed-in visitors who can open it; anonymous writers on public artifacts only when the owner opens them, with per-IP limits and the human check; share link visitors read only.
5. **Live updates** over WebSockets from the first release.
6. **Plans.** Free with a small quota, more on paid plans, under the budget target (US$50 a month as an objective, protection from US$100).
7. **Lifecycle.** The data belongs to the artifact, not a version: publish and rollback do not touch it; it stays while archived, counts in storage, and goes at purge and account or workspace deletion.

From the first review:

8. **Owner SQL and visitor documents do not share a database.**
9. **Spending is bounded by work, not request counts**: rows read and written, durably, per artifact and per owner, per plan, attempts and refusals included; visitor queries only in shapes with a bounded scan; nothing keeps an object awake.
10. **No identity and no attributed write without the visitor's consent on the trusted origin.**
11. **Lifecycle is fenced**: operation IDs, a data generation and a lifecycle epoch in one envelope; holds and transfers are acknowledged barriers; erases target their generation; erasure registration survives a D1 restore; socket authorization has an absolute deadline.
12. The smaller defects of that review are fixed as it says.
13. Existing service tokens gain nothing (new scopes); account deletion erases the documents the account created and the record says how a person asks about the rest; a transfer moves the data; live authorization keeps the 60-second bound, links included; a workspace policy forbids anonymous writing; no point-in-time recovery for owners in the first release; `_by` is session attribution.
14. **Deliveries**: small disabled increments, each feature with its own switch.

From the answers to this record's questions:

15. **One release, built in small steps.** The first release that is switched on includes owner SQL, read and write, and live updates; a staged release was offered and declined. Deliveries are built and reviewed one at a time behind their switches; the feature is switched on only when all of them are ready.
16. **Two databases**, with the owner side copying a collection into its SQL database for analysis, if it can be proven closed.
17. **Consent before identity**: a page learns nothing about the visitor and cannot write as them until the visitor allows it in a control Portifact draws. This narrows 3.
18. **Account deletion** erases the documents the account created on other people's artifacts; owner-made copies and later edits by others in a shared collection are outside that, and the record says how a person asks about those.
19. **Transfers** move the data with the artifact, like comments and the access log.
20. **Service tokens** gain no access; artifact data needs a new scope an admin grants.
21. **Anonymous writing**: offered in a personal space, where the owner decides alone; in a workspace only where the workspace policy that can forbid it exists (the plan with `policies`); a workspace without that control cannot open writing to anonymous visitors.
22. **Plan limits: not decided** ("Open questions").

From the second review, the maintainer's fixed rules for this version:

23. **Operation IDs** are scoped to the authenticated actor, the generation and a hash of the request; authorization is checked before any recorded result is returned; a replay record holds no body or SQL result; replay records are pruned on a schedule and covered by erasure; SQL and copies have the same contract; a retry after a lost acknowledgement neither re-applies nor needs a second allowance.
24. **Fencing**: a fence is persisted before it is acknowledged, on empty objects too; one validator for every command of both objects, maintenance and every erase step included; prepare adopts the epoch it accepts; erasing the payload and writing the next generation's marker are one atomic step that keeps the control state; the record says how a pair of objects recovers when only one completed.
25. **Restore**: the lifecycle state each object needs (owner, epoch, pending transition, holds) lives in the objects' own control records; D1 is reconciled from them; what cannot be reconciled is quarantined until the operator resolves it; a restored owner is never blessed with a newer number.
26. **Author erasure**: an acknowledged barrier is set before documents are deleted; late writes are refused; the journal entry is kept until the barrier and every chunk are durable; scans are indexed by author and bounded by work; two racing first grants create one identity.
27. **A provable ceiling for owner SQL**: the sandbox has its own size cap; a statement's measured cost is always kept; an overdraft becomes a debt that blocks SQL until later days pay it; the debt and the ledger live outside the sandbox's generation; leases are bound to the owner and the ownership epoch; the ceiling is a formula computed per plan; owner SQL does not draw from the visitors' allowance.
28. **Cost model**: two models (with and without the account's included allocations), billing-unit rounding, a 31-day month, all the work the design adds; options A, B and C recomputed; a recommendation that a plan's price covers.
29. **Live**: renewal bound to the grant, session and principal that opened the connection, able to shorten; bytes reserved before sending in UTF-8, protocol messages and fan-out included, against artifact and owner daily limits; a replay does not notify twice.
30. **Values and export**: interactive results flag values that cannot be represented exactly, count the whole response, and never say `truncated: false` for a cut result; export is a separate lossless streamed format from server-generated statements, across both objects with a consistent revision.
31. **Cleanup always works**: deleting, shrinking and exporting have their own allowances; a visitor deletes their own documents without write permission and without the current terms.
32. **Copies** are jobs with source generation and revision, destination, cursor and idempotent page receipts, row and byte limits inside the sandbox, measured charges, a catalog that stays right.
33. **Storage accounting** covers control records and refused work, with a monotonic sequence per object and an explicit sum of the two objects.
34. **Audit**: durable pending, committed and aborted states; obligations survive erasure; recovery does not depend on a surviving D1 intent.
35. **The grant flow**: separate gates to start and to redeem; a real fallback that works with third-party cookies blocked, following decision 0002 (the content in a top-level tab); codes consumed atomically; a browser test in all engines before release.
36. **Claims** are a table of claim, test, and what only a browser or a deployment can show.
37. **Deliveries**: shared lifecycle, copy, export and accounting contracts first; acceptance on what each truly needs; documents, live updates and owner SQL separable behind their switches, so documents and live updates could be switched on before SQL if SQL took longer; an estimate to stand behind.

Alternatives rejected by the issue (Turso Cloud, Turso's engine in Workers, D1 per artifact, shared tables in the regional D1, SQLite in the browser with sync) stay rejected for the reasons it gives.

## Decision in short

- **Two objects per artifact** (the second review confirmed the split): `ArtifactDocuments` holds the collections and speaks only the document API; `ArtifactSandbox`, in its own Worker, holds the owner's tables and copies. **`OwnerLedger`**, one per owner, holds the owner's daily allowances as balances that can go into debt.
- **A control record in every object** holds the artifact, region, owner, generation, epoch, state (open, held, erasing, quarantined), the owner's epoch, the last transition and a storage sequence. One validator, `admit`, decides every command of both objects against it.
- **Operation records** keyed by actor, generation and operation ID, bound to a hash of the request, holding only what was done.
- **Budgets in pools**: growth and reads (documents), owner SQL (its own pools), cleanup and export (their own daily allowances), live bytes. Charged before work, actual work after, refusals kept; SQL overdrafts become debt in the ledger.
- **Erasure**: whole-data erase in two steps, the commit atomic over the payload; author erasure behind a barrier, in bounded chunks; the author journal and the object inventory in R2.
- **A grant on the app origin** before any identity, with separate start and redeem gates, atomic codes and a top-level fallback.
- Shipped off behind five switches; ten deliveries; the ceiling per plan is a formula; option B is recommended.

## Facts checked

Cloudflare's documentation, read on 2026-11-12 ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/), [metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)):

- **Durable Objects on Workers Paid.** Requests: 1 million a month included, then US$0.15 per million (incoming WebSocket messages count 1 in 20, outgoing free). Duration: 400,000 GB-s included, then US$12.50 per million GB-s at 128 MB; an idle object eligible for hibernation is not billed, and pending JavaScript timers, unfinished work or the standard WebSocket API make it ineligible, while a stored alarm does not. SQLite: 25 billion rows read and 50 million rows written included, then US$0.001 and US$1.00 per million; 5 GB-month stored included, then US$0.20 per GB-month. Key-value calls bill as rows. Overage rounds up to billing units (a million requests, a million GB-s).
- **Workers.** 10 million requests included, then US$0.30 per million; 30 million CPU milliseconds included, then US$0.02 per million.
- **Limits.** 10 GB per object; statements up to 100 KB, 100 parameters, 8 MB per value; 30 seconds of CPU per request by default, set per Worker with `limits.cpu_ms`; exceeding it can evict and reset the object; alarms may run late.
- **The SQL API** reports `rowsRead` and `rowsWritten` (the billed values) and hands integers to JavaScript as numbers, so an integer past 2^53 loses precision before the Worker sees it.
- **Jurisdictions.** `namespace.jurisdiction("eu")` keeps objects in the EU; the same name in two jurisdictions is two objects.

Measured in the spike (local workerd): `PRAGMA max_page_count` and `PRAGMA page_count` are refused (`SQLITE_AUTH`), so a statement's writes cannot be capped by SQLite's page limit; the key-value store is a table `_cf_KV` that SQL cannot read; R2's conditional put (`onlyIf: { etagDoesNotMatch: "*" }`) admits one of several concurrent writers; a megabyte holds about 99,000 one-integer rows; an in-place `UPDATE` wrote 5.5 to 16.7 million rows a second.

The code at `develop`: the content Worker exports a SQLite Durable Object already (`TrafficLimiter`) and refuses methods other than `GET` and `HEAD` before routing; sites carry no script policy of Portifact's; public artifacts are served before any session is read; the viewer frames artifacts with a partitioned review session and falls back to a top-level review tab (decision 0002); transfers are refused across regions; the Terms say Portifact "runs no builds, servers or databases for your content"; `PLAN_PRICES` lists Pro at US$2 a month and Team at US$5 a seat; traffic is 1 million requests a month on Free, 2 million on Pro and 3 million a seat on Team.

## Two objects (decisions 8 and 16)

`ArtifactDocuments` speaks only the document API; no SQL from anyone reaches it. `ArtifactSandbox` is the owner side's SQL database: it never holds live documents, only the owner's tables and copies the owner side asked for. The second review confirmed what this makes true in the spike: an owner's foreign key cannot reference documents (they are not there), no owner DDL can block erasure, and an expensive statement holds only the sandbox. In production the sandbox lives in its own Worker (`portifact-sql`), so it shares no isolate with documents.

| Worker                 | Exports                            | Binds                                | `limits.cpu_ms` |
| ---------------------- | ---------------------------------- | ------------------------------------ | --------------- |
| `portifact-data` (new) | `ArtifactDocuments`, `OwnerLedger` | itself                               | default         |
| `portifact-sql` (new)  | `ArtifactSandbox`                  | `OWNER_LEDGER` from `portifact-data` | 1,000 proposed  |
| `portifact-content`    |                                    | `ARTIFACT_DOCUMENTS`                 | default         |
| `portifact-app`        |                                    | all three                            | default         |
| `portifact-jobs`       |                                    | all three                            | default         |

New Workers have no routes, no D1, R2 or queue bindings and no secret; legacy `migrations` with tag `v1` (`new_sqlite_classes`); never `deleted_classes`, `renamed_classes` or `transferred_classes` (a `scripts/` test refuses them). Deploy order: `portifact-data`, `portifact-sql`, then jobs, content and app. `dataNamespaces(env, region)` in `packages/services` is the only place a stub is made (no jurisdiction with `locationHint: "wnam"` for the default region, `jurisdiction("eu")` for the EU), from the directory's region only. The e2e Worker exports all three classes.

## The control record and the validator (decisions 24, 25; findings 2, 3, 4)

Every object keeps a control record (`spikes/artifact-data/src/envelope.ts`): `artifactId`, `region`, `ownerId`, `generation`, `epoch`, `state` (`open`, `held`, `erasing`, `quarantined`), `ownerEpoch` (the epoch at which the current owner took over), `last` (the last transition: created, transfer, hold or release, with the epoch, the owner before and after, and the time) and `storageSeq`. The documents object keeps it in its `pf_meta` table; the sandbox in its key-value store. Every command carries an envelope `{ artifactId, region, ownerId, generation, epoch, opId? }` filled by the calling Worker from D1.

**One validator.** `admit(stored, envelope, mode)` decides every command of both objects: requests, operator commands, and every erase step, including prepare, commit and cancel (spike: findings 2 and 27 on every method). A different artifact or region is `forbidden`; a quarantined object refuses all but the operator; a different owner is `stale` (ownership changes only by a fence); an older epoch is `stale` and a newer one is adopted; a different generation is `stale`, except that an erase step for an older generation is already done; a held object runs only the operator; an erasing object refuses requests.

**Fences.** `fence(envelope, change)` applies a hold, a release or a transfer (`toOwner`). It is persisted in the object's own transaction before it is acknowledged, and on an empty object it creates the control record, so a later stale command is refused (spike: finding 2). A fence needs a newer epoch than the object's; a repeat of the same fence is acknowledged again; an older one is refused. A transfer records the new owner and its epoch and drops the old owner's leases; a hold closes live connections. D1's side: the hold or transfer batch raises the epoch in `artifact_data` and writes a `data_fence` job; the change is in force when both objects acknowledged (`fenced_epoch`); the operator's `hold-artifact` and `transferArtifact` wait for it.

**Erasing the whole data.** `prepareErase` passes the validator, adopts the epoch it accepts and sets `erasing` (spike: finding 3). The job re-reads D1 (a hold may have started), then calls `commitErase` or `cancelErase`. `commitErase` runs one transaction that deletes every payload table (documents, collections, field indexes, sequences, replay records; in the sandbox every owner table and view and the payload keys) and writes the next generation into the control record; budgets, leases, barriers and audit obligations stay (spike: "erasing keeps the control records"). A fence between prepare and commit cancels it. A retry finds the next generation and does nothing.

**When only one object completed.** The erase job targets both objects with the same generation and treats each step as idempotent: a commit that finds the next generation answers done. If the job dies after the documents committed and before the sandbox did, the retry finds the documents done and finishes the sandbox (spike: "erases both objects of a generation atomically each, and finishes when only one had"). Until both report the next generation, D1 keeps the artifact's data state `erasing` and data paths answer `503`. The job retries with backoff and alerts the operator after a day.

**Restore (decision 25; finding 4).** A D1 Time Travel restore rewinds D1, not the objects. After `apply-tombstones` puts holds back, `data_reconcile` reads each object's control record (the R2 inventory lists them) and applies `reconcile(row, control)`: the same owner and hold state raises D1's generation and epoch to at least the object's; another owner, or a hold one side has and the other does not, quarantines both objects (`quarantine`: every command refused, connections closed) and lists the artifact for the operator, who resolves it with `data-resolve <id> --owner <id>` (adopting the owner the objects recorded, or erasing). A restored owner is never given a newer number: the validator refuses a different owner at any epoch (spike: "never lets a restored former owner read the new owner's data").

## Operation records and replay (decision 23; findings 1, 5)

Every mutation (document writes, declarations, SQL writes, copy pages, author erasure chunks with an ID) carries an operation ID. The object records it in the same transaction as the mutation under the key `actor | generation | opId`, with a SHA-256 of the request, the state (`committed` or `aborted`), the kind and what it named (`items/<id>`, a collection name, rows written). Never a body or a SQL result.

- **Before any charge**, inside the validator's transaction, the object looks the key up. The same request is checked against the caller's current authorization (the collection's mode and scope now) and answers `{ replayed: { kind, target } }`, with no body; another request under the same key is `conflict`; an aborted one is `conflict`. So another actor's reuse of an ID is a different key and never sees the first result (spike: finding 1), and a retry after a lost acknowledgement needs no second allowance (spike: finding 1).
- **No double effects.** A replay never applies again and never notifies live connections again (spike: "notifies a replay once").
- **Retention.** Records are pruned after 24 hours, at most 500 a call, through an index on their time, by the object's alarm when it is already awake for other work and by the size scan (spike: finding 5). Author erasure deletes the author's records with their documents.

## Audit with durable states (decision 34; finding 14)

An owner-side mutation writes its audit obligation (`pf_audit`, or the sandbox's key-value store) in its own transaction; copies and author-erasure chunks too (spike: finding 14). Obligations are control data: a whole erase keeps them. The relay never infers "never committed" from an absent obligation: the jobs Worker calls `settle(envelope, actor, opId)`, which returns the committed obligation or records the operation as `aborted` in the same transaction, so a call that arrives later replays as aborted and cannot commit (spike: "settles an operation"). The relay inserts the audit event idempotently on the operation ID and acknowledges the obligation. Recovery does not depend on a surviving D1 intent: the daily sweep walks the R2 object inventory and asks each object for obligations older than an hour.

## Author erasure (decision 26; findings 6, 17)

1. **The journal.** Before a grant's code is issued, the app claims `system/data-authors/<user ID>/<artifact ID>` in the artifact's region's bucket with a conditional put: of two racing first grants one writes, the other reads the winner's visitor ID, so one person has one identity per artifact (spike: "gives two racing first grants one identity").
2. **The barrier.** The account deletion job calls `eraseAuthorChunk`, whose first transaction writes the author's barrier (`pf_barriers`) before deleting anything; from its answer on, every create or replace by that author is refused (spike: finding 6). Grant renewal in D1 also stops at account deletion.
3. **Bounded chunks.** Each call deletes at most 500 documents through an author-first index (`pf_documents_by_author`), and at most as many of the author's replay and rate rows through their own indexes, and answers `more` (spike: finding 17: an absent author in 20,000 documents reads a bounded number of rows).
4. **The journal entry is deleted only after a call answered `more: false`**, so a crash between chunks resumes.
5. A held artifact defers the chunks to the hold's release, as for comments.

## Budgets and the ceiling (decisions 9, 27; findings 7, 10, 12)

### Pools

| Pool                       | Where counted                                                                              | Charged by                                                        | Refusal                         |
| -------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------- |
| Documents growth and reads | the artifact's day (`pf_day`) and the owner's `documents_read`, `documents_written`        | creates, growing replacements, reads, declarations                | `quota_exceeded`                |
| Owner SQL                  | the sandbox's day and the owner's `sql_read`, `sql_written`                                | SQL statements and copy pages                                     | `quota_exceeded`                |
| Cleanup                    | the artifact's own daily cleanup allowance, never the growth pools                         | deletes, shrinking replacements, SQL `DELETE` and `DROP`, erasure | `rate_limited`                  |
| Export                     | the artifact's own daily export allowance                                                  | export pages                                                      | `rate_limited`                  |
| Live bytes                 | the artifact's day and the owner's `live_bytes`                                            | every message sent                                                | the connection is closed `4029` |
| Rates                      | durable rows per author and minute (writes, deletes, connects); reads per caller in memory | each command                                                      | `rate_limited`                  |

Owner SQL never draws from the documents pools, so it cannot stop visitors' writes (spike: finding 12); owner document writes do share the documents pools, which is the owner's own choice. Cleanup and export never meet the growth budget: a spent day still deletes, shrinks and exports (spike: finding 10), and a visitor deletes their own documents without write permission or the current terms.

### How it is charged

- **Before the work**, in its own committed transaction: the rate, the day, and the lease (an estimate). A refusal keeps its charge.
- **After the work**: what the cursor reported above the estimate, for a failed or rolled-back statement too (spike: finding 7: a statement refused for size after updating 4,096 rows stays charged for them).
- **Leases** are taken from the ledger in chunks (5% of the owner's day, at most 100,000 rows read, 1,000 written or 1 MB of live bytes), are bound to the owner and the ownership epoch (a transfer drops them; spike: "never uses the former owner's lease after a transfer"), and are topped up additively, so concurrent requests cannot overwrite each other's grants.
- **The ledger** keeps each pool as a balance that refills by its daily allowance up to one day's worth and can go negative. A SQL overdraft (work past the lease) is settled into it as debt; no lease is granted while the balance is below zero, so later days pay it off first (spike: "turns an overdraft into debt that blocks SQL until later days pay it off"). The ledger is per owner, outside both artifacts' objects and generations: erasing or recreating a sandbox never clears a debt (spike).
- **A statement the platform stops** (the CPU limit) never reports back. Before running, the sandbox writes an in-flight marker; the next statement finds it, charges the plan's worst case (`sqlWorstRowsRead`, `sqlWorstRowsWritten`) as debt and gives up the artifact's remaining leases (spike: "charges a statement the platform stopped at the plan's worst case").

### What bounds one owner statement

- **Writes.** `PRAGMA max_page_count` is refused in Durable Objects (measured), so SQLite cannot stop a statement at a page limit. The bound comes from shapes: an `INSERT … SELECT` may read one table (no join, no compound select; checked on SQLite's own program), `UPDATE` and `DELETE` touch only rows of their own table, triggers are refused, and a sandbox may hold at most 4 indexes (spike). So one statement writes at most the rows its source table holds times one plus the indexes. Committed tables never exceed the sandbox's size cap, so the rows a table holds are at most the cap times about 99,000 small rows per megabyte (measured). `W_max = sandbox MB × 99,000 × 5`.
- **Reads.** A join reads a product of tables: bounded by the sandbox Worker's CPU limit, not by the cap. Locally a 64-million-row self-join took 1.3 to 2.9 seconds, about 25 to 50 million rows a second, so at `cpu_ms: 1000` a statement reads at most about `R_max = 50 million rows` (US$0.05) before the platform stops it; that figure is the plan's `sqlWorstRowsRead` and only staging can confirm the CPU limit stops a statement (see "What only a deployment can show").
- **The ceiling.** Over `D` days an owner's SQL spends at most `allowance × D + W_max` rows written and `allowance × D + R_max` rows read: each day's allowance, plus one overdraft by one statement, after which the debt blocks SQL. Documents spend at most their daily allowances, since every document command is charged at a bounded estimate before it runs and a document write's actual rows are bounded (measured: at most 18).

### Measured cost per operation (production shape)

| Operation                                      | Rows read | Rows written                                                                                     |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| First collection declared (creates the schema) | 42        | 44                                                                                               |
| Visitor create                                 | 24        | 17                                                                                               |
| Visitor replace                                | 23        | 12                                                                                               |
| Visitor delete                                 | 14        | 10                                                                                               |
| Visitor get / page of 20                       | 12 / 33   | 2 / 2                                                                                            |
| Owner create (with its audit obligation)       | 23        | 17                                                                                               |
| SQL insert of one row / select of one row      | 0 / 1     | 1 / 0, plus the sandbox's key-value counters (about 6 reads and 6 writes a statement, estimated) |
| One message sent on the live channel           |           | 2 (the day's bytes and the owner's lease)                                                        |

An object with its schema and one collection is 72 KiB; a 200-byte document adds about 680 bytes. A write costs 17 rows because it also writes its two counters, its lease, its rate row, its operation record (with two index entries), the sequence and the storage sequence; the cheaper alternative would give up replay, fencing or durable budgets.

## Cost model (decision 28; findings 18, 19)

Prices above, a 31-day month, overage rounded up to million-unit billing blocks.

### Typical use

The issue's assumptions: 5% of artifacts with data active on a day; each active artifact 150 reads and 50 writes a day and two tabs with a live connection for an hour (120 renewals); 1.1 MB stored per artifact (data and control). Per active artifact a day, from the measured rows: 326 Durable Object requests (pages, renewals, connects, alarms, ledger calls), 322 Worker requests, 1,460 rows written (writes 850, reads 300, live sends 200, replay pruning 100, alarms and ledger 10), 5,000 rows read, 2 ms of Worker CPU a request; active time `B` per request 5 ms or 100 ms (staging measures it).

|                         | 1,000 artifacts, allocations available | 1,000, none available | 100,000, allocations available           | 100,000, none available |
| ----------------------- | -------------------------------------- | --------------------- | ---------------------------------------- | ----------------------- |
| Durable Object requests | 0.5 M: US$0                            | US$0.15               | 50.5 M: US$7.50                          | US$7.65                 |
| Worker requests         | 0.5 M: US$0                            | US$0.30               | 49.9 M: US$12.00                         | US$15.00                |
| Rows written            | 2.3 M: US$0                            | US$3.00               | 226 M: US$177                            | US$227                  |
| Rows read               | 7.8 M: US$0                            | US$0.01               | 775 M: US$0                              | US$0.78                 |
| Stored data             | 1.1 GB: US$0                           | US$0.22               | 110 GB: US$21                            | US$22                   |
| Duration                | 323 GB-s: US$0                         | US$12.50 (one block)  | US$0 (B = 5 ms) to US$12.50 (B = 100 ms) | US$12.50                |
| Worker CPU              | 1 M ms: US$0                           | US$0.02               | 100 M ms: US$1.40                        | US$2.00                 |
| **Total**               | **US$0**                               | **US$16**             | **US$219 to 231**                        | **US$287**              |

"Allocations available" credits the account's whole included amounts to this feature; "none available" assumes the rest of Portifact already uses them. At 1,000 artifacts data fits in the included amounts, and costs about US$16 if they are already spent (most of it one duration block). At 100,000 artifacts typical use costs US$219 to 287 a month, four to six times the US$50 objective, and rows written are three quarters of it. That scale needs revenue from data, or a cheaper write (the levers are fewer counter rows per write and batching live counters per fan-out instead of per message); no plan cap changes it, because typical use stays under every option's caps.

### What one hostile actor can make Portifact pay

Marginal cost, nothing included, 31 days: rows at the ceiling formula (each day's allowances, one SQL write overdraft `W_max` and one read overdraft `R_max`); Durable Object requests up to the plan's traffic quota (data requests count in it; their Worker requests are the same as static traffic's); stored data at every data artifact's caps; duration at 5 ms a request; Worker CPU at 2 ms. The worst hour spends a whole day's allowances, both overdrafts and the whole month's request quota.

| Option and plan     | Rows written | Rows read | Requests       | Storage  | Worst month                           | Worst hour | Plan price  | Covered under hostile use |
| ------------------- | ------------ | --------- | -------------- | -------- | ------------------------------------- | ---------- | ----------- | ------------------------- |
| A, Free             | US$1.74      | US$1.07   | US$0.15        | US$0.01  | US$3.01                               | US$0.77    | none        | no revenue to cover it    |
| A, Pro              | US$7.74      | US$3.46   | US$0.30        | US$0.44  | US$12.04                              | US$5.50    | US$2        | no                        |
| A, Team (per owner) | US$38.70     | US$17.10  | US$0.45 a seat | US$11.00 | US$67 at 1 seat, US$73 at 10          | US$26      | US$5 a seat | from 14 seats             |
| **B, Free**         | US$0.34      | US$0.22   | US$0.15        | US$0.00  | **US$0.76**                           | US$0.34    | none        | the smallest exposure     |
| **B, Pro**          | US$0.87      | US$0.45   | US$0.30        | US$0.10  | **US$1.82**                           | US$0.70    | US$2        | yes                       |
| **B, Team**         | US$5.58      | US$2.07   | US$0.45 a seat | US$2.55  | **US$10.78 at 1 seat, US$11.97 at 3** | US$3.14    | US$5 a seat | from 3 seats              |
| C, Free             | US$7.13      | US$3.46   | US$0.15        | US$0.06  | US$10.84                              | US$2.94    | none        | no                        |
| C, Pro              | US$21.68     | US$10.28  | US$0.30        | US$2.75  | US$35.10                              | US$13.36   | US$2        | no                        |
| C, Team             | US$96.00     | US$34.15  | US$0.45 a seat | US$44.00 | US$175 at 1 seat, US$180 at 10        | US$53      | US$5 a seat | from 36 seats             |

A hostile visitor on someone else's artifact is bounded by that artifact's day and by the owner's documents pools: on option B Free at most the owner's 5,000 rows written and 500,000 read a day (about US$0.006), and the artifact's writes stop for the day (a denial of service for its other writers until UTC midnight). Mass abuse across many accounts meets budget protection's `pause_data_writes` and the global admission limit. Every figure follows from the formula and inputs above (prices, the 31-day month, billing blocks, the plan's numbers, `W_max = sandbox MB × 99,000 × 5`, `R_max = 50 million rows`).

## The grant (decisions 10, 17; findings 3, 9, 15, 22, 24)

A grant is one person's consent, for one artifact host and one browser, that the page may know them by an opaque per-artifact ID and their display name and save what they enter. Without a grant a page reads what the artifact's access allows and learns nothing about who is there: `GET /__portifact/data/me` answers `{ granted: false }` for everyone. Review, read and link sessions authorize reading only.

**The control** is drawn by Portifact on `app.portifact.com`: the artifact's host and owner, what the page will learn (display name and an ID for this artifact, never the email), that the people who manage the artifact read everything saved there, that the data moves with the artifact if it changes owner, how long the grant lasts, a link to the rights request page; "Allow" and "Not now".

**Two gates** (spike: findings 15, 16): `beginGate` admits `GET /__portifact/data/grant/begin` only as a top-level navigation from the artifact's own page (`same-origin`, `document`) or the viewer's navigation of its frame (`cross-site`, `iframe`); `redeemGate` admits `GET /__portifact/data/grant?code=…` only as a `cross-site` navigation from the app (`document` or `iframe`). A sibling's `same-site` navigation passes neither. The API gate stays same-origin only.

**Three flows**, one rule: the one-use code redeems only with the transaction cookie of the browser that began, on the host it was issued for.

1. **In the viewer's frame.** The viewer navigates its frame to `begin`; the content Worker sets a sealed, partitioned transaction cookie and answers a Portifact page that posts the nonce's hash to the viewer (exact target origin); on "Allow" the app creates the grant and a code bound to the hash and host; the viewer navigates the frame to `grant?code=…`; the Worker sets a partitioned `__Host-pf_grant`.
2. **The top-level tab** (the fallback, as decision 0002 verified for review): where the partitioned cookie is refused (third-party cookies blocked without CHIPS support), the viewer offers "Open in a new tab"; the artifact opens top-level on its own origin, where cookies are first-party, and the page's `data.requestGrant()` runs the direct flow there. The frame keeps reading without a grant.
3. **On a direct visit** (no bar, a custom host, or the tab above): the page opens `begin` top-level in a popup or the same tab; the transaction cookie is first-party; the popup goes to the app, which shows the control and redirects to `grant?code=…`; the Worker sets `__Host-pf_grant` (`SameSite=Lax`) and returns to the page.

**Atomic codes** (finding 15): the code is consumed with one guarded D1 update (`used = 0` to `1`, returning the grant); the spike's redemption computes every hash first and then checks and sets with no await between (spike: "a code redeems once under concurrency").

**Storage, expiry, renewal, revocation**: `data_grants` and `data_grant_codes` (regional); the grant cookie holds sealed claims (grant, artifact, visitor ID, 60-second claims, the grant's expiry, at most 30 days and never past the app session); renewal every 60 seconds checks the grant, the app session and the account's terms version, and writes need the current terms (reads, the person's own deletes and export do not; finding 22). Revocation from the dashboard, the viewer or sign-out applies within 60 seconds, live connections included.

**The ID** (finding 24): random, claimed in the journal, reused by later grants for the same person and artifact. It promises that Portifact never gives a page or an owner an account ID or email through this feature and that two artifacts get unrelated IDs; it does not stop an owner from correlating people through names, content, timing or a restricted artifact's access log. Cookie sealing keys are versioned and rotated (spike).

**Anonymous writers** (decision 21): the same control with the human check on the app and a per-IP issue limit; offered in a personal space and in a workspace with `policies` whose policy allows it; elsewhere `dataWriters: "anyone"` answers `plan_required`, and a workspace that loses `policies` falls back to signed-in writers at its next epoch.

Every grant flow is a browser test in Chromium, Firefox and WebKit with third-party cookies blocked before release; the spike cannot run a browser.

## Requests from the page

All on the artifact's own origin (and its custom domain), reserved under `/__portifact/data/`, routed before the `GET`/`HEAD` check, after the API gate, the artifact lookup, the servable check, the reading session, the grant claims, the network policy, the traffic quota and budget protection; then the envelope and the object. Requests are charged to traffic through the per-isolate meter (no D1 write per request). Routes: `me`, queries and gets under `c/<collection>`, `POST`/`PUT`/`DELETE` under `c/…`, `mine` (the grant holder's own documents), `live` and `live/renew`, `grant/begin` and `grant`, and the client script `data.js`. Rendered Markdown and text documents run no scripts and are out of scope.

## The document model

The owner side declares collections with a mode (`own` default, `append`, `read`, `shared`), an optional unique key and up to the plan's indexed fields. Server fields: `_id`, `_by` (the grant session that created it: attribution, not proof), `_editedBy`, `_created`, `_updated`, `_seq` (scoped to the author in `own`, to the collection elsewhere). The unique key is a scalar, required, recomputed on replacement. Queries come only in seek-bounded shapes with their index named (spike: at most 116 rows read for a page of 100 and 15 to 24 for an empty or sparse match at 100,000 documents). `deleteScope` lets the owner side delete anything, a visitor always delete what they created, and any writer delete in `shared` mode.

## Owner SQL in the sandbox (findings 1, 6, 7, 9)

One statement per call: the shape allowlist (reads `SELECT`; writes `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `CREATE VIEW`, `DROP TABLE|INDEX|VIEW`, `ALTER TABLE`; no `WITH`, recursion, triggers, virtual tables, temporary objects, pragmas or transactions); the opcode allowlist over SQLite's own program, fail closed; `INSERT … SELECT` reads one table; at most 4 indexes; reads in a transaction that is always rolled back; every execution charged before and after; growth past the sandbox's own cap refused, cleanup allowed. Results: one typed form per value, the whole serialized response measured in UTF-8 including column names, `truncated: true` whenever anything was cut or replaced, and `inexact: true` with `{ $inexact }` for an integer past 2^53, which the SQL API has already rounded: the answer advises `CAST(column AS TEXT)` (spike: finding 9). Replays and audit as above. Owner SQL is idempotent by operation ID (spike: finding 1).

## Copies (decision 32; finding 11)

`POST …/data/copies` starts a copy job `{ copyId, collection, table, sourceGeneration, sourceRevision }`; the job reads pages of the documents object's export (primary key order, the cursor in the job) and sends each to the sandbox's `importCopy` with its page number. The sandbox checks the page inside (at most 500 rows and 1 MiB), acknowledges a page it already received from its receipt without writing (spike: finding 11), charges the work it measured to the SQL pools, raises the payload revision and writes an audit obligation. The catalog records the job's source generation and revision and its pages; the documents it reports are counted from the table when asked, so they stay right after retries and after owner SQL changes the table. A job whose source generation is gone stops; a transfer fences both objects, and a job carrying the old owner's envelope is refused.

## Exports (decision 30; finding 20)

Two forms, never mixed. Interactive results are cut at their caps (above). Export is a separate, lossless, streamed format: the documents object's pages in primary key order (documents are JSON already), and the sandbox's tables through statements the server builds from each table's own columns, returning every value's SQLite type and exact text (`typeof`, `CAST(… AS TEXT)` for integers, `hex` for blobs, the shortest round-trip text for reals), in `rowid` order with a cursor (spike: "exports every SQLite type exactly": 9223372036854775807 and a 70,000-byte blob come back exact). A manifest names the format and version, both objects' generations and revisions at the start, the schema and the copies; a final line gives both revisions at the end and `consistent` when neither changed. Export pages are charged to the export allowance.

## Live updates (decision 29; findings 8, 16)

A connection holds in its attachment the author, the principal that opened it (the grant, link or read session), an absolute deadline, its per-minute counters and the plan's daily bytes. The object checks the deadline before every send and every message it processes and keeps one alarm at the earliest deadline (no timers). `renew(envelope, socketId, principal, deadline)` requires the same principal (another credential holding the socket ID is refused), sets the deadline (it may shorten; a past deadline closes the connection) and passes the validator (spike: finding 8). Every message is reserved in UTF-8 bytes before it is sent, acknowledgements included, against the connection's minute (closed `4009` past it), the artifact's day and, for fan-out, the owner's leased bytes (closed `4029` past either); a replay never notifies (spike: finding 16 and "counts what is sent in UTF-8 bytes"). Holds, transfers, quarantine and erasure close connections at their fence.

## Storage accounting (decision 33; finding 13)

Every answer, refusals included, carries `{ generation, seq, bytes }`; `seq` rises with every transaction that may change storage (spike: finding 13). The calling Worker keeps the newest report per object (`newerReport`: later generation, or same and later sequence) and writes it every 5 seconds into `artifact_data` (`documents_bytes`, `sandbox_bytes`); the artifact's data is their explicit sum, and the owner's usage is the sum over its artifacts. Each object enforces its own cap (`bytesPerArtifact` for documents, `sandboxBytes` for the sandbox); control records (counters, leases, operation records, barriers, obligations) are bounded by their pruning and are counted in the reported bytes but not against the caps, with a reserve of 256 KiB per object above the caps. The overshoot of the owner's total within the report lag is at most one day of writes per artifact (the daily allowances), not an average.

## Lifecycle

Publish and rollback never touch the objects. Archive and suspension raise the epoch; the page gets nothing; the owner side reads, exports and erases. A legal hold is a fence on both objects; only the operator exports (`data-export`, to the region's bucket); erasures wait. A transfer (same region) fences both objects to the new owner, drops leases, keeps visitor IDs and moves the data; the Privacy Policy and the grant control say so. Purge and account or workspace deletion run the two-step erase on both objects; account deletion runs author erasure for the account's journal entries. The object inventory and the author journal are in R2. No point-in-time recovery for owners. Plan grace deletes nothing; the new limits refuse new work only.

## Interfaces, scopes and parity (finding 23)

New scopes `data:read` and `data:write`, a role action `data` (admins and editors, in `TOKEN_ACTIONS`); existing tokens gain nothing until an admin grants the scopes. The operations (describe, collections, documents, SQL read and write, copies, export, erase an author or all, data writers) have one service each with API, MCP and CLI parity, the terms classification, `confirm` on destructive tools and untrusted-data notes, as the second version listed.

## Moderation and law

The owner is the controller of what visitors write, Portifact the processor; the Terms give Portifact the standing instruction to erase on account deletion the documents the account created and to let a grant holder delete and export their own. Not covered: owner-made copies, later edits by others in `shared` collections, anything exported elsewhere; the rights request page (session only) lists the artifacts the journal names and notifies their admins. Reports name a collection, a document and its revision; `_by` is never alone evidence against a visitor. Legal texts need a new `TERMS_VERSION`: the Terms' "runs no … databases" sentence, a Privacy Policy category (visitor data, IDs, grants, the journal, location, transfer), the Data Processing Addendum (the category, Annex III, the instruction) and the Acceptable Use Policy (no credentials or payment data, no file hosting or relays, no cross-site tracking, no command channels).

## Switches

| Switch                     | Off means                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARTIFACT_DATA_ENABLED`    | Page data paths answer `404`; owner routes answer `404` except export and erasure; jobs (fences, erasure, audit relay, reconciliation, pruning) always run. |
| `DATA_PAGE_WRITES_ENABLED` | Page writes `503`; reads, the grant holder's deletes and exports work; no new writing grants.                                                               |
| `DATA_LIVE_ENABLED`        | New connections refused; open ones closed by a job within a minute and by their deadline within 60 seconds.                                                 |
| `DATA_SQL_ENABLED`         | SQL and copies `503`; the sandbox stays, is exported and erased. Documents and live updates do not depend on it.                                            |
| `DATA_ANONYMOUS_ENABLED`   | No new anonymous grants; existing ones stop renewing within 60 seconds.                                                                                     |

## Threat model

| Attacker                                     | Tries                                               | What stops it                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A visitor                                    | Another visitor's `own` documents                   | The author bound in every statement; `own` queries cannot name an author.                                                            |
| A visitor                                    | Reuse another visitor's operation ID                | Records are keyed by actor; a reuse is another key (finding 1).                                                                      |
| A visitor                                    | Spend the artifact or the owner                     | Rates, the artifact's day, the owner's pools, all charged before work and kept on refusal.                                           |
| A visitor                                    | Write after their account was deleted               | The author barrier (finding 6).                                                                                                      |
| A page without a grant                       | Learn who is there or write as them                 | `me` is `granted: false` for everyone; no session authorizes writes.                                                                 |
| A sibling artifact                           | Plant its identity (fixation) or call the API       | Codes bound to the beginning browser's nonce; same-origin API gate; separate start and redeem gates.                                 |
| A page holding a socket ID                   | Extend someone's connection with another credential | Renewal requires the same principal (finding 8).                                                                                     |
| The owner                                    | Write unbounded rows with SQL                       | One-table inserts, 4 indexes, the sandbox cap, measured charges kept on failure, debt in the ledger outside the sandbox (finding 7). |
| The owner                                    | Clear a debt by erasing the sandbox                 | The ledger is per owner, outside both objects.                                                                                       |
| The owner                                    | Spend the visitors' allowance with SQL              | Separate SQL pools (finding 12).                                                                                                     |
| The owner                                    | Read through the read call or recurse               | Rollback, allowlists, no `WITH`.                                                                                                     |
| A former owner after a transfer or a restore | Act on the new owner's data                         | The owner is in the envelope and the control record; reconciliation quarantines instead of raising (finding 4).                      |
| A late erase or fence                        | Delete new data or move an object back              | Generations, epochs, one validator, atomic commit (findings 2, 3).                                                                   |
| A D1 restore                                 | Lose erasures, revive grants or ownership           | R2 journal and inventory, control records, window tombstones for revocations, quarantine.                                            |
| A service token                              | Read visitor data                                   | New scopes granted per token.                                                                                                        |
| An agent acting on untrusted text            | Erase or widen                                      | `confirm`, ask-first descriptions, untrusted-data notes.                                                                             |

## Deliveries (decision 37; finding 21)

| #   | Delivery                                                                                                                                                                                                                                                                                                                            | Needs                                   | Acceptance                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This record and the security section                                                                                                                                                                                                                                                                                                |                                         | Review.                                                                                                                                                                                      |
| 2   | **Shared contracts**: the envelope, control record and validator, fences, two-step erase, quarantine and reconciliation, operation records and replay, `settle`, the storage report, the ledger with pools and debt, the copy job and export formats (types only), all in packages with unit and property tests; no object deployed | 1                                       | Property tests of `admit`, `applyFence`, `reconcile`, `newerReport` and the ledger; the formats' round trips.                                                                                |
| 3   | **Documents object** without routes: collections, documents, queries, budgets, author barrier and chunks, the R2 journal and inventory, purge, account and workspace deletion jobs, holds and transfers as barriers, reconciliation after restore                                                                                   | 2                                       | Workerd tests of every case of this record for the documents object; a restore drill on staging; nothing reachable by users.                                                                 |
| 4   | **Owner document API**: services, API, MCP, CLI, scopes, the token scope control, audit relay, document export, the dashboard's read-only Data section                                                                                                                                                                              | 3                                       | Parity, audit coverage, terms classification, export round trip of documents, accessibility.                                                                                                 |
| 5   | **Grants and page reads and writes**: the gates, the three flows, the control, "Data you shared", rights requests, the content Worker's routes, the client script, `DATA_PAGE_WRITES_ENABLED`                                                                                                                                       | 4                                       | Browser tests of every flow in three engines with third-party cookies blocked; fixation refused; revocation within 60 seconds.                                                               |
| 6   | **Live updates**, `DATA_LIVE_ENABLED`                                                                                                                                                                                                                                                                                               | 5                                       | Principal-bound renewal, byte reservations, deadlines across hibernation; staging: zero active time when idle.                                                                               |
| 7   | **Sandbox and owner SQL**: `portifact-sql`, allowlists, the in-flight marker and debt, copies, sandbox export, `DATA_SQL_ENABLED`                                                                                                                                                                                                   | 2, 3 (copies need the documents export) | The spike's SQL tests in the product; staging: a statement past `cpu_ms` (is it stopped, what do queued requests and sockets see, is the marker charged), isolate sharing between sandboxes. |
| 8   | **Combined budgets and protection**: budget protection's steps, the collector's metrics, the hostile-owner and hostile-visitor load on staging across documents, live and SQL                                                                                                                                                       | 6, 7                                    | Measured spend within the ceiling table for the chosen option; measured active time written here.                                                                                            |
| 9   | Anonymous writers, `read` and `shared` from the page, the workspace policy                                                                                                                                                                                                                                                          | 5                                       | Policy and limit tests; browser test of the anonymous flow.                                                                                                                                  |
| 10  | Legal texts, `TERMS_VERSION`, release checks, switches on                                                                                                                                                                                                                                                                           | 4 to 8 (9 if anonymous ships at launch) | The legal checklist; every staging check here done and recorded.                                                                                                                             |

Documents and live updates (deliveries 3 to 6) do not depend on SQL (7), so they could be switched on first if SQL took longer; decision 15 switches everything on together after 8 and 10.

**Estimate**, for one engineer with review, after this redesign: contracts 8 to 12 working days, documents object 12 to 16, owner API 8 to 10, grants and page 12 to 16, live 6 to 8, sandbox and SQL 10 to 14, combined budgets and staging load 6 to 10, legal texts and release 5 to 8: **67 to 94 working days** (about 14 to 19 weeks) for the first release, plus 5 to 7 for anonymous writing. Most uncertain: what the CPU limit does to a sandbox statement and its object (it decides `R_max` and whether the in-flight marker is enough), the browser flows of the grant (the fallback's behavior in WebKit), and the restore drill across two objects.

## Claims and evidence (decision 36; finding 20)

| Claim                                                                                                      | Spike test                                                       | Only a browser or a deployment can show                            |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| One class reached from two Workers                                                                         | `two-workers`                                                    | `script_name` across five deployed Workers                         |
| `own` isolation by ID, filter, cursor                                                                      | `documents`                                                      |                                                                    |
| Operation IDs scoped to the actor, no body in replays, no second allowance, conflicts, pruning             | `review-findings-2` (1, 5), `fencing`                            |                                                                    |
| One validator for every command, fences persisted on empty objects                                         | `review-findings-2` (2), `fencing`                               |                                                                    |
| Prepare adopts the epoch; commit atomic; control kept; one-of-two recovery                                 | `review-findings-2` (3), `fencing`                               | A crash between two objects in production                          |
| Restore: a former owner refused, quarantine                                                                | `fencing` (restore)                                              | A real D1 Time Travel restore with objects                         |
| Author barrier, bounded chunks, one identity under racing grants                                           | `review-findings-2` (6, 17), `fencing`                           | R2 conditional writes under real concurrency                       |
| Measured SQL work charged on failure; debt blocks SQL; debt survives erasure; abandoned statements charged | `review-findings-2` (7), `ceiling`                               | Whether `cpu_ms` stops a statement and the marker is then charged  |
| Write bound by shape (one source table, 4 indexes)                                                         | `ceiling`                                                        |                                                                    |
| Read bound by the CPU limit (`R_max`)                                                                      | `expensive` (local timing)                                       | Yes: the CPU limit itself                                          |
| SQL cannot spend the visitors' pools; leases follow the owner                                              | `review-findings-2` (12), `ceiling`                              |                                                                    |
| Cleanup and export allowances; visitor deletes own                                                         | `review-findings-2` (10), `ceiling`                              |                                                                    |
| Copy pages bounded, receipts idempotent, catalog right                                                     | `review-findings-2` (11), `edges-2`                              |                                                                    |
| Storage reports with a sequence, refusals included                                                         | `review-findings-2` (13), `fencing`                              | The collector's real figures                                       |
| Audit obligations, `settle` aborts, obligations survive erasure                                            | `review-findings-2` (14), `fencing`                              | The relay and sweep in production                                  |
| Start and redeem gates; atomic code redemption                                                             | `review-findings-2` (15, 16), `edges-2`, `grants`                | Every grant flow in three engines with third-party cookies blocked |
| UTF-8 byte reservation, daily caps, no double notify; principal-bound renewal                              | `review-findings-2` (8, 16), `ceiling`, `live`                   | Hibernation across real idle periods; alarms running late          |
| Inexact values flagged, whole response counted, lossless export                                            | `review-findings-2` (9), `rules`, `fencing` (export)             |                                                                    |
| Bounded query shapes                                                                                       | `queries`                                                        |                                                                    |
| `/me` before consent, the grant's D1 rows, scope upgrades, the R2 inventory sweep                          | none (design)                                                    | Delivery tests                                                     |
| Jurisdictions                                                                                              | none: "Jurisdiction restrictions are not implemented in workerd" | Staging                                                            |
| Real billing                                                                                               | none                                                             | Staging and the first invoices                                     |

## Review findings

### First review (27 findings)

Answered in the second version and kept here; the second review rechecked them. The answers to 1, 2, 4, 6, 7, 10, 11, 12, 13, 15, 16 and 27 are spike tests (`review-findings.test.ts`, failing at `af82ab12` and passing since); 3, 5, 8, 9, 14, 17, 18 to 26 are answered in the sections above (the grant, the journal and barriers, live deadlines, storage reports, the deletion boundary, `_by`, exports, audit, the terms, scopes, the ID, costs, deliveries).

### Second review (21 findings)

| #   | Finding                                                                                                                    | Answer                                                                                                                          | Spike                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Operation IDs disclosed another writer's document; SQL not idempotent; retries needed a second allowance                   | Records keyed by actor and generation, bound to a request hash, checked before any charge, authorization rechecked, no body     | Reproduced, now passes                                             |
| 2   | Holds did not fence empty objects; the sandbox's erase ignored holds and artifacts; commit and cancel skipped the envelope | Fences persisted on empty objects; one validator for every step; two-step erase in the sandbox                                  | Reproduced, now passes                                             |
| 3   | Prepare did not adopt the epoch; erase deleted the fence                                                                   | Prepare adopts; commit deletes the payload and writes the next generation in one transaction, control kept; one-of-two recovery | Reproduced, now passes                                             |
| 4   | Restore reconciliation could bless a former owner                                                                          | Owner in the envelope and control record; reconcile from objects; quarantine                                                    | Reproduced, now passes                                             |
| 5   | Replays returned erased bodies; no pruning                                                                                 | No bodies in records; pruning; author erasure deletes records                                                                   | Reproduced, now passes                                             |
| 6   | Late writes after author erasure; racing first grants                                                                      | Barrier before deletion; conditional journal claim                                                                              | Reproduced, now passes                                             |
| 7   | Budgets kept estimates, not measured work; no ceiling                                                                      | Measured work kept on failure; debt in the ledger; shape-bounded writes; CPU-bounded reads; the formula                         | Reproduced, now passes                                             |
| 8   | Renewal not bound to the principal                                                                                         | Principal in the attachment; renewal can shorten                                                                                | Reproduced, now passes                                             |
| 9   | Silent integer corruption; lossy export; uncounted column names                                                            | `$inexact` and `inexact`; whole response counted; lossless export format                                                        | Reproduced, now passes                                             |
| 10  | Cleanup and own deletes refused                                                                                            | Cleanup and export allowances; `deleteScope`                                                                                    | Reproduced, now passes                                             |
| 11  | Copies unbounded, catalog wrong after retries                                                                              | Copy jobs with receipts, limits inside, counted catalog                                                                         | Reproduced, now passes                                             |
| 12  | Leases survived transfers; SQL could stop visitors                                                                         | Leases bound to owner and epoch; separate SQL pools                                                                             | Reproduced, now passes                                             |
| 13  | Storage growth outside the revision; no two-object sum                                                                     | Storage sequence on every change and refusal; explicit sum; control reserve                                                     | Reproduced, now passes                                             |
| 14  | Audit obligations missing and lost                                                                                         | Obligations for copies and erasure; `settle`; obligations survive erasure; sweep from the inventory                             | Reproduced, now passes                                             |
| 15  | One gate for start and redeem; broken fallback; double redemption                                                          | Two gates; top-level tab fallback per decision 0002; atomic codes; browser tests required                                       | Reproduced, now passes (gates, atomicity); flows are browser tests |
| 16  | Live bytes not reserved, not UTF-8, not daily                                                                              | Reservation before sending, UTF-8, artifact and owner limits, no double notify                                                  | Reproduced, now passes                                             |
| 17  | Author erasure bounded by deleted rows, not work                                                                           | Author-first indexes, bounded per call                                                                                          | Reproduced, now passes                                             |
| 18  | Cost table contradicted its assumptions                                                                                    | Two models, 31 days, billing blocks, all added work                                                                             | Calculation in "Cost model"                                        |
| 19  | Options' worst month and seat coverage did not follow                                                                      | Recomputed with requests per seat and storage; B recommended                                                                    | Calculation in "Cost model"                                        |
| 20  | Tests narrower than claims                                                                                                 | "Claims and evidence"                                                                                                           |                                                                    |
| 21  | Estimate optimistic; acceptance dependencies wrong                                                                         | Contracts first; acceptance on true dependencies; 67 to 94 days                                                                 |                                                                    |

Each reproduced finding is a test in `review-findings-2.test.ts`; commit `b0f6234b` adds them alone against `f63e150a`, where all 23 fail; they pass on this version.

## Alternatives rejected

| Option                                                   | Why not                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| One object with a SQL allowlist                          | Its safety rests on the classifier forever; an expensive statement holds the visitors. |
| Capping a statement's writes with `max_page_count`       | Refused in Durable Objects (measured).                                                 |
| Accounting after an unbounded statement as the ceiling   | Not a maximum; replaced by shape bounds, the CPU limit and debt.                       |
| Debt kept in the sandbox                                 | Erasing the sandbox would clear it.                                                    |
| Identity from review or read sessions                    | They can be planted; no consent.                                                       |
| Inferring an aborted operation from a missing obligation | A call still in flight would commit after; `settle` aborts explicitly.                 |

## Open questions for the maintainer

### The plan limits (open)

The numbers are set so a plan's price covers its hostile owner's worst month: rows bound spend, size alone does not (a small artifact can be rewritten all day). The options, with what each costs under hostile use (31 days, nothing included) and typical use (100,000 artifacts):

|                                                          | A                                                                | **B (recommended)**                        | C                               |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ | ------------------------------- |
| Free: data artifacts, documents cap, sandbox cap         | 3, 10 MB, 1 MB                                                   | 1, 5 MB, 256 KB                            | 10, 25 MB, 5 MB                 |
| Free: owner documents written / read a day               | 30,000 / 3 M                                                     | 5,000 / 500,000                            | 100,000 / 10 M                  |
| Free: owner SQL written / read a day                     | 10,000 / 30 M                                                    | 2,000 / 5 M                                | 50,000 / 100 M                  |
| Pro: data artifacts, documents, sandbox                  | 20, 100 MB, 10 MB                                                | 10, 50 MB, 512 KB                          | 50, 250 MB, 25 MB               |
| Pro: documents written / read, SQL written / read a day  | 60,000 / 10 M, 30,000 / 100 M                                    | 15,000 / 3 M, 5,000 / 10 M                 | 200,000 / 30 M, 100,000 / 300 M |
| Team (per owner): data artifacts, documents, sandbox     | 100, 500 MB, 50 MB                                               | 50, 250 MB, 5 MB                           | 200, 1 GB, 100 MB               |
| Team: documents written / read, SQL written / read a day | 300,000 / 50 M, 150,000 / 500 M                                  | 75,000 / 15 M, 25,000 / 50 M               | 1 M / 100 M, 500,000 / 1 B      |
| Hostile month: Free / Pro / Team at 1 seat               | US$3.01 / 12.04 / 67                                             | US$0.76 / 1.82 / 10.78                     | US$10.84 / 35.10 / 175          |
| Covered by the price                                     | Pro no; Team from 14 seats                                       | Pro yes; Team from 3 seats                 | Pro no; Team from 36 seats      |
| Typical use at 100,000 artifacts                         | US$219 to 287 under every option: typical use is below every cap |                                            |                                 |
| What users feel                                          | A busy board on Free                                             | One small app on Free; a team board on Pro | Most hobby apps on Free         |

**Recommendation: B for the first release**, as the second review advised: it is the only option whose prices cover their hostile owner, it keeps owner SQL and live updates in every plan, and its numbers can rise after staging measures active time and real use. Team should be sold at three seats or more, or Team's data limits scaled per seat.

### Engineering choices the record follows

1. **Per-caller read rates in memory**: they shape traffic; the spend is durable.
2. **The top-level tab** as the grant fallback, as review does today.
3. **No `WITH` and no table-valued functions** in owner SQL in the first release.
4. **`cpu_ms: 1000`** for `portifact-sql` and `R_max = 50 million rows`, to be replaced by staging's measurements in delivery 7.
5. **Write cost levers** (fewer counter rows per write, batched live counters) are left for after measurement; they are the main lever on the 100,000-artifact cost.
