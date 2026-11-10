# 0010 Workspace and email domain access modes

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan T2 (`workspaces` in `PLANS`, Team and above)

## Question

An artifact's access mode is `public`, `authenticated` (any signed-in account) or `restricted` (the owner side plus a list of verified addresses). A team wants to share an artifact with everyone in the workspace, or with everyone at the company's email domain, without listing each person. Which two modes are added, who may read under each, how does a workspace prove an email domain is its own, and what keeps the rest of [security.md](../security.md) true?

## Decision in short

- Two new values of `access_mode`: `workspace` (every member of the owning workspace, any role) and `domain` (every member, plus any signed-in account whose verified email is at one of the workspace's verified email domains).
- Both exist only on artifacts owned by a workspace, set by an admin or editor (role action `access`), and setting either needs `workspaces` in the owner's plan. A personal artifact gets `invalid_input`, an owner without the feature `plan_required`.
- A workspace verifies an email domain with a TXT record holding a fresh token of that claim, read over the same DNS over HTTPS client as custom domains, re-checked daily and removed after three missed checks in a row. A domain is verified by at most one workspace at a time. Only admins manage domains (role action `members`), only through the dashboard session.
- Matching is exact on the A-label of the account's one verified email. No subdomain wildcard.
- No D1 read is added to delivery: membership and domains are read where `canRead` already runs (the read handoff, the 60-second claim renewal, the viewer lookup, review codes, downloads and annotations), so a removed member or domain stops reading within the existing 60 seconds.
- Openings in these modes are not recorded in the access log; share-link openings of them are, for the link.

## Threat model

The attacker may be: a former employee or a removed member; someone who registers or buys a domain a workspace used to verify; a second workspace that wants a domain another one holds; a person who controls a consumer mailbox or an address under a shared suffix; anyone who can create a Portifact account with a chosen email at a provider; a hostile site that navigates a signed-in visitor to an artifact; an outsider probing a workspace's artifacts, domains or members through answers; an editor trying to widen access further than an admin intended. Out of scope: an attacker who controls the company's DNS or mail server (they control the domain, which is what verification proves), and an admin who adds a domain they do not mean to trust.

## Design

### Who reads

`canRead` (`packages/domain/src/access.ts`) receives the policy, the viewer (from the session: user ID and verified emails) and the actor (the viewer's role on the owner, from `actorOn`). The policy now also carries `audience`: whether the owner's plan includes `workspaces`, and the verified domains of the owner that match the viewer's email (at most one, read only when needed).

| Mode                         | Anonymous         | Admin or editor | Member | Verified email at a verified domain | Listed reader (verified address) | Other signed-in account |
| ---------------------------- | ----------------- | --------------- | ------ | ----------------------------------- | -------------------------------- | ----------------------- |
| `public`                     | read              | read            | read   | read                                | read                             | read                    |
| `authenticated`              | `unauthenticated` | read            | read   | read                                | read                             | read                    |
| `restricted`                 | `unauthenticated` | read            | no     | no                                  | read                             | no                      |
| `workspace`                  | `unauthenticated` | read            | read   | no                                  | no                               | no                      |
| `domain` with the feature    | `unauthenticated` | read            | read   | read                                | no                               | no                      |
| `domain` without the feature | `unauthenticated` | read            | read   | no                                  | no                               | no                      |

- The reader list grants reading only in `restricted`, as in `authenticated` and `public` today: in the other modes it keeps only the comment exceptions. Switching from `restricted` to `workspace` therefore drops external readers, and the dashboard says so before saving.
- `workspace` does not depend on the plan: members read a workspace's artifacts in the same way whatever the plan, so a lapsed plan changes nothing there. `domain` falls back to `workspace` while the plan lacks the feature: never wider. The access view, the CLI and MCP say so (`audience.featureAvailable: false`).
- An artifact in either mode whose owner is not a workspace (it cannot happen: setting is refused and a transfer resets the mode) reads like `restricted` without readers: only the owner side.

### Setting a mode

`updateAccess` (`packages/services/src/access.ts`) refuses, after authorization, in this order: a personal artifact (`invalid_input`, "Only workspace artifacts can be shared with a workspace or an email domain."), an owner without the feature (`plan_required` through `requireFeature`), and `domain` while the workspace has no verified domain (`invalid_input`). Narrowing to another mode never needs the plan. Changing to either mode bumps `policyGeneration` like every mode change, so every read and review session issued under the old policy renews against the new one at once.

Editors may set both modes, like `public` and `authenticated`, which reach further. Only admins decide which domains count, so an editor can widen an artifact only to the audience the admins defined. The MCP tool `set_access` and the skill tell agents to ask the user before choosing `workspace` or `domain`, as for `authenticated` and `public`.

### Verified email domains

`workspace_domains` (global, migration 0038): ID (`wd_` and 32 hex characters), workspace (cascading from `workspaces`), domain (the A-label, lowercase), the claim's token, state (`pending` or `verified`), created, verified, last checked, consecutive failed checks and when the claim expires. One row per workspace and domain; a partial unique index on the domain where the state is `verified` keeps at most one workspace verifying it. At most 10 domains per workspace, pending or verified (`WORKSPACE_DOMAINS.perWorkspace`), enforced by the insert's own condition.

1. **Normalization** (`normalizeEmailDomain` in `packages/domain/src/email-domains.ts`): trimmed, lowercased, a trailing dot refused, converted to its A-label by the WHATWG URL host parser (UTS 46, so `BÜCHER.example` and `xn--bcher-kva.example` are the same domain), at most 253 characters, labels of 1 to 63 characters, at least two labels, no IP literal in any notation, no wildcard.
2. **The denylist** (`checkEmailDomainAllowed`): Portifact's own domains (`portifact.com`, `portifact.dev`, `portifact.test` and the deployment's app and content domains) and their subdomains; reserved and internal suffixes (`.local`, `.localhost`, `.internal`, `.test`, `.example`, `.invalid`, `.arpa`, `.onion`); a maintained list of the well-known consumer mail domains (`CONSUMER_MAIL_DOMAINS`: Gmail, Outlook and Hotmail, Yahoo, iCloud, Proton, GMX, Yandex, Mail.ru, QQ, 163 and others, with their country variants), matched exactly and as a parent; any domain that is itself a public suffix of the Public Suffix List, in its ICANN or private section (`co.uk`, `github.io`); and anything under a private-section suffix (`someone.github.io`, `x.vercel.app`), where a platform, not the address holder, runs the names. The Public Suffix List comes from `tldts` (MIT, already in the lockfile, now a shipped dependency of `packages/services` only, so the CLI and dashboard bundles do not carry it), injected into the domain rule as a function. **This is a denylist and will always be incomplete**: a consumer provider or shared-mail service missing from it can be verified by whoever controls its DNS, which for a provider is the provider itself. Its job is to catch an admin's mistake (typing `gmail.com`) and the obvious shared names, not to be the boundary: the boundary is the TXT proof, which only the domain's DNS operator can publish.
3. **The claim.** Adding stores a `pending` row with a fresh 128-bit random token (32 hex characters) and an expiry of 7 days, and shows the record: name `_portifact-email.<domain>`, value `portifact-email-verify=<token>`. The name differs from custom domains' `_portifact.<host>`, so one proof never stands in for the other. Adding answers the same whether or not another workspace holds the domain, so it cannot be used to learn which domains are verified on Portifact. Adding again after a removal makes a new row with a new token: an old record proves nothing about a new claim.
4. **The proof.** Verifying reads the TXT values of the record name through `TxtLookup` (`dohTxt`, the custom domains client, built by `emailDomainDepsFromEnv` without the Cloudflare credentials; tests and the e2e stack inject a fake, never the real resolver) and succeeds only when one value is exactly this claim's `portifact-email-verify=<token>`. A resolver failure answers `capacity_unavailable` and counts nothing. When another workspace holds the domain verified, its token is looked for in the same answer: still present, the proof is refused with `version_conflict` ("Another workspace still proves this domain in its DNS. Remove its record first."), which tells only someone who just proved DNS control what that DNS already shows; gone, the other workspace has lost control, and the same batch deletes its row (with a tombstone) before marking this one verified. The batch is conditioned on this claim still being `pending` with that token and unexpired, on the caller still being an admin (`stillAdmin`) and on the other workspace's row being the one read; the partial unique index refuses whatever a race slips past (answered `version_conflict`). Two concurrent proofs of one claim verify it once.
5. **Re-checks.** The jobs Worker's 15-minute maintenance scan (`recheckEmailDomains`) takes up to 50 verified domains last checked more than 24 hours ago, looks each record up and records the result with an update conditioned on the `checked_at` it read, so overlapping scans count a day once. A found record resets the count; a missing one adds one and sets `problem: txt_missing`; at the third miss in a row the row is deleted with a `workspace_domain` tombstone. A resolver failure is not a miss. The domain list shows the count and how many more misses remove the domain, and the Members page warns admins while a domain is failing. Pending claims past their expiry are deleted by the same scan.
6. **Removal.** An admin removes a domain at any time, with no plan check; the row is deleted with a `workspace_domain` tombstone in one batch, conditioned on `stillAdmin`.

### Matching an account

`checkReadAccess` and the annotation services' `roleOf` read the account's email and `emailVerified` from `users`, as the reader list does: the verified email is the one Portifact's own sign-in proved or a provider vouched for under the account-linking rule (security.md, "Identity"), never an address from request input. Its domain is the text after the last `@`, normalized like a workspace domain; an address whose domain does not normalize never matches. When the mode is `domain`, the viewer is not on the owner side or a member, and the plan includes the feature, one indexed read of the global database asks whether that exact domain is verified by the owner. Matching is exact: `eng.acme.example` does not match `acme.example`, because a wildcard would hand a workspace every address any part of the company (or a service it delegates a subdomain to) can mint. A workspace that wants a subdomain verifies it too.

### Revocation without new delivery reads

Delivery keeps its one artifact lookup. Read and review claims are trusted for at most 60 seconds while the policy generation is unchanged; renewing them runs `checkReadAccess`, which now reads the membership (already read by `actorOn`) and, in `domain` mode, the matching domain. So:

- a member removed or demoted (from a member to nothing) stops reading within 60 seconds;
- a domain removed, failed or taken over by another workspace stops granting within 60 seconds;
- an account whose email changes or becomes unverified stops matching within 60 seconds;
- a plan that loses `workspaces` stops domain readers within 60 seconds;
- a mode change bumps the generation and applies at the next request.

None of these bump `policyGeneration`: a domain or a membership belongs to the workspace, not to each artifact, and bumping every artifact's generation would cost a write per artifact for what the 60-second renewal already gives.

### What else follows

- **Viewer.** `ViewerInfo.accessMode` carries the new values. Anonymous visitors see only public artifacts as before; a member or domain reader is a `reader`.
- **Review mode.** Unchanged: review codes and renewals go through `checkReadAccess`.
- **Comment visibility.** Members and domain readers are participants like any admitted reader: their scope follows the artifact's `commentVisibility` (`own` by default), and the per-reader exceptions keep applying to whoever signs in with that verified address, in every mode, so an admin can still open all threads to one domain reader by listing their address with `all`.
- **Access log.** Openings in `workspace` and `domain` modes are not recorded (`isLoggedOpening` stays `restricted` only). The reason that keeps `authenticated` out holds here too: any site can send a signed-in visitor top-level to the artifact, where the read handoff or the viewer completes without a click, so recording would hand the workspace's admins the email of every member or company account a third party sent there, an audience the owner never listed person by person. Analytics' distinct visitors stay `null` for these modes. A share link's openings of them are recorded for the link, like `authenticated` (`isLoggedLinkOpening` covers every mode but `public`).
- **Share links.** Unchanged: a link grants reading in any mode and never touches the policy.
- **Custom domains.** Unchanged: when the content Worker serves custom hosts, it uses the same read sessions.
- **Transfers.** Any change of owner resets `workspace` and `domain` to `restricted` in the transfer's batch (the reader list stays), because both name the old owner's people; the transfer already bumps the generation. The result shows the new mode, and the confirmations say it beforehand: the CLI's help, the MCP tool's description and, for an artifact in either mode, the dashboard's move dialog.
- **Enumeration.** A non-member gets `not_found` for an artifact in either mode, exactly like a missing one. The access view, which shows the member count and the verified domains, is for admins and editors (`access`). The domain list and its writes answer admins; members get `forbidden` and anyone else `Workspace not found.`, like a missing workspace. Refusals at read time never say which rule failed.
- **Lifecycle.** Domains cascade from the workspace, so deleting it removes them; `applyTombstones` deletes rows of tombstoned workspaces and every row named by a `workspace_domain` tombstone (by row ID, so a later claim of the same domain survives), so a restore cannot bring back a domain that was removed or had stopped proving. The account export lists a workspace's domains (name, state, dates, never the token) only for workspaces where the account is an admin.

## Alternatives rejected

- **Wildcard subdomains.** Rejected for the reason above; a few explicit domains per workspace (cap 10) cover the cases met.
- **Proving a domain by an email to `postmaster@` or an admin address.** Shows control of one mailbox, not of the domain, and adds an email path with its own abuse controls. DNS is the authority every mail provider already uses.
- **Reusing custom domains' record name or token.** One proof would then count for two different grants.
- **Bumping every artifact's generation when a domain or member goes.** A write per artifact of the workspace, for no gain over the 60-second renewal.
- **Letting the reader list grant in `workspace` and `domain` too.** Mixes two audiences in one mode and makes "who can read this" harder to state; `restricted` with members added by email remains available.
- **Recording openings in these modes.** See "Access log" above.
- **Refusing a takeover while another workspace holds the domain.** A domain that was sold or lost would stay with the old workspace for up to three days, and the new holder could do nothing; the takeover requires the old token to be gone from the same DNS answer.

## Open risks

- **The denylist is incomplete by nature**, and the Public Suffix List in `tldts` is a snapshot that moves only with dependency updates. A missing consumer provider can be verified only by its own DNS operator, so the residual risk is a provider verifying its own domain, which grants its own users.
- **Provider-vouched emails.** A Google or GitHub account can keep a verified work address after its holder left the company (a consumer Google account created on the work address, or a GitHub email verified years ago). Portifact trusts the provider's `email_verified` as it does for the reader list, so such a person keeps matching the domain until the company deletes the address at the provider or removes the domain. Requiring a recent email code for `domain` mode is a possible follow-up; until then the dashboard's mode description says "anyone with a verified address at".
- **A lost domain keeps granting for up to three days** (three daily checks) plus 60 seconds, unless another workspace takes it over or an admin removes it.
- **DNS answers through one resolver.** A spoofed or stale DoH answer could verify or keep a domain; the resolver is Cloudflare's over HTTPS, as for custom domains.
- **Privacy.** Admins see the verified domains; nothing new about visitors is recorded. The Privacy page will need to say that workspaces verify domains through public DNS records and that members and accounts at a workspace's verified domains can read artifacts shared with them ([legal.md](../legal.md)).
