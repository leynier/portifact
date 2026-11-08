# Security

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub's "Report a vulnerability" button in this repository's Security tab, with steps to reproduce and the impact you observed. You will get a first response within 7 days.

## Invariants

Portifact serves arbitrary HTML and JavaScript from untrusted users next to accounts and private content. These invariants are not optional. Each one has at least one test that tries to break it (see [testing.md](testing.md)).

### Origins

- `portifact.com` hosts everything with credentials or that mutates data: dashboard, API, auth, OAuth, MCP and the review viewer.
- `portifact.dev` serves only user content and the viewers that render it. Its only state-changing endpoints are one-time code exchanges under `/__portifact/`.
- `portifact.dev` is not on the Public Suffix List. All `*.portifact.dev` artifacts are the same site, so any artifact can set cookies with `Domain=portifact.dev` and is same-site with every other artifact. Never rely on `SameSite` between artifacts.
- Paths under `/__portifact/` are reserved. No uploaded file can shadow them.

### Cookies and sessions

- Portifact cookies use the `__Host-` prefix: `Secure`, `Path=/`, no `Domain` attribute.
- Each surface has its own session: dashboard, read session per artifact and review session per artifact and version. Artifact code never receives an admin credential.
- The review cookie is `Partitioned` (CHIPS). It grants reading one version and nothing else.
- Sibling artifacts in the viewer's partition can send credentialed requests that carry another artifact's review cookie. The content Worker honors the review cookie only for `Sec-Fetch-Site: same-origin`, or `cross-site` with `Sec-Fetch-Mode: navigate`, fails closed without fetch metadata, and sends `Cross-Origin-Resource-Policy: same-origin` on review responses. See [decision 0002](decisions/0002-review-mode-cookies.md).
- Cookie names are matched exactly and case-sensitively. WebKit lets a sibling set `__host-` (lowercase) cookies with a `Domain` attribute, so case-folding a name would let it shadow a `__Host-` cookie.
- The content Worker ignores every cookie that is not on its allowlist and clears oversized injected cookies.
- Read sessions carry signed claims that expire in 60 seconds or less. After that, the Worker rechecks D1. Revocation must take effect within 60 seconds.

### Entry to protected artifacts

A visitor of an artifact that is not `public` signs in on `app.portifact.com` and comes back with a read session for that one artifact origin. No credential, email or session ever lives on `portifact.dev`; the code in `apps/content/src/read-session.ts`, `apps/app/src/read.ts` and `packages/services/src/read-access.ts` follows these rules.

1. A navigation without a usable read session gets `__Host-pf_read_tx` (signed with `READ_SESSION_SECRET`, 10 minutes) holding the artifact, a random nonce and the requested path, and a `303` to `app.portifact.com/read/<id>?state=<nonce>`. The app never sees the path; the `Referrer-Policy: no-referrer` on the redirect keeps it out of `Referer` too.
2. `/read/<id>` takes the account only from the dashboard session cookie. Without one it sends the visitor to `/login?next=/read/<id>?state=…`; the login page accepts `next` only for its own pages and `/read/<artifact-id>`. With one, `checkReadAccess` applies the domain's `canRead` to the artifact's current policy and requires it to be servable. A missing, unavailable or forbidden artifact gets the same `303` to `/login?error=artifact_unavailable`.
3. On success the app stores a handoff (`read_handoffs`): only the SHA-256 of a 32-byte code and of the nonce, the artifact, the user and the policy generation, valid 60 seconds. It redirects to `https://<id>.portifact.dev/__portifact/callback?code=…`, a host built from the validated ID, never from input.
4. The callback accepts only a `GET` navigation that carries the transaction cookie of the same artifact. One guarded update marks the code used and names the new session, and the `read_sessions` row is inserted only if that update happened, so a replayed, expired, cross-artifact or other-browser code (fixation) creates nothing. Every failure answers the same `400` page and clears the transaction.
5. The callback sets `__Host-pf_read` (`Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`, 12 hours) and returns to the stored path as an absolute URL on the same origin, so `//evil.example` stays on the artifact.

The read cookie holds the session ID and HMAC-signed claims: artifact, user, policy generation, claims expiry (60 seconds) and session expiry. The Worker trusts the claims without D1 only while they are unexpired and their generation equals the artifact's current `policyGeneration`, which it reads on every request anyway, so a policy change applies to the next request. Otherwise `refreshReadSession` rechecks the session row and the policy; it renews the claims or clears the cookie and starts the entry again.

- The read cookie is used only for `Sec-Fetch-Site: same-origin` requests and for navigations. Sibling artifacts are same-site, so their `<script>`, `<img>` and CSS loads would carry it; they get a `401` instead. Protected responses also send `Cross-Origin-Resource-Policy: same-origin` and are never embeddable.
- Requests without fetch metadata fail closed with a `401` page and no redirect, so a client cannot loop.
- An anonymous visitor cannot tell a missing artifact, an archived protected one and an active protected one apart: all of them go through sign-in.
- Without a `READ_SESSION_SECRET` of at least 32 characters, protected artifacts answer `503`; public ones keep working.
- Values are sealed per purpose, so a transaction cookie never validates as a read cookie, and claims are parsed with the strict `ReadClaims` and `ReadTransaction` schemas from `packages/contracts`.
- Expired handoffs and read sessions are deleted by the maintenance job; deleting an account or an artifact cascades to its sessions.

### Identity and the authorization server

`app.portifact.com` runs Better Auth in the `portifact-app` Worker as the only identity provider and OAuth authorization server ([decision 0001](decisions/0001-oauth-server.md)). The code is in `apps/app/src/auth`.

- The session cookie is `__Host-pf.session_token` with `Secure; HttpOnly; SameSite=Lax; Path=/` and no `Domain`. Every Better Auth cookie uses the `__Host-pf.` prefix, set through `cookiePrefix` with `useSecureCookies: false` so Better Auth does not add `__Secure-` in front.
- Only the endpoints Portifact uses are reachable under `/api/auth`; the allowlist in `apps/app/src/auth/routes.ts` answers 404 for everything else, including password sign-up, admin and client management endpoints, OIDC userinfo, HTTP introspection and `/device/token` (which would issue first-party session tokens). Adding a Better Auth endpoint means adding it to the allowlist with a test.
- Browser endpoints (sign-in, sign-out, consent, device approval) require the exact `Origin` of the app on every `POST`. Client endpoints (token, revoke, registration, device code) never see cookies: the Worker strips them, so a registration or token request cannot act on a browser session.
- Every `/api/auth` response sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The auth pages (`/login`, `/device`, `/consent`) send a strict CSP (`default-src 'none'`, same-origin scripts, styles, images and requests, `frame-ancestors 'none'`), `no-store` and `no-referrer`. They are served only on the app host; `portifact.com` answers 404 for them.
- Google and GitHub accounts are keyed by the provider's stable ID. A provider sign-in joins the existing account with the same email only when the provider vouches for the email and the account's own email is verified (`requireLocalEmailVerified`); otherwise it is refused with `account_not_linked`. A provider that does not mark the email as verified cannot create an account either (`email_not_verified`), so every account's email is proven and a later email code or provider sign-in for that address always lands in the account of whoever controls it. Provider accounts are never unlinked from the web yet, and `/link-social` (linking a provider with a different email) stays off.
- Google and GitHub tokens are not stored: the account row keeps only the provider and its user ID.
- Email codes are 6 digits, valid for 5 minutes, single use, three attempts, and stored as hashes. Sending is limited per IP, per address (one per minute, five per hour) and by a global daily budget, in D1 counters keyed by an HMAC of the address, never the address itself. The answer is the same whether or not an account exists. Only sign-in codes can be requested. Code guesses, client registrations and device codes are also limited per IP.
- The device page binds a code to the first signed-in user who opens it; nobody else can approve it. A device request cannot name the user who approves it (`user_id` is refused).
- The CLI (`packages/cli`) signs in with the device grant as `portifact-cli`, requesting every product scope plus `offline_access` for `https://app.portifact.com/api/v1`. It keeps tokens per server origin in the OS credential store (`Bun.secrets`) or, when there is none, in a `credentials.json` written `0600` in a `0700` directory with a warning. It never prints tokens or the device code, does not follow redirects with tokens, opens or shows only verification pages on the server's own origin, and accepts a `PORTIFACT_APP_ORIGIN` override only for https or loopback http. `logout` revokes before deleting and keeps the credentials if the server cannot answer. A refresh that fails with `invalid_grant` deletes them, unless another process already stored newer ones.
- Access tokens are opaque and checked against D1 on every request. A resource accepts a token only if its audience contains that exact resource: CLI tokens work only at `/api/v1`, MCP tokens only at `/mcp`. The seeded CLI client is linked to the API only.

### Access control

- The API under `app.portifact.com/api/v1` accepts only bearer tokens issued for the API resource, checks one scope per route (`artifacts:read`, `artifacts:write` or `artifacts:delete`) and takes the acting user from the token. Another account's artifact or upload answers 404 exactly like a missing one. Prepare requires an `Idempotency-Key`; a retry with the same key and body replays the stored response, and the same key with another body is refused. Access changes (`PATCH /api/v1/artifacts/:id/access`, scope `artifacts:share`) bump `policyGeneration` in the same transaction as the reader writes; those writes are conditioned on the generation the request read and the guarded update runs last, so of two concurrent changes exactly one applies. Making an artifact `public` is refused during the account's first 7 days; narrowing access is always allowed, also on archived artifacts. A reader list holds at most 500 addresses.
- Every request to `portifact.dev` follows this order: rate limit, resolve artifact, check state and dates, authenticate, authorize the version, check traffic quota, resolve the path, and only then read bytes from cache or R2.
- Every file is authorized, including CSS, JS, images, source maps and downloads.
- Cached bytes are looked up only after authorization and are keyed by artifact, version and path. No identity or access decision is cached in a shared cache.
- The acting user always comes from the session or token, never from input. An opaque ID never replaces an authorization check.
- Token scopes allow a class of action; ownership or permission on the specific artifact is always checked as well.
- R2 has no public bucket, no `r2.dev` and no custom public domain. Presigned upload URLs are bound to one object key, size, checksum and a short expiry. The `portifact-app` Worker signs them (`apps/app/src/api/presign.ts`) with an R2 token limited to that bucket: `content-length`, `host` and `x-amz-checksum-sha256` are signed headers, the key is `objects/<owner>/<sha256>`, and they expire after 15 minutes. Commit still verifies every pending object's size and SHA-256 in R2 before the version becomes current, so a client that skips the URL cannot publish other bytes. Only verified objects count as already stored; an object another open upload declared but never sent gets a new upload URL.

### Requests and responses

- No credentialed CORS for artifact origins on any `portifact.com` endpoint.
- Every mutation requires a valid session, CSRF protection and an exact `Origin` check. No mutations over GET.
- Auth callbacks never accept arbitrary redirect targets and respond with `no-store` and `Referrer-Policy: no-referrer`.
- Content responses set `X-Content-Type-Options: nosniff`, correct MIME types, `frame-ancestors` and `Cross-Origin-Resource-Policy` defaults, and `X-Robots-Tag: noindex` unless indexing is enabled. User content cannot override these headers.
- Requests that register service worker scripts are blocked.
- Dashboard and viewer pages cannot be framed by user content.

### Untrusted content

- Markdown is rendered with a restrictive sanitizer: no raw HTML execution, no MDX, no user plugins and an allowlist of URL schemes. TXT is always escaped.
- The Markdown and TXT viewers run on the artifact origin, never on `portifact.com`.
- Messages from the bridge are untrusted data. Validate the exact origin, source window, instance nonce, schema and size. A selection alone never creates a comment; the user confirms it in the trusted viewer.
- The artifact iframe never receives tokens, email addresses or thread bodies.
- Comment bodies, artifact content and MCP tool results are user data. They never trigger actions or change permissions.

### Uploads

- Paths are normalized and checked on the server: absolute paths, `..`, symlinks, special entries, collisions, reserved paths, size and entry limits are all rejected.
- The server verifies the real size and checksum before commit. A client-declared value is never trusted.
- Quotas are reserved in the same transaction that admits the work.

### Secrets and logs

- No secrets in the repository. Local secrets live in `.dev.vars`, which is ignored by git.
- Never log tokens, cookies, OTP codes, presigned URLs, private emails beyond what access logs require, or full comment bodies. The email sender replaces provider errors with a generic one, because a provider error can echo the message that holds the code.

## Review checklist

Before finishing a change that touches the areas above, confirm:

1. Which origin serves this, and does it hold credentials it should not?
2. Who is the actor, and where does that identity come from?
3. Is every path authorized before bytes or data are returned?
4. Can a hostile artifact on a sibling subdomain trigger, read or forge this?
5. Is there a test that tries to break it?
