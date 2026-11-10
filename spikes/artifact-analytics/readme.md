# Artifact analytics spike

Spike S3 for [decision 0007](../../docs/decisions/0007-artifact-analytics.md): where do per-artifact numbers (page views per day, distinct signed-in visitors) live and how are they read, without a D1 write per delivery request and without identifying anonymous visitors?

It runs in workerd through `@cloudflare/vitest-plugin`, with two local D1 databases (`CONTROL`, reduced `portifact-control`, and `ACCESS`, reduced `portifact-access`) and one local Analytics Engine binding that only records what workerd does with it. No Cloudflare resource is created or used.

- `migrations/control` and `migrations/access`: the reduced tables. `access` holds today's `access_events` with a per-row `expires_at` and the new `artifact_views` (one row per artifact and UTC day, `WITHOUT ROWID`).
- `src/views.ts`: the counting rule (`pageView`): what is one view, what is never one.
- `src/meter.ts`: `ViewMeter`, the per-isolate batching, the same shape as `TrafficMeter`.
- `src/record.ts`: the batched upsert, pruning by expiry, retention changes after a plan change and the erasure an artifact purge runs.
- `src/stats.ts`: `getArtifactStats`, the owner-only read behind the API, MCP and CLI.

Run from the repository root:

```bash
bun run spike:artifact-analytics
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
