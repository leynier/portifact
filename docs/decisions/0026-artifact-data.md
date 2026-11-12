# 0026 Artifact data: a database per artifact

- Status: proposed, second version. Design only: nothing is built, and `spikes/artifact-data` proves the parts this record claims. The first version (commit `7a10518b`) received an adversarial review that asked for a redesign; "Review findings" maps each of its 27 findings to the answer here. The product decisions are the maintainer's, in [issue #194](https://github.com/leynier/portifact/issues/194), in their answers to the review and in their answers to this record's open questions ("The maintainer's answers to the open questions"); only the plan limits remain open.
- Date: 2026-11-12
- Feature: issue #194, "give each artifact its own database". Not a premium plan feature: every plan gets it, with limits per plan.

## Question

An artifact is a static site today. The maintainer wants it to be able to be a small app: its JavaScript, running in a visitor's browser, stores and reads data that outlives the visit (forms, votes, lists, boards), and the owner and their agents read and write the same data through the API, the MCP server and the CLI, with SQL. How can Portifact give each artifact a database without letting a visitor reach another visitor's data, letting a page act as a person without their consent, letting one artifact reach another's, letting a hostile owner or visitor spend Portifact's budget, or breaking any rule the platform already keeps (regions, deletion, restore, holds, quotas, the three interfaces' parity)?

## Decisions taken by the maintainer

From the issue, fixed:

1. **Engine.** Real SQLite in Cloudflare Durable Objects with the SQLite storage backend, in the jurisdiction of the owner's region.
2. **Two doors.** The page uses a document API and never sends SQL. The owner side (admins and editors of the owner and their agents) uses the document API plus SQL, read and write, from the first release.
3. **Identity.** The page learns an opaque per-artifact ID and the display name, never the email.
4. **Who writes from the page.** The owner decides per artifact; by default signed-in visitors who can open it; anonymous writers on public artifacts only when the owner opens them, with per-IP limits and the human check; share link visitors read only.
5. **Live updates** over WebSockets from the first release.
6. **Plans.** Free with a small quota, more on paid plans, under the budget target (US$50 a month as an objective, protection from US$100).
7. **Lifecycle.** The data belongs to the artifact, not a version: publish and rollback do not touch it; it stays while archived, counts in storage, and goes at purge and account or workspace deletion.

From the maintainer's answers to the review, also fixed:

8. **Owner SQL and visitor documents do not share a database** (findings 1, 2, 6, 7, 10, 12); the record evaluates the two shapes offered and chooses one it can prove closed.
9. **Spending is bounded by work, not request counts** (findings 10, 11, 25): every operation is budgeted by rows read and written, durably, per artifact and per owner, per plan, attempts and refusals included, inside the object; visitor queries only in shapes with a bounded scan; nothing keeps an object awake.
10. **No identity and no attributed write without the visitor's consent on the trusted origin** (findings 3, 9, 16): a grant given in a control Portifact draws on `app.portifact.com`, artifact-bound, browser-bound and revocable, is what authorizes writes.
11. **Lifecycle is fenced** (findings 4, 5, 8, 17, 27): durable operation IDs, a data generation and a lifecycle epoch checked by the object on every command through one envelope; holds and transfers are acknowledged barriers; erases target their generation; erasure registration is a durable journal that survives a D1 restore; sizes carry a revision; socket authorization has an absolute deadline.
12. The smaller defects are fixed as the review says (13, 12, 15, 14, 20, 21, 22).
13. **Answers to the review's product questions:** existing service tokens gain nothing, and artifact data needs new explicit scopes (23); deleting an account erases the documents it created, not owner-made copies or other people's later edits in a shared collection, and the record says how a person asks for those (18); a transfer moves the data with the artifact and the Privacy Policy and the grant control say so; live authorization keeps the 60-second bound, links included; a workspace policy forbids anonymous writing, and anonymous writing is not offered where no such control exists (settled by decision 21); no point-in-time recovery for owners in the first release; `_by` is session attribution, never alone evidence against a visitor (19).
14. **Deliveries** (26): small disabled increments with dependencies and acceptance criteria; fencing, the erasure journal, budgets and the SQL boundary proven before any data is exposed; page writes, owner SQL, live connections and anonymous writing each with its own switch; the first release switched on includes owner SQL and live updates.

### The maintainer's answers to the open questions

Given after reading this record's second version; fixed:

15. **One release, built in small steps.** The first release that is switched on includes owner SQL, read and write, and live updates. A staged release (documents and read-only SQL first) was offered and declined: the deliveries are built and reviewed one at a time, behind their switches, and the feature is switched on only when all of deliveries 2 to 7 and 9 are ready.
16. **Two databases.** Owner SQL and visitor documents live in separate objects, and the owner side copies a collection into its SQL database for analysis: confirmed as the preferred shape, on the condition that it is proven closed ("Owner SQL and documents: two objects", and the spike's findings 1, 2, 6, 7, 10 and 12).
17. **Consent before identity.** A page learns nothing about the visitor and cannot write as them until the visitor allows it in a control drawn by Portifact ("The grant"). This narrows decision 3: the page gets the opaque ID and the display name only after that consent, never by default.
18. **Account deletion.** Deleting an account erases the documents that account created on other people's artifacts; owner-made copies and later edits by others in a shared collection are outside that, and the record says how a person asks about those ("Controller, processor and the deletion boundary").
19. **Transfers.** A transfer moves the data with the artifact, like comments and the access log.
20. **Service tokens.** Existing service tokens gain no access; reading or writing artifact data needs a new scope that an admin grants ("Interfaces, scopes and parity").
21. **Anonymous writing.** Offered in a personal space, where the owner decides alone. In a workspace, offered only where the workspace policy that can forbid it exists, which is the plan with workspace policies (`policies`); a workspace without that control cannot open writing to anonymous visitors.
22. **Plan limits: not decided.** The record proposes them from the corrected cost model, bounded by rows read and written as well as by size, and leaves the choice open ("Open questions for the maintainer").

Alternatives rejected by the issue (Turso Cloud, Turso's engine in Workers, D1 per artifact, shared tables in the regional D1, SQLite in the browser with sync) stay rejected for the reasons it gives.

## Decision in short

- **Two Durable Objects per artifact** (shape (b) below): `ArtifactDocuments` holds the collections and speaks only the document API; `ArtifactSandbox` is the owner side's SQL database and holds only tables the owner creates and copies the owner side asked for. Owner SQL never touches live documents, so nothing an owner builds can depend on, block or rewrite them, and an expensive statement never holds the visitors' object.
- **A third class, `OwnerLedger`,** one per owner, leases rows read and written to the owner's objects in chunks, so the owner's daily work is exact up to what its artifacts hold.
- **Three Workers:** `portifact-data` exports `ArtifactDocuments` and `OwnerLedger`; `portifact-sql` exports `ArtifactSandbox` with its own CPU limit, so sandboxes and documents never share an isolate; the content, app and jobs Workers bind them by `script_name`.
- **Every command carries an envelope** (artifact, region, generation, epoch, operation ID) the object checks before anything else.
- **Every command is charged before it runs**, in its own committed transaction, against durable per-writer, per-artifact and per-owner budgets of rows; refused attempts stay charged.
- **Visitor queries come in seek-bounded shapes only**, with the index named in the SQL.
- **A page gets an identity only through a grant** the person gives in a control on `app.portifact.com` (in the viewer, or in a popup on a direct visit), bound to the browser that asked and to the artifact host. Without a grant the page can read what the artifact's access allows and learns nothing about who is there.
- **Erasure is journaled in R2**, which a D1 restore does not rewind.
- Shipped off behind five switches, in nine deliveries.

## Facts checked

Cloudflare's documentation, read on 2026-11-12 ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [FAQ](https://developers.cloudflare.com/durable-objects/reference/faq/), [metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)):

- **Prices on Workers Paid.** Requests: 1 million a month included, then US$0.15 per million; HTTP, RPC, alarms and WebSocket messages count, incoming WebSocket messages 1 in 20, outgoing free. Duration: 400,000 GB-s included, then US$12.50 per million GB-s, billed at 128 MB. SQLite: 25 billion rows read and 50 million rows written included, then US$0.001 and US$1.00 per million; 5 GB-month stored included, then US$0.20 per GB-month. Key-value calls on a SQLite object bill as rows read and written. Billing rounds overage up to units.
- **Duration and hibernation.** Duration is billed "as long as the Object is active and not eligible for hibernation"; an idle object eligible for hibernation is not billed even before it hibernates. Pending JavaScript timers, unfinished requests or `waitUntil`, outbound connections and the standard WebSocket API prevent eligibility; a stored alarm does not. So nothing in this design uses `setTimeout` or `setInterval`; deadlines use alarms.
- **Limits.** 10 GB per object; statements up to 100 KB, 100 bound parameters, 8 MB per value; 30 seconds of CPU per request by default, configurable with `limits.cpu_ms`; each incoming request or message resets the CPU allowance, and exceeding it can evict and reset the object; 1,000 requests a second per object as a soft limit; received WebSocket messages up to 32 MiB; `serializeAttachment` keeps up to 16 KiB per connection.
- **SQLite API.** `exec` reports `rowsRead` and `rowsWritten` (the billed values); `exec` refuses `BEGIN` and `SAVEPOINT` (transactions go through `transactionSync`, rolled back if the callback throws); several statements in one string all run; `deleteAll` erases SQL and key-value data atomically; point-in-time recovery covers the last 30 days and is not available locally.
- **Jurisdictions.** `namespace.jurisdiction("eu")` gives a subnamespace whose objects stay in the EU; the same name in two jurisdictions is two objects.
- **Migrations.** `new_sqlite_classes` creates SQLite-backed classes; a deleted class loses all its data; `exports` replaces `migrations` one-way.

The code at `develop` on the same day: the content Worker exports a SQLite-backed Durable Object already (`TrafficLimiter`) and refuses every method but `GET` and `HEAD` before routing; sites carry no script policy of Portifact's (`contentHeaders` sends only `frame-ancestors`, `nosniff`, CORP and robots); public artifacts are served before any session is read; the viewer frames an artifact with a partitioned review session; transfers are refused across regions; the Terms say Portifact "runs no builds, servers or databases for your content"; `PLAN_PRICES` lists Pro at US$2 a month and Team at US$5 a seat; the free traffic quota is 1 million requests a month.

## Owner SQL and documents: two objects (the maintainer's decision 8)

Two shapes were evaluated against every counterexample of the review:

| Counterexample                                              | (a) One object, fail-closed allowlist                                                                                          | (b) Two objects                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Virtual table written through the read call (1)             | Closed by refusing virtual tables and by read-only execution independent of classification.                                    | Same, and the documents are not in reach whatever happens.                                                                                   |
| Foreign key with `RESTRICT` on documents blocks erasure (2) | Needs a validated dependency graph over every owner DDL, including indirect paths (views, generated columns, future features). | Impossible: the documents are not in the sandbox's database; a reference to them names a table that does not exist there (spike: finding 2). |
| Recursive CTE without the keyword (6)                       | Closed by refusing `WITH`.                                                                                                     | Same.                                                                                                                                        |
| Large BLOB results (7)                                      | Wire encoding with byte caps.                                                                                                  | Same.                                                                                                                                        |
| Mass `UPDATE` spends rows (10)                              | Row budgets.                                                                                                                   | Same, and the sandbox's budget is separate from the visitors'.                                                                               |
| Over-quota cleanup refused (12)                             | Non-growth rule.                                                                                                               | Same.                                                                                                                                        |
| An expensive statement holds visitors' requests             | Not closable: same object, one thread.                                                                                         | Holds only the sandbox; in production the sandbox is another Worker's object, so not even the documents' isolate.                            |
| Account erasure of documents                                | Depends on nothing owner SQL created staying out of the way.                                                                   | Independent of anything the owner builds.                                                                                                    |

**Chosen: (b).** It is the one whose safety argument does not depend on getting a SQL classifier exactly right: the classifier and the read-only rollback protect Portifact's resources and the read-only promise, while the documents' integrity follows from their not being there. Its costs: SQL cannot read documents live, only a copy the owner side asked for, and every artifact with SQL has two objects.

**Copies.** `POST /api/v1/artifacts/:id/data/copies` (owner side, `data:write`) copies one collection into a sandbox table `copy_<name>` with fixed columns (`_id`, `_by`, `_edited_by`, `_created`, `_updated`, `body`), as an outbox job that moves bounded pages (at most 500 documents, each page charged to both objects' budgets) from the documents object's export to the sandbox's `importCopy` (spike: "holds a copy of a collection only when the owner side asks"). The sandbox lists its copies (collection, documents, time) in its key-value state; describe, export and the dashboard show them. A copy is the owner's data: account erasure does not reach it (decision 13), the owner side can erase an author from it with SQL (the spike does), and the rights request page tells a person which copies exist.

## Where the classes live

| Worker                 | Exports                            | Binds                                          | `limits.cpu_ms` |
| ---------------------- | ---------------------------------- | ---------------------------------------------- | --------------- |
| `portifact-data` (new) | `ArtifactDocuments`, `OwnerLedger` | itself (the documents object calls the ledger) | default         |
| `portifact-sql` (new)  | `ArtifactSandbox`                  | `OWNER_LEDGER` from `portifact-data`           | 1,000 proposed  |
| `portifact-content`    |                                    | `ARTIFACT_DOCUMENTS`                           | default         |
| `portifact-app`        |                                    | all three                                      | default         |
| `portifact-jobs`       |                                    | all three                                      | default         |

- **Configuration.** Each new Worker has `workers_dev` and `preview_urls` off, no routes, no D1, R2 or queue binding and no secret; its `fetch` answers 404. Legacy `migrations` with tag `v1` (`new_sqlite_classes`), as the content Worker uses for `TrafficLimiter`; moving to `exports` is one-way and not needed. `deleted_classes`, `renamed_classes` and `transferred_classes` are never used for these classes; a `scripts/` test refuses them in every `wrangler.jsonc`.
- **Deploy order.** `portifact-data`, then `portifact-sql`, then jobs, content and app. A binding to a class whose script does not exist yet fails the deploy.
- **Rollback.** Rolling back a calling Worker never touches stored data. A class Worker can roll back code to versions after `v1`. Each object's reserved schema carries a version and only changes additively (new tables, nullable columns, indexes), so an older build reads a newer database; anything else needs its own record.
- **Region to namespace.** One function, `dataNamespaces(env, region)` in `packages/services`, makes every stub: the default region uses the namespaces without a jurisdiction and `locationHint: "wnam"`, where the default D1 databases and bucket are; the EU uses `jurisdiction("eu")`. The region always comes from the global directory, never from input; the same artifact ID names two different objects in two jurisdictions, and the envelope's region is checked by the object.
- **The e2e Worker** exports all three classes itself and binds them without `script_name`.

## The envelope and fencing (findings 4, 27)

Every command to an artifact's objects carries `{ artifactId, region, generation, epoch, opId? }`, filled by the calling Worker from D1 after authorization (`spikes/artifact-data/src/envelope.ts`). The object keeps its own `{ artifactId, region, generation, epoch, state }` and decides with one function, `checkFence`:

- a different artifact or region: `forbidden` (a routing bug cannot mix two artifacts' data);
- a different generation: `stale` (the data was erased since the request began);
- an older epoch: `stale`; a newer one is adopted (D1 moved first);
- `state = held`: refused to everyone but operator commands.

Every method checks it: document commands, SQL reads and writes, live connections and renewals, author erasure, exports, copies (spike: finding 27 tries a wrong artifact on each).

**D1's side.** `artifact_data` (regional, one row per artifact with data) holds `generation`, `epoch`, `fenced_epoch` (the epoch the objects acknowledged), the size report and the writers setting. The epoch rises in the batch of every change that alters who may act on the data: a hold or release, a transfer, a suspension or reinstatement, an archive or restore, an access change that narrows, a lapsed plan, a collection mode change. The generation rises in the batch that orders an erase of the whole data.

**Barriers.** A hold and a transfer are in force only when acknowledged: their batch raises the epoch and writes a `data_fence` outbox job; the job calls `fence(envelope, state)` on both objects; on success it sets `fenced_epoch`. The operator's `hold-artifact` waits for that and says "hold in force"; `transferArtifact` calls the fence itself after its batch (the job repeats it if the call fails) and answers only after it. A request authorized before the epoch rose and arriving after the fence is refused `stale`; one arriving before is ordered before the barrier, which is the barrier's meaning. A fence carrying an older epoch is refused, so a late job never moves an object back (spike: "refuses a request that began before a transfer").

**Erasure of the whole data** (purge, account or workspace deletion) is two steps, so a hold that starts meanwhile wins: the `erase_artifact_data` job calls `prepareErase` (the object stops serving that generation), re-reads D1 (a hold started?), then calls `commitErase` or `cancelErase`. `commitErase` deletes only if the object is still erasing the same generation at the same epoch, so a fence that arrived in between cancels it; it then records the next generation, so a retry of the same job finds nothing to do and data created later survives it (spike: findings 4 and "makes a hold an acknowledged barrier").

**Operation IDs.** Every mutation carries the Worker's operation ID (the request's idempotency key, or a new one); the object stores the first outcome in `pf_ops` and a retry gets it back without applying twice (spike: "replays a retried mutation"). Entries are pruned after 24 hours by an alarm that runs only when the object is otherwise awake.

## The grant (findings 3, 9, 16, 22, 24)

### What it is

A grant is one person's consent, for one artifact host and one browser, that the artifact's page may know them by an opaque per-artifact ID and their display name and may save what they enter. Without a grant a page can read the collections the artifact's access allows (`append`, `read`, `shared`) and learns nothing about who is there: `GET /__portifact/data/me` answers `{ granted: false }` the same way for an anonymous visitor, a signed-in visitor who has not granted and a share link visitor, so the page cannot tell whether an account session exists. Review, read and link sessions authorize reading the artifact as today; they never authorize a data write and never reveal a name. A planted review cookie (the fixation decision 0002 describes) therefore cannot make anyone an author.

### The control

Portifact draws it, never the page, on `app.portifact.com`, in the person's language. It names the artifact's host and its owner (the workspace's name or the person's display name), says what the page will learn (the display name and an ID for this artifact only, never the email), that the people who manage the artifact read everything saved there, that the data stays with the artifact if it moves to another owner, how long the grant lasts, and links to the rights request page. Buttons: "Allow" and "Not now". The page asks with `data.requestGrant()`; asking is a hint, and the control shows only after the person's own click in the viewer or the popup.

### How it reaches the artifact origin

Two flows, one rule: the one-use code is redeemed only in the browser that began the transaction, on the host it was issued for (`spikes/artifact-data/src/grants.ts`).

1. **In the viewer** (the bar is on, the default). The viewer navigates its frame to `/__portifact/data/grant/begin?flow=frame`; the content Worker sets a sealed, partitioned `__Host-pf_grant_tx_<tag>` (10 minutes) holding a random nonce and answers a Portifact page (not the artifact) that posts the nonce's hash to the parent with the exact app origin as target. The viewer shows the control; on "Allow" it posts the hash to `POST /api/v1/artifacts/:id/data/grants` (dashboard session), which creates the grant and a code bound to the hash and host, and the viewer navigates the frame to `/__portifact/data/grant?code=…&to=<path>`. The handoff gate (`handoffGate`, `iframe` destination, `cross-site`, `navigate`, `GET`) and the transaction cookie admit it; the Worker sets a partitioned `__Host-pf_grant` and redirects to the path. Partitioned cookies under the app's top-level site are what the review session already relies on; where a browser refuses them, the viewer offers the popup flow.
2. **On a direct visit** (no bar, a custom host, or the fallback). `data.requestGrant()` opens a popup on the artifact origin at `/__portifact/data/grant/begin?flow=popup`, which sets an unpartitioned transaction cookie (`SameSite=Lax`) and redirects the popup top-level to `app.portifact.com/data-grant/<id>?state=<nonce hash>`; the app signs the person in if needed, shows the control, and on "Allow" redirects the popup to `/__portifact/data/grant?code=…` (handoff gate with `document` destination); the Worker sets `__Host-pf_grant` (`SameSite=Lax`) and answers a page that closes the popup. The opener learns the result by calling `me` again.

The spike proves the binding: a code planted from an attacker's transaction fails in the victim's browser; a wrong host, a missing transaction, an expired, replayed or wrong code fail; the handoff gate admits only the two navigations and refuses a sibling's `same-site` one (finding 16).

### Storage, expiry, renewal and revocation

- `data_grants` (regional): `id`, `artifact_id` (cascades), `user_id` (null for anonymous; no foreign key, cleaned by `advanceAccountDeletion`), `visitor_id`, `app_session_id` (Better Auth `sessions.id`, like read sessions), `host`, `flow`, `created_at`, `expires_at` (at most 30 days), `revoked_at`, `terms_version`. `data_grant_codes` (regional): code hash, nonce hash, grant, host, expiry (60 seconds), used.
- `__Host-pf_grant` holds sealed claims: grant, artifact, visitor ID, claims expiry (60 seconds), grant expiry; no account ID, no email. Both grant cookies and the transaction cookie are added to `isPortifactCookie`, and `imitatesPortifact` grows `pf_grant`.
- Every 60 seconds the content Worker renews the claims with one regional read of the grant and the existing liveness read of the app session (which also reads `users.terms_version`): a revoked or expired grant, a signed-out session or a lapsed artifact access ends it. **Writes need the current terms** (finding 22): if the account has not accepted the current `TERMS_VERSION`, the renewed claims carry `canWrite: false`; reads, deletes of the person's own documents and the person's own export keep working.
- Revocation: the person's "Data you shared" page on the dashboard lists grants and revokes them; the viewer's bar has "Stop sharing"; signing out ends them with the session. Each takes effect within 60 seconds, live connections included.

### The ID (finding 24)

The visitor ID is `v_` plus 128 random bits, made when the person first grants for that artifact and stored in the grant and in the R2 author journal (below); a later grant for the same person and artifact reuses it from the journal, so a person keeps one ID per artifact across grants, devices and restores. Nothing derives it from the account, so there is no key whose compromise links IDs to accounts. What it protects, precisely: Portifact never gives a page or an owner an account ID or an email through this feature, and two artifacts get unrelated IDs for the same person. What it does not protect: owners learn display names, write times and content, and an owner of two artifacts can correlate a person through those, through what the person typed, or through a `restricted` artifact's access log (which shows readers' addresses to the owner today). The record and the Privacy Policy promise the first and never the second.

The sealing keys of the grant and transaction cookies are versioned (`kid` in the cookie, the newest seals, every listed key opens; spike: "seals the grant cookie under versioned keys"). Rotation: add a key, make it current, remove the old one after the longest cookie lifetime (30 days); on compromise, remove the old key at once, which ends every grant cookie sealed with it, and the next request asks for a new grant (the grant rows and IDs survive).

### Anonymous writers (delivery 8)

The same control, without an account: on "Allow" the app runs the human check (Turnstile on `app.portifact.com`, where its widget is registered) and counts issues per IP (10 an hour proposed) in the D1 rate limits; the grant row has no `user_id` and a random visitor ID, and there is no journal entry (there is no account to erase). Losing the cookie loses the authorship; a new grant is a new author after another human check; this gives no Sybil resistance and the skill says so. Anonymous writing is offered only where its control exists (decision 21): on a personal artifact, where its one owner decides alone, and on a workspace artifact whose plan includes `policies` and whose policy `anonymousData` allows it. A workspace whose plan lacks `policies` cannot open writing to anonymous visitors: `PATCH …/access` with `dataWriters: "anyone"` answers `plan_required` there, and a workspace that loses `policies` falls back to signed-in writers at its next epoch (existing anonymous grants stop renewing within 60 seconds; their documents stay).

## Requests from the page

All on the artifact's own origin (and its custom domain while it holds), reserved, never redirected to the viewer, and routed before the content Worker's `GET`/`HEAD` check:

| Method and path                                                    | What                                                                                             | Needs                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `GET /__portifact/data/me`                                         | `{ granted: false }`, or `{ granted: true, visitor: { id, name }, canWrite, collections, live }` | API gate                        |
| `GET /__portifact/data/c/<collection>?q=<JSON>`                    | A query in an allowed shape                                                                      | API gate; a grant in `own` mode |
| `GET /__portifact/data/c/<collection>/<id>`                        | One document                                                                                     | API gate                        |
| `POST`, `PUT`, `DELETE` under `/__portifact/data/c/…`              | Create, replace, delete                                                                          | API gate, a writing grant       |
| `GET /__portifact/data/mine`                                       | The grant holder's own documents across collections, JSON Lines                                  | API gate, a grant               |
| `GET /__portifact/data/live`                                       | WebSocket                                                                                        | API gate                        |
| `POST /__portifact/data/live/renew`                                | Extends a connection's deadline                                                                  | API gate                        |
| `GET /__portifact/data/grant/begin`, `GET /__portifact/data/grant` | The grant flows                                                                                  | handoff gate                    |
| `GET /__portifact/data.js`, `/__portifact/data.<version>.js`       | The client script                                                                                | none, like the diagram script   |

**Order of checks** for API requests: the switch; the API gate (`Sec-Fetch-Site: same-origin`; on writes and handshakes the exact `Origin`; JSON on writes; no fetch metadata fails closed); the artifact lookup (the existing delivery lookup, which also selects the `artifact_data` row: generation, epoch, writers setting, size report); servable; the session that authorizes reading, as today; the grant claims, if any; the network policy; the traffic quota; budget protection (traffic steps, and `pause_data_writes` for writes); the envelope; the object. Every request is charged to the owner's traffic through the per-isolate `TrafficMeter` (no D1 write per request), and the object's size report goes to the per-isolate `DataSizeMeter`. Responses carry `no-store`, `Cross-Origin-Resource-Policy: same-origin`, `nosniff`, `noindex` and no CORS headers. Data requests are never page views, openings or analytics.

**Content security policy.** Sites get no new policy: their scripts call their own origin. Rendered Markdown and text documents run no scripts (`default-src 'none'`) and cannot use artifact data; this design does not change them.

**The client script.** `/__portifact/data.<version>.js`, a small ES module built by a new `packages/data-client` like the diagram script (content-hashed, immutable, brotli, never charged as traffic, `/__portifact/data.js` redirecting to the current build), with `data.me()`, `data.requestGrant()`, `data.collection(name)` (`create`, `replace`, `delete`, `get`, `query`, `subscribe`) and `DataError` codes. Agents learn it from the skill (with a complete example page), from `describe_artifact_data` and from `portifact data describe --example`.

## The document model

### Collections and modes

The owner side declares collections (`PUT /api/v1/artifacts/:id/data/collections/<name>`): a name, a mode, an optional unique key and up to the plan's number of indexed fields.

- `own` (default): a visitor creates documents and reads, changes and deletes only their own; a page without a grant sees nothing; the owner side sees all.
- `append`: everyone who can open the artifact reads; each writer creates and changes and deletes only their own.
- `read`: everyone reads; only the owner side writes.
- `shared` (opt-in): every writer changes and deletes everything.

### Server fields (finding 19)

`_id` (96 random bits), `_by` (the visitor ID of the grant that created it, or `owner`), `_editedBy` (the last different editor, `shared` mode), `_created`, `_updated` and `_seq`. Input that sets a `_` field is refused. `_by` is **session attribution**: it says which grant's session created the document, not that the person typed it. A hostile page can submit anything through a granted session, and in `shared` mode another writer can rewrite a body that keeps its creator. The record, the skill, the operator's runbook and the report flow say so: `_by` is never alone evidence against a visitor.

### Sequences (finding 15)

`_seq` counts in the document's own scope: the author's own counter in `own` mode, the collection's counter elsewhere (everyone there sees every write anyway). So a visitor's sequence numbers never reveal other authors' private writes (spike: finding 15). Residual side channels remain and are documented: response times, the moment a shared daily budget runs out, and a collection's document cap.

### The unique key (finding 13)

A unique key is a top-level field holding a string, a finite number or a boolean, stored as its JSON text (so `1` and `"1"` differ); it is required, recomputed and re-checked on every replacement, and unique per author identity (one per grant's visitor ID, not one per human).

### Queries (finding 11)

Allowed shapes only, each with its index named in the SQL (`indexed by`), so SQLite seeks to the matching range and walks it in order and the rows read are the page plus one, whether the match is dense, sparse or empty:

| Shape                                                                              | Index                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A page ordered by `_created` (either direction), optional `_created` range, cursor | `pf_documents_created (collection, created, id)`, or in `own` mode `pf_documents_author (collection, author, created, id)` with the caller bound |
| `_by` equals one ID (not in `own` mode), optional `_created` range                 | `pf_documents_author`                                                                                                                            |
| A declared indexed field equals one scalar, optional `_created` range              | `pf_field_<name> (collection, json_extract(body, '$.<name>'), created, id)`                                                                      |

Everything else is refused: `in` lists, `_updated` and `_id` filters, undeclared fields, more than one equality. Page size 1 to 100. Spike, at 100,000 documents: every allowed shape read at most 118 rows for a page of 100 and 17 to 26 rows for an empty or sparse match, in 0 to 6 ms, and SQLite's own plan for each is `SEARCH … USING INDEX` with no scan and no temporary b-tree.

### Validation and bounds

A document is a JSON object of at most the plan's `documentBytes`, at most 16 levels deep. The object enforces every cap in the write's own transaction: documents per collection, collections, indexed fields, bytes per artifact. Over the artifact's size, a change that does not grow the database goes through: deletes always, replacements that shrink, owner SQL that deletes (finding 12; spike: finding 12 and "refuses growth past the artifact's size but lets a smaller replacement through").

## Budgets (the maintainer's decision 9; findings 10, 11, 12, 25)

### What is charged, where

Every command is charged before it runs, in its own committed transaction, so a refusal keeps its charge:

- **The writer's rate**, a durable row per author and minute (`pf_budget`): writes 30 a minute, deletes a separate allowance (60 a minute) so cleanup works when writing is spent. Refused attempts count (spike: finding 10 and "refuses the 31st write of a minute, attempts included").
- **The artifact's day**, one row per UTC day (`pf_day`): rows read and written, charged at an estimate first and trued up with what SQLite reported after. A command that does more than its estimate overshoots once by its own size; the next is refused.
- **The owner's day**, leased from `OwnerLedger` into the same row: an artifact asks the ledger only when its lease runs out, for 5% of the owner's day (at most 100,000 rows read or 1,000 written per chunk) plus any overdraft, so the owner's total is exact up to the leases outstanding in its artifacts (spike: "shares one owner budget across the owner's artifacts").
- **Reads per caller** (300 a minute) are kept in the object's memory: they shape traffic and reset if the object is evicted; the spend they cause is in the durable day row. Charging a read writes one row.
- **The sandbox** charges the same way in its key-value state (statements, 30 a minute; rows per day; the owner's lease), and the app Worker charges **SQL time** per owner per day in the D1 rate limits from each call's measured wall time (design only; the spike does not run it).

Deletes and erasures are never refused by a spent day; they are counted in it.

### Measured cost per operation (spike, production shape)

Rows SQLite reported, with the budget charge, the operation ID, the sequence, the revision and the audit obligation included:

| Operation                                      | Rows read | Rows written |
| ---------------------------------------------- | --------- | ------------ |
| First collection declared (creates the schema) | 28        | 31           |
| Visitor create                                 | 16        | 9            |
| Visitor replace                                | 21        | 9            |
| Visitor delete                                 | 15        | 7            |
| Visitor get                                    | 12        | 1            |
| Visitor page of 20                             | 33        | 1            |
| Owner create (with its audit obligation)       | 15        | 9            |
| SQL insert of one row / select of one row      | 0 / 1     | 1 / 0        |

The sandbox's own state is in its key-value store, billed as rows too and not in the table (about 6 reads and 5 writes a statement, estimated from the code). An object with its schema and one collection is 52 KiB; a 200-byte document adds about 840 bytes.

### Plans (proposed; the one open question)

| Limit                                     | Free      | Pro (US$2) | Team (US$5 a seat) | Enterprise  |
| ----------------------------------------- | --------- | ---------- | ------------------ | ----------- |
| Artifacts with data                       | 3         | 20         | 100                | 1,000       |
| Bytes per artifact                        | 10 MB     | 100 MB     | 500 MB             | 1 GB        |
| Bytes per document                        | 16 KiB    | 64 KiB     | 64 KiB             | 64 KiB      |
| Documents per collection                  | 1,000     | 10,000     | 100,000            | 100,000     |
| Collections / indexed fields per artifact | 10 / 3    | 50 / 5     | 50 / 5             | 50 / 5      |
| Rows written per artifact per day         | 20,000    | 50,000     | 200,000            | 1,000,000   |
| Rows read per artifact per day            | 2 million | 10 million | 50 million         | 200 million |
| Rows written per owner per day            | 30,000    | 60,000     | 300,000            | 2 million   |
| Rows read per owner per day               | 3 million | 10 million | 50 million         | 300 million |
| Owner SQL time per owner per day          | 5 minutes | 30 minutes | 2 hours            | 8 hours     |
| Connections per artifact                  | 25        | 100        | 500                | 1,000       |
| Live bytes sent per artifact per day      | 50 MB     | 500 MB     | 2 GB               | 5 GB        |

Safety caps (all plans): 30 writes and 60 deletes per author per minute, 300 reads per caller per minute, 4 connections per author, 6 connects per author per minute, 30 statements per artifact per minute. Team and Enterprise numbers are per owner, not per seat. New `PlanLimits` keys, read through `entitlements`; overrides apply.

### What one hostile actor can make Portifact pay, with these limits

Marginal prices past the included amounts (rows written US$1 per million, read US$0.001 per million, Durable Object requests US$0.15 per million, Worker requests US$0.30 per million); duration is near zero because objects are eligible for hibernation between requests and SQL time is budgeted. Data requests count in the owner's traffic quota, so request costs are bounded by that quota as for static files today.

| Actor                                                      | Worst hour                                                                                                                                              | Worst month                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Hostile Free owner (3 artifacts, its own visitors and SQL) | About US$0.03 in rows once its day is spent in that hour, plus requests up to its whole monthly traffic quota (1 million, US$0.45) if spent in one hour | About US$1.45 (0.9 million rows written, 90 million read, 1 million requests) |
| Hostile Pro owner                                          | About US$0.07 in rows plus up to US$0.90 of requests                                                                                                    | About US$3.00                                                                 |
| Hostile Team owner                                         | About US$0.35 in rows plus up to US$1.35 of requests                                                                                                    | About US$12 (covered by three seats)                                          |
| Hostile Enterprise owner                                   | About US$2.30 in rows                                                                                                                                   | About US$70 at the defaults; set per contract                                 |
| Hostile visitor on one Free artifact                       | At most that artifact's day: about US$0.022                                                                                                             | About US$0.66, and the artifact's writes stop for the day                     |

A visitor exhausting an artifact's day is a denial of service for that artifact's other writers until UTC midnight. Delivery 3 adds a per-author share of the day (10% proposed) so one writer cannot spend it alone; the spike does not test that share. Mass abuse across many accounts is what budget protection is for.

### Budget protection

A new step `pause_data_writes` at US$105, between `block_uploads` and `pause_annotation_writes`: page writes, owner document writes, SQL writes and copies answer `capacity_unavailable`; reads, exports, deletes and erasures keep working. From `tighten_public_traffic`, existing live connections on public artifacts are closed by a `data_connections_close` job and new ones refused; from `limit_protected_traffic`, all. `PROTECTION_STEPS` grows to five (`budget-override --steps` 1 to 5). The collector adds `durableObjectsInvocationsAdaptiveGroups` (requests), `durableObjectsPeriodicGroups` (active time and messages) and `durableObjectsStorageGroups` (stored bytes), filtered to the three classes, `REFERENCE_PRICES` gains the prices above and `PORTIFACT_RESOURCES` the two Workers (finding 25). A global admission limit on data bytes (100 GB proposed) adds `stop_new_data` (no new artifacts with data, no copies) and, past 120 GB, `pause_data_growth` (only non-growing writes).

### Arithmetic at 1,000 and 100,000 artifacts

The issue's assumptions: 5% of artifacts with data are active on a day, each with 150 reads and 50 writes; 1 MB stored per artifact on average; two browser tabs with a live connection for an hour per active artifact (60 renewals each); and, pessimistically, none of the account's included amounts left for this feature. Rows per operation are the measured production shape (a write 9, a read 1). Duration is bracketed by the active time per request `B`, which only staging can measure; idle objects are not billed.

|                                              | 1,000 artifacts                | 100,000 artifacts                   |
| -------------------------------------------- | ------------------------------ | ----------------------------------- |
| Page requests a month                        | 300,000                        | 30 million                          |
| Live renewals a month                        | 180,000                        | 18 million                          |
| Durable Object requests (both)               | inside the included million    | 47 million over: US$7.05            |
| Worker requests (both)                       | inside the included 10 million | 38 to 48 million over: US$11 to 14  |
| Rows written (600 per active artifact a day) | 0.9 million: US$0              | 90 million, 40 million over: US$40  |
| Rows read                                    | negligible                     | 0.7 billion: US$0                   |
| Stored data                                  | 1 GB: US$0                     | 100 GB, 95 over: US$19              |
| Duration, B = 5 ms                           | US$0                           | 30,000 GB-s: US$0                   |
| Duration, B = 100 ms                         | US$0                           | 600,000 GB-s, 200,000 over: US$2.50 |
| **Total**                                    | **US$0**                       | **about US$77 to 83**               |

At 100,000 artifacts data alone would exceed the US$50 objective; the largest item is rows written, so the plan numbers and the revenue at that scale decide whether it fits (the open question). At 1,000 artifacts it fits in the included amounts. A design that kept 5,000 daily active objects awake for an hour with timers would cost about US$850 a month in duration alone (the review's arithmetic), which is why no timer is allowed.

### Storage accounting (finding 17)

Every write's answer carries the object's `{ generation, revision, bytes }`; the content and app Workers keep the latest per artifact in a per-isolate `DataSizeMeter` and write it every 5 seconds, conditioned on being newer (`newerReport`: a later generation, or the same generation and a later revision), into `artifact_data`; the owner's `account_usage.data_bytes` is the sum over the owner's artifacts by a join on `artifacts.owner_id`, so a transfer moves it with the artifact. A daily scan asks objects whose report is older than a day for their size. Data counts in `accountBytes` with files: publish checks add `data_bytes`, and writes that grow are refused once the owner is over. Within the lag (seconds, a day for a report lost with an isolate) an owner can exceed `accountBytes` by what their artifacts wrote meanwhile, which each artifact's exact cap and the owner's daily write budget bound: at most 30,000 rows of writes on Free, about 25 MB. A transfer is admitted against the target's storage with the size the fence acknowledged.

## Owner SQL in the sandbox (findings 1, 2, 6, 7, 10, 12)

`POST /api/v1/artifacts/:id/data/sql/query` (scope `data:read`) and `.../sql/execute` (`data:write`), MCP `query_artifact_sql` and `execute_artifact_sql`, `portifact data sql "<statement>" [--write]`. One statement per call (`spikes/artifact-data/src/sql-guard.ts`, `sandbox.ts`):

1. **Shape allowlist.** Reads are `SELECT`; writes are `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `CREATE VIEW`, `DROP TABLE|INDEX|VIEW` and `ALTER TABLE`. Refused anywhere outside strings and quoted identifiers: `WITH` (every common table expression, recursive or not, with or without the keyword), `RECURSIVE`, `TRIGGER`, `VIRTUAL`, `TEMP`, `TEMPORARY`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, transaction words, `REINDEX`, `ANALYZE`, `LOAD_EXTENSION`. At most 16 KiB of statement, 100 parameters and 128 KiB of parameters, measured before parsing.
2. **Opcode allowlist.** The object compiles the statement with `EXPLAIN` and every opcode of SQLite's program must be on the read list (or, for a write, the write list); anything else, including an opcode a future SQLite adds, refuses the statement. Virtual table opcodes are on a never list, so table-valued functions (`json_each`) are refused in this release (question 5).
3. **Read-only execution, independent of 1 and 2.** A read runs inside a transaction that is always rolled back, and is refused if SQLite reports any row written (spike: `readOnlyProbe` runs a `DELETE` and a `CREATE TABLE` without the classification; both are refused and nothing changed).
4. **Every execution is charged** (rows estimated before, actual after), and over the artifact's size only statements that do not grow the database commit.
5. **After a write**, no trigger and no virtual table may exist in the schema (defense in depth for 1).
6. **Results** use one typed wire form per SQL type (numbers, text, `null`, `{ $int }` for integers beyond 2^53, `{ $blob }` base64, `{ $omitted: bytes }` past 64 KiB) and stop at 1,000 rows or 1 MiB measured in serialized bytes (finding 7; spike: `zeroblob(2000000)` comes back as `{ $omitted: 2000000 }`).

The sandbox has no reserved SQL objects: its fence, budgets and the list of copies are in the object's key-value store, which SQL cannot read or reference (spike: reading `__cf_kv` fails, and a foreign key to it cannot be satisfied). Foreign keys, views and indexes among the owner's own tables are the owner's to design; they cannot reach documents.

**One bad statement.** SQLite has no statement timeout and an object runs one request at a time. The spike's 8,000-row self-join (64 million rows) ran 1.3 to 1.5 seconds and held another statement on the same sandbox as long; in workerd a documents read waited too, because every object there shares one thread. In production the sandbox is an object of another Worker (`portifact-sql`), so it shares no isolate with documents; whether several sandboxes share an isolate, and what `limits.cpu_ms: 1000` does to a statement, the object's queued requests and its sockets, only staging can show. This record therefore claims no hard containment: the bounds are the CPU limit (unverified), the 30 statements a minute, the owner's SQL time per day, the row budgets and the refusal of recursion.

**Discovery.** `describe_artifact_data` (MCP), `GET /api/v1/artifacts/:id/data` and `portifact data describe` return collections, the sandbox's tables, views, indexes and copies, and the limits.

## Live updates (findings 8, 14)

- A connection goes through every check of a page request; the Worker forwards it to the documents object with the envelope and the caller it decided, including an **absolute deadline** never later than what the grant claims, the link session's claims or the read session allow (at most 60 seconds), links included. The deadline lives in the connection's attachment, so it survives hibernation.
- The object checks the deadline **before every send and every message it processes**, and keeps one stored **alarm** at the earliest deadline, which closes expired connections with code `4001` (spike: a connection with a deadline 50 ms away is closed by the alarm, and the alarm reschedules only for open connections). Nothing uses a timer.
- **Renewal**: the client posts `/__portifact/data/live/renew` with its socket ID before the deadline; the Worker renews the claims (the same 60-second check as any request) and calls `renew`, which extends only that connection and checks the envelope (spike). A missed renewal closes the connection, and the client reconnects and catches up with its last sequence.
- **Who receives what**: subscriptions per collection, only collections the connection may read; in `own` mode only the author's own connections are candidates (spike).
- **Bounds**: messages in at most 1 KiB and 20 a minute per connection, else closed `4008`; bytes out at most 256 KiB a minute per connection, else closed `4009`; at most 6 connects per author per minute (durable), 4 connections per author and the plan's per artifact; bytes sent are added to the artifact's day (`live_bytes`) and charged to the owner's traffic by the Worker from the object's daily total (spike: each bound).
- **Lifecycle**: a hold closes every connection at the fence (`4003`, spike); suspension, archiving, narrowing access, a transfer, a lapsed plan, the live switch going off or budget protection's traffic steps close them through `data_connections_close`, and the 60-second deadline bounds any that the job reaches late.

## Lifecycle (findings 4, 5, 17, 27)

- **Publish and rollback** never touch the objects.
- **Archive, suspension.** Not servable: page requests answer like a missing artifact; the epoch rises and connections close. The owner side may read, export and erase, not write.
- **Legal hold.** The barrier above: both objects refuse everyone but operator commands until release; a prepared erase is cancelled; erasure jobs wait. Only the operator reads the data: `data-export <id>` writes a `data_operator_export` job that exports to the region's bucket under `system/data-exports/<id>/<time>.jsonl`. Account erasure owed for documents on a held artifact is deferred to the `legal_hold_release` job, as for comments.
- **Transfer** (same region only): the objects stay and keep their names; the epoch rises; the fence is acknowledged before the transfer answers; data, collections and visitor IDs move with the artifact; `data_writers` resets to `signed_in`; grants stay (the control said so) and the Privacy Policy says so; storage accounting follows the owner join.
- **Purge, account and workspace deletion.** The two-step erase above, for both objects, in the jobs of the existing paths.
- **The author journal** (finding 5). Before a grant's code is issued, the app writes `system/data-authors/<user ID>/<artifact ID>` (`{ visitorId, region, firstGrantAt }`) to the artifact's region's bucket; nothing can be written under that grant before the journal entry exists. Account deletion lists the account's prefix in every region's bucket and writes one `erase_data_author` job per entry; the job runs `eraseAuthorChunk` (500 documents a call, resumable, spike) on the documents object and then deletes the journal entry. The journal is in R2, so a D1 restore does not rewind it.
- **The object inventory.** Before the first declaration on an artifact, the app writes `system/data-objects/<artifact ID>` to the region's bucket.
- **D1 Time Travel restore.** The objects and the R2 journals are not rewound. After `apply-tombstones` puts holds back first, it: re-runs account deletions, which find their authors in the journal; writes an erase job for every inventory entry whose artifact the restore removed or tombstoned; and runs `data_reconcile_fence` on every inventory entry, which reads each object's fence and raises the D1 generation and epoch to at least the object's (a restore rewinds D1's numbers below the objects', and until reconciled the object refuses the stale envelopes, so data paths answer `503` for those artifacts, never wrong data). The grants in D1 are rewound; grants revoked after the restore point would come back, so revocations write a `data_grant` window tombstone (`WINDOW_TOMBSTONE_KINDS`), re-applied like the other window markers.
- **Point-in-time recovery** of objects is not offered to owners (decision 13) and not used in operations: it would bring back erased documents.
- **Plan grace.** A lower plan refuses new work above its limits and deletes nothing; reads, exports and erasures always work. The new limits are capacity limits, not retention, so none goes in `GATED` or `IN_GRACE`.

## Interfaces, scopes and parity (finding 23)

Two new OAuth scopes, `data:read` and `data:write`, and a new role action `data` (admins and editors; in `TOKEN_ACTIONS`). Existing tokens gain nothing: a service token reaches artifact data only after an admin adds the scopes to it on the dashboard's service token page (a new control, audited as `service_token.scopes_changed`); MCP clients and the CLI ask for them by step-up. Service tokens still authenticate only to the API and the CLI, never MCP. The token's artifact restriction applies as everywhere.

| Operation                          | API                                                     | MCP                                                             | CLI                                    | Scope                     |
| ---------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- | ------------------------- |
| Describe                           | `GET /api/v1/artifacts/:id/data`                        | `describe_artifact_data`                                        | `portifact data describe`              | `data:read`               |
| Declare or change a collection     | `PUT …/data/collections/:name`                          | `set_artifact_collection`                                       | `portifact data collection set`        | `data:write`              |
| Delete a collection                | `DELETE …/data/collections/:name?confirm=`              | `delete_artifact_collection`                                    | `portifact data collection delete`     | `data:write`              |
| Query, get documents               | `GET …/data/collections/:name/documents`                | `list_artifact_documents`, `get_artifact_document`              | `portifact data list`, `get`           | `data:read`               |
| Create, replace, delete a document | `POST`, `PUT`, `DELETE …/documents`                     | `put_artifact_document`, `delete_artifact_document`             | `portifact data put`, `delete`         | `data:write`              |
| SQL read, write                    | `POST …/data/sql/query`, `…/execute`                    | `query_artifact_sql`, `execute_artifact_sql`                    | `portifact data sql [--write]`         | `data:read`, `data:write` |
| Copy a collection to the sandbox   | `POST …/data/copies`                                    | `copy_artifact_collection`                                      | `portifact data copy`                  | `data:write`              |
| Export                             | `GET …/data/export`                                     | `export_artifact_data` (pages)                                  | `portifact data export`                | `data:read`               |
| Erase an author, erase all         | `DELETE …/data/authors/:visitorId`, `POST …/data/erase` | `erase_artifact_data_author`, `erase_artifact_data` (`confirm`) | `portifact data erase-author`, `erase` | `data:write`              |
| Who writes from the page           | `PATCH /api/v1/artifacts/:id/access` with `dataWriters` | `set_artifact_data_writers`                                     | `portifact access data-writers`        | `artifacts:share`         |

One service per operation in `packages/services`, parity tests, every tool in `TOOL_SCOPES`, the terms classification for each route and tool (reads, exports, deletes and erasures open; declarations, writes, SQL writes, copies and widening closed), destructive tools with `confirm`, widening tools telling the agent to ask first, and descriptions marking documents, names and SQL results as untrusted data. The dashboard's Data section (collections, writers, a read-only browser, copies, export, erase) and the new grant control and pages go through every catalog and [accessibility.md](../accessibility.md).

## Exports (finding 20)

`GET …/data/export` streams JSON Lines with the cursor in `Portifact-Next-Cursor`, never built in memory:

- A manifest line first: `{ "type": "manifest", "format": "portifact-artifact-data", "version": 1, artifact, generation, revisionAtStart, collections: [{ name, mode, uniqueKey, indexed, documents }], sandbox: { schema: [{ type, name, sql }], copies }, skipped: [...] }`.
- Documents in primary key order (`collection`, `_id`), each `{ "type": "document", collection, document }` with its server fields.
- Sandbox rows table by table in primary key or `rowid` order (tables `WITHOUT ROWID` by their key), each `{ "type": "row", table, values }` in the typed wire form; views and indexes as their SQL in the manifest.
- A final line `{ "type": "end", revisionAtEnd, consistent }`: `consistent` is true when no mutation happened between start and end (same revision); otherwise each page was read consistently but the whole was not, and the client may restart. Pages resume after the last key, so a restart never duplicates.

`portifact export` and "Download your data" include each artifact's file through the same route, and `collectArtifactRecords` gains a `data` part (`{ skipped }` when held or switched off). The account export lists the artifacts where the account granted (from the journal) and the grants, not other people's data. A grant holder's own export is `/__portifact/data/mine`, and through the rights request page.

## Audit (finding 21)

Owner-side mutations (collection changes, owner document writes, SQL writes, copies, erasures, the writers setting) write an audit obligation (`pf_audit`, or the sandbox's key-value store) in the object transaction that makes the change, under the operation ID. The app Worker writes a `data_audit_relay` outbox row in D1 before calling the object; after the call it inserts the audit event (idempotent on the operation ID) and acknowledges the obligation; if it dies in between, the job asks the object `auditFor(opId)` and does the same; an operation that never committed has no obligation and the job ends (spike: obligations are written for owner mutations and SQL, never for visitors, and acknowledged). Details are counts and kinds only: never a body, a statement, a filter or a visitor ID. Visitors' writes are not audited.

## Moderation and law (findings 18, 19)

### Controller, processor and the deletion boundary

The owner decides what their artifact collects and why: the owner is the controller of what visitors write into it and Portifact its processor, under the Data Processing Addendum, as for the artifact's files. The Terms give Portifact the owner's standing instruction to (a) erase, when an account is deleted, the documents that account's grants created, and (b) let a grant holder delete and export the documents their grant created, at any time. That is the boundary, stated plainly in the Terms, the Privacy Policy and the grant control:

- **Covered**: documents a person's grants created (`_by`), on every artifact, in every collection mode.
- **Not covered**: copies the owner side made into the sandbox; other people's later edits of the person's document in `shared` mode (the document goes with its creator; a person's edits of someone else's document stay with that document); anything the owner exported or retyped elsewhere.
- **How a person asks for the rest**: the dashboard's rights request page (`/data-requests`, session only) lists every artifact the journal names for the account, including ones it can no longer open, and sends the owner's admins a notice (the `data_rights_request` outbox job, through the existing email rules) naming the artifact and the request kind, never the content; Portifact's processor assistance (Article 28) is to forward, record and remind, not to decide. An anonymous grant holder asks the same way with the grant's receipt ID the control showed.

### Reports, suspension and the operator

Reports may name a collection, a document ID and a revision; the report page says visitor-submitted content counts. Suspension fences both objects at once. The operator reads one artifact's data with `data-export`, erases it with `data-erase`, one document with `data-erase-document` and one author with `data-erase-author`, each with a statement of reasons where it affects the owner (`moderation_decisions`), and preserves evidence with a hold. The runbook says `_by` is session attribution.

### Legal texts (a new `TERMS_VERSION`)

Until the switch is on, each page describes the feature under "Features not yet available".

- **Terms.** "It runs no builds, servers or databases for your content." becomes false. New text: artifact data, the owner's responsibility for what their artifact collects and for telling visitors, the owner as controller, the standing instruction above, the deletion boundary, the limits, capacity protection, and that data moves with a transferred artifact.
- **Privacy Policy.** A new category: data visitors write into artifacts (whatever the owner's page collects), the per-artifact visitor ID, the display name the person chose to share, grants, the author journal; retention (until erased by the owner, the person's grant or account deletion, or purge); location (the default region's objects with a western North America location hint, not guaranteed, and the EU jurisdiction for EU workspaces); that the managers of an artifact read what is written there and that it moves with the artifact; the cookies `__Host-pf_grant` and its transaction cookie.
- **Data Processing Addendum.** Visitor-submitted artifact data in the processing description and Annex I; Annex III's location for Durable Objects; the standing instruction; assistance with data subject requests through the rights request page.
- **Acceptable Use Policy.** No collecting passwords, payment card data or government identifiers; no special categories of data or children's data without a lawful basis; no file hosting, pastebins or message relays through documents; no tracking visitors across artifacts or sites; no command channels for software.

## Switches and what turning each off does (finding 26)

| Switch (app and content Workers) | Off means                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARTIFACT_DATA_ENABLED`          | Page data paths answer `404`; owner routes answer `404` except export and erasure, which keep working for data that exists; cleanup jobs always run.  |
| `DATA_PAGE_WRITES_ENABLED`       | Page writes answer `503 capacity_unavailable`; reads, the grant holder's own deletes and exports keep working; no new grants for writing.             |
| `DATA_SQL_ENABLED`               | SQL and copies answer `503`; the sandbox stays, is exported (the export reads it directly) and erased with the artifact.                              |
| `DATA_LIVE_ENABLED`              | New connections are refused; a `data_connections_close` job closes open ones within a minute, and their 60-second deadline closes any the job misses. |
| `DATA_ANONYMOUS_ENABLED`         | No new anonymous grants; existing ones stop renewing, so their writes stop within 60 seconds; their documents stay.                                   |

Never in a deployed `wrangler.jsonc` until the release checks of each pass.

## Cross-cutting rules

- **Owners and roles**: the `data` role action through `can`; the owner side resolves the actor on the artifact's owner (`authorizeOn`) and conditions later D1 writes on the `owner_id` it read; the object's epoch covers what D1 cannot condition.
- **Regions and `TABLE_HOMES`**: `artifact_data`, `data_grants` and `data_grant_codes` are regional; the journals live in the region's bucket; jobs run in the artifact's region; nothing crosses regions.
- **D1 batches and the outbox**: every follow-up (fence, erase, author erase, connections close, size check, audit relay, copy, operator export, rights request, fence reconciliation) is an outbox job written in the batch of its cause.
- **Tombstones and restore**: covered under "Lifecycle"; new window kind `data_grant`.
- **Plans, grace and budget protection**: covered above; no feature gate.
- **Traffic metering**: data requests and live bytes count in the owner's traffic; no D1 write per request.
- **Comment visibility**: not involved.
- **Service tokens**: new scopes, granted per token; never the page.
- **Legal holds, suspensions, exports, deletions, transfers, the terms gate, i18n, accessibility**: covered above.
- **Logs**: `logEvent` only, with IDs, counts and enums; never a document, statement, filter, visitor ID or name.

## Threat model

| Attacker                            | Tries                                                                    | What stops it                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A visitor                           | Read or change another visitor's `own` documents by ID, filter or cursor | The object binds the grant's visitor ID into every statement in `own` mode; `own` queries cannot name an author (spike).                                |
| A visitor                           | Spend the artifact's or the owner's budget                               | Durable per-author minute rates, the artifact's day, the owner's leased day, all charged before work and kept on refusal (spike).                       |
| A visitor                           | Scan with an empty or sparse query                                       | Seek-bounded shapes only (spike: at most 26 rows for an empty match at 100,000 documents).                                                              |
| A visitor                           | Flood the live channel                                                   | Message size and rate, bytes out per minute, connects per minute, connection caps, deadlines (spike).                                                   |
| A visitor                           | Learn other authors' activity                                            | Scoped sequences; residual timing and shared-budget channels documented.                                                                                |
| A share link visitor                | Write or get an identity                                                 | A link is never a grant; it only reads.                                                                                                                 |
| The artifact's own page, hostile    | Learn who is there, or write as a person, without consent                | No grant, no identity: `me` says `granted: false` for everyone; review and read sessions never authorize writes.                                        |
| A sibling artifact                  | Plant its own identity in a victim's browser (fixation)                  | The grant code redeems only with the transaction nonce of the browser that began it (spike); grant cookies are host-only and sealed.                    |
| A sibling artifact                  | Call another artifact's data API                                         | Same-origin API gate; handoffs accept only `cross-site` navigations from the app (spike).                                                               |
| The owner                           | Read visitors' data                                                      | By design: the owner is the controller; the grant control tells visitors.                                                                               |
| The owner                           | Block erasure, rewrite authorship or skip caps with SQL                  | SQL runs in the sandbox, which does not hold the documents (spike: finding 2).                                                                          |
| The owner                           | Write through the read call, recurse, return huge values                 | Allowlists, read-only rollback, typed byte caps (spike: findings 1, 6, 7).                                                                              |
| The owner                           | Spend Portifact's budget with SQL                                        | Row budgets charged before and after each statement, SQL time per day, 30 statements a minute (spike: rows); the CPU limit's effect is a staging check. |
| A workspace member below editor     | Read every visitor's data                                                | No `data` action; in the page, a visitor like anyone.                                                                                                   |
| A stale or misrouted Worker request | Act after a transfer, hold or erase, or on the wrong artifact            | The envelope: artifact, region, generation, epoch, checked by every method (spike: findings 4, 27).                                                     |
| An erase job retried late           | Delete data created after it                                             | Erases target their generation, in two steps cancelled by a fence (spike).                                                                              |
| A D1 restore                        | Lose erasures owed or revive revoked grants                              | R2 journals and inventory, reconciliation of fences, window tombstones for revocations.                                                                 |
| A service token                     | Read visitor data it was not meant for                                   | New scopes, granted per token by an admin.                                                                                                              |
| An agent acting on untrusted text   | Erase, widen writers, make a collection `shared`                         | `confirm`, ask-first tool descriptions, untrusted-data notes.                                                                                           |

## Deliveries (finding 26)

Each delivery is disabled by default, reviewable alone, and updates `AGENTS.md`, `docs/security.md`, `docs/operations.md`, `docs/releasing.md`, the skill and the catalogs it touches.

| #   | Delivery                                                                                                                                                                                                                                                                                                            | Depends on | Acceptance                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This record and the security section                                                                                                                                                                                                                                                                                |            | Review.                                                                                                                                                                                                   |
| 2   | Fencing core: `portifact-data` with `ArtifactDocuments` (no routes), the envelope, `artifact_data` with generation and epoch, the two-step erase, fences, operation IDs, the R2 author journal and object inventory, purge, account and workspace deletion jobs, the restore steps, holds and transfers as barriers | 1          | Workerd tests of every fencing case in this record; a restore drill on staging with an object created and an account deleted after the restore point; nothing reachable by users.                         |
| 3   | Budgets: `pf_day`, `OwnerLedger`, the plan limits, the per-author share, budget protection's steps, the collector's metrics                                                                                                                                                                                         | 2          | Tests of every budget; a staging load that tries the hostile-owner and hostile-visitor patterns and stays within the table above; measured active time recorded here.                                     |
| 4   | Owner document API: services, API, MCP, CLI, `data:read` and `data:write`, the service token scope control, audit relay, export v1, the dashboard's read-only Data section                                                                                                                                          | 3          | Parity, audit coverage, terms classification, export round trip, held and transferred artifacts, accessibility of the dashboard section.                                                                  |
| 5   | Owner SQL: `portifact-sql` with `ArtifactSandbox`, the allowlists, copies, SQL time budget, `DATA_SQL_ENABLED`                                                                                                                                                                                                      | 4          | The spike's SQL tests in the product; staging: a statement past `cpu_ms`, what queued requests and sockets see, whether sandboxes share isolates.                                                         |
| 6   | Grants and page reads and writes: the grant flows in the viewer and the popup, the control, the dashboard's "Data you shared" and rights request pages, the content Worker's routes, the client script, `DATA_PAGE_WRITES_ENABLED`                                                                                  | 4          | e2e in Chromium, Firefox and WebKit with third-party cookies blocked (grant in the frame, popup fallback, fixation refused, revocation within 60 seconds, a sibling's calls refused), axe on the control. |
| 7   | Live updates: the WebSocket route, deadlines, alarms, renewal, bounds, `DATA_LIVE_ENABLED`                                                                                                                                                                                                                          | 6          | Spike tests in the product; staging: zero active time with idle hibernated connections; deadlines across hibernation.                                                                                     |
| 8   | Anonymous writers and `read` and `shared` from the page: anonymous grants, Turnstile on the app, per-IP limits, the workspace policy `anonymousData`, `DATA_ANONYMOUS_ENABLED`                                                                                                                                      | 6          | Tests of the policy and limits; e2e of the anonymous flow.                                                                                                                                                |
| 9   | Legal texts, the new `TERMS_VERSION`, release checks, switches on together (decision 15)                                                                                                                                                                                                                            | 2 to 7     | The legal checklist in `docs/legal.md`; every staging check of this record done and its result written here.                                                                                              |

The first release switched on is deliveries 2 to 7 and 9 (decision 15): nothing is switched on before all of them are ready. Honest estimate, per delivery in working days for one engineer with review: fencing core 8 to 10, budgets 5 to 7, owner document API 8 to 10, owner SQL 6 to 8, grants and page 10 to 14, live updates 5 to 7, legal texts and release checks 4 to 6; **46 to 62 working days** (about 10 to 13 weeks) for the first release, plus 4 to 6 for anonymous writing (delivery 8) if it ships at launch. That is roughly three times the issue's 16 to 22: fencing, budgets, the grant and the second object are work the first version did not count, and a staging check can send a delivery back.

## What the spike proves (73 tests in workerd, `bun run spike:artifact-data`)

- **Review counterexamples.** Twelve tests reproduce findings 1, 2, 4, 6, 7, 10, 11, 12, 13, 15, 16 and 27. They fail on the first spike (commit `af82ab12` adds them alone) and pass on the redesign.
- **Two Workers, one object.** The documents class is exported by one Worker and reached from another by `scriptName`; a read of an artifact without data creates no tables.
- **Documents.** `own` isolation by every ID, filter and cursor; the modes; server fields; `_editedBy`; the unique key on create and replace; scoped sequences; operation ID replay.
- **Queries.** Every allowed shape reads at most 118 rows for a page of 100 and 17 to 26 for an empty or sparse match at 100,000 documents; SQLite's plans are seeks; other shapes are refused.
- **Budgets.** Minute rates with attempts counted; the artifact's day with refusals counted; the owner's day shared across two artifacts through the ledger; deletes when writing is spent; growth refused and shrinking allowed over the size.
- **Fencing.** Stale epochs after a transfer; a hold as a barrier that cancels a prepared erase; erases by generation; the envelope rule; size reports with revisions; audit obligations; chunked author erasure.
- **Sandbox.** The supported corpus runs; everything off the allowlist is refused; read-only execution holds without the classification; typed wire values with byte caps; mass updates run out of budget; copies and the erasure boundary; fences and erase by generation.
- **Live.** `own` fan-out; deadlines closed by the alarm; renewal with the envelope checked; message, byte, connect and connection bounds; closing on a hold.
- **Grants.** One-use, host-bound, browser-bound codes; fixation refused; versioned sealing keys; deadlines bounded by claims; random IDs; both gates.
- **Measurements.** Rows per operation, bytes per document, query timings and the expensive statement, in the tables above.

The spike does not run the per-author share of the day, the SQL time budget, the R2 journals, the D1 side of fencing, the grant's D1 rows or any browser; those are design, and their deliveries carry their tests.

## What only staging can prove

- **Jurisdictions and location hints**: that EU objects are created and served in the EU and default ones land near `wnam`.
- **The CPU limit**: what `limits.cpu_ms` on `portifact-sql` does to a statement, to requests queued on the same object and to its sockets; whether requests arriving during a statement extend it.
- **Isolate sharing**: whether sandboxes of different artifacts share an isolate (the spike's workerd shows one thread for everything).
- **Billing**: active time per request with hibernation-eligible objects, idle WebSockets at zero duration, the analytics fields the collector reads, and the real invoice against the arithmetic above.
- **Browsers**: partitioned grant cookies in the viewer's frame with third-party cookies blocked, in all three engines; the popup fallback; WebSocket handshakes' `Origin` and fetch metadata.
- **Deploys**: `script_name` bindings across the five Workers, the deploy order, refused rollbacks past `v1`.

## Review findings

| #   | Finding                                                | Answer                                                                                                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Read-only SQL wrote through a virtual table            | Sandbox: virtual tables refused by word and opcode; reads run in an always-rolled-back transaction, refused if any row was written. Spike test 1 failed, now passes.     |
| 2   | Owner foreign key blocked erasure                      | Documents are not in the sandbox. Spike test 2 failed, now passes.                                                                                                       |
| 3   | Planted review cookie as write identity                | Writes need a grant; the grant code is bound to the browser's transaction nonce. Spike: fixation refused.                                                                |
| 4   | Unfenced erase, hold and transfer races                | Envelope with generation and epoch; two-step erase; acknowledged fences. Spike test 4 failed, now passes; hold and transfer tests.                                       |
| 5   | Lossy author index, restore gaps, unbounded erase      | R2 author journal written before the grant code, object inventory, restore steps, chunked erase. Spike: chunked erase.                                                   |
| 6   | Recursion without the keyword; CPU limit not a sandbox | `WITH` refused entirely; containment claims removed; CPU limit a staging check. Spike test 6 failed, now passes.                                                         |
| 7   | Binary results bypass the cap                          | Typed wire form, bytes measured per value and per result. Spike test 7 failed, now passes.                                                                               |
| 8   | Socket authorization past the window                   | Absolute deadline from the claims, in the attachment, checked before every send and receive, alarm at the earliest. Spike: alarm close, renewal.                         |
| 9   | `/me` disclosed identity, writes without consent       | `me` says only `granted: false` without a grant; identity only through the control on the app origin.                                                                    |
| 10  | Hostile owner spend; refused attempts not counted      | Durable work budgets per author, artifact and owner, charged before work and kept on refusal; SQL rows trued up. Spike test 10 failed, now passes; mass update runs out. |
| 11  | Empty-result scans of 100,000 rows                     | Seek-bounded shapes with named indexes. Spike test 11 failed, now passes; 100,000-document measurements.                                                                 |
| 12  | Cleanup refused over quota                             | Non-growth rule in both objects; deletes with their own allowance. Spike test 12 failed, now passes.                                                                     |
| 13  | Unique key broken by replacement                       | Recomputed and re-checked on replace, scalar types defined. Spike test 13 failed, now passes.                                                                            |
| 14  | Live channel unbounded                                 | Message size and rate, bytes out, connects per minute, caps, traffic accounting, closing under protection. Spike: each bound.                                            |
| 15  | Global sequence leaks activity                         | Sequences scoped to the author in `own`, the collection elsewhere; residual channels documented. Spike test 15 failed, now passes.                                       |
| 16  | Handoff gate refused its own callback; viewer flow     | A separate handoff gate; frame flow with partitioned cookies and a popup flow. Spike test 16 failed, now passes.                                                         |
| 17  | Size reports could regress; overshoot                  | Reports carry generation and revision, applied only when newer; owner join; quantified overshoot. Spike: `newerReport`.                                                  |
| 18  | Erasure promise too broad                              | Boundary stated (created documents only), the owner's standing instruction, rights request page for the rest. Spike: a copy survives author erasure.                     |
| 19  | `_by` as proof                                         | Described as session attribution; `_editedBy`; reports name the revision.                                                                                                |
| 20  | Export format incomplete                               | Versioned manifest, typed values, schema, stable order, consistency flag, the holder's own export.                                                                       |
| 21  | Audit lost after commit                                | Obligation in the object's transaction, D1 intent row, idempotent relay. Spike: obligations.                                                                             |
| 22  | Terms for visitor sessions                             | Grant renewal requires the current terms for writing.                                                                                                                    |
| 23  | Existing tokens gain access                            | New scopes, granted per token by an admin.                                                                                                                               |
| 24  | ID claims too strong; no rotation                      | Random IDs stored in the journal; what is and is not protected stated; versioned cookie keys with rotation. Spike: key rotation.                                         |
| 25  | Cost premise wrong                                     | Hibernation facts corrected, alarms only, measured production rows, renewals included; staging measures active time.                                                     |
| 26  | Deliveries too coupled                                 | Nine deliveries with dependencies, acceptance and five switches.                                                                                                         |
| 27  | SQL reads skipped the reference check                  | One envelope checked by every method. Spike test 27 failed, now passes.                                                                                                  |

## Alternatives rejected

| Option                                      | Why not                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| One object with a SQL allowlist (shape (a)) | Its safety rests on the classifier being exact forever; an expensive statement still holds the visitors. |
| Identity from review or read sessions       | A session can be planted (decision 0002); a page would learn identity without consent.                   |
| An HMAC-derived visitor ID                  | A key compromise would link IDs to accounts; a random ID stored in the journal needs no key.             |
| Memory-only budgets                         | Reset on eviction; refused attempts would be free.                                                       |
| JavaScript timers for socket expiry         | Keep objects billable.                                                                                   |
| The object writing D1 itself                | Gives the class Workers every region's database; the per-isolate meters already have the pattern.        |

## Open questions for the maintainer

The maintainer answered the other questions of this record's second version (decisions 15 to 22). One remains, plus four engineering choices with a recommendation that the record follows unless the maintainer says otherwise.

### The plan limits (open)

How the numbers were chosen: the cost model shows that typical use is bounded by rows written (9 per document write, 1 per read in the measured production shape) and storage, and that abuse is bounded by the daily row budgets per artifact and per owner plus the existing traffic quota. Size limits alone would not bound spend: a 10 MB artifact can be rewritten all day. So each plan has both, and each budget is set so that a hostile owner's worst month stays near or under the plan's price. Three options:

|                                  | A: proposed (the table in "Plans")                                                                                           | B: tight                                                                                                                                                                                                                           | C: generous                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Free                             | 3 artifacts with data, 10 MB each; 20,000 rows written and 2 million read per artifact a day; 30,000 and 3 million per owner | 1 artifact, 5 MB; 5,000 and 500,000 per artifact a day; 5,000 and 500,000 per owner                                                                                                                                                | 10 artifacts, 25 MB; 50,000 and 5 million per artifact; 100,000 and 10 million per owner |
| Pro (US$2)                       | 20 artifacts, 100 MB; 60,000 rows written and 10 million read per owner a day                                                | 10 artifacts, 50 MB; 30,000 and 5 million per owner                                                                                                                                                                                | 50 artifacts, 250 MB; 200,000 and 30 million per owner                                   |
| Team (US$5 a seat), per owner    | 100 artifacts, 500 MB; 300,000 and 50 million per owner a day                                                                | 50 artifacts, 250 MB; 150,000 and 25 million                                                                                                                                                                                       | 200 artifacts, 1 GB; 1 million and 100 million                                           |
| Hostile Free owner, worst month  | about US$1.45 (US$0.90 rows written, US$0.10 read, US$0.45 requests)                                                         | about US$0.65 (US$0.15 rows, US$0.50 requests)                                                                                                                                                                                     | about US$3.75 (US$3 rows written, US$0.30 read, US$0.45 requests)                        |
| Hostile Pro owner, worst month   | about US$3.00, above the US$2 price                                                                                          | about US$1.95                                                                                                                                                                                                                      | about US$7.80                                                                            |
| Hostile Team owner, worst month  | about US$12, covered by three seats                                                                                          | about US$6.60, covered by two                                                                                                                                                                                                      | about US$34, covered by seven                                                            |
| Typical use at 100,000 artifacts | about US$77 to 83 a month                                                                                                    | about the same: typical use (600 rows written per active artifact a day) is below every cap, so tighter caps cut abuse, not ordinary cost; fewer data artifacts per Free owner lowers it only if those owners would have used more | about the same, with more room for abuse                                                 |
| What users feel                  | A poll, a board or a form on three artifacts works on Free; a busy board (more than about 2,000 writes a day) needs Pro      | One small app on Free; a class or a team board needs Pro                                                                                                                                                                           | Free covers most hobby apps; Pro is rarely needed for data                               |

**Recommendation: A for launch**, revisited after staging measures active time and after the first months of real use. B is the safest against abuse but makes the Free tier a demo; C invites the abuse budget protection exists to stop. Whichever is chosen, the 100,000-artifact cost is driven by rows written per write, so the levers at that scale are the design (fewer counter rows per write) and revenue, not the caps: at that scale data would exceed the US$50 objective under every option.

### Engineering choices the record follows

1. **Per-caller read rates in memory.** They shape traffic; the spend is durable. A durable per-read rate would add a row written to every read and roughly double the rows-written cost.
2. **Safari and partitioned grant cookies.** If WebKit refuses the partitioned grant cookie in the viewer's frame, the popup flow serves there, as the review tab is the fallback for review today.
3. **Table-valued functions and common table expressions in owner SQL** stay refused in the first release, until a check can prove a CTE never names itself and the read-only `json_each` family is reviewed.
4. **Owner SQL time per day.** The proposed minutes per plan are a first guess, to be set from staging's CPU-limit measurements in delivery 5.
