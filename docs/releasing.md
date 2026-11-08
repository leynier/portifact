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

Every push to `main` also runs the `deploy` job after `release`: it builds `apps/web` and deploys the `portifact-app` Worker with `wrangler`, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, then checks that `portifact.com` serves the landing page and the installer redirect. The Worker owns `portifact.com` and `www.portifact.com` as custom domains; `www` redirects to the apex. Pull requests validate the bundle with `wrangler deploy --dry-run`.

The token is an account API token named `portifact-ci-deploy`, limited to Workers, D1, R2 and Queues on the account plus Workers Routes, DNS and Zone read on `portifact.com` and `portifact.dev`. It expires on 2027-11-07; rotate it before then.

## Platforms

`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`, `windows-x64` and `windows-arm64`. Unix archives are `.tar.gz` and Windows archives are `.zip`; each holds a single executable that does not need Node or Bun.

- Linux glibc builds need glibc 2.17 or newer, so they run on Debian, Ubuntu, RHEL and its rebuilds (Rocky, Alma, CentOS 7+), Fedora, Amazon Linux and openSUSE.
- Musl builds are for Alpine and need `libstdc++` and `libgcc` (`apk add libstdc++ libgcc`); the installer checks for them and says so.
- x64 builds use Bun's baseline targets, so they also run on CPUs without AVX2.
- `scripts/smoke-linux-distros.sh` installs and runs the CLI in containers of those distributions, all in parallel; CI runs it on every pull request.

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

The `ci` workflow runs on every pull request and again on `develop` after each merge, which keeps the readme's CI and coverage badges current. It runs lint, typecheck, tests with coverage thresholds, `shellcheck` and a render of sample release notes with the configured preset (`scripts/check-release-notes.mjs`). It also builds every platform and smoke-tests the installers on Linux x64 and arm64, macOS, and Windows x64 and arm64, checking that each machine gets its native build, and across Linux distributions in containers. Pull requests into `develop` also check their title; pull requests into `main` must come from `develop`.

## Setup and recovery

- Secret `RELEASE_DEPLOY_KEY`: private half of a write-enabled deploy key. The `develop` and `main` rulesets allow this deploy key to bypass them. If you rotate it, update both the deploy key and the secret.
- A failed release leaves no tag. Fix the cause on `develop` and merge into `main` again.
- If the sync into `develop` failed, rerun the workflow or merge `main` into `develop` through a pull request.
- Keep `conventional-changelog-conventionalcommits` on the major version that matches the changelog writer bundled with semantic-release. Version 10 of the preset needs `conventional-changelog-writer` 9, while semantic-release 25 ships writer 8, so the preset stays on 9. `scripts/check-release-notes.mjs` catches a mismatch in CI.
