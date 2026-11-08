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
- The landing footer and the footers of `/login`, `/device`, `/consent` and `/report` link all three pages; the landing footer also links the report form and the abuse address.
- Write them in plain language and describe only what the product does today; mark planned features as planned (access logs today). When a feature ships or a rule changes (quotas, retention, cookies, processors), update the affected page in the same change.
- The report form (`app.portifact.com/report`, linked from the landing footer, from `/__portifact/report` on every artifact, from the "Report this artifact" footer of rendered Markdown and TXT documents and from the review viewer), suspension and its notice, and the dashboard's data export and account deletion are live and described in the Terms ("Reports and enforcement", ending the account), the Acceptable Use Policy ("Reporting abuse", enforcement) and the Privacy Policy (rights, retention of deleted accounts and abuse reports). Keep them in sync with [operations.md](operations.md) and the account deletion rules in [security.md](security.md).

Contact addresses used by the pages: `abuse@portifact.com`, `privacy@portifact.com` and `legal@portifact.com`. Cloudflare Email Routing on `portifact.com` forwards all three to the operator's inbox (set up 2026-11-08); a new address needs its own routing rule.

## Acceptance at sign-in

No account is created and no session is issued for an account that has not accepted the current `TERMS_VERSION` (`packages/contracts/src/terms-version.ts`), whatever the method: Google, GitHub or email code.

1. The login page has one required checkbox: "I am 18 or older and I agree to the Terms of Service and the Acceptable Use Policy. I have read the Privacy Policy". Before any method it posts `{ version, acceptTerms: true, confirmAdult: true }` (`TermsAcceptanceInput`) to `POST /api/auth/accept-terms`, a Portifact endpoint in the auth allowlist with the exact-Origin check and a per-IP limit.
2. Without a session, the Worker answers with `__Host-pf_terms` (`Secure; HttpOnly; SameSite=Lax; Path=/`, 30 minutes): the version and the acceptance time, HMAC-signed with a key derived from `BETTER_AUTH_SECRET`. It survives the provider redirects because the callback is a top-level navigation.
3. Better Auth database hooks (`apps/app/src/auth/terms.ts`) enforce it. `user.create.before` refuses to create an account without a valid, current, unexpired cookie and stores `terms_version` and `terms_accepted_at` on the new user. `session.create.before` refuses a session for an account whose stored version is not current unless the cookie is present, and then records it. Refusals are `APIError` `FORBIDDEN` with code `terms_not_accepted`: the email-code sign-in answers 403, and provider callbacks redirect to `/login?error=terms_not_accepted`. `session.create.after` clears the cookie.
4. With a session, the endpoint records the acceptance on that account directly, keeping the time of an earlier acceptance of the same version.
5. Sessions that already exist are checked too: the dashboard routes, the `/api/v1` session lookup and `/read/<id>` treat a session of an account without the current version as no session, so the visitor lands on `/login`, which shows "Review the terms to continue" (accept or sign out) instead of forwarding to `next`.

New accounts also need a solved human check (Cloudflare Turnstile, `__Host-pf_human`), enforced next to the acceptance in the same `user.create.before` hook; see "Human check" in [security.md](security.md). The Privacy Policy lists it under what is collected, the cookie table and Cloudflare's processing; keep them in sync if the check changes.

`terms_version` and `terms_accepted_at` are Better Auth `additionalFields` with `input: false`, so no request body can set them; `get-session` returns them to the login page.

Bearer tokens issued to the CLI and MCP clients before an account accepted are not revoked; the account is asked at its next browser sign-in or dashboard visit.

## Changing the texts

1. Edit the pages. A change to wording that does not alter anyone's rights can keep the version.
2. For a material change, set `TERMS_VERSION` to the new effective date and update the version and date on all three pages (the test fails until they match). Every account is then asked to accept again at its next sign-in or dashboard visit.
3. Announce material changes in advance, as the pages promise.
