# Publishing from GitHub Actions

A workspace on a plan with service tokens ([decision 0011](decisions/0011-service-tokens.md)) publishes a preview of every pull request with the Portifact action, `leynier/portifact/action`: it publishes the build with a publish key, keeps one comment on the pull request with the link, the version and the commit, and deletes the preview when the pull request closes. Plain CLI steps do the same without the action (see "Without the action"). Federation through GitHub's OIDC tokens (no stored secret) comes later.

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

| Input                | Default                    | Meaning                                                                                                               |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `path`               | required                   | Folder or file to publish, relative to the workspace                                                                  |
| `token`              | required                   | The service token, from `secrets.PORTIFACT_TOKEN`; the CLI gets it only as the `PORTIFACT_TOKEN` environment variable |
| `key`                | `pr-<pull request number>` | Publish key: the first run creates the artifact, later runs publish new versions of it                                |
| `name`               | `PR #<number>: <title>`    | Name of the artifact; control characters are removed and it is cut to 200 bytes                                       |
| `comment`            | `true`                     | Create or update one comment on the pull request                                                                      |
| `delete-on-close`    | `true`                     | Delete the preview when the pull request closes (merged or not)                                                       |
| `fail-without-token` | `false`                    | Fail the job, instead of skipping with a warning, when the token is empty                                             |
| `cli-version`        | the action's release       | CLI version to install, or `latest`                                                                                   |
| `github-token`       | `github.token`             | Token for the comment; needs `pull-requests: write`                                                                   |

Outputs: `url`, `artifact-id` and `version` (the version number just published), set on publishing runs.

### What it does

- **Opened, synchronize, reopened**: installs the CLI, runs `portifact publish <path> --key=<key> --name=<name> --json`, sets the outputs, adds the link to the step summary and creates or updates the comment.
- **Closed**: runs `portifact delete --key=<key> --yes --json`. A key nothing holds deletes nothing and succeeds, so a rerun, or a pull request that never published, is not an error. The comment, if there is one, then says the preview was removed.
- **Other actions** (edited, labeled) do nothing.
- **The comment** starts with a hidden marker, `<!-- portifact-preview:<key> -->`. Each run looks for a comment by a bot that starts with that marker and edits it, so pushes do not add comments; a person's comment with the same marker is ignored. Two previews with different keys keep two comments. If the comment cannot be read or written (missing `pull-requests: write`), the run warns and still succeeds, because the preview was published.
- **Errors** from the CLI fail the step with the CLI's message and exit code (3 for an expired or revoked token, 7 when the workspace's plan no longer includes service tokens; see the exit codes in `skills/portifact/SKILL.md`).

### Runners

`ubuntu-latest`, `macos-latest` and `windows-latest`, x64 and arm64. Linux and macOS install with `scripts/install.sh` and Windows with `scripts/install.ps1`; every platform runs the action's steps in bash (Git Bash on Windows) and needs `curl`, `jq` and `gh`, which GitHub's hosted runners include. A self-hosted runner without one of them fails with a message naming it.

## Who can open a preview

The action never widens access. A workspace's new artifacts start `restricted`, so the preview opens only for the workspace's admins and editors until someone shares it. Reviewers sign in to Portifact with an account that may read it: invite them to the workspace, add them as readers (`portifact access add <id> <email>` with a person's login), or, on plans with it, set the artifact to `workspace` or `domain` access from the dashboard. A token without `artifacts:share`, as recommended, cannot do any of this, by design.

## Pull requests from forks

GitHub gives no secrets to `pull_request` runs of pull requests from forks, so the token input is empty. The action then skips with a warning and the job succeeds; set `fail-without-token: true` to fail it instead. A preview of a fork's pull request has to be published by a maintainer, for example by pushing the branch to the repository.

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
