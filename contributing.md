# Contributing to Portifact

Thank you for helping. Portifact is licensed under the [GNU Affero General Public License v3.0](license), and its maintainer also offers it under a commercial license ([docs/licensing.md](docs/licensing.md)). To keep that possible, every contributor signs the [Portifact Individual Contributor License Agreement](cla.md), version 2.0, and confirms it on each pull request. The agreement was prepared without legal counsel, after an adversarial review.

## What the agreement does

You retain ownership of rights you own and grant the permissions stated in the agreement, including proprietary sublicensing. The patent grant covers only the claims specified there. You must have authority for each grant and satisfy the contribution record requirements. This summary does not expand the agreement or override mandatory law. Read [cla.md](cla.md) before signing: it is the agreement, this page only explains how to sign it.

Portifact currently accepts contributions through this procedure only from adults with contractual capacity. A GitHub account's eligibility requirements do not establish that capacity.

If another person or organization owns or controls rights in your contribution, for example an employer, a client or a university, contact hello@portifact.com before submission; the contribution will not be merged until the required written grant or authorization is recorded.

## Who has to sign

Before merge, identify every person who supplied copyrightable material, including co-authors and authors of imported, cherry-picked, squashed or pasted changes. Each person must have a verified agreement covering their material, or the material must have separately documented rights sufficient for both the public and commercial distributions. Commit metadata and co-author trailers help identify contributors but do not prove authorship, authority or assent. Automation accounts cannot grant rights in material created by another person. Unresolved authorship or ownership blocks merge.

The maintainer does not sign a grant to themself. Approved automation accounts (`dependabot[bot]`, `github-actions[bot]`, `imgbot[bot]`) do not sign as legal persons, but their pull requests must preserve every existing signature record and must not introduce unverified signatures.

## How to sign

Two steps, both from your own GitHub account.

1. The first time, add this line at the end of the list in [cla-signers.md](cla-signers.md), with your GitHub login, your numeric account ID (shown by `gh api user --jq .id`, or at `https://api.github.com/users/<your-login>`), your full legal name, today's date (`YYYY-MM-DD`) and the statement exactly as written:

   ```text
   - @your-login (12345678), Your Full Legal Name, 2026-11-12: I have read and agree to the Portifact Individual Contributor License Agreement, version 2.0, whose text in cla.md has the SHA-256 digest 93ea88ec08f6ce189eb0b39653c5d2eece4e31d00dde8110d7438a26ededeec0.
   ```

2. On every pull request, post a comment from your own account with this statement on a line of its own. Below it you may list earlier contributions you want it to cover, by pull request, commit or file.

   ```text
   I sign the Portifact Individual Contributor License Agreement, version 2.0, whose text in cla.md has the SHA-256 digest 93ea88ec08f6ce189eb0b39653c5d2eece4e31d00dde8110d7438a26ededeec0, and I submit my contributions in this pull request under it. I have identified in this pull request any material in it that I did not create, and I intend this comment to be my electronic signature.
   ```

The comment is your signature: only your authenticated account can post it, and the line in `cla-signers.md` is an index. Post the comment, then push a commit or close and reopen the pull request so the check runs again. Identify in the pull request's description any material you did not create, with its source and license.

The `cla` check on the pull request passes when:

- the check read one complete, unchanged head (at most 250 commits);
- the pull request's author, every commit author and every co-author named in a `Co-authored-by` trailer have a line in `cla-signers.md` at the head and posted the comment above on this pull request;
- every commit's author email belongs to a GitHub account, and every co-author trailer uses a GitHub noreply address with the account ID (`12345678+login@users.noreply.github.com`), so the check can tell who they are;
- the pull request keeps every record of `cla-signers.md` on `develop`, adds lines only for accounts that posted the comment on it, and does not change `cla.md` while adding a signature.

The check matches identities to records; it does not prove who owns the material. The maintainer reviews provenance before merging and archives the evidence the check produces.

## Your records

Public Git records may be copied indefinitely. Do not publish your address, identity documents or private contact email in the signer file. Private identity or authority records are retained separately for agreement administration and legal claims and disclosed only as necessary for those purposes, including controlled transaction diligence.

## Before you open a pull request

- Branch from `develop` and open the pull request against `develop`. Its title is a lowercase [Conventional Commit](https://www.conventionalcommits.org/) subject, for example `fix(cli): keep the exit code on a failed upload`.
- Run `bun install`, `bun run check` and `bun run test`; [docs/testing.md](docs/testing.md) explains what each change needs.
- Read [AGENTS.md](AGENTS.md) for the architecture rules and the documents that apply to your change.

Report security issues privately as [docs/security.md](docs/security.md) explains, not in a pull request.
