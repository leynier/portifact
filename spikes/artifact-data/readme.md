# Artifact data spike

Spike for [decision 0026](../../docs/decisions/0026-artifact-data.md), fifth and last design version: one documents object per artifact in a Durable Object, with no owner SQL and no owner ledger. Every command is synchronous (one transaction from admission to work), every limit is the artifact's own and charged by measured work in the work's transaction, erase steps carry an erase ID and refuse under a hold, author erasure is terminal, indexes are built in bounded steps, and live connections reserve messages against the artifact's day. It shows the protocols are sound in workerd; it is not the product, which starts with delivery 3's contracts and their adversarial code review.

It runs in workerd through `@cloudflare/vitest-plugin`. The test runner is the data Worker of the decision (`wrangler.jsonc` exports the class with a `new_sqlite_classes` migration), an auxiliary Worker (`portifact-app-spike`, inline in `vitest.config.ts`) binds the documents class by `scriptName`, and a local R2 bucket (`JOURNAL`) stands for the region's bucket. No Cloudflare resource is created or used.

- `src/envelope.ts`: the envelope and the control record, with `admit`, `applyFence` and `reconcile` now delegating to the production rules of delivery 3 (`@portifact/domain/artifact-data`) through adapters that keep the spike's answer shapes; `src/hash.ts`, the scopes and `newerReport` in `src/model.ts` and the gates in `src/gate.ts` are the production functions too, so the workerd tests here exercise them.
- `src/documents.ts`: `ArtifactDocuments`: the document API for the page and the owner side, the one-transaction mutation shape, per-artifact counters, operation records with the issue-time horizon, author barriers and replayable chunks, fences, erase intents, quarantine and its resolution, `settle` and `acknowledge`, alarm-driven pruning, owner and visitor export, live connections.
- `src/journal.ts`: the author journal's conditional claim, retirement and its one retention rule in R2.
- `src/model.ts`, `src/grants.ts`: the spike's remaining pure rules (query SQL, bodies, grant codes); the production versions are in `packages/domain/src/artifact-data`.
- `test/invariants.test.ts`: synchronous commands, concurrent holds and duplicates, measured charging, caps, incremental index builds, the owner API, plan B Free end to end, live message chunks, the journal rule, and property tests over random command sequences.
- `test/review-findings.test.ts` to `test/review-findings-4.test.ts`: the four reviews' reproductions (commits `e1b403e0`, `b3e12de7`, `3b0a286d` and `3db6c7b1` add them against the version reviewed; each set failed there and passes now). The owner SQL spike is in commit `c5b84930` and the owner ledger in commit `65b85f06`.

Measured (local workerd, one run on a laptop):

| Operation                                                 | Rows read    | Rows written |
| --------------------------------------------------------- | ------------ | ------------ |
| First collection declared (creates the schema)            | 42           | 44           |
| Visitor create / replace / delete                         | 11 / 13 / 12 | 13 / 9 / 11  |
| Visitor get / page of 20                                  | 4 / 25       | 0 / 0        |
| Owner create (with its audit obligation)                  | 10           | 14           |
| Owner bulk delete of 10 / export page of 100              | 55 / 106     | 47 / 2       |
| Any allowed query shape at 100,000 documents, page of 100 | at most 116  |              |
| Empty or sparse match at 100,000 documents                | 15 to 24     |              |

An object with its schema and one collection is 100 KiB; a 200-byte document adds about 720 bytes.

Delivery 2's feasibility experiments (the record's "Feasibility results"):

- `src/drill.ts` and `test/restore-drill.test.ts`: experiment 2, the restore drill. The rows D1 keeps about data (a model, not Portifact's schema), the tombstones a restore must not lose, the R2 inventory and journal, and every transition the record lists on both sides of a restore point; the local test restores D1 by snapshot, re-applies the export, runs reconciliation and checks the recovery table (a local D1, `MAIN`).
- `test/billing.test.ts`: experiment 3's local half. Rows per command against the record's table, no timer in the object, and alarms counted over simulated days with a fake clock (it reaches the object, which runs in the test's isolate).
- `drill/runbook.ts`, `drill/worker.ts` and `src/runbook-plan.ts`: the deployed halves, for the maintainer's agent only. `CLOUDFLARE_API_TOKEN=… node spikes/artifact-data/drill/runbook.ts run --account-id <id>` creates a scratch Worker with this object, a D1 database and an R2 bucket named `pf-exp-data-<run>…` (it refuses any other name and prints no secret), runs the drill with a real Time Travel restore and the billing workload, reads the GraphQL analytics, prints observed against expected and deletes everything; `report --state <file>` resumes the analytics and `cleanup --state <file>` deletes again (idempotent). CI never runs it.
- Experiment 1, the grant handoff in browsers, is `spikes/artifact-data-grant`.

Results (2026-11-12; the record's "Feasibility results" has the tables):

- Restore drill: 13 of 13 scenarios and 11 of 11 follow-ups as the recovery table says, locally and on the scratch deployment with a real Time Travel restore (run `9bed1a8b`).
- Billing: rows per command equal the record's table locally. On the scratch deployment rows written match it and rows read are higher: 1 more per command (the storage report), 1 more per mutation (live invalidation), 1 per subscribed socket, 24 per cold start (the `sqlite_schema` check after a new instance or a hibernation) and 1 more written on an author's first write of a minute (the rate row). `billing.test.ts` reproduces every deployed minute's rows exactly from that rule.
- Active time on the deployment: reads 11 to 16 ms, writes 42 to 50 ms, a pruning alarm on a cold object 108 ms, 1 to 4 ms of CPU each; idle and held objects and an idle connection hibernate (one wake in 10 idle minutes, none held, 0.108 s active for a 610 s connection).
- Alarms: an object wakes about twice per mutation a day later to prune (241 wakes in an hour for 120 writes, locally), which the record's first cost formula left out.
- The runbook's report now floors the per-minute dataset's window to its minute, leaves a whole minute without work before every phase, and no longer asks for fields Cloudflare does not document (`workersInvocationsAdaptive.sum.cpuTime`, a namespace filter on `durableObjectsStorageGroups`).

Run from the repository root:

```bash
bun run spike:artifact-data
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
