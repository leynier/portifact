# 0026 Artifact data: a document database per artifact

- Status: proposed, fourth version. Design only: nothing is built, and `spikes/artifact-data` proves what "Claims and evidence" lists. Versions one (commit `3e601727`), two (`ee9ebb6e`) and three (`c5b84930`) each received an adversarial review that asked for a redesign; "Review findings" maps every finding of the third to its answer, and the first two remain answered as their tables in the earlier versions say. After the third review the maintainer removed owner SQL from the feature (decision 38): this version is one object per artifact with the document API only. The product decisions are the maintainer's ([issue #194](https://github.com/leynier/portifact/issues/194) and their answers to the reviews). Only the plan limits remain open.
- Date: 2026-11-12
- Feature: issue #194, "give each artifact its own database". Not a premium plan feature: every plan gets it, with limits per plan.

## Question

An artifact is a static site today. The maintainer wants it to be able to be a small app: its JavaScript, running in a visitor's browser, stores and reads data that outlives the visit (forms, votes, lists, boards), and the owner and their agents read and manage the same data through the API, the MCP server and the CLI. How can Portifact give each artifact a database without letting a visitor reach another visitor's data, letting a page act as a person without their consent, letting one artifact reach another's, letting a hostile owner or visitor spend Portifact's budget without a bound, or breaking any rule the platform already keeps (regions, deletion, restore, holds, quotas, the three interfaces' parity)?

## Decisions taken by the maintainer

The numbering continues the earlier versions', so the reviews' references stay valid. Decisions marked superseded are kept for the history.

From the issue:

1. **Engine.** Real SQLite in Cloudflare Durable Objects with the SQLite storage backend, in the jurisdiction of the owner's region.
2. **One door.** The page and the owner side both use a document API; nobody sends SQL. (The issue's owner SQL is superseded by 38.)
3. **Identity.** The page learns an opaque per-artifact ID and the display name, never the email (narrowed by 17).
4. **Who writes from the page.** The owner decides per artifact; by default signed-in visitors who can open it; anonymous writers on public artifacts only when the owner opens them, with per-IP limits and the human check; share link visitors read only.
5. **Live updates** over WebSockets from the first release.
6. **Plans.** Free with a small quota, more on paid plans, under the budget target (US$50 a month as an objective, protection from US$100).
7. **Lifecycle.** The data belongs to the artifact, not a version: publish and rollback do not touch it; it stays while archived, counts in storage, and goes at purge and account or workspace deletion.

From the first review: 9 (spending bounded by work, durably, per artifact and per owner, attempts and refusals included, bounded query shapes, nothing keeps an object awake), 10 (no identity and no attributed write without consent on the trusted origin), 11 (lifecycle fenced: operation IDs, a data generation and an epoch in one envelope, holds and transfers as acknowledged barriers, erasure that survives a D1 restore, socket deadlines), 12 (the smaller defects fixed), 13 (service tokens gain nothing; account deletion erases the account's documents; transfers move data; 60-second live bound; a workspace policy can forbid anonymous writing; no point-in-time recovery for owners; `_by` is session attribution), 14 (small disabled deliveries, each with its switch). Decision 8 (two databases) is superseded by 38.

From the answers to the second version: 17 (consent before identity), 18 (account deletion erases the documents the account created; later edits by others to a shared document go with that document, and the record says how a person asks about the rest), 19 (transfers move the data), 20 (service tokens need a new scope), 21 (anonymous writing only where the owner decides alone or a workspace policy controls it), 22 (plan limits open). Decisions 15 (one release including owner SQL) and 16 (a SQL copy of a collection) are superseded by 38; the one-release rule stands for what remains: documents, the owner API and live updates are switched on together.

From the second review: 23 (operation IDs scoped to the actor, generation and request hash; authorization before any replay; no bodies; pruning), 24 (fences persisted before acknowledgement, on empty objects too; one validator; atomic erase commit), 25 (restore reconciled from the object's control record; quarantine), 26 (author barrier before deletion; late writes refused; one identity under racing grants), 28 (two cost models), 29 (live renewal bound to the principal; UTF-8 byte reservations for every message), 31 (cleanup always works), 33 (storage accounting), 34 (durable audit states), 35 (the grant flow), 36 (claims table), 37 (deliveries; the SQL parts superseded). Decisions 27 (a SQL ceiling with debt), 30's SQL export and 32 (copies) are superseded by 38.

From the third review and the maintainer's answer to it:

38. **No owner SQL.** The artifact database is document-based only, for the page and for the owner side. Three design rounds could not make server-side owner SQL both safe to erase and bounded in cost; the documents side converged. Owner SQL is in "Alternatives rejected" and can be reopened later with its own record.
39. **Every await is a fault point.** Control, authorization and the operation's state are checked again in the transaction that reads or writes, after every await; fault-schedule tests inject a hold, a transfer and a duplicate delivery at each await.
40. **Empty objects keep barriers.** An erase, an author erasure or a fence on an object with no data writes its control record; fences check the generation and the transition's identity; every maintenance entry point has an admission mode.
41. **Author erasure is terminal.** Empty objects included; the journal keeps a retired entry so the person never gets a fresh identity; live connections and sequences go at the barrier; the rule for shared edits is decided and tested.
42. **Every execution path is charged** at an upper bound before it runs, maintenance and cleanup included, inside the owner's ceiling.
43. **The export** is exact, stable and byte-bounded, and stable enough to load into a local SQLite database (see "Later").
44. **The cost model** separates amortized use from account-level billing blocks, lists every billable path, and claims coverage only where enforcement and cost agree.

Alternatives rejected by the issue (Turso Cloud, Turso's engine in Workers, D1 per artifact, shared tables in the regional D1, SQLite in the browser with sync) stay rejected for the reasons it gives.

## Decision in short

- **One object per artifact**, `ArtifactDocuments`, holding the collections and speaking only the document API, to the page through the content Worker and to the owner side through the app Worker. **`OwnerLedger`**, one per owner, holds the owner's daily allowances as balances.
- **A control record** in the object: artifact, region, owner, owner epoch, generation, epoch, an independent hold, a quarantine, a pending erase, the last transition with its ID, a storage sequence and a payload revision. One validator, `admit`, with four modes, decides every command.
- **Three phases per command**: awaits (hashing, leases), then one transaction that admits, answers a replay and charges an upper bound, then one transaction that admits again, checks the operation and authorization again and does the work. Nothing decides before the second phase.
- **Operation records** keyed by actor, generation and operation ID, bound to a hash of the request, holding no body; audit obligations under the same key.
- **Budgets in owner pools** (documents read and written, cleanup, export, live bytes) and the artifact's own day, charged at upper bounds before any work, refusals kept.
- **Erasure** in two steps for the whole data, and per author behind a barrier in bounded, replayable chunks; the author journal and the object inventory in R2.
- **A grant on the app origin** before any identity.
- Shipped off behind four switches; eight deliveries with the feasibility experiments first; option B recommended as the smallest exposure, with Pro's coverage conditional on staging's measurements.

## Facts checked

Cloudflare's documentation, read on 2026-11-12 ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)):

- **Durable Objects on Workers Paid.** Requests: 1 million a month included, then US$0.15 per million; RPC calls count as requests; incoming WebSocket messages count 1 in 20, outgoing are free. Duration: 400,000 GB-s included, then US$12.50 per million GB-s, active wall time at 128 MB; an idle object eligible for hibernation is not billed (pending timers, unfinished work or the standard WebSocket API make it ineligible; a stored alarm does not). SQLite: 25 billion rows read and 50 million rows written included, then US$0.001 and US$1.00 per million; 5 GB-month stored included, then US$0.20 per GB-month; key-value calls, deletes and `setAlarm` bill as storage. Compute overage rounds up to billing units (a million requests, a million GB-s).
- **Workers.** 10 million requests included, then US$0.30 per million; 30 million CPU milliseconds included, then US$0.02 per million; WebSocket messages are not Worker requests.
- **Limits.** 10 GB per object; statements up to 100 KB, 100 parameters; 30 seconds of CPU per request by default, set per Worker with `limits.cpu_ms`; alarms may run late.
- **The SQL API** reports `rowsRead` and `rowsWritten` (the billed values) and hands integers to JavaScript as numbers, so an integer past 2^53 loses precision.
- **Jurisdictions.** `namespace.jurisdiction("eu")` keeps objects in the EU.
- **A Durable Object's execution** is single-threaded, but other events run while a method awaits I/O (the ledger, crypto): a method is not one transaction across its awaits. This is what finding 1 of the third review reproduced, and what decision 39 answers.

Measured in the spike (local workerd): R2's conditional put (`onlyIf: { etagDoesNotMatch: "*" }`) admits one of several concurrent writers; an object with its schema and one collection is 84 KiB, and a 200-byte document adds about 660 bytes.

The code at `develop`: the content Worker exports a SQLite Durable Object already (`TrafficLimiter`) and refuses methods other than `GET` and `HEAD` before routing; public artifacts are served before any session is read; the viewer frames artifacts with a partitioned review session and falls back to a top-level review tab (decision 0002); transfers are refused across regions; the Terms say Portifact "runs no builds, servers or databases for your content"; `PLAN_PRICES` lists Pro at US$2 a month and Team at US$5 a seat; traffic is 1 million requests a month on Free, 2 million on Pro and 3 million a seat on Team.

## One object

`ArtifactDocuments`, named by the artifact ID, in the jurisdiction of the artifact's region, holds every collection of the artifact and its control tables. No SQL from anyone reaches it: the owner side declares collections and fields, and every statement the object runs is written by Portifact. So no owner schema, constraint, trigger or reference exists that could block an erasure or make a statement's cost unbounded.

| Worker                 | Exports                            | Binds                | `limits.cpu_ms` |
| ---------------------- | ---------------------------------- | -------------------- | --------------- |
| `portifact-data` (new) | `ArtifactDocuments`, `OwnerLedger` | itself               | 200 proposed    |
| `portifact-content`    |                                    | `ARTIFACT_DOCUMENTS` | default         |
| `portifact-app`        |                                    | both                 | default         |
| `portifact-jobs`       |                                    | both                 | default         |

The new Worker has no routes, no D1, R2 or queue bindings and no secret; legacy `migrations` with tag `v1` (`new_sqlite_classes`), never `deleted_classes`, `renamed_classes` or `transferred_classes` (a `scripts/` test refuses them). Deploy order: `portifact-data`, then jobs, content and app. `dataNamespaces(env, region)` in `packages/services` is the only place a stub is made (`locationHint: "wnam"` for the default region, `jurisdiction("eu")` for the EU), from the directory's region only. The e2e Worker exports both classes. The 200 ms CPU limit is far above any command's work (the largest is an index build over the plan's documents) and bounds the active time a hostile request can cost.

## The control record and the validator

The object keeps a control record (`spikes/artifact-data/src/envelope.ts`) in `pf_meta`: `artifactId`, `region`, `ownerId`, `ownerEpoch` (the epoch at which the owner took over; leases are bound to it), `generation`, `epoch`, `hold` (the transition that set it, independent of everything else), `quarantine` (reason and time, set only by reconciliation, cleared only by the operator), `erasing` (a prepared erase and its target generation), `last` (the last transition: its ID from D1's batch, kind, epoch, owners before and after, time), `storageSeq` (raised by every transaction that may change storage, refusals and maintenance included) and `payloadRevision` (raised only when documents change). Every command carries an envelope `{ artifactId, region, ownerId, generation, epoch, opId? }` filled by the calling Worker from D1.

**One validator, four modes.** `admit(stored, envelope, mode)`:

| Check, in order            | `request` (page, owner side)                    | `operator`  | `erase` (prepare, commit, cancel) | `maintenance` (settle, acknowledge) |
| -------------------------- | ----------------------------------------------- | ----------- | --------------------------------- | ----------------------------------- |
| No control record          | Admitted; only a first write creates the record | Admitted    | Admitted; prepare creates it      | Admitted                            |
| Another artifact or region | `forbidden`                                     | `forbidden` | `forbidden`                       | `forbidden`                         |
| Quarantined                | `quarantined`                                   | Admitted    | `quarantined`                     | Admitted                            |
| Another owner              | `stale`                                         | `stale`     | `stale`                           | Admitted                            |
| Older epoch                | `stale` (a newer one is adopted)                | `stale`     | `stale`                           | Admitted                            |
| Another generation         | `stale`                                         | `stale`     | Older: done; newer: `stale`       | Admitted (the key names it)         |
| Held                       | `held`                                          | Admitted    | `held`                            | Admitted                            |
| Erasing                    | `stale`                                         | Admitted    | Admitted                          | Admitted                            |

Maintenance is admitted on the artifact alone because its job is to deliver what operations of any generation and owner already committed; the operation key names the actor and generation. Pruning is an internal alarm, not an entry point: it does nothing while held or quarantined.

**Fences.** `fence(envelope, { state, toOwner?, transition })` applies a hold, a release or a transfer. It checks the artifact, region and generation, recognizes a repeat of the same transition by its ID and acknowledges it without change, then requires the current owner and a newer epoch. It is persisted in the object's own transaction before it is acknowledged; on an empty object it creates the control record, so a later stale command is refused. A hold or a transfer cancels a prepared erase; a transfer records the new owner and its epoch and drops the old owner's leases; both close live connections. A quarantine survives every fence. D1's side: the hold or transfer batch raises the epoch in `artifact_data` and writes a `data_fence` job carrying the transition ID; the change is in force when the object acknowledged it (`fenced_epoch`); the operator's `hold-artifact` and `transferArtifact` wait for it.

**Erasing the whole data.** `prepareErase` passes the validator, adopts the epoch it accepts and records `erasing` with its generation; on an empty object it creates the control record first. The job re-reads D1 (a hold may have started), then calls `commitErase` or `cancelErase`. `commitErase` runs one transaction that deletes every payload table (documents, collections, field indexes, sequences, operation records) and writes the next generation into the control record; budgets, leases, barriers and audit obligations stay. A retry finds the next generation and does nothing; on an empty object the control record is the generation barrier, so a stale generation-0 write after it is refused.

**Restore.** A D1 Time Travel restore rewinds D1, not the object. After `apply-tombstones` puts holds and revocations back, `data_reconcile` reads each object's control record (the R2 inventory lists them) and applies `reconcile(row, control)`:

| Field                                                       | Authority after a restore                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact and region                                         | The directory and the inventory; a mismatch goes to the operator                                                                                                            |
| Owner and owner epoch                                       | The object's last verified transfer transition                                                                                                                              |
| Generation and epoch                                        | The object; D1 is raised to them only when owner and hold agree                                                                                                             |
| A pending erase                                             | The object's `erasing` and its target; the job is resumed for that target, never skipped by raising numbers                                                                 |
| A hold                                                      | The object's hold record against D1's re-applied holds; disagreement quarantines                                                                                            |
| A quarantine                                                | The object; only the operator clears it                                                                                                                                     |
| Grants, codes, sessions, memberships, tokens, policies      | D1 plus its non-rewound revocation evidence (window tombstones, including `data_grant` revocations), never the object                                                       |
| Artifacts, grants and codes created after the restore point | Gone from D1. The inventory finds objects with no D1 row; each is quarantined for the operator (erase, or recreate the row). Visitors whose grants were lost consent again. |
| Pending account deletions and author erasures               | Re-derived from the tombstones and the journal's retired entries, never from a rewound outbox                                                                               |

`quarantine` closes connections and refuses all but the operator; the operator exports under it and resolves it with `resolveQuarantine(envelope, "adopt" | "erase")`: `adopt` needs an envelope naming the owner the object recorded and clears the quarantine; `erase` moves to the next generation and clears it in one transaction. A hold is kept through both. A restored former owner is refused at any epoch.

## Every await is a fault point (decision 39)

A command has at most three phases:

1. **Awaits that decide nothing**: hashing the request, leasing owner allowance from the ledger. A lease that returns is installed only if the control record still names the owner and ownership epoch the lease was asked for; otherwise the grant is given back to the ledger once, under its lease ID, and the command answers `stale`.
2. **One transaction** that admits the envelope, looks the operation record up (a replay answers here, before any charge, after the caller's current authorization was checked) and charges the command's upper bound. It commits even when it refuses.
3. **One transaction** that admits the envelope again, looks the operation record up again, checks authorization again and does the work, recording the operation and its audit obligation.

Nothing runs between 2 and 3, and a hold, a transfer or a duplicate that lands during an await is seen by both. The spike holds the ledger at its await and injects them there: a hold or a transfer during the lease of create, replace, declare, get and query, and a duplicate during the lease of create, replace, declare and remove. A hold refuses before any read or write, a transfer refuses without leaking a byte and gives the lease back, a duplicate applies once and the late call replays (`fault-schedules.test.ts`, 14 schedules, and `review-findings-3.test.ts`, 3). The export, bulk delete and count await the same lease path and get their schedules in delivery 4.

## Operation records and replay

Every mutation (document writes, declarations, bulk deletes, author erasure chunks) carries an operation ID. The object records it in the same transaction as the mutation under `actor | generation | opId`, with a SHA-256 of the request, the state (`committed` or `aborted`), the kind, what it named and, for erasure chunks and bulk deletes, the small result (counts). Never a body.

- The same request replays as `{ replayed: { kind, target } }` (a chunk replays its counts); another request under the same key, or an aborted one, is `conflict`. Another actor's reuse of an ID is another key.
- A replay never applies again, never charges again and never notifies live connections.
- **Retention and horizon.** Records are pruned 24 hours after they were written by the object's alarm, at most 500 a pass through an index on their time, oldest first, resuming at the next alarm. So an ID is not applied twice, the Worker stamps every operation ID with its issue time and the object refuses an ID older than 23 hours as `conflict` (expired). Author erasure deletes the author's records with their documents. A held or quarantined object prunes nothing.

## Audit with durable states

An owner-side mutation and every author-erasure chunk write their audit obligation (`pf_audit`) in their own transaction under the operation's full key, the same `actor | generation | opId` as the mutation record and the D1 audit event's uniqueness. Obligations are control data: a whole erase keeps them. The jobs Worker calls `settle(envelope, actor, opId)` (maintenance admission): it answers the committed obligation and whether it was delivered, or a committed operation without one, or records the operation as `aborted` in the same transaction, so a call that arrives later cannot commit. The relay inserts the audit event idempotently on the key and calls `acknowledge`, which marks the obligation delivered; delivered obligations are kept 7 days for late settlement, then pruned. Recovery does not depend on a surviving D1 intent: the daily sweep walks the R2 inventory and asks each object for obligations pending longer than an hour.

## Author erasure (decision 41)

1. **The journal.** Before a grant's code is issued, the app claims `system/data-authors/<user ID>/<artifact ID>` in the artifact's region's bucket with a conditional put: of two racing first grants one writes, the other reads the winner's visitor ID.
2. **Retirement before deletion.** The account deletion job first writes the entry retired (`retiredAt`). A retired entry is never deleted while any grant issued before it could still be redeemed (grants last at most 30 days; the entry is kept 31 days past the account's deletion): a claim that finds it refuses (`RetiredIdentity`), so a first-grant request authorized before the deletion and resumed after it gets no fresh identity. Grant issuance and redemption also check the account in D1, which the deletion removed.
3. **The barrier.** The job calls `eraseAuthorChunk`, whose first chunk writes the author's barrier (`pf_barriers`), on an empty object too (it creates the control record), closes the author's live connections and deletes the author's sequence. From its answer on, every create, replace or connection by that author is refused.
4. **Bounded, replayable chunks.** Each chunk deletes at most 500 of the author's documents through an author-first index, rewrites at most 500 of the author's edits on other people's documents to `_editedBy: "erased"` through an editor index, and deletes at most 500 of the author's operation and rate rows, and answers `more`. A chunk carries an operation ID: a repeated chunk replays its recorded counts instead of erasing more. Chunks are counted against cleanup and never refused for budget.
5. **Shared edits.** A document belongs to its creator. Erasing the creator deletes the document, including later edits others made to it; erasing an editor keeps the creator's document and its current content and replaces the editor's attribution with `erased`. The Privacy Policy, the grant control and the rights request page say so.
6. **Completion** is a chunk answering `more: false`: no document, edit attribution, operation record, rate row, sequence or connection of the author remains; the barrier stays (a few bytes, as long as the object) so a late write is refused forever. A held artifact defers the chunks to the hold's release, as for comments.

## Budgets (decisions 9, 42)

### Pools

| Pool             | Where counted                                                                                | Charged by                                                    | Refusal                        |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| Documents growth | the artifact's day and the owner's `documents_written` (with `documents_read` for its reads) | creates, growing replacements, declarations (index builds)    | `quota_exceeded`               |
| Documents reads  | the artifact's day and the owner's `documents_read`                                          | gets, queries, counts                                         | `quota_exceeded`               |
| Cleanup          | the artifact's daily cleanup and the owner's `cleanup`, never the growth pools               | deletes, shrinking replacements, bulk deletes, erasure chunks | `rate_limited`; erasure never  |
| Export           | the artifact's daily export and the owner's `export`                                         | export pages                                                  | `rate_limited`; operator never |
| Live bytes       | the artifact's day and the owner's `live_bytes`                                              | every message sent, acknowledgements and errors included      | the connection closed `4029`   |
| Rates            | durable rows per author and minute (writes, deletes, connects); reads per caller in memory   | every command; shrinking replacements under the write rate    | `rate_limited`                 |

A spent growth day never stops reading, deleting, shrinking or exporting, and a visitor deletes their own documents without write permission or the current terms. Erasure is counted but never refused.

### How it is charged

- **Before the work, at an upper bound**, in phase 2 (`BOUND` in the spike): a write 40 rows read and 40 written, a page of up to 100 documents 131 read, a get 30, a delete 80 rows of cleanup, a bulk delete 60 plus 10 per document, a count by author the collection's cap, an export page its rows plus 34, a declaration 60 and 60. A declaration that adds an indexed field also reserves one written and one read row per existing document before the index is built, so a build that does not fit is refused before it starts. The measured work stays below every bound (`cost.test.ts`, and the property test checks every successful command of random sequences), so nothing is trued up after and nothing can overdraw: there is no debt.
- **Refusals keep their charge**: the charge transaction commits whatever phase 3 decides.
- **Leases** come from the ledger in chunks (5% of the owner's day, at most 100,000 rows read, 1,000 written or 1 MB of live bytes), are bound to the owner and the ownership epoch, are installed only after the revalidation of phase 1, and are given back once when obsolete. The ledger's balance refills by its daily allowance up to one day's worth; its accounting day only moves forward, so a delayed call carrying an older day refills nothing.
- **Maintenance** (alarms, pruning, settlement) writes a bounded number of rows per pass (500 per table) and is counted in the cost model below as a fixed share of writes.

### What the owner side can do without SQL

The owner side's document API is meant to stand on its own for an agent that manages and inspects an artifact's data:

- **Describe**: collections with their mode, unique key, indexed fields, document count and bytes, and the artifact's day and the owner's balances.
- **Read**: get by ID; query any collection (every author's documents) with one equality on `_by` or an indexed field, ordering by `_created` either way, pages of up to 100 with a cursor, all in the bounded shapes the page uses, against the owner's own `documents_read` allowance.
- **Count**: a collection's documents from its counter (one row), or one author's documents through the author index, charged at the collection's cap; a count by an indexed field's value uses that field's index the same way.
- **Write**: create, replace and delete one document; create or replace up to 100 documents in one operation; delete up to 100 by ID in one operation (`bulkRemove`), each a single operation record and audit obligation.
- **Export**: the whole data, exact, in pages (below).

It deliberately does not do joins, aggregates beyond counts (sums, averages, groups), range filters on arbitrary fields, full-text search or arbitrary sort orders: each would need either SQL or a scan whose cost grows with the data. An agent that needs them exports and analyzes locally ("Later").

### Measured cost per operation (production shape, `cost.test.ts`)

| Operation                                      | Rows read | Rows written |
| ---------------------------------------------- | --------- | ------------ |
| First collection declared (creates the schema) | 46        | 44           |
| Visitor create                                 | 23        | 16           |
| Visitor replace                                | 25        | 12           |
| Visitor delete                                 | 15        | 10           |
| Visitor get / page of 20                       | 16 / 37   | 4 / 4        |
| Owner create (with its audit obligation)       | 21        | 16           |
| Owner count / count by author                  | 15 / 37   | 4 / 5        |
| Owner bulk delete of 10                        | 29        | 19           |
| Owner export page of 100                       | 108       | 2            |
| One live chunk reserved (16 KiB)               |           | 2            |

A write costs 16 rows because it also writes its charge counters, its lease, its rate row, its operation record (with two index entries), its sequence and the control record; giving any of them up would give up replay, fencing or durable budgets.

## Cost model (decision 44)

Prices above, a 31-day month. Two models are kept apart: the **amortized** model charges a hostile owner or a population its proportional share of every meter; the **account-level block** model asks what the next invoice can add at most when the account's included amounts are already spent, which is a property of the whole account, not of any owner.

### Every billable path and what bounds it

| Path                                                          | Meter                           | Bound                                                                                             |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Page data requests, grant flows, renewals every 60 seconds    | Worker and DO requests, CPU     | The owner's monthly traffic quota (data requests are charged to it like static ones)              |
| Owner API, MCP and CLI data calls                             | Worker and DO requests          | The same traffic quota, counted per owner                                                         |
| Live connects                                                 | DO requests                     | Per author per minute, connections per artifact, and the traffic quota (the upgrade is a request) |
| Incoming live messages                                        | DO requests (1 in 20), duration | 4 a minute per connection, connections per artifact                                               |
| Outgoing live messages                                        | none, plus 2 rows per 16 KiB    | The owner's and the artifact's live bytes                                                         |
| Document reads and writes, refusals included                  | rows                            | The owner's pools, charged at upper bounds                                                        |
| Deletes, shrinking replacements, bulk deletes, erasure chunks | rows                            | The owner's cleanup pool (erasure: what exists)                                                   |
| Export pages                                                  | rows                            | The owner's export pool                                                                           |
| Ledger calls                                                  | DO requests, rows               | One per lease chunk: at most 20 a pool a day on Free                                              |
| Alarms (deadlines, pruning)                                   | DO requests, rows               | One per deadline or pruning pass; at most 500 rows per table per pass                             |
| Audit relay (`settle`, `acknowledge`) and the inventory sweep | DO requests, rows               | One pair per owner-side mutation; the sweep once a day per object with pending obligations        |
| Journal and inventory in R2                                   | R2 class A and B                | One write per first grant and per new object; reads by jobs (cents per million)                   |
| Stored data                                                   | storage                         | The artifact's size cap plus the 256 KiB control reserve                                          |
| Active time                                                   | duration                        | `cpu_ms: 200` per request; measured on staging for the typical model                              |

### Typical use (amortized)

The issue's assumptions: 5% of artifacts with data active on a day; each active artifact 150 reads and 50 writes a day and two tabs with a live connection for an hour (120 renewals); 1.1 MB stored per artifact. Per active artifact a day, from the measured rows: 328 DO requests, 322 Worker requests, 1,560 rows written (writes 800, reads' counters 600, pruning 150, live and alarms 10), 6,700 rows read, 2 ms of Worker CPU a request; active time 5 ms or 100 ms a request (staging measures it).

|                         | 1,000 artifacts, allocations available | 1,000, none available | 100,000, allocations available   | 100,000, none available |
| ----------------------- | -------------------------------------- | --------------------- | -------------------------------- | ----------------------- |
| Durable Object requests | 0.5 M: US$0                            | US$0.15               | 50.8 M: US$7.50                  | US$7.65                 |
| Worker requests         | 0.5 M: US$0                            | US$0.30               | 49.9 M: US$12.00                 | US$15.00                |
| Rows written            | 2.4 M: US$0                            | US$2.42               | 242 M: US$191.80                 | US$241.80               |
| Rows read               | 10.4 M: US$0                           | US$0.01               | 1.04 B: US$0                     | US$1.04                 |
| Stored data             | 1.1 GB: US$0                           | US$0.22               | 110 GB: US$21.00                 | US$22.00                |
| Duration                | 318 to 6,355 GB-s: US$0                | US$12.50 (one block)  | US$0 (5 ms) to US$12.50 (100 ms) | US$12.50                |
| Worker CPU              | 1 M ms: US$0                           | US$0.02               | 100 M ms: US$1.40                | US$2.00                 |
| **Total**               | **US$0**                               | **US$15.62**          | **US$233.70 to 246.20**          | **US$301.99**           |

At 1,000 artifacts data fits in the included amounts and costs about US$16 if they are already spent (most of it one duration block). At 100,000 artifacts typical use costs US$234 to 302 a month, five to six times the US$50 objective, four fifths of it rows written. That scale needs revenue from data or a cheaper write; no plan cap changes it, because typical use stays under every option's caps.

### What one hostile owner can make Portifact pay (amortized)

Every pool spent every day, the month's traffic quota spent, every artifact at its size cap and every connection sending its 4 messages a minute; nothing included; rows written are the day's growth and cleanup plus 10% for control rows and the live chunks. Active time is shown at 5 ms (a likely figure) and at 100 ms (half the CPU limit; a request's active time also includes its ledger await, so staging must measure it before either figure is a bound).

| Option and plan        | Rows written | Requests (DO and Worker) | Storage  | Month at 5 ms | Month at 100 ms | Worst hour | Price       |
| ---------------------- | ------------ | ------------------------ | -------- | ------------- | --------------- | ---------- | ----------- |
| A, Free                | US$2.14      | US$0.49                  | US$0.01  | US$2.85       | US$3.80         | US$0.56    | none        |
| A, Pro                 | US$4.47      | US$1.17                  | US$0.40  | US$6.88       | US$12.48        | US$1.33    | US$2        |
| A, Team (one seat)     | US$22.35     | US$4.70                  | US$10.01 | US$42.87      | US$109.58       | US$5.49    | US$5 a seat |
| **B, Free**            | US$0.55      | US$0.46                  | US$0.00  | **US$1.10**   | US$1.51         | US$0.48    | none        |
| **B, Pro**             | US$0.78      | US$1.03                  | US$0.10  | **US$2.24**   | US$5.19         | US$1.06    | US$2        |
| **B, Team (one seat)** | US$5.59      | US$3.02                  | US$2.50  | **US$13.63**  | US$47.20        | US$3.22    | US$5 a seat |
| C, Free                | US$7.20      | US$0.58                  | US$0.05  | US$8.49       | US$11.29        | US$0.83    | none        |
| C, Pro                 | US$14.59     | US$1.57                  | US$2.50  | US$20.70      | US$34.25        | US$2.08    | US$2        |
| C, Team (one seat)     | US$71.98     | US$8.05                  | US$40.01 | US$131.84     | US$264.81       | US$10.52   | US$5 a seat |

The worst hour is one day's rows plus the whole month's requests spent in that hour. Team's traffic quota grows by 3 million requests a seat, so its cost grows with seats too; Team revenue passes its hostile owner's amortized cost from **4 seats on B** (15 at 100 ms), 12 on A (36) and 38 on C (86). Of B Pro's US$2.24, US$0.60 is the Worker requests of the traffic quota that any Pro owner can already spend on static content. So **no option's price is shown to cover its hostile owner**: B Pro is over its price by US$0.24 at 5 ms with the static traffic it already allows counted, and B Team needs four seats; coverage is to be decided after staging measures active time, and the plan limits may need lowering or Pro's price raising then.

A hostile visitor on someone else's artifact is bounded by that artifact's day and by the owner's pools: on B Free at most 5,000 rows written and 500,000 read a day (under US$0.01), after which the artifact's writes stop until UTC midnight (a denial of service for its other writers, which the owner can see and answer by narrowing who writes). Mass abuse across many accounts meets budget protection's `pause_data_writes` and the global admission limit.

### Account-level billing blocks

When the account's included amounts are already spent by the rest of Portifact, a month of hostile use can add at most one more block of each compute meter for the whole account, whatever the number of owners: US$0.15 (DO requests), US$0.30 (Worker requests), US$12.50 (duration) and US$0.02 (CPU), US$12.97 in all. Rows and storage are billed without blocks. This is the figure budget protection must keep room for; it is never charged per owner.

## The grant (decisions 10, 17, 35)

A grant is one person's consent, for one artifact host and one browser, that the page may know them by an opaque per-artifact ID and their display name and save what they enter. Without a grant a page reads what the artifact's access allows and learns nothing about who is there: `GET /__portifact/data/me` answers `{ granted: false }` for everyone. Review, read and link sessions authorize reading only.

**The control** is drawn by Portifact on `app.portifact.com`: the artifact's host and owner, what the page will learn (display name and an ID for this artifact, never the email), that the people who manage the artifact read everything saved there, that the data moves with the artifact if it changes owner, how account deletion treats shared edits, how long the grant lasts, a link to the rights request page; "Allow" and "Not now".

**Two gates**: `beginGate` admits `GET /__portifact/data/grant/begin` only as a top-level navigation from the artifact's own page (`same-origin`, `document`) or the viewer's navigation of its frame (`cross-site`, `iframe`); `redeemGate` admits `GET /__portifact/data/grant?code=…` only as a `cross-site` navigation from the app (`document` or `iframe`). A sibling's `same-site` navigation passes neither. The API gate stays same-origin only.

**Three flows**, one rule: the one-use code redeems only with the transaction cookie of the browser that began, on the host it was issued for.

1. **In the viewer's frame.** The viewer navigates its frame to `begin`; the content Worker sets a sealed, partitioned transaction cookie and answers a Portifact page that posts the nonce's hash to the viewer (exact target origin); on "Allow" the app creates the grant and a code bound to the hash and host; the viewer navigates the frame to `grant?code=…`; the Worker sets a partitioned `__Host-pf_grant`.
2. **The top-level tab** (the fallback, as decision 0002 verified for review): where the partitioned cookie is refused, the viewer offers "Open in a new tab"; the artifact opens top-level on its own origin, where cookies are first-party, and the page's `data.requestGrant()` runs the direct flow there.
3. **On a direct visit** (no bar, a custom host, or the tab above): the page opens `begin` top-level in a popup or the same tab; the popup goes to the app, which shows the control and redirects to `grant?code=…`; the Worker sets `__Host-pf_grant` (`SameSite=Lax`) and returns to the page.

**Atomic codes**: consumed with one guarded D1 update (`used = 0` to `1`, returning the grant). **Storage, expiry, renewal, revocation**: `data_grants` and `data_grant_codes` (regional); the grant cookie holds sealed claims (grant, artifact, visitor ID, 60-second claims, the grant's expiry, at most 30 days and never past the app session); renewal every 60 seconds checks the grant, the app session and the account's terms version, and writes need the current terms (reads, the person's own deletes and export do not). Revocation from the dashboard, the viewer or sign-out applies within 60 seconds, live connections included, and writes a `data_grant` window tombstone. **The ID**: random, claimed in the journal, reused by later grants for the same person and artifact, never revived after retirement; it promises that Portifact never gives a page or an owner an account ID or email through this feature and that two artifacts get unrelated IDs; it does not stop an owner from correlating people through names, content, timing or a restricted artifact's access log. Cookie sealing keys are versioned and rotated.

**Anonymous writers** (decision 21): the same control with the human check and a per-IP issue limit; offered in a personal space and in a workspace with `policies` whose policy allows it; elsewhere `dataWriters: "anyone"` answers `plan_required`, and a workspace that loses `policies` falls back to signed-in writers at its next epoch.

## Requests from the page

All on the artifact's own origin (and its custom domain), reserved under `/__portifact/data/`, routed before the `GET`/`HEAD` check, after the API gate, the artifact lookup, the servable check, the reading session, the grant claims, the network policy, the traffic quota and budget protection; then the envelope and the object. Requests are charged to traffic through the per-isolate meter (no D1 write per request). Routes: `me`, queries and gets under `c/<collection>`, `POST`/`PUT`/`DELETE` under `c/…`, `mine` (the grant holder's own documents and their export), `live` and `live/renew`, `grant/begin` and `grant`, and the client script `data.js`. Rendered Markdown and text documents run no scripts and are out of scope.

## The document model

The owner side declares collections with a mode (`own` default, `append`, `read`, `shared`), an optional unique key and up to the plan's indexed fields. Server fields: `_id`, `_by` (the grant session that created it: attribution, not proof), `_editedBy` (the last editor other than the creator, or `erased`), `_created`, `_updated`, `_seq` (scoped to the author in `own`, to the collection elsewhere). The unique key is a scalar, required, recomputed on replacement. Queries come only in seek-bounded shapes with their index named (spike: at most 116 rows read for a page of 100, and 15 to 24 for an empty or sparse match at 100,000 documents). `deleteScope` lets the owner side delete anything, a visitor always delete what they created, and any writer delete in `shared` mode.

## Export (decision 43)

`exportPage(envelope, context, after, limit)` returns documents in primary key order (collection, ID) after a cursor that is the last row's key, each with its server fields and its body exactly as stored (the stored JSON text, so no number passes through a JavaScript conversion on the server), stopped at 500 rows or 1 MiB of encoded rows, whichever comes first (a single document over the byte cap still makes a page of one). Every page carries the payload revision, which changes only when documents change, so an export whose first and last pages carry the same revision is a consistent snapshot, and a quiet export never moves it. The export is the owner side's (export pool) and the operator's under a hold or quarantine (never refused). A grant holder exports their own documents through `mine`.

The file the CLI and the dashboard write from these pages is JSON Lines: a header line `{ format: "portifact-data", version: 1, artifact, generation, revision, collections: [{ name, mode, uniqueKey, indexed }] }`, one line per document `{ collection, id, by, editedBy, created, updated, body }` with `body` the stored JSON, and a footer line with the revision at the end and `consistent`. The format is stable (versioned, never reordered), typed (server fields have fixed types, bodies are the stored JSON) and complete (every document and every collection's declaration), so it loads into SQLite with one table per collection or one table with `json_extract`.

## Live updates (decisions 5, 29)

A connection holds in its attachment the author, the principal that opened it (the grant, link or read session), an absolute deadline, its per-minute counters, its reserved bytes and the plan's daily bytes. The object checks the deadline before every send and every message it processes and keeps one alarm at the earliest deadline (no timers). `renew(envelope, socketId, principal, deadline)` requires the same principal, sets the deadline (it may shorten; a past one closes the connection) and passes the validator. The connection's owner live bytes are leased before it is accepted. Every message sent, acknowledgements and errors included, spends bytes the connection reserved in 16 KiB chunks against the artifact's day and the owner's lease (two counter rows per chunk, not per message); a refused reservation closes it `4029`, more than 256 KiB in a minute `4009`, more than 4 messages in or 1 KiB a message `4008`. A replay never notifies. Holds, transfers, quarantine, erasure and author erasure close connections at their fence.

## Storage accounting

Every answer, refusals included, carries `{ generation, seq, bytes }`. The calling Worker keeps the newest report per object (`newerReport`: later generation, or same and later sequence) and writes it every 5 seconds into `artifact_data.documents_bytes`; the owner's usage is the sum over its artifacts. The object refuses growth when the documents' own bytes pass the plan's size, or when the database file passes it plus a 256 KiB reserve for control records (counters, leases, operation records, barriers, obligations, each bounded by its retention). The overshoot of the owner's total within the report lag is at most one day of growth per artifact.

## Lifecycle

Publish and rollback never touch the object. Archive and suspension raise the epoch; the page gets nothing; the owner side reads, exports and erases. A legal hold is a fence; only the operator exports (`data-export`, to the region's bucket); erasures and pruning wait. A transfer (same region) fences the object to the new owner, drops leases, keeps visitor IDs and moves the data; the Privacy Policy and the grant control say so. Purge and account or workspace deletion run the two-step erase; account deletion runs author erasure for the account's journal entries. No point-in-time recovery for owners. Plan grace deletes nothing; the new limits refuse new work only.

## Interfaces, scopes and parity

New scopes `data:read` and `data:write`, a role action `data` (admins and editors, in `TOKEN_ACTIONS`); existing tokens gain nothing until an admin grants the scopes. The operations (describe, collections, documents, queries, counts, bulk writes and deletes, export, erase an author or all, data writers) have one service each with API, MCP and CLI parity, the terms classification, `confirm` on destructive tools and untrusted-data notes.

## Moderation and law

The owner is the controller of what visitors write, Portifact the processor; the Terms give Portifact the standing instruction to erase on account deletion the documents the account created (with later edits others made to them) and to let a grant holder delete and export their own. Not covered: the content of edits the account made to other people's shared documents (their attribution becomes `erased`), anything exported elsewhere; the rights request page (session only) lists the artifacts the journal names and notifies their admins. Reports name a collection, a document and its revision; `_by` is never alone evidence against a visitor. Legal texts need a new `TERMS_VERSION`: the Terms' "runs no … databases" sentence, a Privacy Policy category (visitor data, IDs, grants, the journal, location, transfer, the shared-edit rule), the Data Processing Addendum (the category, Annex III, the instruction) and the Acceptable Use Policy (no credentials or payment data, no file hosting or relays, no cross-site tracking, no command channels).

## Switches

| Switch                     | Off means                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARTIFACT_DATA_ENABLED`    | Page data paths answer `404`; owner routes answer `404` except export and erasure; jobs (fences, erasure, audit relay, reconciliation) always run. Nothing creates an object while it is off: export and erasure on a missing object answer empty. |
| `DATA_PAGE_WRITES_ENABLED` | Page writes `503`; reads, the grant holder's deletes and exports work; no new writing grants.                                                                                                                                                      |
| `DATA_LIVE_ENABLED`        | New connections refused; open ones closed by a job within a minute and by their deadline within 60 seconds.                                                                                                                                        |
| `DATA_ANONYMOUS_ENABLED`   | No new anonymous grants; existing ones stop renewing within 60 seconds.                                                                                                                                                                            |

## Threat model

| Attacker                                     | Tries                                               | What stops it                                                                                              |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A visitor                                    | Another visitor's `own` documents                   | The author bound in every statement; `own` queries cannot name an author.                                  |
| A visitor                                    | Reuse another visitor's operation ID                | Records are keyed by actor.                                                                                |
| A visitor                                    | Spend the artifact or the owner                     | Rates, the artifact's day, the owner's pools, all charged at upper bounds before work and kept on refusal. |
| A visitor                                    | Write after their account was deleted               | The author barrier, on empty objects too; the retired journal entry.                                       |
| A page without a grant                       | Learn who is there or write as them                 | `me` is `granted: false` for everyone; no session authorizes writes.                                       |
| A sibling artifact                           | Plant its identity (fixation) or call the API       | Codes bound to the beginning browser's nonce; same-origin API gate; separate start and redeem gates.       |
| A page holding a socket ID                   | Extend someone's connection with another credential | Renewal requires the same principal.                                                                       |
| The owner                                    | Spend without bound                                 | Owner pools for every kind of work, upper-bound charges, the traffic quota, the CPU limit.                 |
| The owner                                    | Block erasure                                       | No owner schema exists; erasure is never refused for budget.                                               |
| A former owner after a transfer or a restore | Act on the new owner's data                         | Owner in the envelope and control record, revalidated after every await; quarantine after a restore.       |
| A late erase, fence or duplicate             | Delete new data, move the object back, apply twice  | Generations, epochs, transition IDs, one validator, operation records rechecked in the final transaction.  |
| A D1 restore                                 | Lose erasures, revive grants or ownership           | R2 journal and inventory, the control record, window tombstones, quarantine.                               |
| A service token                              | Read visitor data                                   | New scopes granted per token.                                                                              |
| An agent acting on untrusted text            | Erase or widen                                      | `confirm`, ask-first descriptions, untrusted-data notes.                                                   |

## Deliveries (decision 14)

The experiments that could invalidate the architecture come first, before any adapter or UI.

| #   | Delivery                                                                                                                                                                                                                                                                                                                                                         | Needs  | Acceptance                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | This record and the security section                                                                                                                                                                                                                                                                                                                             |        | Review.                                                                                                                                                            |
| 2   | **Feasibility experiments** on staging, each a throwaway: the grant handoff (frame, top-level tab, popup) in Chromium, Firefox and WebKit with third-party cookies blocked; a restore drill (D1 Time Travel with live objects, reconciliation, quarantine, operator resolution); active time per command and hibernation across idle periods, with the CPU limit | 1      | Each experiment's result written here; a failure sends the design back before delivery 3.                                                                          |
| 3   | **Shared contracts**: the envelope, control record and validator, fences, two-step erase, quarantine and reconciliation, operation records with the issue-time horizon, `settle`, the storage report, the ledger, the export format, in packages with property tests                                                                                             | 2      | Property tests of `admit`, `applyFence`, `reconcile`, `newerReport` and the ledger; the export format's round trip into SQLite.                                    |
| 4   | **The documents object** without routes: collections, documents, queries, counts, bulk operations, budgets, author barrier and chunks, the R2 journal and inventory, purge, account and workspace deletion jobs, holds and transfers, reconciliation                                                                                                             | 3      | Every fault schedule and property of the spike in the product; the restore drill repeated with the real object; nothing reachable by users.                        |
| 5   | **Owner document API**: services, API, MCP, CLI, scopes, the token scope control, audit relay, export, the dashboard's read-only Data section                                                                                                                                                                                                                    | 4      | Parity, audit coverage, terms classification, export round trip, accessibility.                                                                                    |
| 6   | **Grants and page reads and writes**: the gates, the three flows, the control, "Data you shared", rights requests, the content Worker's routes, the client script                                                                                                                                                                                                | 5      | Browser tests of every flow in three engines with third-party cookies blocked; fixation refused; revocation within 60 seconds.                                     |
| 7   | **Live updates**                                                                                                                                                                                                                                                                                                                                                 | 6      | Principal-bound renewal, chunked byte reservations, deadlines across hibernation; staging: zero active time when idle.                                             |
| 8   | **Budgets, protection, legal texts and release**: budget protection's steps, the collector's metrics, hostile-owner and hostile-visitor load on staging, the plan limits fixed from staging's active time, `TERMS_VERSION`, release checks, switches on                                                                                                          | 4 to 7 | Measured spend within the hostile table for the chosen option, or the limits lowered until it is; the legal checklist; every staging check here done and recorded. |
| 9   | Anonymous writers, `read` and `shared` from the page, the workspace policy                                                                                                                                                                                                                                                                                       | 6      | Policy and limit tests; browser test of the anonymous flow.                                                                                                        |

Every owner and page route and every path that creates data stays off until delivery 8; export and erasure work earlier only on objects that exist, and nothing creates one before then.

**Estimate**, for one engineer with review, documents only: feasibility experiments 4 to 6 working days, contracts 6 to 9, the documents object 10 to 14, owner API 8 to 10, grants and page 12 to 16, live 6 to 8, budgets, protection, legal texts and release 9 to 14: **55 to 77 working days** (11 to 15.4 five-day weeks) for the first release, plus 5 to 7 for anonymous writing. It is a planning range conditional on delivery 2's results, not a commitment. Most uncertain, in order: the grant flows in WebKit with partitioned cookies (a failure changes the flow, not the data design); the active time per request in production (it moves B Pro's hostile month from US$2.24 to US$5.19 and decides the plan limits); the restore drill with real objects (the reconciliation rules are tested only as pure functions and in one object); the cost of rows written at scale (four fifths of the typical bill).

## Claims and evidence

Kinds: **P** a property or pure-rule test, **C** a call-site test through the object, **F** a fault schedule at an await, **B** only a browser can show, **D** only a deployment can show.

| Claim                                                                                                                                   | Evidence                                                                                          | Kind | Still to show                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| One class reached from two Workers                                                                                                      | `two-workers`                                                                                     | C    | D: `script_name` across the deployed Workers, jurisdictions     |
| `own` isolation by ID, filter, cursor                                                                                                   | `documents`, `queries`, the transfer schedule on `query` and `get` in `fault-schedules`           | C, F |                                                                 |
| A hold, a transfer or a duplicate during any await is seen before work                                                                  | `fault-schedules` (14 schedules), `review-findings-3` (finding 1)                                 | F    | D: real ledger latency                                          |
| Obsolete leases are given back once; the ledger's day only moves forward                                                                | `fault-schedules` (transfer schedules check the balance; the ledger test)                         | F, C |                                                                 |
| Operation IDs scoped to actor and generation, no bodies, no second charge, conflicts                                                    | `review-findings-2` (1, 5), `fencing`, `fault-schedules` (duplicates)                             | C, F | The issue-time horizon (delivery 3)                             |
| Pruning runs from the alarm, oldest first, bounded, never under a hold                                                                  | `review-findings-3` (alarm), `fencing` (all control tables), `review-findings-3` (hold)           | C    | D: alarms running late                                          |
| One validator with modes; fences check generation and transition; empty objects keep barriers                                           | `fencing` (pure rule table, fences), `review-findings-3` (finding 6), `edges`                     | P, C |                                                                 |
| Prepare adopts the epoch; commit atomic; control kept; holds cancel a prepared erase                                                    | `review-findings-2` (3), `fencing`                                                                | C    |                                                                 |
| Restore: field authority, resume an erase, quarantine, operator resolution                                                              | `fencing` (reconcile, quarantine, adopt, erase)                                                   | P, C | D: the restore drill (delivery 2)                               |
| Author erasure terminal: barrier on empty objects, retired journal, sockets and sequences gone, shared-edit rule, chunk replay          | `review-findings-3` (finding 8, 10), `fencing`, property tests                                    | C, P | D: R2 conditional writes under real concurrency                 |
| Every command charged at an upper bound of its measured work; index builds refused before building                                      | `cost` (actual against `BOUND`), property tests, `review-findings-3` (finding 9)                  | C, P |                                                                 |
| Cleanup and export have owner pools; a spent growth day still deletes; erasure never refused                                            | `fault-schedules` (plan B Free), `review-findings-2` (10), `edges-2`                              | C    |                                                                 |
| Shrinking replacements under the write rate                                                                                             | `review-findings-3` (finding 16)                                                                  | C    |                                                                 |
| Audit keyed by the full operation; delivered and aborted distinct; obligations survive erasure                                          | `review-findings-3` (finding 11), `fencing`, `review-findings-2` (14)                             | C    | D: the relay and sweep                                          |
| Owner API: counts, bulk deletes with one operation and obligation                                                                       | `fault-schedules`                                                                                 | C    |                                                                 |
| Export exact, stable revision, byte-bounded pages                                                                                       | `fencing` (export), `review-findings-3` (finding 12)                                              | C    | The JSON Lines file and its SQLite load (delivery 3)            |
| Every live message charged to artifact and owner, in chunks; principal-bound renewal; deadlines                                         | `fault-schedules` (chunks), `review-findings-3` (finding 15), `review-findings-2` (8, 16), `live` | C    | D: hibernation across real idle periods                         |
| Storage reports with a sequence, refusals included                                                                                      | `review-findings-2` (13), `fencing`                                                               | C    | D: the collector's figures                                      |
| Start and redeem gates; atomic code redemption                                                                                          | `grants`, `edges-2`, `review-findings-2` (15)                                                     | P    | B: every flow in three engines with third-party cookies blocked |
| Bounded query shapes                                                                                                                    | `queries`                                                                                         | C    |                                                                 |
| The `FREE` fixture is option B's Free plan                                                                                              | `harness.ts` (`FREE`, `FREE_OWNER`), `fault-schedules` (plan B Free end to end)                   | C    |                                                                 |
| `/me` before consent, D1 grant rows, scope upgrades, the inventory sweep, switches, bulk create and replace, counts by an indexed value | none (design)                                                                                     |      | Delivery tests                                                  |
| Active time, billing                                                                                                                    | none                                                                                              |      | D: staging and the first invoices                               |

## Review findings

The first two reviews' findings remain answered as the second and third versions' tables say; their reproductions still pass (`review-findings.test.ts`, `review-findings-2.test.ts`), except those about owner SQL, which were removed with it and live in commit `c5b84930`.

### Third review (20 findings)

Reproduced in `review-findings-3.test.ts` (commit `3b0a286d` adds them against `c5b84930`, where 17 of 19 fail); all pass on this version.

| #   | Finding                                                      | Answer                                                                                                                                                                    | Where                                             |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | A fence or duplicate during an await is crossed              | Three phases; final transaction re-admits and rechecks the operation and authorization; leases installed only for the same owner epoch, else given back                   | "Every await is a fault point"; `fault-schedules` |
| 2   | The SQL write ceiling is not a bound                         | Closed by removal (decision 38)                                                                                                                                           |                                                   |
| 3   | The ledger allows several overdrafts and refills a day twice | Overdrafts closed by removal (documents charge an upper bound, no debt); the day only moves forward                                                                       | "How it is charged"; the ledger test              |
| 4   | SQL debt lost, charged twice or moved to the next owner      | Closed by removal                                                                                                                                                         |                                                   |
| 5   | Restore loses a pending erase and cannot resolve quarantine  | Pair reconciliation closed by removal; for one object: field authority table, `resume_erase`, independent hold, operator `adopt` or `erase`, operator export              | "The control record and the validator"; `fencing` |
| 6   | Empty objects and maintenance bypass the validator           | Barriers on empty objects; fences check generation and transition ID; admission modes                                                                                     | Validator table; `review-findings-3`              |
| 7   | Owner DDL can block erasure                                  | Closed by removal: no owner schema exists                                                                                                                                 | "One object"                                      |
| 8   | Author erasure is not terminal                               | Barrier on empty objects, retired journal entry, sockets and sequences at the barrier, shared-edit rule decided and tested                                                | "Author erasure"                                  |
| 9   | Work lost on failure; documents exceed their allowance       | Upper-bound charges before work on every path, index builds reserved before building, cleanup and export in owner pools, erasure counted; the SQL parts closed by removal | "Budgets"                                         |
| 10  | Copies and author chunks lack the operation contract         | Author chunks recorded and replayed with their counts; copies closed by removal                                                                                           | "Author erasure"                                  |
| 11  | Audit identity weaker than mutation identity                 | One key for record, obligation, D1 event and acknowledgement; delivered and aborted distinct                                                                              | "Audit with durable states"                       |
| 12  | Export not lossless, stable or bounded                       | Documents export exact stored text, primary-key cursor, payload revision apart from the storage sequence, 1 MiB pages; SQL export closed by removal                       | "Export"                                          |
| 13  | Copy pagination and consistency                              | Closed by removal                                                                                                                                                         |                                                   |
| 14  | Retention and storage accounting not as claimed              | Alarm-driven, age-ordered, bounded pruning of every control table, never under a hold; 24-hour horizon with issue-time IDs; data cap apart from the control reserve       | "Operation records", "Storage accounting"         |
| 15  | Live protocol messages bypass the owner's bytes              | Owner bytes leased at connect; every message from 16 KiB reservations against artifact and owner                                                                          | "Live updates"                                    |
| 16  | Shrinking replacements bypass the write rate                 | Charged to cleanup, under the write rate                                                                                                                                  | "Pools"                                           |
| 17  | Cost model incomplete; averages labelled worst cases         | Every billable path listed with its bound; amortized and account-block models apart; active time at two values pending staging                                            | "Cost model"                                      |
| 18  | Team break-even wrong; B not a proved ceiling                | Recomputed for documents only (A 12, B 4, C 38 seats at 5 ms); coverage not claimed; B kept as the smallest exposure                                                      | "Cost model", "The plan limits"                   |
| 19  | Claims table overstated; `FREE` fixture not option B         | Table with kinds and what remains; `FREE` and `FREE_OWNER` equal option B's Free                                                                                          | "Claims and evidence"                             |
| 20  | Feasibility work scheduled too late                          | Experiments in delivery 2, before contracts and adapters; the estimate conditional on them                                                                                | "Deliveries"                                      |

## Alternatives rejected

### Owner SQL

The issue gave the owner side SQL, read and write, from the first release, and three versions of this record designed it.

What was tried: first, one database with a SQL allowlist, where owner SQL and visitor documents shared tables; the first review showed the classifier could be passed and an owner's schema could block visitors' deletions. Then a second object per artifact as a sandbox for owner tables, with copies of collections into it, a shape-bounded write ceiling, a CPU-bounded read ceiling, a per-owner ledger with debt for statements that overran their lease, and a lossless SQL export.

What stayed open after three reviews: the write ceiling was not a bound (covering indexes, `CREATE TABLE … AS` and implicit indexes passed the shape guard, and `max_page_count` is refused in Durable Objects); overdrafts and debt could be taken more than once across sandboxes, lost on a failed acknowledgement, or assigned to the next owner after a transfer; accepted owner DDL could make the sandbox's erasure fail indefinitely; the copy contract had no byte-aware pagination and no source consistency across pages; and reconciling two objects after a restore needed pair-wide transition identities the design did not have. Each fix opened another counterexample, while the document side converged. The maintainer removed owner SQL (decision 38); what an owner's agent wanted from it is analysis, which "Later" answers without server-side SQL.

The removed design, its spike code (`sandbox.ts`, `sql-guard.ts`, `wire.ts`) and its tests (`sandbox`, `ceiling`, `expensive`) are in commit `c5b84930`. Owner SQL can be reopened later with its own record, which must answer the findings above first.

### Others

| Option                                                   | Why not                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Charging the measured work after it ran                  | A failure before the cursor reports leaves nothing to charge; upper bounds before work do not. |
| Debt in the ledger                                       | Needed only for unbounded statements, which no longer exist.                                   |
| Identity from review or read sessions                    | They can be planted; no consent.                                                               |
| Inferring an aborted operation from a missing obligation | A call still in flight would commit after; `settle` aborts explicitly.                         |
| Deleting the journal entry when erasure completes        | A delayed first grant would get a fresh identity; the entry is retired instead.                |

## Later

What an owner's agent wanted from SQL is analysis: joins, sums, groups over the artifact's data. It can have that without server-side SQL by exporting the documents and querying them in a local SQLite database on the owner's machine, where the cost and the risk are the owner's. The export format in "Export" is designed for it: stable (versioned, never reordered), typed (fixed server fields, bodies as their stored JSON) and complete (every document and every collection's declaration), so loading it is one table per collection or one table with `json_extract`. A CLI command that does the load (for example `portifact data sqlite <artifact> --out data.db`) is a possible later change, not part of this design.

## Open questions for the maintainer

### The plan limits (open)

Rows bound spend, size alone does not (a small artifact can be rewritten all day). The options, documents only, with what each costs under hostile use (amortized, 31 days, nothing included, 5 ms and 100 ms of active time) and typical use:

|                                                                    | A                                                                | **B (recommended)**                        | C                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- |
| Free: data artifacts, size each, live connections each             | 3, 10 MB, 10                                                     | 1, 5 MB, 10                                | 10, 25 MB, 10                         |
| Free, a day: documents written / read, cleanup, export, live bytes | 30,000 / 3 M, 30,000, 1 M, 50 MB                                 | 5,000 / 500,000, 10,000, 200,000, 20 MB    | 100,000 / 10 M, 100,000, 5 M, 200 MB  |
| Pro: data artifacts, size each, live connections each              | 20, 100 MB, 10                                                   | 10, 50 MB, 10                              | 50, 250 MB, 10                        |
| Pro, a day                                                         | 60,000 / 10 M, 60,000, 5 M, 200 MB                               | 10,000 / 2 M, 10,000, 1 M, 50 MB           | 200,000 / 30 M, 200,000, 10 M, 500 MB |
| Team (per owner): data artifacts, size each, live connections each | 100, 500 MB, 25                                                  | 50, 250 MB, 25                             | 200, 1 GB, 25                         |
| Team, a day                                                        | 300,000 / 50 M, 300,000, 20 M, 1 GB                              | 75,000 / 15 M, 75,000, 5 M, 250 MB         | 1 M / 100 M, 1 M, 50 M, 2 GB          |
| Hostile month, Free / Pro / Team at one seat, 5 ms                 | US$2.85 / 6.88 / 42.87                                           | US$1.10 / 2.24 / 13.63                     | US$8.49 / 20.70 / 131.84              |
| The same at 100 ms                                                 | US$3.80 / 12.48 / 109.58                                         | US$1.51 / 5.19 / 47.20                     | US$11.29 / 34.25 / 264.81             |
| Team revenue passes its cost from                                  | 12 seats (36 at 100 ms)                                          | 4 seats (15 at 100 ms)                     | 38 seats (86 at 100 ms)               |
| Typical use at 100,000 artifacts                                   | US$234 to 302 under every option: typical use is below every cap |                                            |                                       |
| What users feel                                                    | A busy board on Free                                             | One small app on Free; a team board on Pro | Most hobby apps on Free               |

Per artifact, every option keeps documents of at most 16 KiB, 1,000 documents a collection, 10 collections and 3 indexed fields on Free (more on paid plans), 30 writes and 60 deletes per author a minute, and 300 reads per caller a minute.

**Recommendation: B for the first release**, as the smallest exposure that keeps live updates in every plan. It is not shown to be covered by its prices: B Pro's hostile month is US$2.24 at 5 ms against US$2, and B Team needs four seats. Delivery 8 measures active time on staging and fixes the numbers then; if the measured month is over the price, Pro's limits come down (written and cleanup first) or Team is sold from four seats.

### Engineering choices the record follows

1. **Per-caller read rates in memory**: they shape traffic; the spend is durable.
2. **The top-level tab** as the grant fallback, as review does today.
3. **`cpu_ms: 200`** for `portifact-data`, to be confirmed by delivery 2's measurements.
4. **Write cost levers** (fewer counter rows per write) are left for after measurement; they are the main lever on the 100,000-artifact cost.
