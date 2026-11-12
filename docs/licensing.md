# Licensing

How Portifact is licensed, what the license asks of people who host it, the commercial license and why contributions need a contributor license agreement. This page explains the project's position; it is not legal advice. The contributor license agreement and this page were prepared without legal counsel, after an adversarial review, by the maintainer's decision of 2026-11-12 (as for the service's legal texts, see "Operating decisions" in [legal.md](legal.md)).

## One repository under the AGPL

All of Portifact's code is open source under the GNU Affero General Public License v3.0 only (`license`), in this one repository. There is no private premium code. What is sold is the hosted service at `portifact.com`, and a separate commercial license, for the rights the maintainer owns or is authorized to sublicense, for those who want to use Portifact on other terms than the AGPL's.

Self-hosted copies are not feature-limited and there are no license keys. Paid plans for the hosted service are being built; their features go in this repository like everything else and are turned on per account by its plan, never by a license check. Whoever hosts Portifact assigns plans to accounts with the operator tool (`bun run --cwd apps/jobs operator`, see [operations.md](operations.md)), the same way the hosted service does, and nothing in the code checks who is hosting it.

## What the AGPL asks of someone who hosts a modified copy

You may run, study, change and share Portifact under the AGPL. These obligations matter most for hosting:

- **Source for network users.** If you modify Portifact and the modified version supports remote network interaction, AGPL section 13 requires a prominent offer of its complete Corresponding Source to all users interacting with it remotely, with access at no charge. A repository link suffices only if it provides that source for the actual version being used. Separate source delivery obligations apply when you convey covered software, including downloadable binaries or covered browser code.
- **Combined works.** When you convey a covered modified work, AGPL section 5 governs licensing of the work as a whole; section 13 additionally governs qualifying modified network deployments. Independent aggregates are treated separately. GPLv3 material combined under section 13 retains its GPLv3 terms.
- **Notices.** Keep the copyright and license notices, including `third-party-notices.md` for the open source packages Portifact ships, and mark your changes as yours with a date.
- **No warranty.** Portifact comes without warranty, as sections 15 and 16 of the license say.

Separate programs that only talk to Portifact through its API, CLI or MCP server are usually not part of the same work. Publishing an artifact through Portifact does not by itself place that artifact under the AGPL. Material copied or derived from covered program code remains subject to the rights and licenses applicable to that material.

## Commercial license

The maintainer offers a separate commercial license for rights the maintainer owns or is authorized to sublicense, to anyone who wants to host, modify or embed Portifact on other terms than the AGPL's, for example without publishing their changes. It does not waive third-party license obligations or supply rights that the maintainer has not obtained. Ask at hello@portifact.com.

The licensor is currently the maintainer, Leynier Gutiérrez González, as a natural person. A company is planned. It will become the licensor only after the relevant project rights, agreements and records have been transferred to it and it has assumed the applicable obligations. The commercial license's terms are not published yet and are drafted per request until they are.

Whether the commercial license can cover a part of Portifact depends on two kinds of records. They support that judgment, but they do not prove a complete chain of title:

- **Contributions are licensed to the maintainer** under the contributor license agreement below.
- **Dependency licensing is screened, with documented exceptions.** `bun run check` fails when a package that the Workers, the web pages or the CLI ship has a license outside `COMMERCIAL_COMPATIBLE` in `scripts/notices.ts`, which lists permissive licenses only. GPL, AGPL and other strong copyleft licenses never pass. Weak copyleft (LGPL, MPL, EPL) is accepted only as an exception for an exact package version in `COMMERCIAL_EXCEPTIONS`: each entry is the maintainer's reviewed decision, recorded with its reason, and an update of the package needs the review again; see "Third-party notices" in [releasing.md](releasing.md). A package with a choice of licenses is used under its permissive one (DOMPurify under Apache-2.0).

The CLI binary also embeds the Bun runtime, which statically links LGPL libraries (JavaScriptCore and WebKit, tinycc); a commercial license of the CLI has to keep the relinking terms that `third-party-notices.md` describes.

## Why contributions need a contributor license agreement

Without an agreement, each contributor keeps the copyright of their changes and licenses them to everyone only under the AGPL. Then the maintainer could not offer the commercial license for code that includes them, and the whole project would depend on every past contributor for any license change.

The [Portifact Individual Contributor License Agreement](../cla.md) is adapted from the Apache Software Foundation's individual agreement. The CLA gives the maintainer additional permissions to distribute covered contributions under open source or proprietary terms while contributors retain their copyright. It also imposes the representations and obligations stated in the agreement. Versions released under the AGPL remain usable under that license subject to its terms; a later commercial release does not withdraw those permissions. The CLA does not require permanent repository hosting, publication of every future version, or disclosure of proprietary derivatives.

The CLA is a permission and provenance mechanism, not a guarantee of title: it does not guarantee exclusive ownership, freedom from third-party claims or contributor-funded indemnification. Any warranty or indemnity offered to a commercial customer must be stated separately and is the responsibility of the party offering it.

Contributors sign by posting the statement as a comment on each pull request from their own GitHub account, and add their signature record to `cla-signers.md` the first time ([contributing.md](../contributing.md)). Anyone who owns or controls rights in a contribution, such as an employer, must give a written grant before it is merged, and the procedure is open only to adults with contractual capacity. The `cla` workflow checks the records on every pull request into `develop`; how it works is in "Contributor license agreement" in [releasing.md](releasing.md).

The maintainer's private agreement archive (the evidence the check produces, contact confirmations, identity and authority records) must exist before the first outside contribution is merged. It does not exist yet; creating it is the maintainer's step, and until then no outside contribution is merged.

## Agreement versions

Version 1.0 was published with a notice that it awaited a legal review, and it was never signed: nobody but the maintainer and the repository's automation had contributed while it was published. It was withdrawn and replaced by version 2.0, which applies the adversarial review. A new version gets a new number, a new digest and new statements, earlier records keep the version they name, and `AGREEMENT_VERSIONS` in `scripts/cla.ts` says which versions accept new submissions.

## Accepted residual risks

The adversarial review found two limits that the agreement cannot remove, and the maintainer accepted them as they are:

- **Statutory termination and nonwaivable rights.** Calling the licenses irrevocable cannot exclude termination rights such as those of 17 USC section 203 in the United States, which let qualifying authors or their heirs end a grant decades later, or other rights that an author's own law makes nonwaivable. The agreement says so, and commercial diligence material must keep that qualification rather than promise permanent immunity from author claims.
- **No contributor indemnity.** The agreement holds no indemnity from contributors, as is usual for an individual agreement. A representation may be of little practical value against a contributor who cannot be reached or cannot pay, and the agreement gives no ownership, no trademark license and no protection against unrelated patents.
