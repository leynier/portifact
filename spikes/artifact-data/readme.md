# Artifact data spike

Spike for [decision 0026](../../docs/decisions/0026-artifact-data.md), fifth and last design version: one documents object per artifact in a Durable Object, with no owner SQL and no owner ledger. Every command is synchronous (one transaction from admission to work), every limit is the artifact's own and charged by measured work in the work's transaction, erase steps carry an erase ID and refuse under a hold, author erasure is terminal, indexes are built in bounded steps, and live connections reserve messages against the artifact's day. It shows the protocols are sound in workerd; it is not the product, which starts with delivery 3's contracts and their adversarial code review.

It runs in workerd through `@cloudflare/vitest-plugin`. The test runner is the data Worker of the decision (`wrangler.jsonc` exports the class with a `new_sqlite_classes` migration), an auxiliary Worker (`portifact-app-spike`, inline in `vitest.config.ts`) binds the documents class by `scriptName`, and a local R2 bucket (`JOURNAL`) stands for the region's bucket. No Cloudflare resource is created or used.

- `src/envelope.ts`: the envelope, the control record, `admit` (the one validator, with its four modes), `applyFence` and `reconcile`.
- `src/documents.ts`: `ArtifactDocuments`: the document API for the page and the owner side, the one-transaction mutation shape, per-artifact counters, operation records with the issue-time horizon, author barriers and replayable chunks, fences, erase intents, quarantine and its resolution, `settle` and `acknowledge`, alarm-driven pruning, owner and visitor export, live connections.
- `src/hash.ts`: a synchronous SHA-256, so binding an operation to its request needs no await.
- `src/journal.ts`: the author journal's conditional claim, retirement and its one retention rule in R2.
- `src/model.ts`, `src/grants.ts`, `src/gate.ts`: the pure rules.
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

Run from the repository root:

```bash
bun run spike:artifact-data
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
