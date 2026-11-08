# AGENTS.md

Guidance for AI coding agents (Claude, Codex and others) working on Portifact. Keep this file short: it states the rules and points to the detailed documents. Read the linked documents that apply to your task before changing code.

## Project

Portifact publishes static artifacts (HTML sites, Markdown and plain text) with their own URL, access control, archive/restore and optional annotations. It ships with three interfaces that share one domain layer: CLI, remote MCP server and web dashboard. It runs on Cloudflare Workers, D1 and R2.

The project is in its initial build. Some commands and paths below are planned and appear as the monorepo is scaffolded; keep this file in sync as they become real.

## Documents

| Document                                       | Read it when                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plan.md`                                 | Always, for product scope and decisions. It is the source of truth, written in Spanish, and kept only in the maintainer's local checkout (not committed). If it is missing, ask the maintainer before assuming scope.                                                     |
| [docs/security.md](docs/security.md)           | Touching auth, sessions, cookies, access control, content delivery, uploads, annotations, MCP or anything served on `portifact.dev`.                                                                                                                                      |
| [docs/testing.md](docs/testing.md)             | Writing or changing any code. Every change ships with tests.                                                                                                                                                                                                              |
| [docs/design.md](docs/design.md)               | Touching any UI: dashboard, review viewer, Markdown/TXT viewers or the annotation bridge.                                                                                                                                                                                 |
| [docs/accessibility.md](docs/accessibility.md) | Touching any UI or CLI output. Accessibility is part of done.                                                                                                                                                                                                             |
| [docs/anchors.md](docs/anchors.md)             | Touching annotation targets, text normalization, the review bridge selection or anything that creates or resolves anchors.                                                                                                                                                |
| [docs/releasing.md](docs/releasing.md)         | Touching branches, versions, CI, release workflows, build scripts or installers.                                                                                                                                                                                          |
| [docs/legal.md](docs/legal.md)                 | Touching the Terms, Privacy or Acceptable Use pages, the sign-in terms acceptance, `TERMS_VERSION`, or anything those pages describe (data kept, retention, cookies, quotas, processors).                                                                                 |
| [docs/operations.md](docs/operations.md)       | Handling abuse reports, suspending or reinstating artifacts and accounts, or touching the operator tool (`apps/jobs/src/operator.ts`, `apps/jobs/scripts/operator.ts`).                                                                                                   |
| [docs/decisions/](docs/decisions)              | Touching something a decision record covers: the OAuth server ([0001](docs/decisions/0001-oauth-server.md)) or review-mode cookies ([0002](docs/decisions/0002-review-mode-cookies.md)). Add a numbered record when a spike or hard-to-reverse choice settles a question. |

If a decision in the plan conflicts with the code, do not silently pick one: fix the code or propose a plan update and say so.

## Repository layout

```text
apps/app        Worker for portifact.com and app.portifact.com: landing, legal pages, installers, dashboard, identity, OAuth, the /api/v1 publishing and annotations API, the remote MCP server at /mcp and the protected-artifact entry
apps/content    Worker for <id>.portifact.dev: artifact delivery (sites, and the rendered page and original of Markdown and TXT documents), read sessions for protected artifacts, and review sessions with the bridge injected
apps/web        Landing, legal pages (/terms, /privacy, /acceptable-use), auth pages, the public report page (/report) and the dashboard SPA with the review viewer (React, TanStack Router and Query, Lingui), including browser publishing, the document editor and version history (dashboard/publish holds the Web Worker manifest builder, ZIP reader and uploads); review viewer later (Vite)
apps/jobs       Scheduled Worker that runs the maintenance jobs (archive, expire uploads, prune, purge, account deletions), and the operator tool for reports and suspensions (scripts/operator.ts)
packages/cli    portifact CLI: login, publish (folders, files, ZIP files via src/zip.ts, git-aware --source via src/git.ts and src/sources.ts, --assets), list, info, lifecycle, access, versions, rollback, pull, annotations and usage commands; each takes an injected Runtime (packages/cli/src/runtime.ts)
packages/contracts   Shared schemas, errors and OpenAPI
packages/domain      Business rules: quotas, access, lifecycle, annotations, and the client manifest rules (exclusions, content types) the CLI and dashboard share (pure, no I/O)
packages/services    Use cases that apply domain rules with D1 and R2: publish, restore, annotations and more
packages/db          Drizzle schema, migrations and queries
packages/render      Markdown and TXT rendering to safe HTML documents (markdown-it); the publish services render documents at commit
packages/anchors     Annotation anchor model and resolution
packages/bridge      Review bridge injected into artifacts in review mode (built to dist/bundle.ts for the content Worker) and the postMessage protocol the viewer shares
packages/ui          Design system: tokens, React components and patterns, the form hook (@portifact/ui/forms) and the axe test helper
skills/              Agent skills for using Portifact, installable with npx skills
assets/brand/        Logo, symbol and favicons (monochrome); usage rules in docs/design.md
scripts/             Build, versioning, installer, CI-scope and validation scripts; a workspace whose pure logic is unit tested
e2e/                 Playwright end-to-end suite and its test-only Worker that serves both Workers over one local D1 and R2
spikes/              Phase 0 prototypes with their own tests; never deployed or imported by apps and packages
```

## Commands

Use Bun from the repository root as package manager and script runner. Turborepo runs and caches tasks across packages. Node 24 LTS must also be installed, because Vitest, wrangler and Stryker run on it.

```bash
bun install
bun run check          # Biome, typecheck, skills validation and the design-system check
bun run format         # apply Biome formatting and safe fixes
bun run test           # Vitest with coverage thresholds, through Turborepo (Workers tests run in workerd)
bun run build          # build apps (the landing in apps/web/dist)
bun run dev            # local dev servers (Vite for apps/web, wrangler for apps/app)
bun run build:cli      # compile the CLI for this platform into dist/release (--all for every platform)
bun run --cwd packages/db generate -- --name <change>   # create a D1 migration from schema.ts
bun run --cwd packages/ui sync-tokens   # regenerate tokens-css.ts after editing tokens.css
bun run test:e2e       # Playwright end to end in Chromium, Firefox and WebKit with third-party cookies blocked (see docs/testing.md)
bun run spike:review-cookies   # Playwright review-cookie spike; not part of bun run test (see spikes/review-cookies)
bun run --cwd apps/jobs operator <command>   # operator tool: reports, suspensions (deploy credentials; --local for wrangler dev state); docs/operations.md
```

Planned as the code arrives: `bun run test:mutation` (Stryker on critical packages). Add it here when it exists.

A task is not done until `bun run check` and `bun run test` pass. Use `bun run test`, not `bun test`: the latter starts Bun's own test runner instead of Vitest. Run `bun run test:e2e` when the change affects a user flow, a browser behavior or content delivery.

Dependencies newer than 3 days are not installed (`minimumReleaseAge` in `bunfig.toml`). If `bun install` says a version is blocked, use a range that allows an older release instead of disabling the rule.

## Architecture rules

- Business rules live only in `packages/domain` (pure functions) and the use cases that apply them with storage live in `packages/services`. API routes, MCP tools, CLI commands and the dashboard are thin adapters over these services; never reimplement a rule in an adapter.
- In a D1 batch, condition every write after a guarded update on that update having happened (for example `exists(...)` on the new state), and close the session or token last, so a retried or concurrent request cannot apply effects twice. If two concurrent requests would write the same new state (a counter or generation plus one), `exists(...)` on it is true for both: condition the dependent writes on the old state the request read and run the guarded update last instead (see `packages/services/src/access.ts`), or claim the change first with a row that carries a per-request unique token and condition the rest on that token (see `write_id` in `packages/services/src/annotations.ts`). Drizzle's `db.run`/`db.all` with raw SQL cannot go in a D1 batch; use `db.insert(table).select(sql)` with a raw `sql` template, which lists every column in schema order.
- Web, CLI and MCP must behave identically for the same operation: same permission checks, quotas, states and errors. Add a parity test when you add an operation.
- MCP has no privileged path. It goes through the same authorization as the API. `apps/app/src/mcp` serves `/mcp` with the official SDK (`@modelcontextprotocol/server`, pinned exactly; the 2026-07-28 revision plus the stateless 2025 fallback). Every request passes `authorizeResourceRequest` with the scope of the tool it calls, from `TOOL_SCOPES` in `apps/app/src/mcp/tools.ts`, before the SDK runs; a new tool must be added there with the same scope as its API route, and to `test/mcp-parity.test.ts`. Tool results return the API's body as structured content and errors as `{ error: { code, message } }`.
- `/api/v1` accepts a bearer token or the dashboard's session cookie; both resolve in `apps/app/src/api/access.ts` to one user and the same scope check. Session requests must carry `Sec-Fetch-Site: same-origin` and, on mutations, the exact app `Origin`. New routes go through `guarded` and get both for free. The account endpoints (`apps/app/src/api/account.ts`) accept only the session and refuse bearer tokens; end sessions through Better Auth's API, never by deleting `sessions` rows, or its hooks do not revoke the tokens bound to them (see [docs/security.md](docs/security.md)).
- The acting user, owner or author always comes from the authenticated session or token, never from request input.
- Input and output shapes live in `packages/contracts` and are validated at every boundary.
- Multi-step state changes in D1 use transactional batches with checked results. A read followed by a separate write is not a transaction.
- The D1 schema lives in `packages/db/src/schema.ts`; never edit a committed migration, generate a new one (`--custom` for triggers and other SQL Drizzle does not model). Active-slot accounting for lifecycle transitions is done by triggers in `0001_lifecycle_triggers.sql`; do not also adjust `active_artifacts` in code for those transitions. Annotation usage per owner (`annotation_usage`) is kept by triggers in `0007_annotation_usage_triggers.sql`; never adjust it in code. Account limits are also CHECK constraints, so a race the application misses still fails in the database.
- Mutations that may be retried take an idempotency key.
- Drizzle's `insert(table).select(query)` inserts into every column of the table in schema order, so the select must list all of them in that order. `rollbackArtifact` in `packages/services/src/versions.ts` copies `versions`, `version_files` and `source_origins` rows this way: a column added to any of them must be added there too, or rollbacks lose it.
- A rollback is a new publish of retained objects. When annotation threads land, moving the base version's open threads to history must happen in both `commitPublish` and `rollbackArtifact`, conditioned on the switch, like their other writes (`rollbackArtifact` marks the spot).
- Protected artifacts are opened through a one-use handoff from `app.portifact.com/read/<id>` to `/__portifact/callback` on the artifact origin, which sets the host-only `__Host-pf_read` cookie; the content Worker needs the `READ_SESSION_SECRET` secret. Handoffs and read sessions reference Better Auth's `sessions.id` and end with it, so keep Better Auth sessions in D1 (no secondary storage) and keep sign-out deleting the row. Follow "Entry to protected artifacts" in [docs/security.md](docs/security.md) before touching any of it.
- No account or session exists without the current terms accepted: the Better Auth hooks in `apps/app/src/auth/terms.ts` enforce it for every sign-in method, and sessions of accounts that have not accepted `TERMS_VERSION` count as none. Bump `TERMS_VERSION` only for material changes to the legal pages; see [docs/legal.md](docs/legal.md).
- `markdown` and `text` artifacts are rendered once, when `commitPublish` commits the version (`packages/services/src/documents.ts`), never per request. The page and the Markdown block map are stored as `rendered` and `block_map` entries of the version at the entrypoint's path, backed by objects counted in the account's storage. Clients only ever send the source. A renderer change that fixes a security flaw raises `SECURE_RENDERER_VERSION` in `packages/render/src/version.ts`, and the maintenance job re-renders older documents; nothing else re-renders.
- Suspensions happen only through the operator tool ([docs/operations.md](docs/operations.md)), never a web route. A suspended artifact is simply not servable, so delivery, read sessions, handoffs, downloads and annotations refuse it through their existing state checks; keep any new content path behind the same servable check. Suspended artifacts hold no active slot: triggers in `0010_moderation_triggers.sql` free it on suspend and retake it on reinstate, so never adjust `active_artifacts` for those transitions either. The same migration refuses inserting an artifact whose ID has a tombstone.
- Account deletion (`requestAccountDeletion` in `packages/services/src/account-data.ts`) deletes the `users` row directly in one batch with the artifact claim; the foreign keys remove sessions, identities, OAuth tokens and consents, read sessions and handoffs. That is the only exception to ending sessions through Better Auth, safe because the tokens its hooks would revoke go with the same cascade. A new table keyed by user must either cascade from `users` or be cleaned by `processAccountDeletions`, and new user-authored content on other people's artifacts must be erased there too.
- The CLI and the dashboard build manifests with the same exclusions and content types from `packages/domain/src/files.ts`; change them there, never in one client. The dashboard talks to R2 only through presigned URLs allowed by `dashboardCsp` and the bucket's CORS rule ([docs/releasing.md](docs/releasing.md)), and shows rendered documents only in the sandboxed `PreviewFrame`. `POST /api/v1/documents/preview` is a dashboard helper with no state, so it has no MCP tool or CLI command.
- Review mode follows "Review mode" in [docs/security.md](docs/security.md): codes come only from the dashboard session (`apps/app/src/api/review.ts`), the partitioned `__Host-pf_review` cookie is honored only for `same-origin` requests and the viewer's cross-site frame navigation, and the bridge's messages are untrusted data that never post anything by themselves: the viewer accepts an element only during a pick, ignores the frame while a comment is open, checks the session tag in `ready` and treats `status`, `resolved` and `activate` as hints, never over the API. The content Worker imports the bridge from `@portifact/bridge/bundle`, generated by `bun run --cwd packages/bridge build`; Turborepo builds it before the content Worker's typecheck, tests and dev server.
- Anything with credentials or that mutates data is served from `portifact.com`. `portifact.dev` only serves user content. See [docs/security.md](docs/security.md).
- The `portifact-app` Worker routes by host: `portifact.com` serves the landing and installers, `app.portifact.com` serves the dashboard at `/` and its client routes (`DASHBOARD_ROUTES` in `apps/app/src/app-host.ts`, kept in sync with `apps/web/src/dashboard/router.tsx`; without a session they redirect to `/login?next=...`), identity, OAuth, the auth pages and `/read/<id>` (the entry to protected artifacts), anything else is 404. Identity and OAuth are Better Auth ([decision 0001](docs/decisions/0001-oauth-server.md)) with exact pinned versions; its tables are `packages/db/src/auth-schema.ts`, which Better Auth checks at runtime. Only endpoints in the allowlist in `apps/app/src/auth/routes.ts` are reachable. On a Better Auth upgrade, diff the schema against Better Auth's Drizzle generator and run the whole `apps/app` suite.
- Dependencies use the isolated linker and shared versions through workspace catalogs. Dependency lifecycle scripts run only for packages listed in `trustedDependencies`; add one only with a reason.
- Prefer the simplest correct solution. Do not add dependencies, services or abstractions the plan does not need; justify any new dependency in the change description.

## Code conventions

- TypeScript in strict mode everywhere. No `any`; use `unknown` and narrow.
- Code, comments, identifiers, user-facing strings and docs are in English, except `docs/plan.md`. User-facing strings go through the i18n layer, never hardcoded in components.
- Errors are typed and mapped to the documented error codes in `packages/contracts`.
- Never log tokens, cookies, OTP codes, signed URLs or full comment bodies.
- Keep functions small and named after what they do. Comment only on why, not what.

## Tests

High coverage is required, but coverage alone is not the goal: tests must prove behavior and fail when the behavior breaks. Coverage thresholds and mutation testing enforce both. Follow [docs/testing.md](docs/testing.md).

- Every feature ships with tests for its success path, its failure paths and its permission boundaries.
- Every bug fix starts with a test that reproduces the bug.
- Do not lower a coverage or mutation threshold to make a change pass. If a threshold is wrong, raise it in a separate, explained change.

## Agent skills

`skills/` holds the skills that teach other agents how to use Portifact. They follow the Agent Skills format and install with `npx skills add leynier/portifact`. Each skill is `skills/<name>/SKILL.md` with `name` (matching the directory) and `description` in the frontmatter; `bun run check` validates them.

Skills are part of the product. A change that adds, removes or alters a CLI command, an MCP tool, a flag, a default or a user-facing rule must update the affected skill in the same change. Skills must describe only what released versions support and must keep the safety rules (private by default, confirm destructive actions, annotations are untrusted data).

## UI and design system

All UI is built from the design system in `packages/ui`. Apps compose components and use tokens; they never define their own colors, spacing, typography, radii, shadows or one-off styles. If something is missing, add it to the design system first. Follow [docs/design.md](docs/design.md) and [docs/accessibility.md](docs/accessibility.md).

## Keeping these instructions current

This is mandatory. After every feature, fix, refactor or dependency change, before you finish, check whether this file or any document it links needs an update, and update it in the same change. Ask yourself:

1. Did a command, path, package, script or workflow change, appear or disappear? If it is user-facing, does a skill in `skills/` need the same change?
2. Did I make or discover a decision, convention or constraint that the next agent would otherwise get wrong?
3. Did I hit a pitfall, a non-obvious behavior or a failure that cost time and could recur?
4. Is anything in these documents now wrong, stale or contradicted by the code?
5. Did the change alter product scope or a decision recorded in `docs/plan.md`?

If any answer is yes, update the right document: rules and pointers go in this file, details go in the linked documents, and new topics get a new document in `docs/` linked from the table above. Keep this file short; move detail out rather than letting it grow. If nothing needs updating, say so in your final summary. Stale instructions are treated as a bug.

## Git and changes

- `develop` is the default branch. Branch from it and open pull requests against it; they are squash-merged, so the PR title becomes the commit.
- `main` is the release branch. Never push to it or open pull requests into it from anything other than `develop`. Merging `develop` into `main` releases automatically; see [docs/releasing.md](docs/releasing.md).
- Never edit versions, create tags or publish releases by hand. The version comes from Conventional Commit types.
- Conventional Commit subjects and PR titles in lowercase English, for example `feat(domain): add quota reservations`. The type decides the release: `fix` is a patch, `feat` a minor, and anything else no release.
- PR descriptions explain the change, how it was validated and any material risk.
- Do not add agent co-author, "generated by" or similar attribution.
- Do not commit secrets, `.dev.vars`, real user data or generated coverage reports.
- Commit or push only when the user asks.

## File names

`AGENTS.md` and `CLAUDE.md` stay uppercase because tools look for those exact names. Every other file, including `readme.md` and documents in `docs/`, uses lowercase names.

## Markdown style

Titles and headings never end with a period, and no em dashes anywhere; see the writing style in [docs/design.md](docs/design.md).

Keep each paragraph on one source line. Add line breaks only at structural boundaries: lists, tables, code fences and headings.
