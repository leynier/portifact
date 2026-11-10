# Content search spike

Spike for [decision 0012](../../docs/decisions/0012-content-search.md): can SQLite FTS5 hold the content search index of the paid plans (feature `contentSearch`) in D1, next to the artifacts, with guarded batches and the repository's migrations, and which tokenizer serves the product's eight languages?

It runs in workerd through `@cloudflare/vitest-plugin`, with one local D1 database (`DB`, a reduced regional database). No Cloudflare resource is created or used.

- `migrations/0001_init.sql`: a reduced `artifacts` table, the index tables, the FTS5 table, its triggers, and two FTS5 tables used only to compare tokenizers.
- `src/search.ts`: CJK segmentation, the MATCH builder, an artifact's index written in one guarded batch, one owner's search and the snippet parser.
- `test/search.test.ts`: FTS5 and Drizzle side by side, owner isolation, the tokenizer comparison and hostile queries.
- `test/lifecycle.test.ts`: stale and repeated jobs, rollback of a failed batch, every removal path through triggers and cascades, storage growth and query cost.
- `test/snippet-cost.test.ts`: why the index is chunked.

Run from the repository root:

```bash
bun run spike:content-search
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
