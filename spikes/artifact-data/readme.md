# Artifact data spike

Spike for [decision 0026](../../docs/decisions/0026-artifact-data.md): can each artifact have its own SQLite database in a Durable Object, reached from more than one Worker, with a document API that keeps visitors apart, owner SQL that cannot break the document invariants, exact bounds and live updates?

It runs in workerd through `@cloudflare/vitest-plugin`. The test runner is the data Worker of the decision (`wrangler.jsonc` exports `ArtifactData` with a `new_sqlite_classes` migration), and an auxiliary Worker (`portifact-app-spike`, inline in `vitest.config.ts`) binds the same class by `scriptName`, as the content, app and jobs Workers will. No Cloudflare resource is created or used.

- `src/artifact-data.ts`: the Durable Object: reserved `pf_` tables, the document operations with the author condition, owner SQL behind the guard, the size, document, collection and rate bounds, hibernatable WebSockets and erasing. Every call returns the rows SQLite read and wrote.
- `src/model.ts`: modes, callers, body validation and the query builder (pure).
- `src/sql-guard.ts`: the owner SQL lexer (one statement, refused keywords) and the `EXPLAIN` program check (pure).
- `src/visitor.ts`: the opaque per-artifact visitor ID.
- `src/gate.ts`: the same-origin gate the content Worker applies before any lookup.

Measured (local workerd, one run on a laptop; the record keeps the numbers it relies on):

| Operation                                      | Rows read        | Rows written |
| ---------------------------------------------- | ---------------- | ------------ |
| First collection declared (creates the schema) | 13               | 15           |
| Create a document                              | 6                | 6            |
| Update a document                              | 8                | 4            |
| Delete a document                              | 8                | 4            |
| Get by ID                                      | 2                | 0            |
| Page of 20 (own documents or all)              | 22               | 0            |
| Filter on a body field, 1,000 documents        | 1,001            | 0            |
| Page of 100 at 100,000 documents               | 102 (1 to 2 ms)  | 0            |
| Filter on a body field at 100,000 documents    | 100,001 (169 ms) | 0            |

A 200-byte document adds about 420 bytes to the database; an object with one collection and no documents is 32 KiB; 100,000 small documents are 18 MB. An owner statement joining 8,000 rows with themselves (64 million rows, from a table of a few kilobytes) ran 1.7 to 2.1 s, and a visitor read sent at the same time waited exactly that long; in workerd a read on another artifact's object waited too, because every object runs on one thread there.

Run from the repository root:

```bash
bun run spike:artifact-data
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
