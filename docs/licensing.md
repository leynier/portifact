# Licensing

How Portifact is licensed, what the license asks of people who host it, the commercial license and why contributions need a contributor license agreement. This page explains the project's position; it is not legal advice, and the agreement and the commercial offer are drafts pending legal review.

## One repository under the AGPL

All of Portifact's code is open source under the GNU Affero General Public License v3.0 only (`license`), in this one repository. There is no private premium code. What is sold is the hosted service at `portifact.com`, and a commercial license for those who want to host Portifact without the AGPL's obligations.

Self-hosted copies are not feature-limited and there are no license keys. Paid plans for the hosted service are being built; their features go in this repository like everything else and are turned on per account by its plan, never by a license check. Whoever hosts Portifact assigns plans to accounts with the operator tool (`bun run --cwd apps/jobs operator`, see [operations.md](operations.md)), the same way the hosted service does, and nothing in the code checks who is hosting it.

## What the AGPL asks of someone who hosts a modified copy

You may run, study, change and share Portifact under the AGPL. These obligations matter most for hosting:

- **Source for network users (section 13).** If you modify Portifact and let people use it over a network, you must offer those users the complete corresponding source of the version you run, under the AGPL, for example with a prominent link to a public repository. Section 13 applies to modified copies; an unmodified release can point to this repository.
- **Same license for the whole work.** Your changes, and code that forms one program with Portifact, are licensed under the AGPL when you distribute them or offer them to network users. You cannot add further restrictions.
- **Notices.** Keep the copyright and license notices, including `third-party-notices.md` for the open source packages Portifact ships, and mark your changes as yours with a date.
- **No warranty.** Portifact comes without warranty, as sections 15 and 16 of the license say.

Separate programs that only talk to Portifact through its API, CLI or MCP server are usually not part of the same work. Artifacts that people publish are their own content, not Portifact's code, and are not covered by its license.

## Commercial license

The maintainer offers Portifact under a commercial license to anyone who wants to host it, modify it or embed it without the AGPL's obligations, for example without publishing their changes. It covers the same code as this repository. Ask at hello@portifact.com.

The licensor is currently the maintainer, Leynier Gutiérrez González, as a natural person; a company is planned and would take over the project and this offer. The commercial license's terms are not published yet and are drafted per request until they are.

A commercial license cannot relicense other people's code. Two things keep it possible:

- **Contributions are licensed to the maintainer** under the contributor license agreement below.
- **Shipped dependencies are permissive.** `bun run check` fails when a package that the Workers, the web pages or the CLI ship has a license outside `COMMERCIAL_COMPATIBLE` in `scripts/notices.ts`, which lists permissive licenses only. GPL, AGPL and other strong copyleft licenses never pass. Weak copyleft (LGPL, MPL, EPL) is accepted only as a reviewed exception for an exact package version in `COMMERCIAL_EXCEPTIONS`, with its reason; see "Third-party notices" in [releasing.md](releasing.md). A package with a choice of licenses is used under its permissive one (DOMPurify under Apache-2.0).

The CLI binary also embeds the Bun runtime, which statically links LGPL libraries (JavaScriptCore and WebKit, tinycc); a commercial license of the CLI has to keep the relinking terms that `third-party-notices.md` describes.

## Why contributions need a contributor license agreement

Without an agreement, each contributor keeps the copyright of their changes and licenses them to everyone only under the AGPL. Then the maintainer could not offer the commercial license for code that includes them, and the whole project would depend on every past contributor for any license change.

The [Portifact Individual Contributor License Agreement](../cla.md), adapted from the Apache Software Foundation's individual agreement, solves that without taking anything away from contributors: they keep their copyright and every right to use their own work, and grant the maintainer and their successors and assigns a broad copyright and patent license, including the right to sublicense their contributions under other terms. The contributions stay available to everyone under the AGPL in this repository.

Contributors sign once, by adding a line to `cla-signers.md` in their first pull request ([contributing.md](../contributing.md)). The `cla` workflow checks it on every pull request into `develop`; how it works is in "Contributor license agreement" in [releasing.md](releasing.md).
