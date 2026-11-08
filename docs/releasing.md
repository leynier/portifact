# Releasing

Releases are fully automatic. Nobody edits versions, writes tags or uploads binaries by hand: merging `develop` into `main` is the only release action.

## Branches

| Branch    | Role                                              | How changes get in                                                                            |
| --------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `develop` | Default branch. All work targets it.              | Pull requests, squash-merged, with green CI and a Conventional Commit title.                  |
| `main`    | Release branch. Every push can produce a release. | Only pull requests from `develop`, merged with a merge commit, with green CI and smoke tests. |

Both branches are protected by repository rulesets. The only actor allowed to push directly is the release deploy key, used by the release workflow.

Use a merge commit (not squash) when merging `develop` into `main`, so the release tooling can read every individual commit.

## Commit messages decide the version

Pull request titles become the squashed commit on `develop`, so they must follow [Conventional Commits](https://www.conventionalcommits.org). CI checks them.

While Portifact is below 1.0.0:

| Commit                                                             | Release                                   |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `fix:` or `perf:`                                                  | Patch, for example 0.3.1 → 0.3.2          |
| `feat:`                                                            | Minor, for example 0.3.1 → 0.4.0          |
| Breaking change (`feat!:` or a `BREAKING CHANGE:` footer)          | Minor, not major, until the public launch |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `build:`, `style:` | No release                                |

The switch to 1.0.0 at launch is done by removing the `breaking` rule in `.releaserc.json` and merging a breaking change.

## What happens on merge to main

The `release` workflow (`.github/workflows/release.yml`):

1. Runs `bun run check` and `bun run test`.
2. Uses semantic-release to read the commits since the last tag and compute the next version. If there are no releasable commits, it stops here.
3. Writes the version to `packages/cli/package.json` and `bun.lock` (`scripts/set-version.ts`).
4. Compiles the CLI for all platforms with `bun build --compile` (`scripts/build-cli.ts`) and writes `SHA256SUMS`.
5. Commits `chore(release): vX.Y.Z [skip ci]` to `main` and tags it `vX.Y.Z`.
6. Publishes a GitHub release with notes, the archives, `SHA256SUMS`, `install.sh` and `install.ps1`.
7. Signs build provenance attestations for the archives through GitHub's OIDC token (Sigstore).
8. Syncs `develop` with `main`. This runs after every push to `main`, even when there is nothing to release, so `main` is never ahead of `develop`. It fast-forwards `develop` to `main`, leaving both on the same commit; only if `develop` received new commits during the run does it create a merge commit instead.

## Deploying portifact.com

Every push to `main` also runs the `deploy` job after `release`: it applies pending D1 migrations to `portifact-control` (`wrangler d1 migrations apply --remote`), deploys the `portifact-content` Worker (artifact origins on `*.portifact.dev`, D1 plus the private R2 bucket `portifact-artifacts`), deploys the `portifact-jobs` Worker (maintenance every 15 minutes and the consumer of the `portifact-jobs` and `portifact-email-events` queues, no routes), builds `apps/web` and deploys the `portifact-app` Worker, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, then checks that `portifact.com` serves the landing page and the installer redirect and that `app.portifact.com` serves the authorization server metadata. The Worker owns `portifact.com`, `www.portifact.com` and `app.portifact.com` as custom domains and routes by host: the apex serves the landing and installers, `www` redirects to the apex, and `app` serves identity, OAuth and the auth pages (see [security.md](security.md)). Pull requests validate both bundles with `wrangler deploy --dry-run`. Migrations must stay backward compatible with the code still running during a deploy: add columns and tables first, remove them in a later release.

### Jobs Worker queue

The `portifact-jobs` Worker produces to and consumes from the Cloudflare Queue `portifact-jobs` (`queues` in `apps/jobs/wrangler.jsonc`): its schedule relays pending rows of the transactional outbox to the queue and its consumer runs them (see "Maintenance and the outbox" in [operations.md](operations.md)). Wrangler does not create queues on deploy, and deploying a Worker bound to a missing queue fails, so the maintainer creates it once before the first release that ships the binding, with the deploy credentials:

```bash
npx wrangler queues create portifact-jobs
```

It survives deploys. The deploy token already has Queues access. No dead-letter queue is configured: a message whose retries run out is dropped, and the outbox sends its job again an hour later because the row is still there. Pull requests validate the binding with `wrangler deploy --dry-run`, which does not check that the queue exists.

### Email events queue

Cloudflare Email Service reports bounces and complaints through an event subscription to a queue, which the `portifact-jobs` Worker consumes (the second consumer in `apps/jobs/wrangler.jsonc`) to keep the email suppression list (see "Email quota and suppressions" in [operations.md](operations.md)). Before the first release that ships this consumer, the maintainer, with the deploy credentials:

1. Creates the queue, because deploying a consumer of a missing queue fails: `npx wrangler queues create portifact-email-events`.
2. Subscribes it to the sending domain in the dashboard: Queues, `portifact-email-events`, Subscriptions, Subscribe to events, source Email Sending, domain `portifact.com` (the domain that sends from `noreply@portifact.com`), events `message.bounced` and `message.complained`.
3. After the deploy, checks the jobs Worker's logs for `email_event` lines once a bounce happens (sending a code to a non-existent mailbox at a domain you control produces one). `email_event_malformed` means the subscription delivers another body shape than the event JSON or a JSON string of it, which the consumer accepts; fix the parser before relying on it.

No dead-letter queue is configured: an event whose 5 retries fail is dropped, and Cloudflare's own suppression still refuses the next send, which records a `provider` suppression. Without the subscription nothing breaks: suppressions then come only from refused sends.

### Third-party notices

`third-party-notices.md` and the CLI's embedded copy (`packages/cli/src/third-party-notices.ts`, printed by `portifact licenses`) list the licenses and notices of every production dependency of the Workers, the web pages and the CLI binary, generated from the installed packages by `bun run notices` (`scripts/third-party-notices.ts`). The app Worker serves the Markdown as plain text at `portifact.com/third-party-notices` (copied into `apps/web/dist` by the Vite build). `bun run check` fails when either file is stale or when a shipped package's license is not in `AGPL_COMPATIBLE` (`scripts/notices.ts`); adding a license there is a license review, so say why in the change. Versions are left out so routine updates do not change the files, but a new or removed dependency, or a changed license text, does: run `bun run notices` after `bun install` and commit the result, including on Dependabot's pull requests, which fail `check` until then.

### App Worker configuration

Non-secret values live in `vars` in `apps/app/wrangler.jsonc`: `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`, `CONTENT_DOMAIN` (artifact origins, used for public URLs and to send signed-in visitors back from `/read/<id>`), `R2_ACCOUNT_ID` with `R2_BUCKET` for the S3 endpoint that presigned uploads target, and `TURNSTILE_SITE_KEY`, the public site key of the human check (see below). The Worker also binds the `portifact-control` D1 database, the `portifact-artifacts` bucket as `ARTIFACTS` (to verify uploads at commit) and Cloudflare Email Service as `EMAIL` (`send_email`, sending from `noreply@portifact.com`).

Secrets are set once on the `portifact-app` Worker and survive deploys:

| Secret                 | Value                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | 32 random bytes, base64 (`openssl rand -base64 32`). Rotating it signs out every session and voids pending authorization and consent requests.                                           |
| `GOOGLE_CLIENT_SECRET` | Secret of the Google OAuth client whose ID is `GOOGLE_CLIENT_ID`.                                                                                                                        |
| `GITHUB_CLIENT_SECRET` | Secret of the GitHub OAuth app whose ID is `GITHUB_CLIENT_ID`.                                                                                                                           |
| `R2_ACCESS_KEY_ID`     | Access key ID of the R2 API token `portifact-app-uploads`, limited to Object Read and Write on `portifact-artifacts`. It only signs upload URLs.                                         |
| `R2_SECRET_ACCESS_KEY` | Secret access key of that token. Rotating it voids upload URLs already issued; clients ask for fresh ones with `GET /api/v1/publishes/:id`.                                              |
| `TURNSTILE_SECRET_KEY` | Secret key of the Turnstile widget whose site key is `TURNSTILE_SITE_KEY`. Without it every human check fails closed: no new accounts and no first comments on other people's artifacts. |

Set or rotate one by piping it to `wrangler secret put <NAME> --name portifact-app` from `apps/app`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment, so the value never appears in the shell history or the output. The Google client must allow the redirect URI `https://app.portifact.com/api/auth/callback/google` and the GitHub app the callback URL `https://app.portifact.com/api/auth/callback/github`.

### Human check (Turnstile)

Account creation and a visitor's first comments need a Cloudflare Turnstile widget ([security.md](security.md), "Human check"). The code fails closed, so until both values exist the deployed app refuses new accounts (existing accounts keep signing in) and visitors' first comments. Both exist since 2026-11-08 (widget `portifact-app`, secret set on the Worker). To recreate them:

1. In the Cloudflare dashboard, Turnstile, add a widget named `portifact-app` in Managed mode with the hostname `app.portifact.com` only, and pre-clearance off.
2. Put its site key in `TURNSTILE_SITE_KEY` in `apps/app/wrangler.jsonc` (public; it ships with the next deploy).
3. Pipe its secret key to `wrangler secret put TURNSTILE_SECRET_KEY --name portifact-app` like the other secrets. Rotating it in the dashboard and here takes effect at once; tokens issued before stay valid only for the old key.

Local development uses Cloudflare's documented test keys in `apps/app/.dev.vars`: `TURNSTILE_SITE_KEY=1x00000000000000000000AA` and `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` always pass (`2x...` keys always fail). Never put a test key in the deployed configuration. The app tests set the same test keys in `vitest.config.ts` and fake siteverify; the e2e Worker leaves `TURNSTILE_SITE_KEY` empty and seeds comments without the check.

### Storage CORS for the dashboard

The dashboard uploads to and downloads from the `portifact-artifacts` bucket's S3 endpoint directly from the browser, so the bucket needs a CORS rule. The maintainer applies it once in the Cloudflare dashboard (R2, `portifact-artifacts`, Settings, CORS policy) or with `npx wrangler r2 bucket cors set portifact-artifacts --file cors.json`; it survives deploys. Without it, browser uploads and downloads fail with a network error while the CLI keeps working.

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://app.portifact.com"],
        "methods": ["PUT", "GET"],
        "headers": ["x-amz-checksum-sha256", "content-type"]
      },
      "exposeHeaders": ["ETag"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

`exposeHeaders: ["ETag"]` is required: multipart uploads (files over 64 MiB) read each part's `ETag` and report it to the API, and without it every large browser upload fails while small ones keep working. Part URLs sign only `content-length` and `host`, so the allowed headers need no change. Keep R2's default lifecycle rule that aborts incomplete multipart uploads after seven days; the `abort_multipart` job cleans up normally and that rule catches the rest.

Only the app origin is allowed: never add `*.portifact.dev` or `*`. The URLs are still presigned, so CORS only decides which page may read the answers. `host` and `content-length` are signed too, but the browser sets them and they are not CORS request headers. For local development against a real bucket, add `http://localhost:8787` in a separate rule and remove it afterwards. The dashboard's `connect-src` already allows `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (`dashboardCsp` in `apps/app/src/app-host.ts`).

### Content Worker configuration

`apps/content/wrangler.jsonc` holds `CONTENT_DOMAIN` and `APP_ORIGIN` as `vars`. One secret is set once on the `portifact-content` Worker and survives deploys:

| Secret                | Value                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `READ_SESSION_SECRET` | 32 random bytes, base64 (`openssl rand -base64 32`). Signs the read session and sign-in transaction cookies of artifact origins. Rotating it ends every read session; readers sign in again without noticing. |

Set it with `wrangler secret put READ_SESSION_SECRET --name portifact-content` from `apps/content`, the same way as the app's secrets. Until it is set, protected artifacts answer `503` and public ones are served normally.

Keep Cloudflare from changing what the Workers serve: Web Analytics' Real User Measurements must stay disabled on both zones (Web Analytics, each site, Manage site, RUM set to "Disable"), and so must any other zone feature that rewrites HTML, such as Rocket Loader, Email Address Obfuscation or Zaraz. Automatic RUM injects a third-party beacon script into every HTML response, including user artifacts on `portifact.dev`. Our CSP blocks it, but it alters user content and loads a script the Privacy Policy does not describe. It was on by default for both zones and was turned off on 2026-11-08. On `portifact.dev`, Email Address Obfuscation (Security, Settings) and Automatic HTTPS Rewrites (SSL/TLS, Edge Certificates) were turned off the same day. Rocket Loader is off. Server-side Excludes is still on: the dashboard no longer shows it and the deploy token cannot change zone settings. It only hides content wrapped in `<!--sse-->` from visitors flagged as suspicious.

The Worker also binds the `TrafficLimiter` Durable Object (`TRAFFIC_LIMITER`, a SQLite-backed class created by the `v1` entry of `migrations` in `apps/content/wrangler.jsonc`), which counts the per-visitor limits only while budget protection tightens traffic. `wrangler deploy` applies the migration; never edit or remove an applied migration entry, add a new tag for a class change. It replaced the Workers Rate Limiting namespaces 7301 and 7302, which are no longer bound; if rate limiting namespaces are ever used again, keep to the 7300 range, because namespace IDs are shared by every Worker on the Cloudflare account and other projects use 1001 to 1005. The `portifact-jobs` Worker has the secrets `CF_ANALYTICS_TOKEN` (an API token with only Account Analytics Read) and `CF_ACCOUNT_ID` set in production, which turn on the Cloudflare analytics collector of the budget run; the alert emails stay off until configured (see "Budget alerts and protection" in [operations.md](operations.md)).

For local development, build `apps/web`, apply the migrations to the local database (`npx wrangler d1 migrations apply portifact-control --local` from `apps/app`), put the same names plus `APP_ORIGIN=http://localhost:8787` in `apps/app/.dev.vars` (ignored by git) and run `npx wrangler dev --local-upstream localhost:8787` from `apps/app`. Without `--local-upstream`, `wrangler dev` rewrites every request to the first route's host, `portifact.com`, and the auth pages answer 404. With that origin, `localhost` is the app host; the landing is served by `bun run --cwd apps/web dev`. Migration 0003 links the CLI client to the production API resource, so the device flow against `localhost` needs a local client row linked to `http://localhost:8787/api/v1`; then point the CLI at it with `PORTIFACT_APP_ORIGIN=http://localhost:8787`.

The token is an account API token named `portifact-ci-deploy`, limited to Workers, D1, R2 and Queues on the account plus Workers Routes, DNS and Zone read on `portifact.com` and `portifact.dev`. It expires on 2027-11-07; rotate it before then.

## Platforms

`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`, `windows-x64` and `windows-arm64`. Unix archives are `.tar.gz` and Windows archives are `.zip`; each holds a single executable that does not need Node or Bun.

- Linux glibc builds need glibc 2.17 or newer, so they run on Debian, Ubuntu, RHEL and its rebuilds (Rocky, Alma, CentOS 7+), Fedora, Amazon Linux and openSUSE.
- Musl builds are for Alpine and need `libstdc++` and `libgcc` (`apk add libstdc++ libgcc`); the installer checks for them and says so.
- x64 builds use Bun's baseline targets, so they also run on CPUs without AVX2.
- `scripts/smoke-linux-distros.sh` installs and runs the CLI in containers of those distributions, all in parallel; CI runs it on every pull request that can affect the CLI.

## Installing

```bash
curl -fsSL https://portifact.com/install | bash
```

```powershell
irm https://portifact.com/install.ps1 | iex
```

`portifact.com/install` and `portifact.com/install.ps1` redirect to the scripts attached to the latest release. Both scripts verify the archive against `SHA256SUMS` before installing. They accept `PORTIFACT_VERSION`, `PORTIFACT_INSTALL_DIR` and `PORTIFACT_NO_MODIFY_PATH`; see the header of each script.

To verify that a downloaded archive was built by this repository's workflow:

```bash
gh attestation verify portifact-linux-x64.tar.gz --repo leynier/portifact
```

## Checks on pull requests

The `ci` workflow runs on every pull request and again on `develop` after each merge, which keeps the readme's CI and coverage badges current. It runs lint, typecheck, tests with coverage thresholds, `shellcheck` and a render of sample release notes with the configured preset (`scripts/check-release-notes.mjs`). It also builds every platform and smoke-tests the installers on Linux x64 and arm64, macOS, and Windows x64 and arm64, checking that each machine gets its native build, and across Linux distributions in containers. The `e2e` job installs Chromium, Firefox and WebKit with their system libraries (`bun run --cwd e2e browsers --with-deps`) and runs `bun run test:e2e`; it does not retry failed tests, and a failure uploads `e2e/test-results/` (traces) as the `e2e-traces` artifact. The `secrets` job downloads gitleaks (version and SHA-256 pinned in `ci.yml`, checked before it runs, with read-only repository permissions and no persisted credentials) and scans the change's commits (`gitleaks git --log-opts=<base>..<head>`) and the checked-out tree (`gitleaks dir`) on every run, plus the whole history when the scope asks for it, with the rules in `.gitleaks.toml` (the default rules plus a narrow allowlist; findings are redacted in the log). To update gitleaks, change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` together from the release's checksums file and run it locally on the repository first. Pull requests into `develop` also check their title; pull requests into `main` must come from `develop`.

Mutation testing has its own `mutation` workflow, which runs weekly, on demand and on pull requests into `main`; see [testing.md](testing.md#mutation-testing).

A first `changes` job (`scripts/ci-scope.ts`) skips work the diff cannot affect, and skipped jobs satisfy required checks. The CLI build and the installer smoke tests run only when the CLI, a workspace package it depends on, its build or installer scripts, shared tooling (`package.json`, `bun.lock`, `bunfig.toml`, root tsconfig) or the workflows change. Lint, typecheck and tests are skipped only when every changed file is under `docs/`, `license` or issue templates; `readme.md`, `AGENTS.md` and `skills/` still run them because checks read those files. Pull requests into `main` always run everything, and if `changes` fails the other jobs run anyway. The end-to-end suite runs when `apps/app`, `apps/content`, `apps/web`, any workspace package but the CLI, `e2e/`, shared tooling (including `turbo.json`) or `ci.yml` change. The secret scan always runs; its scope only decides the whole-history pass, which runs when `.gitleaks.toml` or `ci.yml` change, for pull requests into `main` and when the range cannot be computed (`SECRET_SCAN_FILES`). `.gitleaks.toml` alone does not run lint and tests. When you add a file the CLI build or the installers depend on, add it to `CLI_FILES` in `scripts/ci-scope.ts` with a test, and likewise `E2E_FILES` for the end-to-end suite.

## Setup and recovery

- Secret `RELEASE_DEPLOY_KEY`: private half of a write-enabled deploy key. The `develop` and `main` rulesets allow this deploy key to bypass them. If you rotate it, update both the deploy key and the secret.
- A failed release leaves no tag. Fix the cause on `develop` and merge into `main` again.
- If the sync into `develop` failed, rerun the workflow or merge `main` into `develop` through a pull request.
- Keep `conventional-changelog-conventionalcommits` on the major version that matches the changelog writer bundled with semantic-release. Version 10 of the preset needs `conventional-changelog-writer` 9, while semantic-release 25 ships writer 8, so the preset stays on 9. `scripts/check-release-notes.mjs` catches a mismatch in CI.
