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
