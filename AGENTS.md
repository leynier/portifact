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
| [docs/releasing.md](docs/releasing.md)         | Touching branches, versions, CI, release workflows, build scripts or installers.                                                                                                                                                                                          |
| [docs/decisions/](docs/decisions)              | Touching something a decision record covers: the OAuth server ([0001](docs/decisions/0001-oauth-server.md)) or review-mode cookies ([0002](docs/decisions/0002-review-mode-cookies.md)). Add a numbered record when a spike or hard-to-reverse choice settles a question. |

If a decision in the plan conflicts with the code, do not silently pick one: fix the code or propose a plan update and say so.

## Repository layout

```text
apps/app        Worker for portifact.com: landing assets and installers today; API, auth, OAuth, MCP and jobs later
apps/content    Worker for <id>.portifact.dev: public artifact delivery today; session handoffs, bridge and viewers later
apps/web        Landing page today; dashboard and review viewer later (Vite)
packages/cli    portifact CLI
packages/contracts   Shared schemas, errors and OpenAPI
packages/domain      Business rules: quotas, access, lifecycle, annotations (pure, no I/O)
packages/services    Use cases that apply domain rules with D1 and R2: publish, restore and more
packages/db          Drizzle schema, migrations and queries
packages/render      Markdown and TXT rendering pipeline
packages/anchors     Annotation anchor model and resolution
packages/bridge      Review script injected into artifacts
packages/ui          Design system: tokens and components
skills/              Agent skills for using Portifact, installable with npx skills
assets/brand/        Logo, symbol and favicons (monochrome); usage rules in docs/design.md
scripts/             Build, versioning, installer and validation scripts
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
bun run spike:review-cookies   # Playwright review-cookie spike; not part of bun run test (see spikes/review-cookies)
```

Planned as the code arrives: `bun run test:e2e` (Playwright on Chromium, Firefox and WebKit) and `bun run test:mutation` (Stryker on critical packages). Add them here when they exist.

A task is not done until `bun run check` and `bun run test` pass. Use `bun run test`, not `bun test`: the latter starts Bun's own test runner instead of Vitest. Run `bun run test:e2e` when the change affects a user flow, a browser behavior or content delivery.

Dependencies newer than 3 days are not installed (`minimumReleaseAge` in `bunfig.toml`). If `bun install` says a version is blocked, use a range that allows an older release instead of disabling the rule.

## Architecture rules

- Business rules live only in `packages/domain` (pure functions) and the use cases that apply them with storage live in `packages/services`. API routes, MCP tools, CLI commands and the dashboard are thin adapters over these services; never reimplement a rule in an adapter.
- In a D1 batch, condition every write after a guarded update on that update having happened (for example `exists(...)` on the new state), and close the session or token last, so a retried or concurrent request cannot apply effects twice.
- Web, CLI and MCP must behave identically for the same operation: same permission checks, quotas, states and errors. Add a parity test when you add an operation.
- MCP has no privileged path. It goes through the same authorization as the API.
- The acting user, owner or author always comes from the authenticated session or token, never from request input.
- Input and output shapes live in `packages/contracts` and are validated at every boundary.
- Multi-step state changes in D1 use transactional batches with checked results. A read followed by a separate write is not a transaction.
- The D1 schema lives in `packages/db/src/schema.ts`; never edit a committed migration, generate a new one. Account limits are also CHECK constraints, so a race the application misses still fails in the database.
- Mutations that may be retried take an idempotency key.
- Anything with credentials or that mutates data is served from `portifact.com`. `portifact.dev` only serves user content. See [docs/security.md](docs/security.md).
- The `portifact-app` Worker routes by host: `portifact.com` serves the landing and installers, `app.portifact.com` serves identity, OAuth and the auth pages, anything else is 404. Identity and OAuth are Better Auth ([decision 0001](docs/decisions/0001-oauth-server.md)) with exact pinned versions; its tables are `packages/db/src/auth-schema.ts`, which Better Auth checks at runtime. Only endpoints in the allowlist in `apps/app/src/auth/routes.ts` are reachable. On a Better Auth upgrade, diff the schema against Better Auth's Drizzle generator and run the whole `apps/app` suite.
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
