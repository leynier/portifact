# Artifact data grant spike

Experiment 1 of [decision 0026](../../docs/decisions/0026-artifact-data.md)'s delivery 2: does the grant handoff work in real browsers with third-party cookies blocked, and can a sibling artifact abuse it? The record's "Feasibility results" holds the outcome per engine and per flow.

- `src/server.ts`: one HTTPS server that plays the app Worker (a sign-in stand-in, the viewer, the consent control, the code API and revocation) and the content Worker (the begin and redeem gates, the one-use code bound to the beginning browser's transaction nonce and host, `me` and a write), with the prototype's own rules from `spikes/artifact-data/src/gate.ts` and `grants.ts`.
- `src/pages.ts`: the viewer, the consent control and the artifact page with its `window.spike` helpers.
- `src/proxy.ts` and `src/tls.ts`: the CONNECT proxy and throwaway certificate of `spikes/review-cookies`, for the e2e stack's hosts and the redirector.
- `playwright.config.ts`: the e2e suite's four projects, with what decision 0002 measured for partitioned cookies in each.
- `tests/grant.spec.ts`: the three flows (the viewer's frame, the top-level tab, a direct visit in the same tab and in a popup), `me` before a grant, a sibling's planted cookies and codes, one use in one browser, and revocation within one renewal period (3 seconds here, 60 in the design). Each test prints its observations.

Run from the repository root:

```bash
bun run --cwd spikes/artifact-data-grant browsers   # once
bun run spike:artifact-data-grant -- --project=chromium-3pc-blocked --project=firefox-chips --project=firefox-3pc-blocked
```

WebKit on Linux needs its system libraries (`npx playwright install-deps webkit`, which uses `sudo`). CI runs this experiment in the e2e job of each engine, after the suite, so WebKit is covered there. It is not part of `bun run test`, and this code is never deployed or imported by apps and packages.
