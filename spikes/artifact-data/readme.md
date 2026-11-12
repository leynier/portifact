# Artifact data spike

Spike for [decision 0026](../../docs/decisions/0026-artifact-data.md), fourth version: one documents object per artifact in a Durable Object, with no owner SQL, one validator over a control record revalidated after every await, operation records, fenced two-step erasure, terminal author erasure, budgets charged at upper bounds in owner pools through a per-owner ledger, an exact export, live connections with chunked byte reservations and the grant's gates.

It runs in workerd through `@cloudflare/vitest-plugin`. The test runner is the data Worker of the decision (`wrangler.jsonc` exports both classes with a `new_sqlite_classes` migration), an auxiliary Worker (`portifact-app-spike`, inline in `vitest.config.ts`) binds the documents class by `scriptName`, and a local R2 bucket (`JOURNAL`) stands for the region's bucket. No Cloudflare resource is created or used.

- `src/envelope.ts`: the envelope, the control record, `admit` (the one validator, with its four modes), `applyFence` and `reconcile`.
- `src/documents.ts`: `ArtifactDocuments`: the document API for the page and the owner side (counts and bulk deletes included), the three phases of every command, operation records and replay, budgets, author barriers and replayable chunks, fences, two-step erase, quarantine and its resolution, `settle` and `acknowledge` for audit, alarm-driven pruning, the export, live connections.
- `src/ledger.ts`: `OwnerLedger`: per-owner pools as balances that refill daily on a day that only moves forward, with a latch the fault schedules use to hold a lease.
- `src/journal.ts`: the author journal's conditional claim and retirement in R2.
- `src/model.ts`, `src/grants.ts`, `src/gate.ts`: the pure rules.
- `test/fault-schedules.test.ts`: a hold, a transfer and a duplicate at the lease await of every command, property tests over random sequences, the owner API, plan B Free end to end, live chunks and the ledger.
- `test/review-findings.test.ts`, `test/review-findings-2.test.ts` and `test/review-findings-3.test.ts`: the three reviews' reproductions (commits `e1b403e0`, `b3e12de7` and `3b0a286d` add them against the version reviewed; each set failed there and passes now). The owner SQL spike and its tests were removed with owner SQL; they are in commit `c5b84930`.

Measured (local workerd, one run on a laptop):

| Operation                                                 | Rows read    | Rows written |
| --------------------------------------------------------- | ------------ | ------------ |
| First collection declared (creates the schema)            | 46           | 44           |
| Visitor create / replace / delete                         | 23 / 25 / 15 | 16 / 12 / 10 |
| Visitor get / page of 20                                  | 16 / 37      | 4 / 4        |
| Owner create (with its audit obligation)                  | 21           | 16           |
| Owner bulk delete of 10 / export page of 100              | 29 / 108     | 19 / 2       |
| Any allowed query shape at 100,000 documents, page of 100 | at most 116  |              |
| Empty or sparse match at 100,000 documents                | 15 to 24     |              |

An object with its schema and one collection is 84 KiB; a 200-byte document adds about 660 bytes.

Run from the repository root:

```bash
bun run spike:artifact-data
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
