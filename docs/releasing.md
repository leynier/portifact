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

Every push to `main` also runs the `deploy` job after `release`: it applies pending D1 migrations to `portifact-control` and to the access log database `portifact-access` (`wrangler d1 migrations apply --remote`, from `apps/content`, whose configuration binds both), deploys the `portifact-content` Worker (artifact origins on `*.portifact.dev`, D1 plus the private R2 bucket `portifact-artifacts`), deploys the `portifact-jobs` Worker (maintenance every 15 minutes and the consumer of the `portifact-jobs` and `portifact-email-events` queues, no routes), builds `apps/web` and deploys the `portifact-app` Worker, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, then checks that `portifact.com` serves the landing page and the installer redirect and that `app.portifact.com` serves the authorization server metadata. The Worker owns `portifact.com`, `www.portifact.com` and `app.portifact.com` as custom domains and routes by host: the apex serves the landing and installers, `www` redirects to the apex, and `app` serves identity, OAuth and the auth pages (see [security.md](security.md)). Pull requests validate both bundles with `wrangler deploy --dry-run`. Migrations must stay backward compatible with the code still running during a deploy: add columns and tables first, remove them in a later release.

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

### Access log database

The owner's access log (see "Access logs" in [security.md](security.md)) lives in a D1 database of its own, `portifact-access`, bound as `ACCESS_DB` in `apps/content`, `apps/app` and `apps/jobs` (`wrangler.jsonc`) with migrations in `packages/db/access-migrations` (generated from `packages/db/src/access-schema.ts` with `bun run --cwd packages/db generate:access -- --name <change>`). The database exists since 2026-11-08 (ID `b5285aa9-aa8d-4c2c-9828-22e31c1aec9e`, in the three `wrangler.jsonc` files); the deploy job applies its migrations before deploying the Workers, and they are backward compatible like the control database's. To recreate it, run `npx wrangler d1 create portifact-access` with the deploy credentials and put the new ID in the three configurations.

Locally, `npx wrangler d1 migrations apply portifact-access --local` from `apps/app` or `apps/content` creates it next to the control database; the tests and the e2e stack create their own.

### Third-party notices

`third-party-notices.md` and the CLI's embedded copy (`packages/cli/src/third-party-notices.ts`, printed by `portifact licenses`) list the licenses and notices of every production dependency of the Workers, the web pages and the CLI binary, generated from the installed packages by `bun run notices` (`scripts/third-party-notices.ts`). The app Worker serves the Markdown as plain text at `portifact.com/third-party-notices` (copied into `apps/web/dist` by the Vite build). `bun run check` fails when either file is stale, when a shipped package's license is not in `AGPL_COMPATIBLE` (`scripts/notices.ts`), or when it is AGPL compatible but not in `COMMERCIAL_COMPATIBLE`, the stricter list of permissive licenses that keep the commercial license possible ([licensing.md](licensing.md)). An expression passes when one side of an OR has all its identifiers in the list, so a dual-licensed package is used under its permissive side (DOMPurify, `MPL-2.0 OR Apache-2.0`). GPL, AGPL and other strong copyleft never go in `COMMERCIAL_COMPATIBLE`; weak copyleft (LGPL, MPL, EPL) stays out of it too and is accepted only for an exact version in `COMMERCIAL_EXCEPTIONS` with a written reason, pending a lawyer's review. The only exception today is `elkjs@0.12.1` (`EPL-2.0 OR GPL-3.0-or-later`, Mermaid's ELK layout, bundled unmodified in the diagram script); an update of it fails `check` until the exception is reviewed again for the new version. Adding a license to either list or an exception is a license review, so say why in the change, and never add a strong copyleft package as an exception: replace it or ask the maintainer. A package whose manifest declares no license is refused as `UNKNOWN` until its license file is read and its exact version added to `REVIEWED_LICENSES` in the same file (Mermaid's dependency `khroma@2.1.0` is MIT); an update of that package needs the review again. Versions are left out so routine updates do not change the files, but a new or removed dependency, or a changed license text, does: run `bun run notices` after `bun install` and commit the result, including on Dependabot's pull requests, which fail `check` until then.

### Contributor license agreement

The `cla` workflow (`.github/workflows/cla.yml`) passes a pull request into `develop` only when its author and every commit author have a line in `cla-signers.md` at the pull request's head with the exact statement of `cla.md`'s version, and the pull request only adds lines for its own authors (no signature on `develop` removed or changed). The rules are `scripts/cla.ts` (unit tested, run by `scripts/cla-main.ts`); the maintainer (`leynier`), `dependabot[bot]`, `github-actions[bot]` and `imgbot[bot]` are exempt (`EXEMPT_LOGINS`), and a commit whose author email belongs to no GitHub account fails. It runs on `pull_request_target` from the base branch, so a pull request cannot change the check that judges it: it checks out the base commit, never runs code from the pull request and reads the head's signers file and the commit list through the API with a read-only token. A consequence is that a change to the workflow or the check takes effect only once it is on `develop`, and the pull request that adds it is not checked by it. The commits endpoint lists at most 250 commits, more than any pull request here should have. Co-authors named only in `Co-authored-by` trailers are not checked. A new agreement version changes `CLA_VERSION`, the statement in `contributing.md` and `cla.md` together (a test checks them), and earlier signatures then fail the format check, so plan how existing signers re-sign before bumping it.

`cla` is a required status check of the `develop` ruleset, with `quality`, `pr-title` and `build` (set by the maintainer on 2026-11-10, after the workflow had run once so GitHub listed it); a renamed check must be updated there by hand. Pull requests from forks run it without the first-time contributor approval, which is fine because it runs only base-branch code with a read-only token.

### App Worker configuration

Non-secret values live in `vars` in `apps/app/wrangler.jsonc`: `APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GITHUB_CLIENT_ID`, `CONTENT_DOMAIN` (artifact origins, used for public URLs and to send signed-in visitors back from `/read/<id>`), `R2_ACCOUNT_ID` with `R2_BUCKET` for the S3 endpoint that presigned uploads target, and `TURNSTILE_SITE_KEY`, the public site key of the human check (see below). The Worker also binds the `portifact-control` D1 database, the `portifact-artifacts` bucket as `ARTIFACTS` (to verify uploads at commit) and Cloudflare Email Service as `EMAIL` (`send_email`, sending from `noreply@portifact.com`).

Secrets are set once on the `portifact-app` Worker and survive deploys:

| Secret                 | Value                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | 32 random bytes, base64 (`openssl rand -base64 32`). Rotating it signs out every session and voids pending authorization and consent requests.                                                                                                                                                                                                                                                       |
| `GOOGLE_CLIENT_SECRET` | Secret of the Google OAuth client whose ID is `GOOGLE_CLIENT_ID`.                                                                                                                                                                                                                                                                                                                                    |
| `GITHUB_CLIENT_SECRET` | Secret of the GitHub OAuth app whose ID is `GITHUB_CLIENT_ID`.                                                                                                                                                                                                                                                                                                                                       |
| `R2_ACCESS_KEY_ID`     | Access key ID of the R2 API token `portifact-app-uploads`, limited to Object Read and Write on `portifact-artifacts`. It only signs upload URLs.                                                                                                                                                                                                                                                     |
| `R2_SECRET_ACCESS_KEY` | Secret access key of that token. Rotating it voids upload URLs already issued; clients ask for fresh ones with `GET /api/v1/publishes/:id`.                                                                                                                                                                                                                                                          |
| `TURNSTILE_SECRET_KEY` | Secret key of the Turnstile widget whose site key is `TURNSTILE_SITE_KEY`. Without it every human check fails closed: no new accounts and no first comments on other people's artifacts.                                                                                                                                                                                                             |
| `WEBHOOK_KEY`          | At least 32 characters, for example 32 random bytes in base64 (`openssl rand -base64 32`). Seals webhook URLs and signing secrets at creation ([decision 0009](decisions/0009-webhooks.md)); the `portifact-jobs` Worker opens them with the same value, so set both, on the jobs Worker first. Without it creating a webhook answers `503`. To rotate it, see "Content Worker configuration" below. |
| `UNSUBSCRIBE_SECRET`   | 32 random bytes, base64 (`openssl rand -base64 32`). Checks the signed unsubscribe links of comment notice emails; the `portifact-jobs` Worker signs them with the same value, so set both. Rotating it voids links in emails already sent (people then turn notices off in their settings). Without it the unsubscribe endpoint answers `503`.                                                      |

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

The Worker bundles the diagram script (the pinned Mermaid build and its runner, "Diagrams and highlighted code" in [security.md](security.md)), which `bun run build` generates in `packages/render/dist` before the deploy; Turborepo also builds it before the content Worker's typecheck, tests and dev server, and before the e2e workspace's typecheck, which compiles the content Worker's sources through `e2e/worker`: any generated module the content Worker imports (the bridge bundle, the diagram script) must be a dependency of `@portifact/e2e#typecheck` in `turbo.json` too, or a clean CI run typechecks before it exists. It is embedded precompressed (the brotli body as base64, about 1.6 MB of module, which barely compresses further), within the Workers Paid plan's 10 MB compressed limit; watch the size `wrangler deploy` reports when upgrading Mermaid. Each build is served at its own content-hashed URL, so deploying a new Mermaid needs no cache purge.

The Worker also binds the `TrafficLimiter` Durable Object (`TRAFFIC_LIMITER`, a SQLite-backed class created by the `v1` entry of `migrations` in `apps/content/wrangler.jsonc`), which counts the per-visitor limits only while budget protection tightens traffic. `wrangler deploy` applies the migration; never edit or remove an applied migration entry, add a new tag for a class change. It replaced the Workers Rate Limiting namespaces 7301 and 7302, which are no longer bound; if rate limiting namespaces are ever used again, keep to the 7300 range, because namespace IDs are shared by every Worker on the Cloudflare account and other projects use 1001 to 1005. The `portifact-jobs` Worker needs `UNSUBSCRIBE_SECRET` with the same value as `portifact-app` (`wrangler secret put UNSUBSCRIBE_SECRET --name portifact-jobs` from `apps/jobs`) before comment notices can be sent: without it their jobs fail before sending and wait in the outbox. Webhooks need `WEBHOOK_KEY` on `portifact-jobs` with the same value as `portifact-app`: set it on the jobs Worker first (`wrangler secret put WEBHOOK_KEY --name portifact-jobs` from `apps/jobs`), then on the app, then deploy, so no webhook is sealed with a key the jobs Worker lacks; without it, webhook deliveries fail before sending and wait in the outbox. To rotate it: put the old value in `WEBHOOK_KEY_PREVIOUS` and the new one in `WEBHOOK_KEY` on `portifact-jobs`, then the new one in `WEBHOOK_KEY` on `portifact-app`; the maintenance run re-seals up to 200 webhooks a run and logs `webhookKeysLeft`; once it is 0, delete `WEBHOOK_KEY_PREVIOUS`. `WEBHOOKS_PAUSED` is the emergency stop of deliveries ([operations.md](operations.md), "Webhooks"); leave it unset. Keep a retired `WEBHOOK_KEY` value for at least 30 days: after a D1 Time Travel restore to before a rotation, put it back in `WEBHOOK_KEY_PREVIOUS`, or the restored webhooks sealed with it stop with `key_unavailable`. `WEBHOOKS_ENABLED` is not in either `wrangler.jsonc` and must not be set until the checks in "Webhooks" below pass. The jobs Worker runs with the `global_fetch_strictly_public` compatibility flag and a second cron (`* * * * *`, the outbox relay); both come with `wrangler deploy`. The `portifact-jobs` Worker has the secrets `CF_ANALYTICS_TOKEN` (an API token with only Account Analytics Read) and `CF_ACCOUNT_ID` set in production, which turn on the Cloudflare analytics collector of the budget run; the alert emails stay off until configured (see "Budget alerts and protection" in [operations.md](operations.md)).

For local development, build `apps/web`, apply the migrations to the local databases (`npx wrangler d1 migrations apply portifact-control --local` and `npx wrangler d1 migrations apply portifact-access --local` from `apps/app`), put the same names plus `APP_ORIGIN=http://localhost:8787` in `apps/app/.dev.vars` (ignored by git) and run `npx wrangler dev --local-upstream localhost:8787` from `apps/app`. Without `--local-upstream`, `wrangler dev` rewrites every request to the first route's host, `portifact.com`, and the auth pages answer 404. With that origin, `localhost` is the app host; the landing is served by `bun run --cwd apps/web dev`. Migration 0003 links the CLI client to the production API resource, so the device flow against `localhost` needs a local client row linked to `http://localhost:8787/api/v1`; then point the CLI at it with `PORTIFACT_APP_ORIGIN=http://localhost:8787`.

The token is an account API token named `portifact-ci-deploy`, limited to Workers, D1, R2 and Queues on the account plus Workers Routes, DNS and Zone read on `portifact.com` and `portifact.dev`. It expires on 2027-11-07; rotate it before then.

### Webhooks

Webhooks ship switched off ([decision 0009](decisions/0009-webhooks.md), "Switched off"). Before setting `WEBHOOKS_ENABLED="true"` on `portifact-jobs` and then `portifact-app` (as a `wrangler secret put` or a var in a deploy that only the maintainer makes), run these checks on a staging deployment of the jobs Worker on the same Cloudflare account, with a staging webhook owned by an operator account, and record each result in decision 0009's open risks with the date. Use only receivers you control.

1. **Private, loopback and metadata addresses.** Create DNS names you control that resolve to `127.0.0.1`, `10.0.0.1`, `192.168.0.1`, `169.254.169.254`, `::1` and `fd00::1` (an A or AAAA record each), and a webhook per name. Required: every delivery fails (a network error or a Cloudflare error status), and no listener you run on those addresses on a machine of yours ever sees a request. If one succeeds or reaches a listener: do not enable webhooks; record it, and either resolve names with DNS over HTTPS and refuse private answers before each send (accepting the rebinding gap) or keep the feature off.
2. **Same-account reach.** Point webhooks at (a) a zone of the account with a WAF rule or Access policy that blocks outside clients, (b) a Worker custom domain of another project on the account, (c) that zone's `<host>.cdn.cloudflare.net` name if a partial setup exists, and (d) a tunnel's public hostname with Access in front. Required: each answers exactly as it does to a request from outside Cloudflare (the WAF or Access answers), never as an internal request that skips them. If any is reached around its protection: do not enable webhooks; add the pattern to `CLOUDFLARE_HOSTS` if it is a Cloudflare-owned name, or move the jobs Worker to a dedicated Cloudflare account with no other projects, and run the checks again.
3. **The `CF-Worker` header.** Send a delivery to a receiver you control that logs request headers. Required: `CF-Worker` carries nothing that names the account's other projects. If it carries the account's `workers.dev` subdomain (shared by every Worker of the account): either accept it in decision 0009 as public information about Portifact's account, or move the jobs Worker to a dedicated account (or give it a zone of its own and confirm the header then names that zone), and run the check again.

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

The `ci` workflow runs on every pull request and again on `develop` after each merge, which keeps the readme's CI and coverage badges current. It runs lint, typecheck, tests with coverage thresholds, `shellcheck` and a render of sample release notes with the configured preset (`scripts/check-release-notes.mjs`). It also builds every platform and smoke-tests the installers on Linux x64 and arm64, macOS, and Windows x64 and arm64, checking that each machine gets its native build, and across Linux distributions in containers. The `e2e` job is a matrix with one job per Playwright project (`e2e (chromium-3pc-blocked)`, `e2e (firefox-chips)`, `e2e (firefox-3pc-blocked)`, `e2e (webkit)`) running in parallel, because the suite runs with one worker per stack: run back to back, the four projects took about 14 minutes, five times `quality`. Each job installs only its own browser with its system libraries (`bunx playwright install --with-deps <browser>` in `e2e/`) and runs `bun run test:e2e -- --project=<project>`. It does not retry failed tests, and a failure uploads that project's `e2e/test-results/` (traces) as the `e2e-traces-<project>` artifact. A new Playwright project needs a matrix entry, or CI never runs it. The `secrets` job downloads gitleaks (version and SHA-256 pinned in `ci.yml`, checked before it runs, with read-only repository permissions and no persisted credentials) and scans the change's commits (`gitleaks git --log-opts=<base>..<head>`) and the checked-out tree (`gitleaks dir`) on every run, plus the whole history when the scope asks for it, with the rules in `.gitleaks.toml` (the default rules plus a narrow allowlist; findings are redacted in the log). To update gitleaks, change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` together from the release's checksums file and run it locally on the repository first. Pull requests into `main` must come from `develop`. Pull requests into `develop` also run the `cla` workflow (see "Contributor license agreement" below) and check their title in a separate `pr-title` workflow (`.github/workflows/pr-title.yml`), which also runs when the title is edited; `ci` does not run on edits, because a title or description edit used to start a second full run that cancelled the first through the concurrency group and left a cancelled required check blocking the merge.

Mutation testing has its own `mutation` workflow, which runs only when started by hand; releases do not wait for it. See [testing.md](testing.md#mutation-testing).

A first `changes` job (`scripts/ci-scope.ts`) skips work the diff cannot affect, and skipped jobs satisfy required checks. The CLI build and the installer smoke tests run only when the CLI, a workspace package it depends on, its build or installer scripts, shared tooling (`package.json`, `bun.lock`, `bunfig.toml`, root tsconfig) or the workflows change. Lint, typecheck and tests are skipped only when every changed file is under `docs/`, `license` or issue templates; `readme.md`, `AGENTS.md` and `skills/` still run them because checks read those files. Pull requests into `main` always run everything, and if `changes` fails the other jobs run anyway. The end-to-end suite runs when `apps/app`, `apps/content`, `apps/web`, any workspace package but the CLI, `e2e/`, shared tooling (including `turbo.json`) or `ci.yml` change. The secret scan always runs; its scope only decides the whole-history pass, which runs when `.gitleaks.toml` or `ci.yml` change, for pull requests into `main` and when the range cannot be computed (`SECRET_SCAN_FILES`). `.gitleaks.toml` alone does not run lint and tests. When you add a file the CLI build or the installers depend on, add it to `CLI_FILES` in `scripts/ci-scope.ts` with a test, and likewise `E2E_FILES` for the end-to-end suite.

## Setup and recovery

- Secret `RELEASE_DEPLOY_KEY`: private half of a write-enabled deploy key. The `develop` and `main` rulesets allow this deploy key to bypass them. If you rotate it, update both the deploy key and the secret.
- A failed release leaves no tag. Fix the cause on `develop` and merge into `main` again.
- If the sync into `develop` failed, rerun the workflow or merge `main` into `develop` through a pull request.
- Keep `conventional-changelog-conventionalcommits` on the major version that matches the changelog writer bundled with semantic-release. Version 10 of the preset needs `conventional-changelog-writer` 9, while semantic-release 25 ships writer 8, so the preset stays on 9. `scripts/check-release-notes.mjs` catches a mismatch in CI.
