# Operations

How the operator handles abuse reports and suspensions (plan section 13). There is no operator web UI: every operator action runs from the operator's machine through the operator tool.

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

## Account deletions

Deletions need no operator action: the request removes the user at once and the scheduled jobs finish the rest (see "Account deletion" in [security.md](security.md)). `select * from account_deletions` lists the ones still in progress.

## Traffic quota

An account whose artifacts served 1 million requests or 25 GB in the current UTC month gets 429 on all of them until the next month (`TRAFFIC_LIMITS`; see "Access control" in [security.md](security.md)). Its counters are in `traffic_counters`, one row per account and month, for example `select owner_id, requests, bytes from traffic_counters where cycle_start = <month start in ms> order by bytes desc limit 20` to see the largest consumers during a budget review. There is no operator command to raise or reset a counter: a quota exception is a product decision, not an operation. Counters older than the previous month are pruned by the maintenance job.
