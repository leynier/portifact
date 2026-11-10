# Custom domains spike

Spike S2 for [decision 0006](../../docs/decisions/0006-custom-domains.md): how can a paid owner serve one artifact from their own hostname (`docs.example.com`) through Cloudflare for SaaS, without an extra D1 read per delivery request and without weakening the isolation of `docs/security.md`?

It runs in workerd through `@cloudflare/vitest-plugin`, with two local D1 databases: `GLOBAL` (the control database, which also holds the default region, as production would) and `DB_EU` (a regional database of decision 0005). No Cloudflare resource is created or used: the custom hostnames API and DNS over HTTPS are fakes behind the interfaces in `src/domains.ts`, and `src/cloudflare.ts` is checked against a fake `fetch` only.

- `migrations/0001_init.sql`: the reduced tables (`artifacts.custom_host`, `domain_claims`, `custom_domains`, `outbox`, `handoffs`).
- `src/hostname.ts`: what an owner may attach (`normalizeHostname`) and how the content Worker tells an artifact host from a custom one (`classifyHost`).
- `src/host-directory.ts`: the isolate cache of hostname to artifact and region, used as a hint only.
- `src/delivery.ts`: the content Worker's lookup on both kinds of host, the canonical redirect of old links and the `http` upgrade.
- `src/handoff.ts`: the read entry's callback origin, handoff codes bound to their host and the viewer's frame source.
- `src/domains.ts`: claim, TXT proof, Cloudflare provisioning, activation, detach, transfer, re-check, plan limit, suspension and the reconciliation after a restore.
- `src/cloudflare.ts`: the custom hostnames API client and the TXT lookup, as the app and jobs Workers would call them.

Run from the repository root:

```bash
bun run spike:custom-domains
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.
