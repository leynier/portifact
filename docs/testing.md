# Testing

Portifact handles access control, uploads and untrusted HTML, so the tests are the main proof that it is safe. The goal is the highest coverage we can reach with tests that verify real behavior. A test that cannot fail when the code is wrong is worse than no test, because it creates false confidence.

## What a real test is

A test earns its place when all of these hold:

1. It asserts an observable outcome: a return value, a stored row, an HTTP status and body, an emitted event, a rendered result or a rejected request.
2. It fails if the behavior it covers breaks. Check this when you write it: break the code on purpose and watch the test fail.
3. It exercises real collaborators where practical: real D1, R2 and Queues bindings in the Workers runtime, the real router and the real domain services.
4. Its name states the behavior, for example `rejects publish when the account has no active slots`.

Not acceptable:

- Tests without meaningful assertions, or that only assert that a function was called.
- Snapshot-only tests for logic. Snapshots are allowed only for small, reviewed outputs such as rendered Markdown fixtures, next to explicit assertions.
- Mocking the unit under test, or mocking so much that the test only checks the mocks.
- Asserting private implementation details that can change without changing behavior.
- Tests written only to raise coverage, such as calling getters or constructors with no assertion about their effect.
- Skipped or `.only` tests in committed code.

Mock only true external boundaries: identity providers, the email provider and the system clock. Prefer fakes with real behavior over call-recording mocks.

## Layers

| Layer                 | Tool                                                                     | Covers                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                  | Vitest                                                                   | Pure logic: quota math, path normalization, anchors, lifecycle dates, manifest validation, policy decisions.                                       |
| Property-based        | fast-check with Vitest                                                   | Inputs with large spaces: path and ZIP normalization, Unicode anchors and offsets, date arithmetic, quota reservations under random interleavings. |
| Integration (Workers) | Vitest with `@cloudflare/vitest-plugin` (formerly `vitest-pool-workers`) | API routes, MCP tools, content delivery, auth flows and jobs running in the Workers runtime against real local D1, R2 and Queues.                  |
| Contract and parity   | Vitest                                                                   | The same operation through API, MCP and CLI yields the same result, error and side effects.                                                        |
| End to end            | Playwright on Chromium, Firefox and WebKit                               | Login, publish, protected access, review mode with third-party cookies blocked, annotations, archive and restore.                                  |
| Security              | Vitest and Playwright with hostile fixtures                              | The invariants in [security.md](security.md), each with at least one test that tries to break it.                                                  |

Workers tests run inside workerd through `@cloudflare/vitest-plugin`, which supports Vitest 4, so the workspace catalog stays on Vitest 4. Keep `compatibility_date` in each `wrangler.jsonc` no newer than the date the installed workerd supports, or the test runtime refuses to start.

D1 tests use the real local D1 inside workerd: `packages/db/test/apply-migrations.ts` applies `packages/db/migrations` before the tests, the same SQL that production runs. Assert on database errors through the `cause` chain, because Drizzle wraps SQLite errors.

To control the clock in Workers tests, call the app's `fetch` from the test (it runs in the same isolate) and fake only `Date` with `vi.useFakeTimers({ toFake: ["Date"] })`, so I/O keeps working. Apply D1 migrations in a setup file with `readD1Migrations` and `applyD1Migrations`. `apps/app/test` shows both.

Auth tests in `apps/app/test` build the Worker with `createWorker(() => deps)` from `harness.ts`, where `deps` is a fake email sender (an outbox the test reads codes from) and a fake network for Client ID Metadata Documents. Google and GitHub are faked by replacing the global `fetch` with `vi.stubGlobal`, because Better Auth calls them through it; send provider callbacks with `accept: text/html` and `sec-fetch-mode: navigate`, as a browser does, or Better Auth answers a continued authorization with JSON instead of a redirect. The D1 database is shared by every test in a file, so use a distinct email per test; the `signIn` helper clears the rate-limit counters first, and rate-limit tests reset them in `beforeEach`. Routing and asset tests use `SELF.fetch`, which goes through the static assets layer like production; they need `apps/web` built first, which Turborepo does before `@portifact/app#test`.

Content Worker tests call `handle(request, env, now)` from `apps/content/src/index.ts` with an explicit clock and send the `Sec-Fetch-*` headers a browser would (`navigate` for page loads, `same-origin` for subresources, `same-site` for a sibling artifact); without them the Worker fails closed. The read-session tests play the app's part with `issueReadHandoff` from `@portifact/services`, the same call `/read/<id>` makes, and `apps/app/test/read-handoff.test.ts` tests the app route. `drizzle-orm` is not a dependency of `apps/content`, so its tests change rows with raw SQL through `env.DB`. Handoffs need a live dashboard session (`sessions` row, a foreign key), so these tests insert one per user and sign out by deleting it.

MCP tests in `apps/app/test` use the official SDK client (`@modelcontextprotocol/client`) against the Worker in process, pinned to the 2026-07-28 revision (`test/mcp-helpers.ts`), and raw JSON-RPC when a test needs the HTTP status or `WWW-Authenticate` header. `test/mcp-parity.test.ts` runs each operation through `/api/v1` and MCP for one user at the same faked time and compares bodies, errors and scope challenges; extend it with every new tool. Advance the faked clock by minutes there, not hours, or the access tokens expire.

Rendered HTML in `packages/render` is asserted on the DOM a browser would build: `src/test-html.ts` parses it with parse5 (the WHATWG parser), and the security tests check every element and attribute against an allowlist, including for random hostile input with fast-check. `src/golden.test.ts` snapshots a reviewed rendering; when it changes, bump `RENDERER_VERSION`.

CLI tests in `packages/cli` run on Node, so `Bun.secrets` is absent: commands take a `Runtime` (fetch, clock, sleep, browser launcher, OS credential store, config directory) and tests pass a fake credential store and a clock that `sleep` advances instead of waiting. HTTP goes to a real local server, `src/testing/fake-server.ts`, that answers the device code, token, revoke and `/api/v1/me` requests like `apps/app`, with scripted answers to device polls. Its `/api/v1` publishing, artifact, access and version routes (`src/testing/fake-api.ts`) validate requests with `packages/contracts`, replay idempotency keys, check scopes and deduplicate by SHA-256, and a fake presigned storage target refuses uploads whose size, checksum, bytes or URL expiry are wrong and serves downloads only through unexpired links without an `Authorization` header (`server.api.gets` records them). `server.api.seedVersion(artifact, files)` adds a committed version with stored bytes and takes paths as given, so pull tests can play a hostile server. `server.faults` answers, drops or alters the next matching request, which is how tests lose a prepare answer, expire a URL or fail a commit. Publishing tests write real files with `h.files`, and `h.signIn()` stores tokens with every scope. Every test that prints checks that no issued token appears in the output. Check credential storage against the real OS store by building the binary (`bun run build:cli`) and running it against that server; to force the file fallback on Linux, set `DBUS_SESSION_BUS_ADDRESS` to a path that does not exist.

The auth pages in `apps/web` are tested with happy-dom against their real markup: `src/auth/test-page.ts` loads the page's HTML and fakes the `/api/auth` calls.

The dashboard is tested the same way, through its real API client and router: `src/dashboard/test-support.tsx` renders the app with memory history over an in-memory `/api/v1` and session endpoint. Query by role and accessible name, and run `axeViolations` from `@portifact/ui/testing` on each screen and state; happy-dom has no layout, so the helper skips color contrast, which the token tests and the end-to-end tests cover. Failed queries retry once after about a second, so error-state assertions wait up to 3 seconds. For refresh timing, use `vi.useFakeTimers({ shouldAdvanceTime: true })` and TanStack Query's `focusManager` for a hidden tab. Component tests in `packages/ui` and `apps/web` set `// @vitest-environment happy-dom` per file and call `cleanup` after each test, because Vitest globals are off.

End-to-end tests of review mode must block third-party cookies explicitly and prove it with an unpartitioned control cookie. Chromium needs the full browser (`channel: "chromium"`) with a profile that sets `profile.cookie_controls_mode = 1`; the headless shell ignores profile preferences. Firefox uses `network.cookie.cookieBehavior`. WebKit blocks by default, but only macOS uses Safari's cookie layer: WebKit on Linux has no partitioned cookies. `spikes/review-cookies` shows all three and maps hosts through a local proxy, which works in every engine.

## Required cases

Every feature covers:

- The success path.
- Each documented failure path and error code.
- Permission boundaries: owner, authorized reader, other authenticated user and anonymous. For token-based access, also insufficient scope, revoked token and wrong audience.
- Quotas and limits at, just below and just above the boundary.
- Concurrency where state is shared: two publishes on the same base, two uploads racing for the last slot, duplicated callbacks and queue redelivery.
- Time-dependent rules with a controlled clock. Never wait real time.

Every bug fix starts with a failing test that reproduces the bug.

## Coverage

Coverage uses the Istanbul provider, which works inside the Workers pool. Thresholds are enforced in CI and in `bun run test`. Each package writes a `json-summary` report; after every merge into `develop`, CI aggregates them with `scripts/coverage-badge.ts` and publishes the result to the `badges` branch, which feeds the coverage badge in the readme.

| Scope                                                                                     | Lines | Branches |
| ----------------------------------------------------------------------------------------- | ----- | -------- |
| `packages/domain`, `packages/anchors`, `packages/contracts`, auth and access-control code | 95%   | 95%      |
| Other packages and Workers                                                                | 90%   | 85%      |
| `apps/web` and `packages/ui` components                                                   | 85%   | 80%      |

Coverage shows what ran, not what was verified, so mutation testing backs it up.

## Mutation testing

Stryker runs on `packages/domain`, `packages/anchors`, auth and access-control code. It changes the code in small ways and expects a test to fail for each change. The initial minimum mutation score is 80%, and it should rise over time. A surviving mutant means a missing or weak assertion: fix the test, or explain why the mutant is equivalent.

## Fixtures

- `fixtures/artifacts/` holds sample sites, Markdown and TXT, including maximum-size and edge cases.
- `fixtures/hostile/` holds malicious inputs: ZIP path traversal, symlinks, zip bombs, HTML that tries cookie tossing, forged `postMessage`, CSRF forms, service worker registration, script-injecting Markdown and oversized selectors.
- Fixtures are small and deterministic. Large fixtures are generated in the test, not committed.

## CI gates

A change merges only when lint, typecheck, the design-system check, all test layers that apply, the coverage thresholds and, for critical packages, the mutation score pass.
