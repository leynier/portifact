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
- The content Worker ignores every cookie that is not on its allowlist and clears oversized injected cookies.
- Read sessions carry signed claims that expire in 60 seconds or less. After that, the Worker rechecks D1. Revocation must take effect within 60 seconds.

### Access control

- Every request to `portifact.dev` follows this order: rate limit, resolve artifact, check state and dates, authenticate, authorize the version, check traffic quota, resolve the path, and only then read bytes from cache or R2.
- Every file is authorized, including CSS, JS, images, source maps and downloads.
- Cached bytes are looked up only after authorization and are keyed by artifact, version and path. No identity or access decision is cached in a shared cache.
- The acting user always comes from the session or token, never from input. An opaque ID never replaces an authorization check.
- Token scopes allow a class of action; ownership or permission on the specific artifact is always checked as well.
- R2 has no public bucket, no `r2.dev` and no custom public domain. Presigned upload URLs are bound to one object key, size, checksum and a short expiry.

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
- Never log tokens, cookies, OTP codes, presigned URLs, private emails beyond what access logs require, or full comment bodies.

## Review checklist

Before finishing a change that touches the areas above, confirm:

1. Which origin serves this, and does it hold credentials it should not?
2. Who is the actor, and where does that identity come from?
3. Is every path authorized before bytes or data are returned?
4. Can a hostile artifact on a sibling subdomain trigger, read or forge this?
5. Is there a test that tries to break it?
