# 0005 Regions and EU data residency

- Status: proposed (spike S4 of the paid plans programme; blocks F3's region column and resolver and E5)
- Date: 2026-11-09
- Spike: [spikes/regions](../../spikes/regions)

## Question

Enterprise workspaces will be able to keep their data in the EU. The promise: a workspace created in the EU region has its files, artifact metadata, comments and logs stored in the EU. The region is chosen when the workspace is created and never changes. Identity (users, sessions, OAuth) stays global, and processing only in the EU is not promised.

How does the code get there without a batch that spans two databases, without an extra D1 read per delivery request, and with as little as possible built into workspaces (F3) before the EU exists?

## Facts checked

Re-read in Cloudflare's documentation on 2026-11-09. Only read, not run against Cloudflare.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                            | Source                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| An R2 bucket's jurisdiction is set at creation and "cannot be changed". A Worker reaches it with `"jurisdiction": "eu"` next to `bucket_name` in the `r2_buckets` binding. The S3 endpoint is `https://<account_id>.eu.r2.cloudflarestorage.com`, and a jurisdiction endpoint cannot reach buckets outside it. Location hints are best effort; only jurisdictions guarantee where objects are stored.           | [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)           |
| `wrangler r2 bucket create`, `r2 bucket cors set` and `r2 bucket lifecycle add` take `--jurisdiction`.                                                                                                                                                                                                                                                                                                          | [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)     |
| D1 jurisdictions are `eu`, `fedramp` and `us`, "can only be set on database creation and cannot be added or updated after". Created with `wrangler d1 create <name> --jurisdiction=eu`. "Workers may still access the database constrained to a jurisdiction from anywhere in the world": the jurisdiction decides where data is stored, not where it is processed. Read replicas stay inside the jurisdiction. | [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)       |
| Regional Services, which keeps Workers execution in a region, "is an Enterprise add-on". Portifact does not have it.                                                                                                                                                                                                                                                                                            | [Regional Services](https://developers.cloudflare.com/data-localization/regional-services/) |

Not found in those pages, so still open: whether D1 Time Travel works the same on a jurisdictional database, and whether an R2 API token scoped to buckets can include a jurisdictional bucket next to the default one. The plan's note that jurisdictions carry no surcharge was not re-checked against the pricing pages.

## What was tried

`spikes/regions` is a reduced model of the tables the cross-database operations touch, run in workerd with three local D1 databases (`GLOBAL`, `DB_DEFAULT`, `DB_EU`) and two local R2 buckets. No Cloudflare resource is used. Every cross-database test runs twice: with every region in its own database, which proves the code never relies on two handles being the same database, and with the default region inside the control database, the layout production would use.

Verified by running code (`bun run spike:regions`, 45 tests, 100% of lines and 95% of branches):

1. **Creating an artifact across databases** (`src/create.ts`): the ID is claimed in the global directory (only if it has no tombstone), then the artifact is written in the owner's region. Two concurrent creates that draw the same ID get one winner and the loser draws again; a tombstoned ID is never handed out; a crash between the claim and the regional write leaves only an unused ID that serves 404 and can never be claimed again, and the retry succeeds with a new ID; nothing regional is written when no ID can be claimed.
2. **Account deletion across regions** (`src/deletion.ts`, `src/purge.ts`): one global batch deletes the user, then one batch per region fences the owner and claims what it owns. Artifact and comment writes still in flight after the fence are refused by a trigger. Four concurrent runs finish exactly once with one tombstone; a run never finishes while any region still holds the account's artifacts or comments; comments on other owners' artifacts are erased in slices; a region that is down at request time is fenced by the job later. A purge job delivered twice concurrently is harmless.
3. **The content Worker's lookup** (`src/delivery.ts`): two D1 queries for an artifact the isolate has not seen, then one per request, which is today's cost; an unknown ID costs one query, as today, and a miss is never cached. An EU artifact's bytes are read only from the EU bucket.
4. **Read sessions**: today's `read_sessions` shape, with foreign keys to `users` and `sessions`, cannot be inserted in a regional database (D1 enforces the keys and those rows are global). Without the keys, signing out still stops renewal, because the liveness check already runs on every redeem and refresh and becomes a read of the global database.
5. **Outbox per database**: jobs carry the database they live in, run against that region's database and bucket, and are idempotent on redelivery and on an old generation. With the default region inside the control database, relaying per region would send every row twice; relaying per database does not.
6. **Tombstones after a restore**: after a simulated Time Travel restore of the EU database, re-applying the global tombstones deletes a purged artifact again and re-fences a deleted account.

Mutation checks run by hand: making every deletion run report `finished`, disabling the fence trigger and dropping the tombstone condition from the ID claim each made the expected tests fail.

Only read, not run: the wrangler bindings, presigning against the real EU endpoint, CORS on a jurisdictional bucket, and the jobs in section 5 beyond the outbox and purge.

## Recommended design

### 1 Region resolver

`REGIONS` and `Region` live in `packages/contracts`. Each Worker builds one `Regions` value from its bindings:

```ts
interface RegionHandles {
  region: Region;
  db: RegionalDb; // control data of the region
  accessDb: AccessDb; // access log of the region
  bucket: R2Bucket;
  presigner: Presigner; // signs against the region's S3 endpoint
}
interface Regions {
  global: GlobalDb;
  get(region: Region): RegionHandles; // throws for a region without bindings, never falls back
  all(): readonly RegionHandles[];
}
```

`GlobalDb` and `RegionalDb` are the same Drizzle `Db` with a brand, so passing one where the other is expected is a type error. A service that touches only owner data takes `RegionalDb` (and `R2Bucket`); one that touches identity takes `GlobalDb`; the few that need both take `{ global, regional }`. Services keep taking handles as arguments. Who passes them:

- **App Worker** (`/api/v1`, MCP, `/read/<id>`): the access layer already resolves the user; F3's `resolveActor` returns `Actor { userId, ownerId, role, region }` from the membership and the workspace row, and the adapter calls the service with `regions.get(actor.region)`. Routes that name only an artifact (the viewer lookup, `/read/<id>`, reports) find the region in the directory. Presigned upload and download URLs come from that region's presigner.
- **Content Worker**: the hostname gives the ID, the directory gives the region, and delivery, read and review sessions, the traffic meter and the opening log use that region's handles. `TrafficMeter` and `OpeningLog` keep one pending batch per region.
- **Jobs Worker**: every scan and the relay loop over `regions.all()` (section 5); a queue message names its database.

A personal space is always in the default region. A workspace's region is `organizations.region`, which a trigger refuses to change. Transferring an artifact between owners in different regions is refused in the domain, with the same error in web, CLI and MCP.

Bindings, the same shape in the three Workers:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "portifact-control", "database_id": "..." },
  { "binding": "ACCESS_DB", "database_name": "portifact-access", "database_id": "..." },
  // Created once with `wrangler d1 create <name> --jurisdiction=eu`; the ID goes here.
  { "binding": "DB_EU", "database_name": "portifact-control-eu", "database_id": "...", "migrations_dir": "../../packages/db/migrations" },
  { "binding": "ACCESS_DB_EU", "database_name": "portifact-access-eu", "database_id": "...", "migrations_dir": "../../packages/db/access-migrations" }
],
"r2_buckets": [
  { "binding": "ARTIFACTS", "bucket_name": "portifact-artifacts" },
  { "binding": "ARTIFACTS_EU", "bucket_name": "portifact-artifacts-eu", "jurisdiction": "eu" }
],
"vars": { "R2_BUCKET_EU": "portifact-artifacts-eu" }
```

The app Worker's EU presigner signs against `https://<account_id>.eu.r2.cloudflarestorage.com/portifact-artifacts-eu`, and `dashboardCsp`'s `connect-src` gains that host. The EU bucket gets the same CORS rule as today's, set with `wrangler r2 bucket cors set portifact-artifacts-eu --jurisdiction eu`, and its lifecycle rule with `--jurisdiction eu`. Whether the existing R2 API token can cover both buckets is checked when the bucket is created; otherwise the EU presigner gets its own secret pair.

**One migration history for every control database.** The EU database gets the same migrations as `portifact-control`, so its global tables exist and stay empty. Two histories would drift. The cost is that no regional table may keep a foreign key into a global table (finding 4), and the storage reconciliation reports any row found in a global table of a regional database.

### 2 Global artifact directory

`artifact_directory (id primary key, region, created_at)` in the global database: no owner, no name, no personal data. A row is written when an ID is claimed and is never updated or deleted (triggers refuse both), so every ID ever handed out is in it and none is reused in any region. The content Worker caches positive answers in isolate memory (a bounded LRU of 10,000 entries) with no expiry and no invalidation, because the answer cannot change. Misses are not cached.

| Option                                           | Delivery cost                                                                                                  | Creation                                                             | Compatibility                                                                                                                                                                                                                                                                      | Verdict    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Global `artifact_directory`, cached              | One extra read per artifact per cold isolate, then today's single read; an unknown ID costs one read, as today | Claim the ID globally, then the regional batch (prototyped)          | No change to IDs or hostnames                                                                                                                                                                                                                                                      | **Chosen** |
| Region in the ID (a marker character)            | No extra read                                                                                                  | One regional batch                                                   | `ArtifactId` is `^[a-z2-7]{10}$` in contracts and released CLIs validate it (`parseArtifactId`). A marker inside the alphabet collides with existing IDs (about 1 in 32 start with any given letter); one outside it breaks every released CLI. It also caps the number of regions | Rejected   |
| Region in the hostname (`<id>.eu.portifact.dev`) | No extra read                                                                                                  | Still needs a global ID registry, or IDs could repeat across regions | A second-level wildcard is not covered by the Universal SSL certificate (it needs Advanced Certificate Manager, a paid add-on); links, `viewerCsp`, `frame-ancestors`, the review flow and the cookie rules all gain a second content host shape                                   | Rejected   |

Tombstones stay global, as `tombstones` today, and the directory blocks reuse on its own as well. The existing `artifacts_refuse_tombstoned_id` trigger keeps working for the default region and is inert in the EU database (its `tombstones` table is empty), which is fine because the claim checks the global table.

**Restore of the global database.** Directory rows claimed after the restore point disappear while their artifacts still exist in a region. The restore drill rebuilds them from every region (`insert ... select id, '<region>' from artifacts on conflict do nothing`) before publishing reopens, next to `applyTombstones`. Until then a lost ID could in theory be claimed again; with 32^10 IDs that is improbable, and a reuse in the same region fails on the regional primary key anyway.

### 3 Operations that would span two databases

"Global first" means the global write is the point of no return and the regional part is retried by a job until done. The fence is `owner_fences`, a regional table whose rows a trigger checks on inserts of artifacts, threads and messages (prototyped); it is the regional copy of an `account` tombstone.

| Operation today (one batch)                                                              | Global part                                                                                                | Regional part                                                                            | How it stays correct                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an artifact (`preparePublish`)                                                    | Directory claim                                                                                            | Artifact, version, files, usage, upload session                                          | Claim first, then the regional batch (prototyped). A crash leaves an unused ID. The idempotency record is regional and in the batch, so a retry after a crash in between draws a new ID                                                                                                                                                         |
| Account deletion (`requestAccountDeletion`, `advanceAccountDeletion`)                    | User and its cascades, `account_deletions`, the `account_deletion` job, the `account` tombstone at the end | Fence and claim per region; comments on other owners' artifacts; read sessions; openings | Global first; fence and claim per region inline and from the job; finish with one global batch whose `returning` row tells one run it finished (prototyped). Personal artifacts are in the default region; between the global batch and the inline claim they stay servable only while the inline step runs, or until the job runs if it failed |
| Workspace deletion (F3)                                                                  | Workspace row, memberships, invitations, plan; job; tombstone                                              | Fence and claim in its region                                                            | The same path as an account                                                                                                                                                                                                                                                                                                                     |
| Transfer between personal space and workspace (T1)                                       | Nothing when both owners are in one region                                                                 | Owner change and usage move                                                              | Refused across regions, so it stays one regional batch                                                                                                                                                                                                                                                                                          |
| Readers matched by email (`artifact_readers`, `checkReadAccess`)                         | The user's verified email                                                                                  | The reader list                                                                          | Two reads, no write; nothing to split                                                                                                                                                                                                                                                                                                           |
| Read and review handoffs and sessions (keys to `sessions.id` and `users.id`)             | Better Auth session, user                                                                                  | Handoff and session rows                                                                 | Keys dropped (finding 4); redeem and refresh check the global session, as they already do, so sign-out ends a session at its next renewal, within the existing 60-second SLA. A session deleted between the check and the regional insert lives at most until that renewal. Rows are pruned on expiry and erased per region by account deletion |
| Access log (`recordOpenings`, `erase_access_events`)                                     | None                                                                                                       | Openings in the region's access database                                                 | Already a separate database: each region's control outbox writes `erase_access_events` for its own access database                                                                                                                                                                                                                              |
| Outbox                                                                                   | Global jobs (account deletion)                                                                             | Regional jobs (purge, delete objects, abort multipart, erase openings, expiry notices)   | One outbox per database, the job written in the batch of the state change as today; messages carry `scope`, the database (prototyped)                                                                                                                                                                                                           |
| Purge (`purge_artifact`, `deleteArtifactData`)                                           | `artifact` tombstone                                                                                       | Objects and rows                                                                         | The job writes the global tombstone first (a `purging` artifact never returns), then deletes; a crash in between is finished by the redelivery (prototyped)                                                                                                                                                                                     |
| Tombstones around a restore (`exportTombstones`, `applyTombstones`)                      | Tombstones, deletions, directory                                                                           | `purging` artifacts and fences                                                           | Export from every database; apply re-deletes and re-fences per region (prototyped) and rebuilds the directory after a global restore                                                                                                                                                                                                            |
| Suspensions (`0010_moderation_triggers.sql`)                                             | Abuse reports                                                                                              | Artifact state, `suspensions`, active slots                                              | `suspensions` is regional, so the suspension and the slot triggers stay one batch; the operator tool marks the report `actioned` in a second, idempotent step                                                                                                                                                                                   |
| Budget and email counters (`recordEmailsSent`, `checkNoticeCapacity`, `platform_budget`) | All of them                                                                                                | None                                                                                     | Global already. A regional `expiry_notice` job deletes its regional row, sends and counts in the global database, the same order and failure handling as today                                                                                                                                                                                  |
| Traffic (`recordTraffic`)                                                                | None                                                                                                       | The owner's `traffic_counters`                                                           | An owner is in one region, so it stays one regional upsert; the budget run sums every region                                                                                                                                                                                                                                                    |

### 4 Tables

Global (in `portifact-control`, which also holds the default region's data):

- `auth-schema.ts`, all of it: `users`, `sessions`, `accounts`, `verifications`, `oauth_clients`, `oauth_resources`, `oauth_client_resources`, `oauth_refresh_tokens`, `oauth_access_tokens`, `oauth_consents`, `oauth_client_assertions`, `device_codes`, `rate_limits`.
- `schema.ts`: `account_settings` (keyed by user), `account_deletions`, `tombstones`, `abuse_reports`, `platform_budget`, `budget_alerts`, `email_suppressions`, `email_counters`.
- New: `artifact_directory`; with F1 and F3, `owner_plans`, `organizations` (with `region`), `org_members`, `org_invitations`.
- In every database, one instance each: `outbox`, `maintenance_cursors`, `operations` (an idempotency record lives where its operation writes).

Per region (in `portifact-control` for the default region, in `portifact-control-eu` for the EU):

- `schema.ts`: `artifacts`, `artifact_readers`, `read_handoffs`, `read_sessions`, `review_handoffs`, `review_sessions` (these four without their keys to `users` and `sessions`), `versions`, `source_origins`, `objects`, `version_files`, `upload_sessions`, `multipart_uploads`, `multipart_parts`, `account_usage`, `usage_events`, `traffic_counters`, `storage_findings`, `lifecycle_events`, `suspensions`, `annotation_threads`, `annotation_messages`, `annotation_events`, `annotation_usage`.
- New: `owner_fences`.
- `access-schema.ts`: `access_events`, in `portifact-access` and `portifact-access-eu`.

### 5 Jobs per region

- **Maintenance scans** (archive, expire uploads, prune, purge, version expiry, read session prune, re-render): once per regional database, each with its own `maintenance_cursors`. Account deletions run from the global database and fan out.
- **Outbox relay**: once per database, never per region (finding 5). `JobMessage` gains `scope`; a message without it means the control database, so messages already queued at deploy still work.
- **Purges**: regional jobs, global tombstone first.
- **Storage reconciliation**: per region, each bucket against its database, findings in that region's `storage_findings`, plus the check that global tables in a regional database are empty.
- **Budget run**: one run; metrics summed from every region's counters, and Cloudflare's analytics for every resource (`PORTIFACT_RESOURCES` gains the EU databases and bucket); state in the global `platform_budget`.
- **Backups and the restore drill**: Time Travel is per database, so the drill covers each one. After restoring any database, re-apply tombstones in every region, and rebuild the directory if the global one was restored. Whether Time Travel behaves the same on a jurisdictional database is checked in the first drill.
- **Operator tool**: commands that name an artifact find its region in the directory; commands that scan (`storage-report`, `export-tombstones`, `apply-tombstones`) take `--region` and default to every region; `--config` keeps working with a scratch database per region.

### 6 What leaves the region

| What                                                                         | Rule                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, account settings, workspace names, memberships, invitations, plans | Global by design and stated in the promise. Workspace names and slugs are global; the DPA says so, and the dashboard says it when the region is chosen                                             |
| Directory and tombstones                                                     | IDs, a region and times only                                                                                                                                                                       |
| Abuse reports                                                                | Global operator data sent by third parties; they may quote an artifact. Stated in the privacy and subprocessor texts                                                                               |
| Processing                                                                   | Workers run where the request lands and read EU data there. Not promised otherwise without Regional Services                                                                                       |
| Caches                                                                       | Nothing caches an EU artifact's bytes or metadata outside D1 and R2: no Cache API, KV or Durable Object copy. Nothing does today; the isolate cache holds only ID to region                        |
| Emails                                                                       | Sent through Cloudflare Email Service. For an EU workspace, notices carry a count and a link, never comment text or artifact names (expiry notices list names today, so they change for EU owners) |
| Webhooks and integrations                                                    | Destinations the customer chooses, documented as leaving the region; the existing body rules apply                                                                                                 |
| Queues                                                                       | Messages carry only `{ scope, id, topic }`; payloads stay in the outbox row                                                                                                                        |
| Logs                                                                         | Workers observability is global: never log artifact names, comment bodies, emails or content, in any region (today's rule covers tokens and bodies; it widens)                                     |
| Analytics and budget                                                         | Aggregate counts only, no identifiers                                                                                                                                                              |
| Traffic limiter Durable Object                                               | Counters per visitor IP for budget protection, no workspace data                                                                                                                                   |

### 7 What F3 must include now

Only what would otherwise make E5 touch every service again:

1. `REGIONS = ["default"] as const` and `type Region` in `packages/contracts`.
2. `organizations.region text not null default 'default'`, with a trigger that refuses changing it.
3. `Actor { userId, ownerId, role, region }`, filled only in the services by `resolveActor(global: GlobalDb, userId: string, ownerId: string): Promise<Result<Actor>>`.
4. `GlobalDb` and `RegionalDb` brands in `packages/db`, used in the signatures F3 already rewrites for `Actor` (`{ global, regional }` where both are needed). With one region both wrap the same binding.
5. `Regions` with `get` and `all`, built once per Worker by `regionsFromEnv(env)`, so adapters call `regions.get(actor.region)` instead of `createDb(env.DB)`.
6. `artifact_directory`, backfilled from `artifacts`, with the never-update and never-delete triggers, and `preparePublish` claiming the ID there before its batch (`claimArtifactId`).

Everything else (fences, dropping the session keys, scoped messages, jobs per region, the EU bindings) waits for E5.

Implemented in F3 with decision 0004's names: `workspaces.region` and `workspace_members` instead of `organizations` and `org_members`. One deviation from item 4: a `RegionalDb` carries its deployment's global database as `.global`, so services that work on regional data and resolve a role or claim an ID take one `RegionalDb` instead of `{ global, regional }`; the brands still keep a `GlobalDb` from being passed as a `RegionalDb` and the reverse. With a second region, each region's handle points at the same `GlobalDb`.

## Cost and effort

Cloudflare: the EU databases and bucket have no fixed fee and are billed by use like the others (from the plan, not re-checked). Delivery adds one D1 read per artifact per cold isolate, at about US$0.001 per million rows read: negligible. A second R2 API token may be needed; nothing else is known.

Effort, inferred from recent PR sizes, not measured:

| Order | PR                                                                                                                                                                                                                     | Size                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| F3    | The six items above, inside F3's own PRs                                                                                                                                                                               | 1 to 1.5 extra days |
| E5.1  | `owner_fences` and their triggers; the keys dropped from the four handoff and session tables (table rebuilds); liveness read through the global handle                                                                 | 1.5 days            |
| E5.2  | Account and workspace deletion fanned out per region; tombstone export and apply per region; directory rebuild                                                                                                         | 2 days              |
| E5.3  | Outbox per database with `scope`; scans, reconciliation, budget sums and access log prune per region                                                                                                                   | 1.5 days            |
| E5.4  | Content Worker: directory lookup with the isolate cache, traffic meter and opening log per region, read and review sessions across databases                                                                           | 1.5 days            |
| E5.5  | App Worker: presigner per region and CSP; region choice at workspace creation in the dashboard, `--region` in the CLI and the MCP parameter, with skills and the 8 languages                                           | 1.5 days            |
| E5.6  | Infrastructure: the maintainer creates the EU databases and bucket; bindings in the three Workers, CORS and lifecycle, `docs/releasing.md`, `docs/operations.md` and the restore drill per region, operator `--region` | 1 day               |
| E5.7  | Email and logging rules for EU owners, `docs/security.md`, privacy and subprocessor texts (the legal part waits for the company)                                                                                       | 1 day               |
| E5.8  | End to end: an EU workspace published, viewed, commented on and deleted on the e2e stack with two databases and two buckets                                                                                            | 1 day               |

About 8 PRs and 11 days for E5 after F3, in line with the plan's estimate for wave 3. E5.1 to E5.4 are sequential; E5.5 to E5.8 can run in parallel after E5.4.

## Alternatives rejected

- **Region in the ID or the hostname**: see section 2.
- **One database per workspace**: isolates perfectly but multiplies migrations, backups and drills by the number of workspaces, and still needs the global directory.
- **Copying regional data into the global database for lists or search**: breaks the promise; lists read from the owner's region.
- **A two-phase commit table across databases**: D1 has no cross-database transaction, and the outbox with ordered, idempotent steps gives the same outcome with patterns the codebase already uses.
- **Keeping read and review sessions global, next to identity**: keeps the sign-out cascade, but those rows say who opened which artifact, the kind of log the promise covers. The liveness check already ends them on sign-out, so the cascade is only cleanup.
- **Moving a workspace between regions**: not a switch. It is an export and an import into a new workspace with new artifact IDs.

## Open risks

- Time Travel on jurisdictional D1 databases and an R2 token covering a jurisdictional bucket stay unverified until the resources exist.
- A request authenticated just before an account deletion can still land in a region in the moment before its fence; the fence closes it for everything after, and the job's repeated claim covers what landed before.
- Workers process EU data outside the EU. A customer who needs processing in the EU too needs Regional Services (Cloudflare Enterprise) and a different promise.
- The prototype models only the tables it needs; the real `preparePublish`, purge and deletion batches carry more statements, and each must be split along the same lines with its own tests.
