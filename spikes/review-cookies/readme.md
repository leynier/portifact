# Review-mode cookies spike

Phase 0 harness for [decision 0002](../../docs/decisions/0002-review-mode-cookies.md): does a `Partitioned` `__Host-pf_review` cookie, set inside the review viewer's iframe, work in Chromium, Firefox and WebKit with third-party cookies blocked, and can a sibling artifact abuse it?

- `src/server.ts`: one HTTPS server that plays the `app` Worker (viewer and code API) and the `content` Worker (code exchange and artifact delivery).
- `src/proxy.ts`: a `CONNECT` proxy that maps the spike hosts to that server for every engine.
- `playwright.config.ts`: one project per engine configuration, with the behavior observed for it.
- `tests/review-cookies.spec.ts`: the checks. Each run prints its observations, one per line.

Run from the repository root:

```bash
bun run --cwd spikes/review-cookies browsers   # once
bun run spike:review-cookies
```

Requirements and caveats are in the decision record. This code is never deployed or imported by apps and packages.
