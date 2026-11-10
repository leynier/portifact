# Publishing from GitHub Actions

A workspace on a plan with service tokens ([decision 0011](decisions/0011-service-tokens.md)) publishes a preview of every pull request with plain CLI steps. A reusable action and federation through GitHub's OIDC tokens (no stored secret) come later.

## Set up

1. An admin of the workspace opens its Service tokens page in the dashboard (`/service-tokens?workspace=<slug>`) and creates a token: label "GitHub previews", role editor, scopes Read, Publish and Delete, an expiry, and the restriction "Artifacts with a key prefix" with the prefix `pr-`. Delete lets the job remove the preview when the pull request closes, and the prefix keeps the token from touching anything else.
2. Copy the token, which starts with `pfst_` and is shown once, into the repository's secrets as `PORTIFACT_TOKEN` (Settings, Secrets and variables, Actions). Never put it in the workflow file, a log or a command line.

## Workflow

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
    steps:
      - uses: actions/checkout@v4
        if: github.event.action != 'closed'
      - name: Install the Portifact CLI
        run: |
          curl -fsSL https://portifact.com/install | PORTIFACT_NO_MODIFY_PATH=1 bash
          echo "$HOME/.portifact/bin" >> "$GITHUB_PATH"
      - name: Build
        if: github.event.action != 'closed'
        run: npm ci && npm run build
      - name: Publish the preview
        if: github.event.action != 'closed'
        run: portifact publish ./dist --key "pr-${{ github.event.number }}" --name "PR ${{ github.event.number }}" --json
      - name: Delete the preview
        if: github.event.action == 'closed'
        run: portifact delete --key "pr-${{ github.event.number }}" --yes
```

The first run creates the artifact with the key `pr-<number>`; every later push publishes a new version of the same artifact, so the job stores no artifact ID. Deleting by a key nothing holds deletes nothing and succeeds, so a rerun of the closed job is harmless. The token acts on its own workspace, so the commands need no `--workspace`.

## Notes

- Pull requests from forks get no secrets in `pull_request` workflows, so their previews are skipped; do not switch to `pull_request_target` with a checkout of the fork's code, which would hand the token to untrusted code.
- The CLI never prints the token or writes it to disk; `--json` output holds the artifact's URL, ID and version.
- An expired or revoked token fails with exit code 3 and says why; a workspace whose plan no longer includes service tokens fails with exit code 7.
- If the token leaks, revoke it on the Service tokens page at once ([operations.md](operations.md), "A leaked service token").
