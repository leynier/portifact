# Legal pages and terms acceptance

Portifact publishes three legal documents on `portifact.com` and records, for every account, which version of them it accepted. A lawyer reviewed the texts on 2026-11-08, as plan section 17 requires before registration opens; have any material change reviewed again before it ships.

## Pages

| Path              | Source                         | Covers                                                                                                                                    |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/terms`          | `apps/web/terms.html`          | Operator, 18+ eligibility, accounts, quotas, content license, lifecycle, enforcement, disclaimers, liability, Florida law, changes        |
| `/privacy`        | `apps/web/privacy.html`        | Data collected (including the Turnstile human check), uses, cookies, processors (Cloudflare, Google, GitHub), retention, rights, children |
| `/acceptable-use` | `apps/web/acceptable-use.html` | Prohibited content and behavior, coding agents, abuse reports, enforcement                                                                |

- They are static Vite entries like the landing (`apps/web/vite.config.ts`), load only the shared stylesheet and no script, and use design-system token utilities only. `apps/app/src/site.ts` serves them on `portifact.com` with the strict `PAGE_CSP`, `no-cache`, `nosniff` and `X-Frame-Options: DENY`; the app host answers 404 for them.
- Each page shows the version and the effective date. `apps/web/src/legal.test.ts` checks that both match `TERMS_VERSION`, so the pages and the code cannot drift.
- The pages were written once from a generator that is not kept; edit the HTML directly and keep the structure (one `h1`, a table of contents whose links match the `section` ids, captioned tables, the legal footer with `aria-current`).
- The landing footer and the footers of `/login`, `/device`, `/consent` and `/report` link all three pages; the landing footer also links the report form and the abuse address. The sign-in notice links them too (see "Acceptance at sign-in").
- Write them in plain language and describe only what the product does today; mark planned features as planned. When a feature ships or a rule changes (quotas, retention, cookies, processors), update the affected page in the same change.
- The report form (`app.portifact.com/report`, linked from the landing footer, from `/__portifact/report` on every artifact, from the "Report this artifact" footer of rendered Markdown and TXT documents and from the review viewer), suspension and its notice, and the dashboard's data export and account deletion are live and described in the Terms ("Reports and enforcement", ending the account), the Acceptable Use Policy ("Reporting abuse", enforcement) and the Privacy Policy (rights, retention of deleted accounts and abuse reports). Keep them in sync with [operations.md](operations.md) and the account deletion rules in [security.md](security.md).

Contact addresses used by the pages: `abuse@portifact.com`, `privacy@portifact.com` and `legal@portifact.com`. Cloudflare Email Routing on `portifact.com` forwards all three to the operator's inbox (set up 2026-11-08); a new address needs its own routing rule.

## Acceptance at sign-in

No account is created and no session is issued for an account that has not accepted the current `TERMS_VERSION` (`packages/contracts/src/terms-version.ts`), whatever the method: Google, GitHub or email code.

Consent is collected with a sign-in-wrap: there is no checkbox, and choosing a sign-in method is the acceptance. The conditions that make it valid are part of the product and are tested (`apps/web/src/auth/login.test.ts`, `e2e/tests/sign-in.spec.ts`):

- The notice is conspicuous and shown before any action: a bordered block in full-contrast text the size of the buttons' labels, right above the methods, never collapsed or behind a link. It reads "By continuing with Google, GitHub or an email code, you confirm that you are 18 or older, you agree to the Terms of Service and the Acceptable Use Policy, and you have read the Privacy Policy", with each document linked (opening in a new tab).
- It sits next to every sign-in button: the Google, GitHub, "Email me a code" and "Sign in" (code step) buttons follow it on the same card, and each names it in `aria-describedby`, so a screen reader reads the notice with the button. It stays on screen in the code step.
- The action records the acceptance: every method posts the acceptance before it starts, and the Worker records the accepted version and time per account, exactly as below.
- The review screen for accounts on an older version uses the same pattern: "By selecting Agree and continue, you confirm..." above the button that records it.

Sign-in-wrap is the maintainer's choice of 2026-11-08 instead of the earlier required checkbox; the lawyer reviewed the texts with the checkbox, so have them confirm sign-in-wrap is enough before relying on it. The Terms say "You accept these terms when you continue with Google, GitHub or an email code at sign-in, below the notice that says so"; that sentence changed with the mechanism without a new `TERMS_VERSION`, because what users accept did not change.

1. Before any method, the login page posts `{ version, acceptTerms: true, confirmAdult: true }` (`TermsAcceptanceInput`) to `POST /api/auth/accept-terms`, a Portifact endpoint in the auth allowlist with the exact-Origin check and a per-IP limit. The body states what the notice says; the page sends it only when the user chose a method.
2. Without a session, the Worker answers with `__Host-pf_terms` (`Secure; HttpOnly; SameSite=Lax; Path=/`, 30 minutes): the version and the acceptance time, HMAC-signed with a key derived from `BETTER_AUTH_SECRET`. It survives the provider redirects because the callback is a top-level navigation.
3. Better Auth database hooks (`apps/app/src/auth/terms.ts`) enforce it. `user.create.before` refuses to create an account without a valid, current, unexpired cookie and stores `terms_version` and `terms_accepted_at` on the new user. `session.create.before` refuses a session for an account whose stored version is not current unless the cookie is present, and then records it. Refusals are `APIError` `FORBIDDEN` with code `terms_not_accepted`: the email-code sign-in answers 403, and provider callbacks redirect to `/login?error=terms_not_accepted`. `session.create.after` clears the cookie.
4. With a session, the endpoint records the acceptance on that account directly, keeping the time of an earlier acceptance of the same version.
5. Sessions that already exist are checked too: the dashboard routes, the `/api/v1` session lookup and `/read/<id>` treat a session of an account without the current version as no session, so the visitor lands on `/login`, which shows "Review the terms to continue" (the notice with "Agree and continue", or sign out) instead of forwarding to `next`.

The Privacy Policy also describes the email suppression list (undeliverable address records with their retention) and the daily email counts; keep them in sync with `SUPPRESSION_TTL_MS` (`packages/domain/src/email.ts`) and "Identity" in [security.md](security.md). They were added on 2026-11-08 without a new `TERMS_VERSION`: they describe processing that protects delivery for everyone and changes no one's rights.

The Privacy Policy says that owners get an expiry notice a few days before their artifacts expire, at most one a day, unless they turn it off in Settings, and that undeliverable addresses get none; keep it in sync with "Expiry notices" in [operations.md](operations.md). The policy announced these notices as planned since its first version; they went live without a new `TERMS_VERSION`, because they use the address already kept for sign-in, only for the service, with an opt-out, and change no one's rights.

The Privacy Policy and the Terms say who sees a comment: its artifact's creator always, and the other people with access only as the creator's comment visibility allows (by default, only the threads they or the creator started). This narrowed what other readers see when comment visibility shipped, on the version of 2026-11-08 without a new `TERMS_VERSION`, because it only reduces who reads a comment and changes no one's rights; keep it in sync with "Comment visibility" in [security.md](security.md).

The Privacy Policy describes the access log (what is recorded, that only the artifact's creator sees it, 30 days, erasure with the artifact or the visitor's account); keep it in sync with "Access logs" in [security.md](security.md) and `ACCESS_LOG` in `packages/contracts`. Access logs were listed as planned, with the same 30 days, since the policy's first version; they went live on the version of 2026-11-08 without a new `TERMS_VERSION` pending the maintainer's decision, recorded in the pull request that shipped them. Since the viewer with the Portifact bar, only `restricted` artifacts record openings: visits of public and `authenticated` artifacts are never recorded, even with a session, because any site can send a signed-in visitor to them; the policy says so, which narrows what is collected and needs no new acceptance.

New accounts also need a solved human check (Cloudflare Turnstile, `__Host-pf_human`), enforced next to the acceptance in the same `user.create.before` hook; see "Human check" in [security.md](security.md). The Privacy Policy lists it under what is collected, the cookie table and Cloudflare's processing; keep them in sync if the check changes.

`terms_version` and `terms_accepted_at` are Better Auth `additionalFields` with `input: false`, so no request body can set them; `get-session` returns them to the login page.

Bearer tokens issued to the CLI and MCP clients before an account accepted are not revoked; the account is asked at its next browser sign-in or dashboard visit.

## Changing the texts

1. Edit the pages. A change to wording that does not alter anyone's rights can keep the version.
2. For a material change, set `TERMS_VERSION` to the new effective date and update the version and date on all three pages (the test fails until they match). Every account is then asked to accept again at its next sign-in or dashboard visit.
3. Announce material changes in advance, as the pages promise.
