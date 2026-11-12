# Artifact data spike

Spike for [decision 0026](../../docs/decisions/0026-artifact-data.md), third version: a documents object and a separate SQL sandbox per artifact in Durable Objects, with one validator over a control record, operation records, fenced two-step erasure, author barriers, budgets in pools with an owner ledger that carries debt, bounded SQL statements, lossless export, principal-bound live connections and the grant's gates.

It runs in workerd through `@cloudflare/vitest-plugin`. The test runner is the data Worker of the decision (`wrangler.jsonc` exports the three classes with a `new_sqlite_classes` migration; production puts the sandbox in its own Worker), an auxiliary Worker (`portifact-app-spike`, inline in `vitest.config.ts`) binds the documents class by `scriptName`, and a local R2 bucket (`JOURNAL`) stands for the region's bucket. No Cloudflare resource is created or used.

- `src/envelope.ts`: the envelope, the control record, `admit` (the one validator), `applyFence` and `reconcile`.
- `src/documents.ts`: `ArtifactDocuments`: the document API, operation records and replay, budgets in pools, leases bound to the owner, author barriers and bounded chunks, fences, two-step erase keeping the control records, `settle` for audit, live connections with principal-bound renewal and UTF-8 byte reservations.
- `src/sandbox.ts`: `ArtifactSandbox`: owner SQL behind the shape and opcode allowlists, one-table `INSERT … SELECT`, four indexes, measured charges kept on failure, the in-flight marker, debt through the ledger, copies with receipts, lossless export, its own two-step erase.
- `src/ledger.ts`: `OwnerLedger`: per-owner pools as balances that refill daily and can go negative.
- `src/journal.ts`: the author journal's conditional claim in R2.
- `src/model.ts`, `src/sql-guard.ts`, `src/wire.ts`, `src/grants.ts`, `src/gate.ts`: the pure rules.
- `test/review-findings.test.ts` and `test/review-findings-2.test.ts`: the two reviews' reproductions. Commit `af82ab12` adds the first twelve against the first spike and commit `b0f6234b` the next twenty-three against the second; each set failed there and passes now.

Measured (local workerd, one run on a laptop):

| Operation                                                 | Rows read    | Rows written |
| --------------------------------------------------------- | ------------ | ------------ |
| First collection declared (creates the schema)            | 42           | 44           |
| Visitor create / replace / delete                         | 24 / 23 / 14 | 17 / 12 / 10 |
| Visitor get / page of 20                                  | 12 / 33      | 2 / 2        |
| Owner create (with its audit obligation)                  | 23           | 17           |
| Any allowed query shape at 100,000 documents, page of 100 | at most 116  |              |
| Empty or sparse match at 100,000 documents                | 15 to 24     |              |

An object with its schema and one collection is 72 KiB; a 200-byte document adds about 680 bytes. A megabyte holds about 99,000 one-integer rows, and an in-place `UPDATE` wrote 5.5 to 16.7 million rows a second. A 64-million-row self-join ran 1.3 to 2.9 s and held another statement on the same sandbox as long.

Run from the repository root:

```bash
bun run spike:artifact-data
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
