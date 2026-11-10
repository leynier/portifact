# Contributing to Portifact

Thank you for helping. Portifact is licensed under the [GNU Affero General Public License v3.0](license), and its maintainer also offers it under a commercial license ([docs/licensing.md](docs/licensing.md)). To keep that possible, every contributor signs the [Portifact Individual Contributor License Agreement](cla.md) once, before their first pull request is merged. The agreement is a draft pending legal review.

## What the agreement does

You keep the copyright of your contributions. You grant the maintainer, Leynier Gutiérrez González, and their successors and assigns a license to use, change and distribute them, including under licenses other than the AGPL, such as the commercial license, plus a patent license for them. You confirm that you have the right to grant it, for example that your employer allows it. Read [cla.md](cla.md) before signing: it is the agreement, this page only explains how to sign it.

## How to sign

In your first pull request, add this line at the end of the list in [cla-signers.md](cla-signers.md), with your GitHub login, your full name and today's date (`YYYY-MM-DD`), and the statement exactly as written:

```text
- @your-login, Your Full Name, 2026-11-09: I have read the Portifact Individual Contributor License Agreement, version 1.0, in cla.md, and I agree to it for all my past and future contributions to Portifact.
```

The `cla` check on the pull request passes when:

- the pull request's author and the author of every commit in it have a line in `cla-signers.md` at the pull request's head;
- every commit's author email belongs to a GitHub account, so the check can tell who wrote it (add the email to your account, or set `git config user.email` to your GitHub noreply address, and push again);
- the pull request only adds lines for its own authors, and does not remove or change anyone else's line.

You sign once: later pull requests pass as long as your line is on `develop`. If several people author one pull request, each adds their own line in a commit they author. Contributions through `Co-authored-by` trailers are not checked automatically, so co-authors sign the same way in a pull request of their own or ask the maintainer.

The maintainer and GitHub's automation accounts (`dependabot[bot]`, `github-actions[bot]`) are exempt. If you contribute on behalf of a company, ask at hello@portifact.com before signing: a corporate agreement may be needed.

## Before you open a pull request

- Branch from `develop` and open the pull request against `develop`. Its title is a lowercase [Conventional Commit](https://www.conventionalcommits.org/) subject, for example `fix(cli): keep the exit code on a failed upload`.
- Run `bun install`, `bun run check` and `bun run test`; [docs/testing.md](docs/testing.md) explains what each change needs.
- Read [AGENTS.md](AGENTS.md) for the architecture rules and the documents that apply to your change.

Report security issues privately as [docs/security.md](docs/security.md) explains, not in a pull request.
