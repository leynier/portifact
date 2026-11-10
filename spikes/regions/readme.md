# Regions spike

Spike S4 for [decision 0005](../../docs/decisions/0005-regions.md): can an Enterprise workspace keep its files, artifact metadata, comments and logs in the EU while identity stays global, without any batch spanning two databases?

It runs in workerd through `@cloudflare/vitest-plugin`, with three local D1 databases (`GLOBAL`, `DB_DEFAULT`, `DB_EU`) and two local R2 buckets (`ARTIFACTS`, `ARTIFACTS_EU`). No Cloudflare resource is created or used. Every cross-database test runs in two layouts: every region in its own database (`separate`), and the default region inside the control database (`colocated`), the layout production would use.

- `migrations/0001_init.sql`: the reduced tables the prototype needs. One history is applied to every control database.
- `src/regions.ts`: the region resolver (`createRegions`, `ownerRegion`, the EU S3 endpoint).
- `src/directory.ts`: the global artifact directory with its isolate cache.
- `src/create.ts`: creating an artifact (claim the ID globally, then write it in the region).
- `src/delivery.ts`: the content Worker's lookup and object read.
- `src/read-session.ts`: read sessions without foreign keys into the identity tables.
- `src/deletion.ts` and `src/purge.ts`: account deletion fanned out to every region with owner fences, purges and tombstones after a restore.
- `src/outbox.ts`: one outbox per database, relayed per database.

Run from the repository root:

```bash
bun run spike:regions
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
