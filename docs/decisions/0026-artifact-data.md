# 0026 Artifact data: a SQLite database per artifact

- Status: proposed. Design only: nothing is built, and `spikes/artifact-data` proves the uncertain parts. The product decisions are the maintainer's, in [issue #194](https://github.com/leynier/portifact/issues/194); this record turns them into a design and settles the issue's open points except the ones under "Open questions for the maintainer".
- Date: 2026-11-12
- Feature: issue #194, "give each artifact its own database". Not a premium plan feature: every plan gets it, with limits per plan.

## Question

An artifact is a static site today. The maintainer wants it to be able to be a small app: its JavaScript, running in a visitor's browser, stores and reads data that outlives the visit (forms, votes, lists, boards), and the owner and their agents read and write the same data through the API, the MCP server and the CLI. How can Portifact give each artifact a database without letting a visitor reach another visitor's data, letting one artifact reach another's, letting a hostile owner or visitor spend Portifact's budget, or breaking any rule the platform already keeps (regions, deletion, restore, holds, quotas, the three interfaces' parity)?

## Decisions taken by the maintainer

These come from the issue and are fixed here:

1. **Engine.** Real SQLite, one database per artifact, in a Cloudflare Durable Object with the SQLite storage backend, created in the jurisdiction of the owner's region.
2. **Two doors.** The page uses a document API and never sends SQL. The owner side (admins and editors of the owner, and their agents and service tokens) uses the same document API plus SQL, read and write, from the first release.
3. **Identity.** The page learns an opaque visitor ID, different in each artifact, and the visitor's display name. Never the email.
4. **Who writes from the page.** The owner decides per artifact. By default, signed-in visitors who can open the artifact write. The owner can open writing to anonymous visitors of a public artifact, with limits per IP address and the human check. Share link visitors only read.
5. **Live updates** over a WebSocket from the first release.
6. **Plans.** Free with a small quota, more on paid plans, under the budget target in `docs/operations.md` (US$50 a month as an objective, automatic protection from US$100).
7. **Lifecycle.** The data belongs to the artifact, not to a version: publishing and rolling back do not touch it. It stays while the artifact is archived, counts in the owner's storage and goes when the artifact is purged or its account or workspace is deleted.

Alternatives the issue rejected, kept here for the record: Turso Cloud (a new sub-processor outside Cloudflare, no published data processing terms, an acquisition announced in October 2026, tokens scoped by table but not row), Turso's open source engine inside Workers (no storage backend for Workers or Durable Objects), D1 per artifact (no dynamic bindings, and the REST API's account-wide rate limit rules it out for visitor traffic), shared tables in the owner's regional D1 database (untrusted visitor writes in the platform's one-writer main database, sharing its size cap) and SQLite in the browser with sync (each client holds a replica and pushes changes, which does not fit untrusted writers). This record adds two more under "Alternatives rejected".

## Decision in short

- One Durable Object class, `ArtifactData`, exported by a **new Worker, `portifact-data`**, that serves nothing else and holds no other binding. The content, app and jobs Workers bind it by `script_name`. One object per artifact, `idFromName(<artifact ID>)` in the region's namespace: no jurisdiction with a `wnam` location hint for the default region, `jurisdiction("eu")` for the EU.
- The object holds reserved `pf_` tables for document collections and any tables the owner creates with SQL. It never sees an account ID, an email, a session or a plan row: the calling Worker authorizes, decides who the caller is and passes the plan's limits on every call, and the object enforces them exactly inside its own transactions.
- The page talks to `/__portifact/data/…` on its own origin, same-origin only, through the content Worker, after the artifact's authorization, the network policy, the traffic quota and budget protection, like any file. The owner side talks to `/api/v1/artifacts/:id/data/…`, MCP tools and `portifact data`, through the app Worker's usual authorization.
- Visitors are named by `v_` plus 128 bits of an HMAC of the artifact ID and the account (or an anonymous visitor cookie) under a content Worker secret: stable in one artifact, unlinkable across artifacts, irreversible.
- Owner SQL is one statement per call. A lexer refuses a second statement, recursive CTEs and triggers; SQLite's own `EXPLAIN` program decides what a statement writes, and no statement may write a reserved table or change its schema. Reads of reserved tables are allowed. The data Worker's CPU limit is what ends a statement that runs too long, so it is set low and owner SQL has its own rate limit.
- Live updates use hibernatable WebSockets on the object. A change reaches only connections that may read it; in `own` mode only the author's own connections are even considered.
- Limits per plan, an exact per-artifact size cap in the object, the size reported into `account_usage.data_bytes` (outside the CHECK constraint) within seconds, and a new budget protection step that pauses data writes.
- Shipped switched off (`ARTIFACT_DATA_ENABLED`), in seven deliveries, the first being this record.

## Facts checked

Cloudflare's documentation, read on 2026-11-12:

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): on Workers Paid, requests 1 million a month included then US$0.15 per million (HTTP requests, RPC sessions, WebSocket messages and alarms; incoming WebSocket messages count 20 to 1; a WebSocket connection is one request; outgoing messages and protocol pings are free); duration 400,000 GB-s included then US$12.50 per million GB-s, billed on 128 MB whatever the use, "as long as the Object is active and not eligible for hibernation"; SQLite rows read 25 billion included then US$0.001 per million, rows written 50 million included then US$1.00 per million, stored data 5 GB-month included then US$0.20 per GB-month. The page says SQLite storage billing starts on 2026-01-07, so it applies today. The page's own WebSocket example (100 objects, 50 connections each, one message a minute for 8 hours a day) costs US$142.95 without hibernation and its hibernation example US$20.65.
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/): 10 GB per object; unlimited objects and storage per account on Workers Paid; statements up to 100 KB, 100 bound parameters, 8 MB per string, BLOB or row, 100 columns per table, LIKE and GLOB patterns of 50 bytes; 30 seconds of CPU per request by default, configurable up to 5 minutes with `limits.cpu_ms`, and "each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds"; a soft limit of 1,000 requests per second per object; received WebSocket messages up to 32 MiB; a full object answers `SQLITE_FULL` to writes and keeps serving reads.
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): `exec` cursors report `rowsRead` and `rowsWritten`, the values billed; `exec` refuses `BEGIN` and `SAVEPOINT` (transactions go through `transactionSync`, rolled back if the callback throws); several statements separated by semicolons all run, and only the last is returned; `databaseSize`; `deleteAll()` erases SQL and KV data atomically (and the alarm with a compatibility date from 2026-02-24); point-in-time recovery to any moment of the last 30 days with `getBookmarkForTime` and `onNextSessionRestoreBookmark`, not available locally.
- [Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/): `namespace.jurisdiction("eu")` gives a subnamespace whose objects stay in the EU; "the same name [may] represent different IDs in different jurisdictions", so the same artifact ID names two different objects in two jurisdictions.
- [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/): hibernation needs the object to be the WebSocket server through `ctx.acceptWebSocket`; alarms, requests, `setTimeout` and `setInterval` prevent it; the constructor runs again on wake; `serializeAttachment` keeps up to 16,384 bytes per connection; no fixed connection cap ("thousands of clients per instance"); batch messages rather than sending many small ones.
- [Migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/): `new_sqlite_classes` creates a SQLite-backed class; the storage backend cannot change later; the newer `exports` configuration replaces `migrations`, a Worker can use only one of them, and once deployed with `exports` it cannot go back; a deleted class loses "all of its stored data permanently"; you cannot roll back to a version deployed before an `exports`-driven lifecycle change.

The code, at `develop` on the same day:

- The content Worker already exports a SQLite-backed Durable Object (`TrafficLimiter`, migration tag `v1`) and refuses every method but `GET` and `HEAD` before routing (`route` in `apps/content/src/index.ts`).
- Sites carry no script policy of Portifact's: `contentHeaders` sends only `frame-ancestors`, `nosniff`, CORP and the robots header, so a site's own script can `fetch` its own origin. Rendered Markdown and text documents run no scripts (`default-src 'none'`, "Untrusted content" in [security.md](../security.md)).
- A public artifact is served before any session is read (`artifact?.accessMode === "public"` short-circuits in `route`), so a signed-in visitor of a public artifact has no session on its origin today.
- The viewer frames an artifact with a review session for signed-in visitors, and the review cookie is honored for `same-origin` requests ("Review mode" in [security.md](../security.md)).
- Transfers are refused across regions (`transferArtifact`, `packages/services/src/transfer.ts`).
- The Terms say Portifact "runs no builds, servers or databases for your content" (`apps/web/terms.html`). The Privacy Policy already lists Durable Objects among the Cloudflare services Portifact uses and says its databases are stored "in its western North America location, which Cloudflare chose ... and does not guarantee".

## Where the class lives

### A third Worker

`ArtifactData` lives in a new Worker, `portifact-data` (`apps/data`): `main` exports the class and a `fetch` that answers 404, `workers_dev` and `preview_urls` off, no routes, no D1, R2 or queue bindings, and no secret. Three Workers bind it by `script_name`:

| Worker              | Binding         | Uses                                                                                                                                               |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portifact-content` | `ARTIFACT_DATA` | The page's document API and the live channel.                                                                                                      |
| `portifact-app`     | `ARTIFACT_DATA` | The owner side: API and MCP.                                                                                                                       |
| `portifact-jobs`    | `ARTIFACT_DATA` | Erasing (purge, account and workspace deletion, one author), closing connections after access changes, the operator's export, the size safety net. |

Why not export it from the content Worker, which already has a migration history: the CPU limit. A Durable Object runs one request at a time, workerd's SQLite has no statement timeout, and the only thing that ends a statement that runs too long is the platform's CPU limit, which `limits.cpu_ms` sets per Worker for the objects it defines. The content Worker must keep the default 30 seconds for delivery; the data Worker sets its own (1,000 ms proposed, "Owner SQL"). A separate Worker also deploys, rolls back and logs on its own, and a mistake in its configuration cannot take delivery down. It costs one more Worker in `PORTIFACT_RESOURCES` and in the release workflow; calls from another script are not billed as Worker requests, only as Durable Object requests.

The e2e Worker, which already serves both Workers in one script, exports the class itself and binds it without `script_name`.

### Configuration, deploy order and migration tags

```jsonc
// apps/data/wrangler.jsonc
{
  "name": "portifact-data",
  "main": "src/index.ts",
  "workers_dev": false,
  "preview_urls": false,
  "limits": { "cpu_ms": 1000 },
  "durable_objects": { "bindings": [{ "name": "ARTIFACT_DATA", "class_name": "ArtifactData" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ArtifactData"] }],
  "observability": { "enabled": true, "head_sampling_rate": 0.1, "logs": { "enabled": true, "head_sampling_rate": 0.1, "invocation_logs": false } }
}
// apps/content, apps/app, apps/jobs
"durable_objects": { "bindings": [ ..., { "name": "ARTIFACT_DATA", "class_name": "ArtifactData", "script_name": "portifact-data" }] }
```

- **Legacy `migrations`, not `exports`.** The rest of the repository uses `migrations` (`TrafficLimiter`), and moving a Worker to `exports` is one-way. The data Worker starts with tag `v1`; a later class is a new tag. `deleted_classes`, `renamed_classes` and `transferred_classes` are never used for `ArtifactData` (each would delete or move every artifact's data); a `scripts/` test refuses them in every `wrangler.jsonc`, like the existing `invocation_logs` check.
- **Deploy order.** The release workflow deploys `portifact-data` first, then `portifact-jobs`, `portifact-content` and `portifact-app`. A binding to a class whose script does not exist yet fails the deploy, so the order is required on the first release and harmless after. The data Worker never depends on the others.
- **Rollback.** Rolling back the content, app or jobs Worker never touches stored data. Rolling back the data Worker is allowed for code; Cloudflare refuses to roll back past the version that introduced the class (to be confirmed in staging, "Release checks"). The object's reserved schema is versioned in `pf_meta` (`schema`), migrated forward on first use inside `blockConcurrencyWhile`, and only ever changed additively (new tables, new nullable columns, new indexes), so an older build reads a newer database; a change that is not additive needs its own record.
- **Region to namespace.** One function, `dataNamespace(env, region)` in `packages/services`, is the only place a stub is made: the default region gets `env.ARTIFACT_DATA.get(env.ARTIFACT_DATA.idFromName(id), { locationHint: "wnam" })`, matching where the default D1 databases and bucket are today, and the EU gets `env.ARTIFACT_DATA.jurisdiction("eu").idFromName(id)`. A new region adds a line. Because the same name in two jurisdictions is two objects, the region always comes from the global directory (`artifact_directory`, the content Worker's `deliveryRegion`), never from input or a guess, and every call carries `{ artifactId, region }`, which the object stores on its first write and checks on every call: a mismatch is refused, so a Worker bug cannot mix two artifacts' data (spike: "refuses a call that names another artifact").
- **A read never creates storage.** The object creates its schema on the first write only; a read of an artifact without data answers empty and stores nothing (spike: "stores nothing for a read of an artifact that has no data"). The Worker also knows from D1 whether the artifact has data (`artifact_data`, below) and does not call the object at all when it has none.

## Identity

### Who the caller is

The content Worker decides the caller from Portifact's own cookies only, by exact name, in this order, the same order delivery uses:

1. A review session (`__Host-pf_review` in the viewer's frame, or `__Host-pf_review_tab`), honored only for `same-origin` requests as today. It names an account. Data requests from an artifact the viewer frames carry it, so artifacts with the Portifact bar work.
2. A read session (`__Host-pf_read`), with its 60-second claims and renewal. It names an account.
3. A link session (`__Host-pf_link`): a `reader` that names nobody and never writes.
4. A public artifact without a session: a `reader`, unless the owner opened writing to anonymous visitors and the request carries a valid `__Host-pf_visitor` cookie, which makes it an anonymous `visitor`.

Anything else answers `401` with the same body for every reason; a data request never starts a sign-in, because it is a `fetch`, not a navigation. A signed-in person on a public artifact has no session there today (public delivery reads none), so the client script's `signIn()` navigates to `/__portifact/data/sign-in`, which starts the existing read entry (`__Host-pf_read_tx_…`, `/read/<id>`, the callback) for a public artifact too; `checkReadAccess` admits anyone signed in to a public artifact, so nothing changes in the app.

Whether a named caller may write comes from the artifact's `data_writers` setting and its current access: `signed_in` (the default) lets any account that can open the artifact write; `anyone` adds anonymous visitors while the artifact is public (a non-public artifact treats it as `signed_in`, without changing the stored value); `none` makes the page read only. The owner side is never a page caller: an admin who opens their own artifact is a visitor like anyone else and sees only their own documents in `own` mode, so a page an editor wrote cannot read every visitor's data through an admin's browser.

### The visitor ID

`v_` followed by the first 128 bits of `HMAC-SHA-256(K, artifactId ‖ 0x00 ‖ subject)`, base64url, where `K` is derived with HKDF from a new content Worker secret, `ARTIFACT_DATA_SECRET` (at least 32 characters), and `subject` is `a:<account ID>` or `c:<visitor cookie value>`, so the two kinds never collide (`visitorId` in the spike). It is:

- **Per artifact.** Two artifacts get unrelated IDs for the same person, so two owners cannot correlate their visitors, and one artifact's code cannot recognize a visitor from another.
- **Irreversible.** Without the secret nobody can go from an ID to an account; with it, only by trying account IDs. The object, the page, owner SQL and exports see only the ID.
- **Stable.** The secret never rotates: rotating it would orphan every document from its author. If it leaks, IDs become linkable to accounts for someone who also knows account IDs, which are not public; nothing grants access through an ID ("An opaque ID never replaces an authorization check").

`data_authors` (below) records, for Portifact only, which account wrote in which artifact under which visitor ID, so deleting an account can find and erase its documents.

### The anonymous visitor cookie

Delivery 4 only. `__Host-pf_visitor` holds 128 random bits, sealed with `seal` under its own purpose (`apps/content/src/cookies.ts`), `Secure; HttpOnly; SameSite=Strict; Path=/`, host-only, one year. It is added to `isPortifactCookie`, and `imitatesPortifact` grows `pf_visitor`, so a sibling's look-alike is cleared at any size and grants nothing. It is issued only by a one-use handoff after the human check: the client script's `becomeVisitor()` navigates top-level to `app.portifact.com/data-visitor/<id>`, which runs Turnstile (the widget's hostname is `app.portifact.com` only, so it cannot run on an artifact origin), counts the issue per IP in the D1 rate limits, and redirects to `/__portifact/data/visitor?code=…`, redeemed like `/__portifact/link`: a `GET` top-level `cross-site` navigation, one guarded update, the cookie, a redirect to the stored path. The cookie names nobody: losing it loses the documents' authorship, and the owner keeps them.

### What the page learns

Only by asking: `GET /__portifact/data/me` answers `{ visitor: { id, name } | null, canWrite, writers, collections: [{ name, mode, uniqueKey, indexed }], live, limits: { documentBytes, writesPerMinute } }`. `name` is the account's display name, read from the global `users` row on this call only (one D1 read), and stored in the object's `pf_authors` so the owner side can show who wrote; an anonymous visitor has no name. Nothing is injected into the page: no global, no cookie readable by script, no header. The email address never reaches the content Worker's data paths, the object or the page.

## Requests from the page

### Routes

All on the artifact's own origin (`<id>.portifact.dev` and, while it holds, its custom domain), reserved like the rest of `/__portifact/` (manifests already refuse the prefix), added to the list in "Origins", and never redirected to the viewer:

| Method and path                                              | What                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `GET /__portifact/data/me`                                   | The caller as above.                                            |
| `GET /__portifact/data/c/<collection>?q=<JSON>`              | A query (filters, order, limit, cursor), at most 4 KiB of `q`.  |
| `GET /__portifact/data/c/<collection>/<id>`                  | One document.                                                   |
| `POST /__portifact/data/c/<collection>`                      | Create. JSON body, the document.                                |
| `PUT /__portifact/data/c/<collection>/<id>`                  | Replace the body.                                               |
| `DELETE /__portifact/data/c/<collection>/<id>`               | Delete.                                                         |
| `GET /__portifact/data/live`                                 | The WebSocket.                                                  |
| `GET /__portifact/data/sign-in?to=<path>`                    | Navigation: starts the read entry, also on a public artifact.   |
| `GET /__portifact/data/visitor?code=…`                       | Navigation: redeems the anonymous visitor handoff (delivery 4). |
| `GET /__portifact/data.js`, `/__portifact/data.<version>.js` | The client script, like the diagram script.                     |

The data paths are routed before the method check that refuses everything but `GET` and `HEAD`, which stays in force for every other path.

### Order of checks

For every data request except the script, in this order, so a refusal before authorization reveals nothing and charges nothing:

1. **Switch.** Without `ARTIFACT_DATA_ENABLED="true"` on the content Worker, `404` as for any unknown path.
2. **Gate** (`dataGate`, spike `src/gate.ts`): `Sec-Fetch-Site: same-origin` on every request; on writes, the exact origin in `Origin` and `Content-Type: application/json`; on the WebSocket handshake, the exact origin in `Origin`. No fetch metadata fails closed. Sibling artifacts are same-site but never same-origin, so their requests, navigations, forms and WebSockets are refused here, whatever cookies they carry.
3. **The artifact.** The existing directory lookup and delivery lookup (`lookupDelivery`, one D1 read, cached per isolate where it is today), which also selects `data_writers`, whether an `artifact_data` row exists, the owner's `stored_bytes` and `data_bytes`, and the plan it already joins. Not servable (archived, expired, suspended, held, without a version) answers like a missing artifact. No `artifact_data` row answers `404` without calling the object.
4. **Identity** as above, with the read and review sessions' existing renewal.
5. **Network policy** (`networkDecision`), as `serve` applies it.
6. **Traffic quota** (`trafficExhausted`), then **budget protection**: the traffic steps exactly as delivery, and for writes the new `pause_data_writes` step (`503 capacity_unavailable`).
7. **Owner storage** for writes that can grow: `stored_bytes + data_bytes` at or over the plan's `accountBytes` answers `quota_exceeded` (eventual, see "Quotas").
8. **The object**, with the caller, the plan's data limits and the request.
9. **Metering**: the request is charged to the owner's traffic through the per-isolate `TrafficMeter` (request count and response bytes; no D1 write per request), and the size the object returned goes to the per-isolate `DataSizeMeter` ("Quotas").

Responses are JSON with `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff` and `X-Robots-Tag: noindex`, never CORS headers, and errors as `{ error: { code, message } }` with the documented codes (`unauthenticated`, `forbidden`, `not_found`, `invalid_input`, `conflict`, `rate_limited`, `quota_exceeded`, `traffic_exceeded`, `capacity_unavailable`). Data requests are never page views, openings or analytics.

### CSRF and cookies

Every write needs `Sec-Fetch-Site: same-origin`, the exact `Origin` and a JSON content type, which no cross-origin form, image or navigation can produce, and a cross-origin `fetch` with JSON is preflighted and gets no CORS answer. The read, review and link cookies are host-only, so another artifact never holds them; the review cookie is honored only for same-origin requests already. A cookie a sibling sets with `Domain=portifact.dev` is foreign and grants nothing ("Injected cookies").

### Content security policy

Sites get no new policy: their own script calls their own origin, which `connect-src` would allow anyway. If an owner ships a policy without `'self'` in `connect-src`, their page cannot use the API; that is their choice. Review mode keeps its header policy, which governs the artifact's scripts only through `script-src` (the bridge's nonce), so the client script loaded by the page from its own origin is allowed exactly when the page's other same-origin scripts are; the e2e suite checks the review frame. Rendered Markdown and text documents run no scripts and their policy is `default-src 'none'`, so they cannot use artifact data, and this design does not change them.

### Custom domains

On an artifact's custom host the routes are the same and same-origin means the custom host. Read and review sessions there already redeem only on the host they were issued for. The anonymous visitor cookie is per host, so a visitor who used both hosts has two IDs; the owner sees two authors. Accepted, and stated in the skill.

## The document model

### Collections

The owner side declares collections, never the page: `PUT /api/v1/artifacts/:id/data/collections/<name>` with `{ mode, uniqueKey?, indexed? }`. Names are 1 to 32 of `a-z`, `0-9` and `_`, starting with a letter. A collection has:

- **A mode**, one of four:
  - `own` (the default): a visitor creates documents and reads, changes and deletes only their own; a reader sees nothing; the owner side sees all.
  - `append`: everyone who can open the artifact reads every document; each writer creates, and changes and deletes only their own.
  - `read`: everyone who can open the artifact reads; only the owner side writes.
  - `shared`: opt-in; every writer creates, changes and deletes every document; `_by` stays the creator.
- **An optional unique key**: a top-level field whose value is unique per author (`pf_documents_unique`), for one vote per person. A document without the field is refused.
- **Up to three indexed fields** (delivery 3): top-level fields the object indexes with partial expression indexes (`create index pf_idx_<collection>_<n> on pf_documents (json_extract(body, '$.<field>'), created, id) where collection = '<collection>'`), created and dropped only by the object.

Changing a collection's mode applies to the next request; open connections subscribed to it are closed so they resubscribe under the new mode. Deleting a collection deletes its documents (`confirm` equal to the name) and is recorded in the audit log.

### Documents and server fields

A document is a JSON object of at most `documentBytes` serialized, at most 16 levels deep, whose top-level keys never start with `_`. The server sets and returns `_id` (96 random bits, base64url), `_by` (the visitor ID, or `owner` for the owner side), `_created`, `_updated` and `_seq` (the object's change counter); input that sets any `_` field is refused, not ignored, so a client bug shows.

### Queries

A query is `{ filters?, order?, limit?, after? }`:

- **Filters**, at most 4: a field (`_by`, `_id`, `_created`, `_updated` or a top-level body field matching `^[A-Za-z][A-Za-z0-9_]{0,31}$`), an operator (`eq`, `lt`, `lte`, `gt`, `gte`, `in` with at most 20 values) and a scalar value. The field name is checked by that pattern before it becomes part of the JSON path; every value is a bound parameter.
- **Order**: `_created` ascending or descending, with `_id` as the tie breaker.
- **Limit**: 1 to 100, default 20; the object reads one more row to know whether there is a next page.
- **Cursor**: `after`, the last document's `[_created, _id]`, compared as a row value.

Why every query is bounded: the order always follows an index (`pf_documents_created`, or `pf_documents_author` in `own` mode), so a page reads about its size (measured: 22 rows for a page of 20, 102 for a page of 100 at 100,000 documents, 1 to 2 ms); a filter on a body field that is not indexed scans the collection, so it is allowed only on collections of at most 1,000 documents (measured: 1,001 rows), and larger collections filter only on indexed fields (measured unindexed at 100,000 documents: 100,001 rows and 169 ms, which is why it is refused there); and the number of documents in a collection is itself capped. Reads are also limited per caller in the object's memory (300 a minute per visitor ID, or per hashed IP for readers), like `TrafficLimiter`, so a visitor cannot hold an object busy with reads.

### The SQL the object runs

The reserved schema (the spike's `SCHEMA`, plus `pf_authors` and `pf_changes`, which the spike leaves out):

```sql
create table pf_meta (key text primary key, value) without rowid;          -- artifact, region, seq, schema
create table pf_collections (name text primary key, mode text not null, unique_key text,
  documents integer not null default 0, bytes integer not null default 0) without rowid;
create table pf_documents (collection text not null, id text not null, author text not null,
  created integer not null, updated integer not null, seq integer not null, unique_value text,
  body text not null, size integer not null, primary key (collection, id)) without rowid;
create index pf_documents_author on pf_documents (collection, author, created, id);
create index pf_documents_created on pf_documents (collection, created, id);
create unique index pf_documents_unique on pf_documents (collection, author, unique_value)
  where unique_value is not null;
create table pf_rate (author text primary key, window integer not null, count integer not null) without rowid;
create table pf_authors (author text primary key, name text, kind text not null, seen integer not null) without rowid;
create table pf_changes (seq integer primary key, collection text not null, id text not null,
  author text not null, kind text not null);                                -- deletes, for reconnects
```

Each write is one `transactionSync`, rolled back whole on any refusal:

- **Create**: read the collection's mode and count; refuse by mode (`writeScope`); count the write (`insert into pf_rate … on conflict (author) do update set count = case when window = excluded.window then count + 1 else 1 end, window = excluded.window returning count`, refused past the limit, and the refusal rolls the count back); refuse at the document cap; validate the body; `update pf_meta set value = value + 1 where key = 'seq' returning value`; `insert into pf_documents (…) values (…)`; `update pf_collections set documents = documents + 1, bytes = bytes + ?`; refuse if `databaseSize` passed the artifact's cap. Measured: 6 rows read, 6 written (the row, its two index entries, the counter, the sequence and the rate row).
- **Update**: the same checks, then `select size, author, created from pf_documents where collection = ? and id = ?` and `update pf_documents set body = ?, size = ?, updated = ?, seq = ? where collection = ? and id = ?`, both with `and author = ?` bound to the caller in `own` and `append`; a document of another author is simply not found. Measured: 8 read, 4 written.
- **Delete**: `delete from pf_documents where collection = ? and id = ? [and author = ?] returning size, author`, the counters, and a `pf_changes` row (kept for the last 1,000 changes) so a reconnecting client learns about deletions. Measured: 8 read, 4 written.
- **Get**: `select … from pf_documents where collection = ? and id = ? [and author = ?]`. Measured: 2 read.
- **Query**: `select id, author, created, updated, seq, body from pf_documents where collection = ? [and author = ?] [filters] [and (created, id) > (?, ?)] order by created, id limit ?` (`buildQuery`).

**The author condition.** In `own` mode, for a visitor, `and author = ?` bound to the caller's own visitor ID is added by the object to every read and every write, after and independently of anything the caller sent; a filter on `_by` naming someone else adds a second condition that matches nothing. No ID, filter, cursor or `in` list reaches another author's row (spike: "never lets Bob read, list, change or delete Alice's document, by any ID or filter", which tries each). In `append` mode reads have no author condition and writes do; in `shared` neither does; in `read` only the owner side writes.

The plan's limits come in each call from the Worker, which read them with the artifact; the object never caches them across calls, so a plan change applies at the next request.

## Owner SQL

### Who may run what

`POST /api/v1/artifacts/:id/data/query` (read, scope `artifacts:read`) and `POST /api/v1/artifacts/:id/data/execute` (write, scope `artifacts:write`), MCP `query_artifact_data` and `execute_artifact_data`, `portifact data sql "<statement>" [--write] [--param …]`. Both need the new role action `data`, which admins and editors have and members do not; service tokens get it within their reach (`TOKEN_ACTIONS`, `actorOn` with the `ArtifactSubject`), so a token restricted to keys reaches only its artifacts. A workspace member below editor never reads other visitors' documents: in the page they are a visitor like anyone.

### Which tables: the reserved tables are read only (the issue's open point, decided)

Owner SQL may create, change and drop its own tables, indexes and views, write them freely and read everything, the reserved tables included (the owner side reads every document anyway). It may never write a reserved table or change its schema. Writing documents goes through the document API, which keeps the invariants the platform relies on: the author condition, the counters the caps read, the unique key, the change sequence the live channel and reconnects use, and the size cap. Letting SQL write them would let one `update pf_documents set author = …` hand a visitor's document to another visitor in `own` mode, and a bulk insert skip every cap; checking those invariants after arbitrary SQL would be a second implementation of the document API in triggers that SQL could also drop.

How it holds, without parsing SQL (spike `sql-guard.ts`, `ArtifactData.sql`):

1. **Lexer** (`checkStatement`): at most 16 KiB and 100 parameters; exactly one statement (strings, quoted identifiers and comments are skipped, and anything but whitespace or comments after a `;` is refused, because `exec` would run every statement); refuses `RECURSIVE` (the one way to write a statement that never ends over a tiny database), `TRIGGER` (a trigger on an owner table runs as a subprogram that `EXPLAIN` of the triggering statement does not list, so it could write reserved tables later) and the words workerd refuses anyway (`ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`), so callers get `invalid_input` instead of a platform error.
2. **SQLite's own program** (`checkProgram`): the object runs `EXPLAIN <statement>` with the parameters (it compiles, it does not execute) and reads the opcodes. A read call refuses any b-tree write (`OpenWrite`, `Clear`, `Destroy`, `CreateBtree`, `ParseSchema`, `Drop*`, `VDestroy`). A write call refuses `OpenWrite` (operand `p2`), `Clear` and `Destroy` (`p1`) on the root page of any reserved table or index, read from `sqlite_schema` right before. `Clear` matters: `delete from t` without a condition truncates with `Clear`, not `OpenWrite`.
3. **After running** (writes only, inside `transactionSync`): the reserved objects' entries in `sqlite_schema` (`type:name:sql` of every name or table starting with `pf_`) and the number of triggers must be what they were, and `databaseSize` within the cap; otherwise the transaction rolls back. This catches `alter table pf_documents …` and `create index … on pf_documents`, which write only page 1.

Measured in the spike: `update`, `delete`, `insert` on reserved tables, `drop index`, `drop table`, `alter table … add column` and `create index … on pf_documents` are all refused and the documents stay as they were; triggers are refused; a write through the read call is refused; a statement that would grow the database past the cap rolls back. workerd itself refused `BEGIN`, `SAVEPOINT`, `ATTACH`, `PRAGMA writable_schema`, reading `__cf_kv`, `load_extension` and `VACUUM`, and allowed `EXPLAIN`, reading `sqlite_schema` and `PRAGMA table_info` (the lexer refuses `PRAGMA` anyway; the schema tool reads `sqlite_schema` and `pragma_table_info` from the object's own code).

**Transactions and schema changes.** One statement is one transaction; there is no multi-statement transaction through the API, because a transaction held across requests would block visitors. Schema changes are ordinary statements on the owner's own tables. **Results**: at most 1,000 rows and 1 MiB of JSON, with `truncated: true` past either (measured). **Discovery**: `GET /api/v1/artifacts/:id/data` and MCP `describe_artifact_data` return the collections (mode, unique key, indexed fields, document count, bytes) and the owner tables with their columns, indexes and views, plus the limits; the MCP tool descriptions point agents to it first.

### One bad query

A Durable Object runs one request at a time, and SQLite has no statement timeout: an expensive statement holds every other request of that artifact until it ends. The spike measured an 8,000-row table joined with itself (64 million rows, a few kilobytes of data, within every size cap): 1.7 to 2.1 seconds, and a visitor read sent at the same moment waited exactly as long. In workerd every object of the class runs on one thread, so a read on another artifact's object waited too; in production several objects can share an isolate, so the risk is not confined to the owner's own artifact.

What bounds it:

- **The CPU limit of the data Worker**, `limits.cpu_ms: 1000`. Document operations measured in microseconds to a few milliseconds, and the largest allowed scan (an indexed page or a 1,000-document filter) a few milliseconds, so 1 second leaves two orders of magnitude of margin. A statement past it is killed with the object, which Cloudflare resets; requests in flight on that object fail and the client script retries reads once. The caller gets `503 capacity_unavailable` with the message "The statement ran too long and was stopped", mapped from the platform's exceeded-CPU error. Cloudflare resets the CPU budget on each incoming request, so a statement on a busy object could outlive one budget; whether a statement blocking the event loop lets new requests in at all is a release check.
- **A strike rule in the app Worker**, which measures each owner SQL call's wall time (the object cannot: its clock does not advance during a synchronous statement): a call over 500 ms counts a strike in the D1 rate limits per artifact; after 3 strikes in 10 minutes, owner SQL for that artifact answers `rate_limited` for 10 minutes. Document API calls are not affected.
- **Rate limits**: 30 owner statements a minute per artifact, counted in the object's memory, and the existing request limits on the API.
- **No recursion, no triggers** (the lexer), and **the size caps**, which keep full scans small; a cross join is the remaining way to spend time, which the CPU limit ends.

## Live updates

- **Who connects.** `GET /__portifact/data/live` goes through every check of "Order of checks" (a WebSocket handshake carries `Origin` and fetch metadata), then the Worker forwards the upgrade to the object with the caller it decided in a header it sets itself (`X-Portifact-Caller`: the visitor ID or none, and the limits), on a request it builds, so no header from the page reaches the object. The owner side has no WebSocket in the first release.
- **What a connection receives.** It subscribes per collection with `{ "subscribe": "<name>" }`; the object accepts only collections the connection may read (`readScope`), so a reader cannot subscribe to an `own` collection. A change goes to connections subscribed to its collection, and in `own` mode the object looks only at `getWebSockets("author:<_by>")`, so another visitor's connection is never a candidate (spike: "delivers a change only to its author's connections"). Messages carry the document as the reader would get it, or only the ID for a deletion.
- **Revocation within 60 seconds.** A connection opened with a read or review session lives at most 60 seconds (its claims' lifetime); the object closes it with code `4001` and the client script reconnects through the Worker, which renews the session or refuses, and catches up with `since=<seq>` (the documents and `pf_changes` after it, at most 100, or "resync"). Public and link connections live 10 minutes. Access narrowing, suspension, archiving, transfer, a lost plan and a changed collection mode also write a `data_connections_close` outbox job that closes every connection of the artifact at once (spike: `closeConnections`).
- **Caps and back pressure.** Connections per artifact by plan (25, 200, 1,000) and 4 per visitor ID (per hashed IP for readers), counted from `getWebSockets()` at accept (spike: both caps). A connection's attachment holds at most 50 subscriptions. The object coalesces changes per connection into one frame every 100 ms, closes a connection whose sends fail, and the writes that cause messages are themselves rate limited, so the fan-out is bounded by writes per minute times connections.
- **Cost.** With hibernation an idle object with open connections bills no duration. Each connection is one Durable Object request and one content Worker request (with its delivery lookup) per minute for signed-in visitors because of the 60-second renewal, and incoming messages count 1 in 20. Outgoing messages are free. See "Cost".

## Data model outside the object

| Table                      | Home     | What                                                                                                                                                                                                                                                                                                                                                                           | Deleted                                                                                                        | Exported                                   | Restore                                                         |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `artifact_data`            | regional | One row per artifact with data: `artifact_id` (primary key, cascades from `artifacts`), `bytes`, `reported_at`, `created_at`. Its existence is "this artifact has data" (counted against `dataArtifacts`).                                                                                                                                                                     | With the artifact (cascade) after the erase job is written; erasing all data deletes it.                       | In the artifact's records (counts only).   | Rewound; see "Lifecycle".                                       |
| `artifacts.data_writers`   | regional | `signed_in` (default), `anyone`, `none`. Selected by the delivery lookup.                                                                                                                                                                                                                                                                                                      | With the artifact.                                                                                             | In the artifact's access records.          | Rewound like the access policy.                                 |
| `data_authors`             | regional | `artifact_id`, `user_id`, `visitor_id`, `first_at`; primary key (`artifact_id`, `user_id`), cascades from `artifacts`. Written once per account and artifact, on the first write (`insert … on conflict do nothing` by the content Worker in `waitUntil`, after the object answered `firstWrite`). No foreign key to `users` (a regional table cannot reference a global one). | Cascade; `advanceAccountDeletion` deletes the account's rows after writing an `erase_data_author` job per row. | In the account export (artifact IDs only). | Rows written after the restore point are lost; see "Lifecycle". |
| `account_usage.data_bytes` | regional | Sum of `artifact_data.bytes` over the owner's artifacts. Not in the CHECK constraint.                                                                                                                                                                                                                                                                                          | With the usage row.                                                                                            | In usage.                                  | Recomputed by the scan.                                         |

Each goes in `TABLE_HOMES` as regional. The new outbox topics, in `OUTBOX_TOPICS`, `OutboxTopic` and `runJob`, all run by the jobs Worker in the artifact's region and idempotent: `erase_artifact_data` (calls `erase()`; an empty object stays empty), `erase_data_author` (calls `eraseAuthor(visitorId)`; a missing author erases nothing), `data_connections_close`, `data_size_check` (the safety net) and `data_operator_export`.

## Interfaces and parity

The owner side, all through `packages/services/src/artifact-data.ts`, which authorizes (`authorizeOn` with `data`), checks a hold for the people who manage it (`HELD_MESSAGE`), loads the owner's entitlements, calls the object through `dataNamespace` and maps its outcome to the contracts' errors. Inputs and outputs live in `packages/contracts/src/artifact-data.ts`.

| Operation                                                                                | API                                                     | MCP tool                                          | CLI                                | Scope              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- | ------------------ |
| Describe (collections, owner tables, limits)                                             | `GET /api/v1/artifacts/:id/data`                        | `describe_artifact_data`                          | `portifact data describe <id>`     | `artifacts:read`   |
| Declare or change a collection                                                           | `PUT …/data/collections/:name`                          | `set_artifact_collection`                         | `portifact data collection set`    | `artifacts:write`  |
| Delete a collection                                                                      | `DELETE …/data/collections/:name?confirm=<name>`        | `delete_artifact_collection` (`confirm`)          | `portifact data collection delete` | `artifacts:delete` |
| List or query documents                                                                  | `GET …/data/collections/:name/documents?q=`             | `list_artifact_documents`                         | `portifact data list`              | `artifacts:read`   |
| Get a document                                                                           | `GET …/documents/:docId`                                | `get_artifact_document`                           | `portifact data get`               | `artifacts:read`   |
| Create or replace a document                                                             | `POST …/documents`, `PUT …/documents/:docId`            | `put_artifact_document` (`idempotencyKey`)        | `portifact data put`               | `artifacts:write`  |
| Delete a document                                                                        | `DELETE …/documents/:docId`                             | `delete_artifact_document`                        | `portifact data delete`            | `artifacts:write`  |
| SQL read                                                                                 | `POST …/data/query`                                     | `query_artifact_data`                             | `portifact data sql`               | `artifacts:read`   |
| SQL write                                                                                | `POST …/data/execute`                                   | `execute_artifact_data`                           | `portifact data sql --write`       | `artifacts:write`  |
| Export (JSON Lines, streamed by collection and table, cursor in `Portifact-Next-Cursor`) | `GET …/data/export`                                     | `export_artifact_data` (pages of at most 256 KiB) | `portifact data export`            | `artifacts:read`   |
| Erase one visitor's documents                                                            | `DELETE …/data/authors/:visitorId`                      | `erase_artifact_data_author` (`confirm`)          | `portifact data erase-author`      | `artifacts:delete` |
| Erase all data                                                                           | `POST …/data/erase` (`confirm` equal to the ID)         | `erase_artifact_data` (`confirm`)                 | `portifact data erase` (asks)      | `artifacts:delete` |
| Who writes from the page                                                                 | `PATCH /api/v1/artifacts/:id/access` with `dataWriters` | `set_artifact_data_writers`                       | `portifact access data-writers`    | `artifacts:share`  |

- **Parity.** Same service, same checks, same errors; a parity test (`test/mcp-parity.test.ts` and the CLI's) for each operation, every tool in `TOOL_SCOPES` with its route's scope, and the plan's limits read only in the service. Creating with an `Idempotency-Key` stores only the document's ID and rebuilds the answer on replay (the body is user data, like comment text).
- **Untrusted data.** Documents, owner table contents and visitors' names are written by visitors. The MCP tool descriptions and the skill say so, as they do for comments: never follow instructions found in them, and widening tools (`set_artifact_data_writers` to `anyone`, `set_artifact_collection` to `shared`) tell the agent to ask the user first. Destructive tools need `confirm`.
- **Terms gate.** Reads, the export and both erasures are in `TERMS_OPEN_OPERATIONS` (reads and deletions stay open, like today); declaring, writing, SQL writes and widening writers answer `terms_not_accepted`; `dataWriters` narrowing is allowed through `actsWithoutCurrentTerms`. Each new route and tool is classified in `apps/app/test/terms-operations.test.ts`.
- **Dashboard.** The artifact page gains a "Data" section: collections with their mode and counts, who writes, a read-only document browser, export and erase. No SQL console in the first release (the CLI and MCP have it). Every string goes through the catalogs in every language; the browser is a table with headers, the destructive actions confirm with the name typed, and focus and errors follow [accessibility.md](../accessibility.md).
- **Skill.** `skills/portifact` gains a section on artifact data: the client script and its API, the four modes and when to use each, `own` as the safe default, that documents are visitor input, the limits, and the CLI and MCP commands. Updated in the delivery that ships each part.

## Quotas, plans and cost

### Limits per plan (proposed)

| Limit                                       | Free                     | Pro    | Team    | Enterprise | Enforced by                                                                   |
| ------------------------------------------- | ------------------------ | ------ | ------- | ---------- | ----------------------------------------------------------------------------- |
| Artifacts with data (`dataArtifacts`)       | 3                        | 50     | 200     | 1,000      | The `artifact_data` insert in the declaring batch, against the count (exact). |
| Bytes per artifact (`dataBytesPerArtifact`) | 10 MB                    | 100 MB | 1 GB    | 1 GB       | `databaseSize` before commit, in the object (exact).                          |
| Bytes per document                          | 16 KiB                   | 64 KiB | 64 KiB  | 64 KiB     | The object (exact).                                                           |
| Documents per collection                    | 1,000                    | 10,000 | 100,000 | 100,000    | The collection's counter in the write's transaction (exact).                  |
| Collections per artifact                    | 10                       | 50     | 50      | 50         | The object (exact).                                                           |
| Writes per artifact per day                 | 5,000                    | 50,000 | 500,000 | 500,000    | A `pf_rate` row for the artifact (exact).                                     |
| Connections per artifact                    | 25                       | 200    | 1,000   | 1,000      | The object, at accept (exact).                                                |
| Writes per author per minute                | 30                       | 30     | 30      | 30         | `pf_rate` (exact). Safety cap, a constant.                                    |
| Reads per caller per minute                 | 300                      | 300    | 300     | 300        | Object memory (resets when the object is evicted). Safety cap.                |
| Connections per visitor                     | 4                        | 4      | 4       | 4          | The object. Safety cap.                                                       |
| Owner statements per artifact per minute    | 30                       | 30     | 30      | 30         | Object memory. Safety cap.                                                    |
| Data in the owner's storage                 | counts in `accountBytes` |        |         |            | Eventual, below.                                                              |

These are new `PlanLimits` keys in `PLANS` (not per seat), read through `entitlements`, and overrides apply. Team and Enterprise get the same per-artifact numbers because the object's own limits (10 GB, one thread) do not grow with seats.

Spike: a document one byte over the cap, the collection's next document and the 31st write of a burst of 40 in one minute are refused inside the object, exactly, and a write that would take the database past its cap is rolled back with nothing kept.

### How the size reaches the owner's storage

`account_usage` has CHECK constraints the object cannot join, and the object holds no D1 binding. Every write the object answers carries `databaseSize`. The content Worker keeps the latest size per artifact in a per-isolate `DataSizeMeter` and writes once per 5-second window through `waitUntil`, like `TrafficMeter`: `update artifact_data set bytes = ?, reported_at = ? where artifact_id = ? and reported_at < ?`, then `update account_usage set data_bytes = (select coalesce(sum(d.bytes), 0) from artifact_data d join artifacts a on a.id = d.artifact_id where a.owner_id = ?) where owner_id = ?`. Absolute values, never increments, so a lost or repeated flush converges. The app Worker writes the same after owner-side writes. The jobs Worker's `data_size_check` scan asks each object whose `reported_at` is older than a day for its size, a bounded number per run with a `maintenance_cursors` cursor, as the safety net for sizes lost with an evicted isolate.

Lag and overshoot: the owner's total is at most a few seconds stale, plus a day for a size lost with an isolate. Within that, an owner can exceed `accountBytes` by what their artifacts wrote meanwhile, which each artifact's exact cap bounds (at most `dataArtifacts` times `dataBytesPerArtifact` in the worst case, 30 MB on Free). The publish checks (`checkPublish`) add `data_bytes` to `stored_bytes`, so data and files share the account's space; the CHECK constraint stays on files only. When the total is over, writes that grow (create, a larger replace, owner SQL writes) answer `quota_exceeded`; reads, deletes, the export and erasing always work.

### Budget protection

- A new step `pause_data_writes` at US$105, between `block_uploads` (US$100) and `pause_annotation_writes` (US$110): page writes, owner document writes and SQL writes answer `capacity_unavailable`; reads, exports, deletes and erasing keep working, and connections stay open. `PROTECTION_STEPS` grows to five, so `budget-override --steps` takes 1 to 5 and the usage `capacity` block names data writes.
- New connections are refused from `tighten_public_traffic` on public artifacts and from `limit_protected_traffic` on the rest, like requests.
- The collector adds the Durable Object datasets (`durableObjectsInvocationsAdaptiveGroups` for requests, `durableObjectsPeriodicGroups` for active time, rows read and written and stored bytes) filtered to the `ArtifactData` namespace of `portifact-data`, `REFERENCE_PRICES` gains the prices above, and `PORTIFACT_RESOURCES` adds the Worker. A global admission limit on data bytes (100 GB proposed) adds `stop_new_data` (refusing new collections on artifacts without data) like the other admission limits.

### Cost per operation

| Operation                       | Content or app Worker requests                                      | D1                                                                                                   | Durable Object requests                                 | Object rows read and written                                   |
| ------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Page read (get or a page of 20) | 1                                                                   | the delivery lookup it already does (1 query, a few rows)                                            | 1                                                       | 2 to 22 read                                                   |
| Page write                      | 1                                                                   | the lookup; a `data_authors` insert once per account and artifact; the size flush per isolate window | 1                                                       | 6 to 8 read, 4 to 6 written                                    |
| `me`                            | 1                                                                   | the lookup and one global `users` read                                                               | 1                                                       | 1 to 3                                                         |
| Live connection                 | 1 per connect and per renewal (every 60 s signed in, 10 min public) | the lookup per connect                                                                               | 1 per connect; incoming messages 1 in 20; outgoing free | none at rest                                                   |
| Owner document call             | 1 app request                                                       | the usual authorization reads                                                                        | 1                                                       | as above                                                       |
| Owner SQL                       | 1 app request                                                       | authorization; the strike counter only past 500 ms                                                   | 1                                                       | what the statement reads and writes, up to 1,000 rows returned |
| Erase                           | 1 job                                                               | the job row                                                                                          | 1                                                       | `deleteAll`                                                    |
| First collection                | 1                                                                   | the `artifact_data` insert and audit event                                                           | 1                                                       | 13 read, 15 written                                            |

Storage: an empty object with one collection is 32 KiB; a 200-byte document adds about 420 bytes; 100,000 small documents are 18 MB.

### Arithmetic at 1,000 and 100,000 artifacts

The issue's assumptions: 5% of the artifacts with data are active on a given day, with 200 data requests each (150 reads, 50 writes), 1 MB of data on average, and Portifact's other usage taking none of the included amounts (pessimistic). Duration is the unknown that matters: how long an object stays billable after a request without WebSockets is not stated by Cloudflare, so the table brackets it with `B` seconds billed per request.

|                                                                  | 1,000 artifacts                                    | 100,000 artifacts                                  |
| ---------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Data requests a month                                            | 300,000                                            | 30 million                                         |
| Content Worker requests                                          | inside the 10 million included: US$0               | 30 million: about US$6 to 9                        |
| Durable Object requests                                          | inside 1 million: US$0                             | 29 million over: US$4.35                           |
| Rows written (6 per write)                                       | 450,000: US$0                                      | 45 million, inside 50 million: about US$0          |
| Rows read                                                        | negligible                                         | under 1 billion: US$0                              |
| Stored data                                                      | 1 GB, inside 5 GB: US$0                            | 100 GB: US$19                                      |
| Duration, B = 0.1 s                                              | 3,750 GB-s: US$0                                   | 375,000 GB-s, inside 400,000: US$0                 |
| Duration, B = 1 s                                                | 37,500 GB-s: US$0                                  | 3.75 million GB-s: US$42                           |
| Live connections (2 tabs open an hour a day per active artifact) | 180,000 renewals: US$0                             | 18 million renewals: about US$8                    |
| **Total**                                                        | **US$0** (US$1 if every artifact filled its 10 MB) | **US$37 to 40 (B = 0.1 s), US$79 to 82 (B = 1 s)** |

So 1,000 artifacts fit in the included amounts, and 100,000 cost US$37 to 82 a month, which alone is near or above the US$50 objective: data at that scale needs paying customers, and the measured active time decides which end applies (release check). A B of 10 s would cost about US$464 in duration alone and is what budget protection exists for.

### What a hostile user can make Portifact spend

- **A free owner writing to their own artifacts**: 3 artifacts times 5,000 writes a day is 450,000 writes a month, 2.7 million rows written (US$2.70 past the included amount) and 30 MB. Reads are bounded by the traffic quota (1 million requests a month on Free) at most 1,000 rows each (the unindexed filter cap): 1 billion rows read, US$1. CPU per request is capped at 1 s by the data Worker. About US$4 a month per hostile free account at most, and account creation needs the human check.
- **A visitor on someone else's artifact**: bounded by that artifact's daily and per-author write limits and the owner's traffic quota, which the owner pays in quota, not money; anonymous writers (delivery 4) also by the handoff's per-IP limit and the human check.
- **Many accounts at once**: the budget projection and `pause_data_writes` at US$105, then the traffic steps, and the 100 GB admission limit.

## Lifecycle

- **Publish and rollback** never touch the object.
- **Archive and restore from the archive.** An archived artifact is not servable, so page requests answer like a missing artifact and live connections are closed by the `data_connections_close` job its transition writes; the owner side can still describe, read, export and erase, and cannot write. Restoring it serves the same data. The data counts in storage throughout.
- **Suspension.** Not servable: the page gets nothing, connections are closed in the suspension's batch job. The owner side may read, export and erase while suspended, never write, unless a hold is open.
- **Legal hold.** The object is preserved untouched: nothing erases it (the erase job checks `isHeld` and leaves a held artifact's object, and the purge never reaches a held artifact anyway), and reads, the export and erasing answer `forbidden` with `HELD_MESSAGE` to the people who manage it, after authorization, like files and comments; anyone else gets the missing-artifact answer. Only the operator reads it, with `data-export <id>`, which writes a `data_operator_export` job; the jobs Worker writes JSON Lines to the artifact's region's bucket under `system/data-exports/<id>/<timestamp>.jsonl` (so EU data stays in the EU), which the operator downloads with `wrangler r2 object get` and deletes after use. An account deletion that touches a visitor's documents on a held artifact defers that erasure until release (`legal_hold_release` gains the deferred `erase_data_author` jobs), as it does for comments.
- **Transfer** between owners (same region only, as today): the object stays where it is and keeps its ID, because it is named by the artifact ID and the region does not change. The data, collections and visitor IDs go with the artifact, so the new owner side reads everything the old one did. The transfer's batch recomputes `data_bytes` for both owners, checks `dataArtifacts` and the storage on the target like any other storage, resets `data_writers` to `signed_in` (as it resets the workspace modes), and writes `data_connections_close`.
- **Purge** (`deleteArtifactData`): writes `erase_artifact_data` in the purge's batch; the job calls `erase()` (spike: idempotent, leaves an empty database). The `artifact_data` and `data_authors` rows go by cascade. A new way to delete artifacts goes through the same path.
- **Account and workspace deletion.** Their artifacts are purged as above. For the account as a visitor, `advanceAccountDeletion` writes an `erase_data_author` job per `data_authors` row of the account in every region and then deletes the rows, in bounded batches; the job calls `eraseAuthor(visitorId)` (spike: erases that author's documents, keeps the counters right). `pf_authors` loses the name with them.
- **D1 Time Travel restore.** The objects are not rewound. An artifact the restore brings back that had been purged later comes back with an empty object (its erase job ran) and is purged again by `apply-tombstones`. An artifact the restore takes away (created after the restore point) leaves an object nobody can reach, because every route resolves the artifact first and IDs are never reused; `apply-tombstones` writes `erase_artifact_data` for every ID the directory has and the region lacks, after `rebuildArtifactDirectory`. `data_authors` rows written after the restore point are lost, so a later deletion of such an account cannot find those documents: an accepted gap, written in "Restoring a backup", that the owner can close with `erase-author` on request. `account_usage.data_bytes` is recomputed by the size scan.
- **The object's own point-in-time recovery** is not used in operations and not offered to owners in the first release: restoring an object to an earlier moment would bring back documents erased since, including erasures owed to people. A later delivery may offer an owner "undo" within 30 days if erasures can be re-applied after it.
- **Plan grace.** When a plan lapses or is lowered nothing is deleted: the data limits drop at once for new work (writes that grow, new collections, new artifacts with data answer `quota_exceeded`), and reads, the export and erasing keep working. The new limits are capacity limits, not retention, so none goes in `GATED` or `IN_GRACE`; the grace's "Download your data" page and `portifact export` include the data.

## Moderation and law

### Controller and processor

The owner decides what their artifact collects and why, so the owner is the controller of the data visitors write into it and Portifact its processor, under the Data Processing Addendum, exactly as for the artifact's files. Portifact is the controller of the account, the session and the `data_authors` link between an account and the artifacts it wrote in. Consequences:

- A visitor who wants to see, correct or delete what they wrote asks the owner; the owner has `erase-author` and the export. Portifact forwards requests it receives to the owner and helps as the DPA says.
- Deleting a Portifact account erases its documents on every artifact, as it erases its comments, because the account's own data is Portifact's to delete. This is a promise to visitors that limits what owners keep; recommended, and asked as question 2.
- Anonymous writers have no account: only the owner can find and erase their documents.

### Reports, suspension and the operator

The report form covers an artifact's data: a new reason is not needed ("Illegal or harmful content" and the rest apply), and the report page gains a hint that visitor-submitted content counts. Suspension stops the page and the live channel at once. The operator reads one artifact's data with `data-export`, erases it with `data-erase <id>` and one visitor's documents with `data-erase-author <id> <visitor ID>`, each recorded with a statement of reasons where the decision affects the owner (`moderation_decisions`). The operator's export holds personal data: it is written to the region's bucket, downloaded once and deleted.

### Legal texts (a new `TERMS_VERSION`)

The change is material, so the delivery that writes the texts raises `TERMS_VERSION` and every account accepts again at its next sign-in ([legal.md](../legal.md)). Until the switch is on, the feature is described in each page's "Features not yet available" section.

- **Terms.** "It runs no builds, servers or databases for your content." becomes false. New text: Portifact stores data that an artifact's own page or its owner writes through the artifact data feature; the owner is responsible for what their artifact collects, must say so to their visitors, and is the controller of it; what visitors write is erased with the artifact and with the visitor's account; the limits per plan; data writes may pause under capacity protection.
- **Privacy Policy.** A new category: data written into artifacts by their pages (content defined by the owner, the opaque visitor ID, the display name, timestamps), kept until the owner or the visitor's account deletion erases it or the artifact is purged; where it is stored (the default region's objects with a location hint for western North America, which Cloudflare does not guarantee, like the databases today; the EU jurisdiction for EU workspaces); that the owner, not Portifact, decides its purpose; and the `__Host-pf_visitor` cookie (anonymous writers only).
- **Data Processing Addendum.** The processing description and Annex I gain visitor-submitted artifact data (categories of data subjects: the customer's visitors; categories of data: whatever the customer's artifact collects); Annex III's location statement covers Durable Objects with the location hint and the EU jurisdiction; deletion at the end of processing includes the objects.
- **Acceptable Use Policy.** New prohibitions: collecting passwords, payment card data or government identifiers through artifact data; collecting special categories of personal data or data from children without a lawful basis; using documents to host files or relay messages for others; using artifact data to track visitors across artifacts or sites.

## The client script

`/__portifact/data.<version>.js` is a small ES module, built by a new `packages/data-client` like the diagram script: content-hashed, `Cache-Control: public, max-age=31536000, immutable`, brotli-encoded, served before any artifact lookup and never charged as traffic; `/__portifact/data.js` answers `302` to the current build. It loads nothing else and uses only `fetch` and `WebSocket` on its own origin. A page loads it with `<script type="module">import { data } from "/__portifact/data.js"</script>` or an import map; there is no npm package in the first release.

```ts
const me = await data.me(); // { visitor: { id, name } | null, canWrite, collections, ... }
await data.signIn(); // navigates to /__portifact/data/sign-in
const votes = data.collection("votes");
const mine = await votes.create({ poll: "p1", choice: "a" });
await votes.replace(mine._id, { poll: "p1", choice: "b" });
await votes.delete(mine._id);
const page = await votes.query({ filters: [{ field: "poll", op: "eq", value: "p1" }], limit: 50 });
const next = await votes.query({ after: page.next });
const stop = votes.subscribe((change) => render(change)); // reconnects, renews and catches up
```

Errors are thrown as `DataError` with the API's `code`. Agents learn it from the skill (with a complete example page), from `describe_artifact_data`, whose answer includes a short usage note and the script's path, and from the CLI's `portifact data describe --example`, which prints a page that uses every collection.

## Exports, audit and webhooks

- **Export.** `GET …/data/export` streams JSON Lines: one `{ "type": "collection", … }` line per collection, then its documents as stored (with server fields), then `{ "type": "table", name, columns }` and its rows, in parts with a cursor (`Portifact-Next-Cursor`), like the audit export; never built in memory. `portifact export` and the "Download your data" page include each artifact's `data.jsonl` through the same route, and `collectArtifactRecords` gains a `data` part (`{ skipped }` when held or switched off). The account export (session) lists the account's artifacts with data (counts) and the artifacts where the account wrote as a visitor (IDs only, from `data_authors`), not the documents: those belong to the owners.
- **Audit log.** Recorded on the owner side, in the batch or the call: `data.collection_set`, `data.collection_deleted`, `data.writers_changed`, `data.sql_executed` (the statement's kind from `EXPLAIN`, never its text), `data.erased`, `data.author_erased` (counts only), `data.exported`. Never a document, a statement, a visitor ID or a name. Visitors' writes are not recorded. Each kind goes in `AUDIT_DETAILS`, `AUDIT_TARGETS`, the dashboard catalogs and `auditSummary`, and each use case in `RECORDED` or `NOT_RECORDED` of the coverage test. Owner SQL writes on the object cannot share a D1 batch, so `data.sql_executed` is written by one insert after the object answered, the same deliberate exception `audit.exported` makes.
- **Webhooks.** No events in the first release: a write per visitor action would make webhooks a firehose. A later `data.changed` digest is possible.
- **Access log and analytics.** Data requests are not openings or views.

## Cross-cutting rules

- **Owners and roles.** The new role action `data` (admins and editors; in `TOKEN_ACTIONS`), decided by `can` over `ROLE_ACTIONS`; the owner side always resolves the actor on the artifact's owner (`authorizeOn`), and every later write is conditioned on the `owner_id` it read. A member gets `forbidden`, a stranger the missing-artifact answer.
- **Regions.** The object lives in the artifact's region's jurisdiction; every D1 table is regional; jobs are written in the artifact's region's outbox; the operator export goes to the region's bucket. Nothing crosses regions; `KNOWN_CROSS_DATABASE` stays empty (the `me` call's `users` read is a global read on the global handle, like the read entry's).
- **D1 batches.** Declaring the first collection inserts `artifact_data` on the condition that the owner is under `dataArtifacts` and the artifact is the owner's and active, with the audit event, in one batch, and only then calls the object; a declare that the object refuses deletes the row again only if the object holds no collection (`describe`). The object's own transactions are the guard for everything inside it.
- **Outbox.** Every follow-up (erase, author erase, connections close, size check, operator export) is an outbox job written in the batch of the change that causes it.
- **Tombstones and restore.** Covered under "Lifecycle"; no new tombstone kind (an artifact's purge and an account's deletion already have theirs, and `apply-tombstones` re-runs the erasures).
- **Plans, gates and grace.** Limits only, no feature gate; covered above.
- **Budget protection and traffic metering.** Covered above; no D1 write per request.
- **Comment visibility.** Not involved: documents are not comments, and the comment scope rules do not apply to them.
- **Service tokens.** May use the owner side within their reach, never the page; `data` in `TOKEN_ACTIONS`; a token with only `artifacts:read` reads documents, which name visitors only by opaque ID and display name.
- **Legal holds and suspensions**, **exports**, **deletions** and **transfers**: covered above.
- **Terms gate.** Covered under "Interfaces".
- **i18n and accessibility.** The dashboard's Data section and the error messages it shows go through every catalog; the client script's messages are the API's English codes, for the owner's code to translate.
- **Logs.** `logEvent` only: `data_request_refused` with the code, `data_object_failed` with `errorLabel`, `data_sql_slow` with the artifact and milliseconds; never a document, a statement, a filter value, a visitor ID or a name.

## Threat model

| Attacker                                                       | Tries                                                                                                         | What stops it                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A visitor                                                      | Read or overwrite another visitor's document in `own` mode by ID, filter, cursor or `in` list                 | The object adds `author = <caller>` to every statement in `own` mode, bound from the caller the Worker decided; the spike tries each path.                                                           |
| A visitor                                                      | Set `_by`, `_id` or timestamps                                                                                | Refused (`invalid_input`); the server sets them.                                                                                                                                                     |
| A visitor                                                      | Write as someone else                                                                                         | The author comes only from the session or visitor cookie, sealed or signed by Portifact; the page never sends it.                                                                                    |
| A visitor                                                      | Exhaust the artifact                                                                                          | Per-author writes a minute, per-artifact writes a day, documents per collection, bytes per document and per artifact, reads per minute, connections per visitor and per artifact, the traffic quota. |
| A visitor                                                      | Hold the object busy with queries                                                                             | Indexed order, page size 100, unindexed filters only up to 1,000 documents, 300 reads a minute, CPU limit.                                                                                           |
| A visitor                                                      | Receive another visitor's changes live                                                                        | `own` changes are sent only to `author:<_by>` connections; subscriptions are checked by mode.                                                                                                        |
| A share link visitor                                           | Write                                                                                                         | The link session is a `reader`; `writeScope` refuses.                                                                                                                                                |
| A sibling artifact                                             | Call another artifact's data API with the visitor's cookies, by `fetch`, form, image, navigation or WebSocket | The gate requires `Sec-Fetch-Site: same-origin` and, on writes and handshakes, the exact `Origin`; sessions are host-only; no CORS.                                                                  |
| A sibling artifact                                             | Plant a `pf_visitor` look-alike or a review cookie                                                            | Foreign cookies grant nothing, imitations are cleared; `__Host-pf_visitor` cannot be set with a `Domain`; a frame review cookie on a document request is cleared as today.                           |
| A sibling artifact                                             | Correlate visitors across artifacts                                                                           | Visitor IDs are per artifact HMACs; no email or account ID reaches any page.                                                                                                                         |
| The artifact's owner, writing hostile code                     | Read visitors' data                                                                                           | The owner side reads it by design (the owner is the controller); the page in an admin's browser gets only that admin's own documents in `own` mode, so it cannot exfiltrate through an admin.        |
| The artifact's owner                                           | Learn visitors' emails or accounts                                                                            | Only visitor IDs and display names; the HMAC cannot be reversed without the secret.                                                                                                                  |
| The artifact's owner                                           | Break invariants with SQL (reassign authors, skip caps)                                                       | Reserved tables are read only to SQL: `EXPLAIN` root-page check, schema comparison, no triggers; spike-tested.                                                                                       |
| The artifact's owner                                           | Block the platform with one expensive statement                                                               | Data Worker CPU limit of 1 s, the strike rule, 30 statements a minute, no recursion; other artifacts sharing the isolate are affected at most for that second (release check).                       |
| The artifact's owner                                           | Escape the database (`ATTACH`, `PRAGMA`, extensions, `_cf_` tables)                                           | workerd's authorizer (measured) and the lexer.                                                                                                                                                       |
| The artifact's owner                                           | Spend Portifact's budget                                                                                      | Plan limits, the traffic quota, budget protection's `pause_data_writes`, the admission limit.                                                                                                        |
| A workspace member below editor                                | Read every visitor's data                                                                                     | No `data` action: `forbidden` on the owner side; a visitor in the page.                                                                                                                              |
| A service token                                                | Reach artifacts outside its restriction, or the page                                                          | `actorOn` with the artifact subject; tokens have no page identity.                                                                                                                                   |
| An agent acting on untrusted text (comments, documents, names) | Erase data, open writing to anyone, make a collection `shared`                                                | `confirm` on destructive tools; widening tools tell the agent to ask the user first; tool descriptions mark documents as untrusted.                                                                  |
| Anyone                                                         | Reach an object of an artifact that is gone or held                                                           | Every route resolves the artifact in D1 first; held artifacts refuse everyone but the operator.                                                                                                      |
| A Worker bug                                                   | Use the wrong region's object                                                                                 | `dataNamespace` from the directory only; the object checks `{ artifactId, region }` on every call.                                                                                                   |

## Deliveries

Each delivery ships behind `ARTIFACT_DATA_ENABLED` (content and app Workers; off in every deployed `wrangler.jsonc`), is reviewable on its own, and updates `AGENTS.md`, `docs/security.md`, `docs/operations.md`, `docs/releasing.md`, the skill and the catalogs in the same change.

1. **This record and the security section.** Nothing else.
2. **The object and the owner side.** `apps/data` with `ArtifactData` (reserved schema, all four modes in the object, document operations, bounds, erase, author erase), `dataNamespace`, the D1 tables and migration, `artifact_data` accounting, the plan limits, the owner-side document API with API, MCP and CLI parity, export, audit, the outbox jobs (erase, author erase, size check, operator export), purge and deletion wiring, holds, transfer, restore handling. Leaves out SQL, the page, live updates and anonymous writers. Tests: workerd tests of the object (from the spike), service tests for every permission boundary, parity tests, the audit coverage, the terms classification, a held artifact, a transfer, a purge and an account deletion end to end with the jobs. Release checks: the data Worker deploys first; the region guard passes with the EU binding; an EU artifact's object is created in the EU jurisdiction (checked with a staging artifact).
3. **Owner SQL.** The lexer, the `EXPLAIN` check, the schema comparison, the CPU limit, strikes, indexed fields for collections, `describe` with tables. Tests: the spike's refusals, a fuzz of statements against reserved tables, the strike rule with an injected clock. Release check: a cross join on a staging object is killed at the CPU limit and the next request works; whether a running statement lets other requests in.
4. **The page.** The content Worker's data routes and order of checks, the gate, identity from review, read and link sessions, `me`, sign-in on public artifacts, `DataSizeMeter`, the budget step, the client script package, the dashboard's Data section, and `own` and `append` from the page (the object already enforces the others; `read` and `shared` stay refused to the page in this delivery, as the issue orders). Tests: the gate against sibling origins in workerd; e2e in Chromium, Firefox and WebKit with third-party cookies blocked (a page writes and reads, another visitor cannot see it, the viewer frame works with the review session, a sibling artifact's `fetch` fails); axe on the dashboard section. Release check: the e2e stack and staging.
5. **Live updates.** The WebSocket route, subscriptions, the 60-second renewal and catch-up, the close job, caps, coalescing. Tests: the spike's delivery tests, renewal and revocation within 60 seconds, e2e with two browsers. Release check: active time with idle connections is zero in Cloudflare's analytics on staging.
6. **Anonymous writers and the remaining modes.** `data_writers = anyone`, the visitor handoff with Turnstile on the app, `__Host-pf_visitor` in `isPortifactCookie`, per-IP limits, `read` and `shared` from the page. Tests: the handoff's one-use code, the cookie's imitations, the per-IP limits.
7. **Legal texts, release checks and the switch.** The new `TERMS_VERSION`, the four pages in every language, the AUP, `AVAILABLE_PLAN_FEATURES` is not involved (no feature), the operations runbook, then the switch on in production.

The issue's estimate (16 to 22 working days for the first release) stands for deliveries 2 to 5.

## What the spike proved

`spikes/artifact-data`, 44 tests in workerd (`bun run spike:artifact-data`):

- **Two Workers, one object.** A class exported by one Worker with a `new_sqlite_classes` migration, bound from a second Worker by `scriptName`; what one wrote, the other read. One object per artifact ID; another ID is another, empty database; a read creates no storage; a call naming another artifact or region is refused.
- **The author condition.** In `own` mode a visitor cannot read, list, change or delete another's document by ID, `_by` filter, `_id` filter, body filter, `in` list, range or cursor; the owner side reads all; a reader none. `append`, `read` and `shared` behave as specified; the unique key gives one vote per person.
- **Bounds inside the object, exactly.** A document one byte over the cap refused and one at the cap accepted; the collection's fourth document of three refused for visitors and the owner; 30 of a burst of 40 writes accepted and exactly 10 refused, another author unaffected, the next minute open again; writes past the database size refused with nothing kept; collections capped.
- **Owner SQL.** Own tables, indexes and views work; every write and schema change to reserved tables refused and the documents unchanged; triggers refused; writes through the read call refused; several statements, recursion and transactions refused; workerd's own refusals listed; results truncated at 1,000 rows; an oversized write rolled back.
- **An expensive statement.** 64 million joined rows from 8,000 took 1.7 to 2.1 s; a visitor read on the same object waited exactly as long; a read on another object waited too in workerd.
- **Live updates.** Hibernatable WebSockets: in `own` mode only the author's connections got the change; in `append` every subscribed connection, readers included, and none subscribed elsewhere; caps per artifact and per author; closing all connections.
- **Erasing.** `deleteAll` leaves an empty database, twice is fine, and the name can be used again; erasing one author keeps the others and the counters.
- **Rows per operation** and **size per document**, as in the tables above.

## What it could not prove, and release checks

- **Jurisdictions and location hints.** workerd has no jurisdictions. Check on staging that `jurisdiction("eu")` objects are created and served from the EU and that the default namespace with `locationHint: "wnam"` lands there.
- **Real prices and active time.** Local workerd bills nothing. Run a staging load (the issue's 200 requests a day profile compressed into an hour, plus idle WebSockets) and read `durableObjectsPeriodicGroups` for active time and rows, to replace `B` in the arithmetic.
- **The CPU limit.** workerd does not enforce it. Check on staging that `limits.cpu_ms` on the data Worker applies to its objects, what the caller sees, and whether requests arriving during a statement extend it.
- **Isolate sharing.** Whether production places several artifacts' objects in one isolate, so that one statement delays others; measure with two staging objects.
- **Rollback.** That Cloudflare refuses rolling the data Worker back past `v1`, and that a later rollback keeps data.
- **Cross-script binding.** Proven in miniflare; check `wrangler deploy` with `script_name` across the three Workers in staging, and the deploy order.
- **Browsers.** Fetch metadata and `Origin` on same-origin `fetch` and WebSocket handshakes, and the review frame's partitioned cookie on data requests, in the e2e suite in all three engines.

## Alternatives rejected

| Option                                                                        | Why not                                                                                                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export the class from the content Worker                                      | One CPU limit for delivery and owner SQL; a configuration mistake in the class's Worker would take delivery down.                                     |
| A SQL parser to decide what owner SQL touches                                 | A second grammar to keep in step with SQLite; SQLite's own `EXPLAIN` program is exact and already there.                                              |
| Owner SQL may write the reserved tables, with triggers to keep the invariants | SQL can drop the triggers; invariants would be checked twice in two languages.                                                                        |
| The owner gets owner-side reads in the page                                   | A page an editor wrote would read every visitor's data through an admin's browser.                                                                    |
| One object per owner instead of per artifact                                  | One busy or hostile artifact would block all of an owner's artifacts, transfers would move data between objects, and the 10 GB limit would be shared. |
| The object writes D1 itself (alarms) to report its size                       | Gives the data Worker every region's database and an alarm per object; the content Worker's per-isolate meter already has the pattern.                |
| Live connections that last until closed by a job                              | Breaks the 60-second revocation invariant on sign-out, which writes no job.                                                                           |

## Open questions for the maintainer

1. **Revocation on live connections.** Recommended: renew signed-in connections every 60 seconds, as every other session, at about US$8 a month at 100,000 artifacts. The alternative is 5 minutes plus the close job, cheaper but a stated exception to "Revocation must take effect within 60 seconds".
2. **Erasing a deleted account's documents on other people's artifacts.** Recommended: yes, like comments, stated in the Terms. The alternative leaves them to each owner as controller, which a person cannot follow across artifacts.
3. **The numbers.** The plan limits above (3 artifacts with data and 10 MB each on Free) and the US$105 step; at 100,000 artifacts data alone costs US$37 to 82 a month, so the free tier may need to be smaller once real active time is known.
4. **Anonymous writing in workspaces.** Recommended: a workspace policy (`anonymousData: false`) in delivery 6, so an admin can forbid `anyone` on the workspace's artifacts; the policies feature is Enterprise, so other plans would rely on admins reviewing.
5. **The data Worker's CPU limit.** 1 second is proposed; a lower value protects visitors more and limits what owner SQL can do in one statement.
6. **Point-in-time recovery for owners.** Not offered; a later "undo" would have to re-apply erasures owed to people.
