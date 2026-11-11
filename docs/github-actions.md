# Publishing from GitHub Actions

A workspace on a plan with service tokens ([decision 0011](decisions/0011-service-tokens.md)) publishes a preview of every pull request with the Portifact action, `leynier/portifact/action`: it publishes the build with a publish key, keeps one comment on the pull request with the link, the version and the commit, and deletes the preview when the pull request closes. Plain CLI steps do the same without the action (see "Without the action"). A workspace can also trust a repository instead of storing a token: the job then exchanges GitHub's OIDC ID token for a credential that lives 15 minutes (see "Without a stored token"; [decision 0024](decisions/0024-github-oidc-federation.md)). That mode ships switched off: it works only once Portifact turns it on (`GITHUB_OIDC_ENABLED`, [releasing.md](releasing.md), "GitHub OIDC"), and until then the dashboard says it is not available.

## Set up the token

1. An admin of the workspace opens its Service tokens page in the dashboard (`/service-tokens?workspace=<slug>`).
2. Create a token with the label "GitHub previews", the scopes Read, Publish and Delete (`artifacts:read`, `artifacts:write`, `artifacts:delete`) and nothing else, an expiry, and the restriction "Artifacts with a key prefix" with the prefix `pr-`. Delete lets the job remove the preview when the pull request closes; the prefix keeps the token from touching any other artifact of the workspace, even if it leaks. Leave Share unchecked: the action never changes access.
3. Copy the token, which starts with `pfst_` and is shown once.
4. In the repository on GitHub, open Settings, Secrets and variables, Actions, choose New repository secret, name it `PORTIFACT_TOKEN` and paste the token. Never put it in the workflow file, a log, a command line or a variable.
5. Note the token's expiry; before it, create a new one and replace the secret. If it leaks, revoke it on the Service tokens page at once ([operations.md](operations.md), "A leaked service token").

## Workflow

`.github/workflows/preview.yml`:

```yaml
name: Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

# One run per pull request at a time; a close cancels a publish still running.
concurrency:
  group: preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        if: github.event.action != 'closed'
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        if: github.event.action != 'closed'
        with:
          node-version: 24
      - name: Build
        if: github.event.action != 'closed'
        run: npm ci && npm run build
      - uses: leynier/portifact/action@<commit SHA of a release tag> # vX.Y.Z
        with:
          path: dist
          token: ${{ secrets.PORTIFACT_TOKEN }}
```

`pull-requests: write` lets the action write its comment with the workflow's own `GITHUB_TOKEN`; `contents: read` is all the checkout needs. The close run builds nothing and needs no checkout: it only deletes.

### Pinning the action

The action lives in the `action/` directory of this repository, so it is used as `leynier/portifact/action@<ref>`. The ref is a release tag (`vX.Y.Z`) or, better, the full commit SHA that tag points to, with the tag in a comment as above: a tag can be moved, a commit cannot, and Dependabot updates both forms. Find the SHA on the release's page, or with `git ls-remote https://github.com/leynier/portifact refs/tags/vX.Y.Z`.

Tags are created only by the release workflow ([releasing.md](releasing.md)), so the first release after the action was merged is the first ref that has it. The action installs the CLI of the same release: it reads the version from `packages/cli/package.json` next to the action, which the release commit sets, and runs the repository's own installer from that commit, which downloads that version and verifies it against the release's `SHA256SUMS`. Set `cli-version` only to install another release (`1.2.3`, or `latest`).

### Inputs

| Input                | Default                    | Meaning                                                                                                                                   |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `path`               | required                   | Folder or file to publish, relative to the workspace                                                                                      |
| `token`              | empty                      | The service token, from `secrets.PORTIFACT_TOKEN`; the CLI gets it only as the `PORTIFACT_TOKEN` environment variable                     |
| `workspace`          | empty                      | The workspace's slug, for the OIDC mode; used only when `token` is empty (see "Without a stored token")                                   |
| `key`                | `pr-<pull request number>` | Publish key: the first run creates the artifact, later runs publish new versions of it; `gh-<repository ID>/pr-<number>` in the OIDC mode |
| `name`               | `PR #<number>: <title>`    | Name of the artifact; control characters are removed and it is cut to 200 bytes                                                           |
| `comment`            | `true`                     | Create or update one comment on the pull request                                                                                          |
| `delete-on-close`    | `true`                     | Delete the preview when the pull request closes (merged or not)                                                                           |
| `fail-without-token` | `false`                    | Fail the job, instead of skipping with a warning, when the token is empty                                                                 |
| `cli-version`        | the action's release       | CLI version to install, or `latest`                                                                                                       |
| `github-token`       | `github.token`             | Token for the comment; needs `pull-requests: write`                                                                                       |

Outputs: `url`, `artifact-id` and `version` (the version number just published), set on publishing runs.

### What it does

- **Opened, synchronize, reopened**: installs the CLI, runs `portifact publish <path> --key=<key> --name=<name> --json`, sets the outputs, adds the link to the step summary and creates or updates the comment.
- **Closed**: runs `portifact delete --key=<key> --yes --json`. A key nothing holds deletes nothing and succeeds, so a rerun, or a pull request that never published, is not an error. The comment, if there is one, then says the preview was removed.
- **Other actions** (edited, labeled) do nothing.
- **The comment** starts with a hidden marker, `<!-- portifact-preview:<key> -->`. Each run looks for a comment by a bot that starts with that marker and edits it, so pushes do not add comments; a person's comment with the same marker is ignored. Two previews with different keys keep two comments. If the comment cannot be read or written (missing `pull-requests: write`), the run warns and still succeeds, because the preview was published.
- **Errors** from the CLI fail the step with the CLI's message and exit code (3 for an expired or revoked token, 7 when the workspace's plan no longer includes service tokens; see the exit codes in `skills/portifact/SKILL.md`).

### Runners

`ubuntu-latest`, `macos-latest` and `windows-latest`, x64 and arm64. Linux and macOS install with `scripts/install.sh` and Windows with `scripts/install.ps1`; every platform runs the action's steps in bash (Git Bash on Windows) and needs `curl`, `jq` and `gh`, which GitHub's hosted runners include. A self-hosted runner without one of them fails with a message naming it.

## Without a stored token

With GitHub Actions OIDC ([decision 0024](decisions/0024-github-oidc-federation.md)) the repository keeps no Portifact secret. GitHub gives the job a signed ID token that says which repository, run and event it is; the CLI exchanges it at Portifact for a credential that lives 15 minutes, keeps it in memory and never writes, prints or passes it on. The mode ships switched off and needs a plan with service tokens.

### Trust the repository

1. Find the repository's numeric IDs, which trust is bound to (a renamed repository stays trusted; a deleted and re-created one with the same name does not): `gh api repos/OWNER/REPO --jq '.id, .owner.id'`. A run also has them as `GITHUB_REPOSITORY_ID` and `GITHUB_REPOSITORY_OWNER_ID`, and a refused exchange prints them.
2. An admin of the workspace opens its Service tokens page, section GitHub Actions, and fills in the repository's `owner/name` (shown to people only), the two IDs, the events that may publish, optionally an exact ref or environment, and what its runs may do. For previews keep the default events (`pull_request`, `push`) and choose Read, Publish and Delete.
3. The page shows the audience the workflow asks GitHub for, `https://app.portifact.com/workspaces/<slug>/github`. The action and the CLI build it from the workspace slug; nothing to copy unless you call the exchange yourself.

Every credential is restricted to the publish keys that start with `gh-<repository ID>/`, so one repository's workflow can never touch another repository's previews or an artifact published by hand. It is an `editor` of the workspace and nothing else: no comments, no access changes (the scope is never offered), no MCP.

### Which runs can publish

- `pull_request`: GitHub gives a fork's run no ID token in a public repository, so only branches of the repository itself publish. In a private repository with "Send write tokens to workflows from pull requests" turned on, a fork's run gets one too, and nothing in the token tells it apart: leave the event off there, or require an environment with reviewers.
- `pull_request_target` and `workflow_run` are privileged runs a fork's pull request can start; the dashboard asks for a confirmation before trusting them, and the action refuses `pull_request_target` anyway.
- A ref narrows by exact match (`refs/heads/main`); a pull request run's ref is `refs/pull/<number>/merge`, so a branch ref lets no pull request publish. An environment narrows by exact name, and GitHub applies its protection rules (required reviewers, branch rules) before the job gets its token, which makes it the strongest narrowing.

### Workflow

```yaml
name: Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

concurrency:
  group: preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  id-token: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        if: github.event.action != 'closed'
        with:
          persist-credentials: false
      - name: Build
        if: github.event.action != 'closed'
        run: npm ci && npm run build
      - uses: leynier/portifact/action@<commit SHA of a release tag> # vX.Y.Z
        with:
          path: dist
          workspace: acme
```

`id-token: write` lets the job ask GitHub for an ID token; without it, or on a fork's pull request, the action skips with a warning (or fails with `fail-without-token: true`). The preview's key is `gh-<repository ID>/pr-<number>`. Without the action, set `PORTIFACT_GITHUB_OIDC` to the workspace slug in the CLI steps' `env` instead of `PORTIFACT_TOKEN`, grant `id-token: write`, and publish with keys under `gh-<repository ID>/` (`GITHUB_REPOSITORY_ID` is in every run's environment). The CLI does nothing with GitHub's token unless `PORTIFACT_GITHUB_OIDC` is set and `PORTIFACT_TOKEN` is not, so a job that grants `id-token: write` for a cloud login never talks to Portifact by accident.

### Removing trust

Removing the repository on the Service tokens page stops its credentials at once, including one a run holds right now, and a restore of Portifact's database cannot bring the trust back. Changing the rule ends its credentials the same way.

## Who can open a preview

The action never widens access. A workspace's new artifacts start `restricted`, so the preview opens only for the workspace's admins and editors until someone shares it. Reviewers sign in to Portifact with an account that may read it: invite them to the workspace, add them as readers (`portifact access add <id> <email>` with a person's login), or, on plans with it, set the artifact to `workspace` or `domain` access from the dashboard. A token without `artifacts:share`, as recommended, cannot do any of this, by design.

## Pull requests from forks

GitHub gives no secrets and no ID token to `pull_request` runs of pull requests from forks, so the token input is empty and the OIDC mode has nothing to exchange. The action then skips with a warning and the job succeeds; set `fail-without-token: true` to fail it instead. A preview of a fork's pull request has to be published by a maintainer, for example by pushing the branch to the repository.

Do not switch to `pull_request_target` to get the secret. That event runs with the repository's secrets and a writable `GITHUB_TOKEN`, and a workflow that checks out and builds the fork's code (`ref: ${{ github.event.pull_request.head.sha }}`) runs that code with them: the build scripts, the package manager's install hooks and anything they download could read `PORTIFACT_TOKEN` and the `GITHUB_TOKEN`. The action refuses to run on `pull_request_target`.

## Untrusted values

The pull request's title, branch and author come from whoever opened it. The action takes every value from the event through environment variables, never as `${{ }}` expressions inside a script, passes the name to the CLI as one argument, and writes nothing from the event into the comment: the comment holds only the key (escaped), the URL and version the CLI returned (both checked) and the first seven characters of the head commit (checked as a SHA). Keep the same rule in your own steps: put `${{ github.event.* }}` values in `env:` and quote them in the script, and pin every third-party action by its commit SHA. The token never reaches the logs, the outputs, the comment or the step summary; GitHub also masks secrets in logs.

## Without the action

The same job with plain CLI steps, for a runner or a flow the action does not cover:

```yaml
name: Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read

jobs:
  preview:
    runs-on: ubuntu-latest
    env:
      PORTIFACT_TOKEN: ${{ secrets.PORTIFACT_TOKEN }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        if: github.event.action != 'closed'
        with:
          persist-credentials: false
      - name: Install the Portifact CLI
        run: |
          curl -fsSL https://portifact.com/install | PORTIFACT_NO_MODIFY_PATH=1 bash
          echo "$HOME/.portifact/bin" >> "$GITHUB_PATH"
      - name: Build
        if: github.event.action != 'closed'
        run: npm ci && npm run build
      - name: Publish the preview
        if: github.event.action != 'closed'
        run: portifact publish ./dist --key "pr-$PR_NUMBER" --name "PR $PR_NUMBER" --json
      - name: Delete the preview
        if: github.event.action == 'closed'
        run: portifact delete --key "pr-$PR_NUMBER" --yes --json
```

The first run creates the artifact with the key `pr-<number>`; every later push publishes a new version of the same artifact, so the job stores no artifact ID. The token acts on its own workspace, so the commands need no `--workspace`. Pin the installer with `PORTIFACT_VERSION` for repeatable builds. `publish --json` prints `url`, `artifactId` and `versionNumber`; `delete --key --json` prints `{"key","deleted":false}` when nothing had the key.

## Notes

- The CLI never prints the token or writes it to disk, and withholds it from the programs it starts.
- An expired or revoked token fails with exit code 3 and says why; a workspace whose plan no longer includes service tokens fails with exit code 7.
- The action's logic is `action/preview.sh`, unit tested with a fake CLI and a fake `gh` in `scripts/github-action.test.ts`, which also checks `action.yml` and the workflows on this page (no expression inside a script, every action pinned by SHA). The real CLI's keyed publish and delete with a service token are covered end to end in `e2e/tests/service-tokens.spec.ts`.
- Checked against the real services on 2026-11-11 with the action at `v0.34.0`, in a scratch repository with a temporary workspace on the Team plan and its service token as the `PORTIFACT_TOKEN` secret: opening a pull request published a preview with key `pr-1` and left one comment with its link, a second push updated the same preview and the same comment, closing the pull request deleted the preview, and the token appeared in no log. The workspace, plan and token were removed afterwards. GitHub would not start the workflow in a private repository of an account with a billing problem; that is GitHub's refusal, not the action's.
