# Artifact data spike

Spike for [decision 0026](../../docs/decisions/0026-artifact-data.md), second version: can each artifact have a documents database and a separate SQL sandbox in Durable Objects, reached from more than one Worker, with fencing, durable work budgets, bounded queries, a fail-closed SQL boundary, consent-bound identities and live updates with deadlines?

It runs in workerd through `@cloudflare/vitest-plugin`. The test runner is the data Worker of the decision (`wrangler.jsonc` exports the three classes with a `new_sqlite_classes` migration; production puts the sandbox in its own Worker), and an auxiliary Worker (`portifact-app-spike`, inline in `vitest.config.ts`) binds the documents class by `scriptName`, as the content, app and jobs Workers will. No Cloudflare resource is created or used.

- `src/documents.ts`: `ArtifactDocuments`, the documents object: the document API with the author condition, the envelope check, operation IDs, durable budgets charged before work, the owner's lease, fences, the two-step erase, chunked author erasure, audit obligations, size reports with revisions, hibernatable WebSockets with deadlines and an alarm.
- `src/sandbox.ts`: `ArtifactSandbox`, the owner side's SQL database: the shape and opcode allowlists, read-only execution by rollback, typed results, budgets in its key-value store, copies, fences and erase by generation.
- `src/ledger.ts`: `OwnerLedger`, the owner's daily budget leased to artifacts.
- `src/envelope.ts`, `src/model.ts`, `src/sql-guard.ts`, `src/wire.ts`, `src/grants.ts`, `src/gate.ts`: the pure rules (the envelope, modes and query shapes, the SQL allowlists, the wire form, the grant handoff and sealed keys, the gates).
- `test/review-findings.test.ts`: the review's counterexamples. Commit `af82ab12` adds them against the first spike, where all twelve fail; they pass on the redesign.

Measured (local workerd, one run on a laptop; the record keeps the numbers it relies on):

| Operation                                                 | Rows read    | Rows written |
| --------------------------------------------------------- | ------------ | ------------ |
| First collection declared (creates the schema)            | 28           | 31           |
| Visitor create / replace / delete                         | 16 / 21 / 15 | 9 / 9 / 7    |
| Visitor get / page of 20                                  | 12 / 33      | 1 / 1        |
| Owner create (with its audit obligation)                  | 15           | 9            |
| Any allowed query shape at 100,000 documents, page of 100 | at most 118  |              |
| Empty or sparse match at 100,000 documents                | 17 to 26     |              |

An object with its schema and one collection is 52 KiB; a 200-byte document adds about 840 bytes. An owner statement joining 8,000 rows with themselves ran 1.3 to 1.5 s and held another statement on the same sandbox as long; in workerd a documents read waited too, because every object runs on one thread there.

Run from the repository root:

```bash
bun run spike:artifact-data
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
