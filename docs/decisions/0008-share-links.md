# 0008 Share links

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan P4 (`shareLinks` in `PLANS`, Pro and above)

## Question

A protected artifact can be read today only by signed-in people: anyone with an account (`authenticated`) or the verified addresses on the list (`restricted`). Paid owners want to hand one artifact to someone without an account: a link, optionally with a password and an expiry, that they can revoke. How does a visitor without an account reach the artifact origin without weakening any rule of [security.md](../security.md), and what does the link grant?

## What a link grants

Reading the current version of one artifact, and nothing else. A link visitor never reads or writes comments, never gets a review session or the viewer, never appears on the reader list, and is never identified: the access log records that a link was used in a 30-minute window, not who used it. A link changes nothing about the access policy: the mode, the readers and `policyGeneration` stay as they are. Making an artifact `public` remains the way to publish it openly.

## Threat model

The attacker may be: anyone who sees the link (a chat app, a mail scanner, a link preview bot, a person behind the visitor, a browser extension with history access); someone guessing tokens or passwords from many IPs; a hostile artifact on a sibling origin of `portifact.dev`; the artifact itself (its own scripts run on its origin); another site that navigates or frames the visitor; and a signed-in visitor trying to get more than their account gives. Out of scope: an attacker who controls the visitor's browser or device, and the owner leaking the link on purpose.

## Design

### The link and its token

- `share_links` (migration 0033): ID (`sl_` and 32 hex characters), artifact, label (1 to 80 characters, no control characters), the SHA-256 of the token, an optional expiry, the optional password hash with its salt and iteration count, who created it, created, revoked and last used (a UTC day). Rows cascade from the artifact.
- The token is 32 bytes from `crypto.getRandomValues` (256 bits), in unpadded base64url, the shape of `OpaqueToken`. Only its SHA-256 is stored; a fast hash is enough because the input has full entropy. It is returned once, in the create response, inside the link URL; no list, export, log or later response carries it. Creation therefore takes no idempotency key: a stored replay would keep the token in D1. A retried create makes a second link, which the owner revokes.
- At most 20 active links per artifact (`SHARE_LINKS.activePerArtifact`, a safety cap, not a plan value), enforced by the insert itself (`insert … select … where (select count(*) …) < 20`), so concurrent creates cannot pass it. Active means not revoked and not expired.
- Expiry is optional, at most 365 days ahead. Without one, a link lasts until it is revoked or the artifact is deleted.
- Links can be created in every access mode. On a `public` artifact a link adds nothing while the artifact stays public (the dashboard says so) and starts to matter if the owner narrows access later. Changing the mode never touches links: they are a separate, explicit grant shown in the same sharing settings, and narrowing access does not revoke them. The dashboard's link list sits next to the access mode so the owner sees both.

### Token in the fragment, not the path

The link is `https://app.portifact.com/s#<token>`.

| Concern                        | Token in the path (`/s/<token>`)                                                                        | Token in the fragment (`/s#<token>`)                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Server and platform logs       | In every request line: Cloudflare's request logs, Workers logs and analytics would hold it              | Never sent to any server; the request is `GET /s`                                                                                   |
| Link previews and URL scanners | They fetch the URL with the token; the page must make sure a fetch consumes nothing and reveals nothing | They fetch `/s` without a token and get the same generic page as everyone                                                           |
| `Referer`                      | Only the app's `no-referrer` stops it                                                                   | Browsers never send fragments in `Referer`, and `no-referrer` stays                                                                 |
| Redirects                      | A redirect could carry it in `Location`                                                                 | Browsers copy a fragment onto a redirect target that has none, so `/s` must never redirect, and it does not                         |
| History and the address bar    | Stays in both                                                                                           | The page removes it with `history.replaceState` before doing anything else, so the address bar and the session entry show `/s` only |
| Needs JavaScript               | No                                                                                                      | Yes; the entry page is a script page like the other auth pages                                                                      |

The fragment wins: the server side never sees the token in a URL, which removes the largest leak (logs), and previews cannot even learn that a token exists. The cost is that the browser's global history may already have recorded the full URL before the script ran (engines differ), that a reload after the fragment is removed asks the visitor to open the link again, and that clients without JavaScript cannot open links. Opening a link again in the same tab changes only the fragment, which loads nothing, so the page reloads itself on `hashchange` (found by the e2e suite).

### The entry and the handoff

1. `GET /s` on the app host serves the entry page (an auth page built by apps/web, `noindex`, `no-store`, `no-referrer`, the strict page policy plus the human check). It reads the fragment, removes it, checks its shape and posts `{ token }` to `POST /api/v1/share/open`.
2. `/api/v1/share/open` takes no credentials, like the report endpoint: exact app `Origin`, `Sec-Fetch-Site: same-origin`, a JSON body of at most 1 KiB, and the D1 counters (below). It never reads the dashboard session, so a signed-in visitor's account is not involved. `openShareLink` (services) hashes the token and finds the link with its artifact and the owner's plan in one read. It succeeds only for a live link (not revoked, not expired) of a servable artifact (active, unexpired, with a current version, not suspended) whose owner's plan includes `shareLinks`, with the right password when the link has one.
3. On success it stores a handoff in `share_handoffs`: the SHA-256 of a fresh 32-byte code, the link, the artifact, 60 seconds. It records the link's last-used day (one write per entry, never per delivery request) and answers `{ location: "https://<id>.portifact.dev/__portifact/link?code=…" }`, the host built from the stored artifact ID, never from input. The page navigates there with `location.replace`, so the entry page does not stay in history, and the target carries no fragment, so the browser has nothing to copy.
4. `/__portifact/link` (reserved, never shadowed, never redirected to the viewer) redeems the code only for a `GET` top-level navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) that is `cross-site`; a sibling artifact's navigation is `same-site` and a frame is not a document, so neither can redeem. One guarded update marks the code used for this artifact (the host's), while it is unexpired and the link is still live, and the `share_sessions` row is inserted only if that update happened. Every failure answers the same `400` page.
5. It sets `__Host-pf_link` (`Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`) with sealed claims `{ v, sid, aid, lid, exp, sexp }` under their own purpose (`pf_link`), so neither a read cookie nor a transaction validates as one, and redirects to `/` of the artifact origin. The session ends after 12 hours or at the link's expiry, whichever comes first.

The token never reaches the artifact origin: the handoff URL holds only the code, the app sends `Referrer-Policy: no-referrer` and the token is a fragment anyway.

### Delivery with a link session

The content Worker keeps its order: rate limit, resolve the artifact, state and dates, authenticate, authorize, traffic quota, path, bytes. Authentication tries, in this order: a review session, public delivery, a read session, then a link session; a link session never starts a sign-in. `authorizeLink` (`apps/content/src/share-session.ts`):

- uses the cookie only for `same-origin` requests and navigations, exactly like the read cookie, and only with exactly one value under the exact name;
- refuses when the artifact is missing or not servable, or the owner's plan no longer includes `shareLinks` (the plan comes with the artifact lookup, so this adds no read);
- trusts the claims for at most 60 seconds, then `refreshShareSession` rechecks the session row, the link (not revoked, not expired, same artifact) and renews them. Revocation, expiry, suspension, archiving and deletion therefore end the session within 60 seconds (state and plan at once);
- on failure clears the cookie and answers a page that says the link expired or was revoked, with a link back to `/` that goes through sign-in.

A link session is served the current version like a read session, charged to the owner's traffic like any request, with the protected headers (`Cross-Origin-Resource-Policy: same-origin`, `noindex`, `private`) plus `Referrer-Policy: no-referrer` and `frame-ancestors 'self'`: neither the app nor any other site frames a link visitor's page.

### Which session wins

A signed-in visitor with a usable read session is served through it, so a link never replaces an account's session. A read session that no longer passes (access removed) is cleared and the link is tried next; the visitor then sees exactly what the link grants, never more than an anonymous holder of the link. Comments, the viewer, review codes, downloads through the API, the annotation API and the access log all authorize the account on the app origin and know nothing of link sessions, so holding a link adds nothing there, and the account's own rights are unchanged.

### The viewer and the bar

A link session is never redirected to the viewer: the viewer's lookup authorizes accounts only, and a link visitor would land on a sign-in prompt. They get the artifact itself on its origin, without the bar, which is not a security control (security.md, "The viewer", item 13). The viewer's rules (`viewerCsp`, the top-level redirect, review mode) are unchanged: the redirect is skipped only for responses authorized by a link session.

### Passwords

- Optional, 8 to 200 characters. PBKDF2-HMAC-SHA-256 through WebCrypto with a 16-byte random salt per link and 100,000 iterations, the highest count workerd accepts (it refuses more), stored with the row so it can rise later. On a Worker it costs a few tens of milliseconds of CPU per attempt, well within the paid plan's limit, and the rate limits below keep attempts rare. 100,000 is below OWASP's 600,000 for this hash; the compensations are the human check, the per-link lockout and that the password protects a link whose 256-bit token must leak first.
- Verification derives the key and compares it in constant time. A request that carries a password always runs one derivation: against the link's salt, or a fixed dummy salt when the token is unknown, expired, revoked, or the link has no password. The database read is one indexed lookup either way.

### Answers that reveal nothing

| Request            | Live link, no password | Live link with password                              | Unknown, expired or revoked token, or an artifact or plan that no longer allows it |
| ------------------ | ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Without a password | Handoff                | `401 unauthenticated` ("This link needs a password") | `404 not_found`                                                                    |
| With a password    | Handoff                | Handoff, or `403 forbidden` for a wrong password     | `403 forbidden`, the same body                                                     |

Without a password, a visitor learns only whether the link they hold works and whether it needs a password, which a 256-bit token makes worthless to a guesser. With a password, a wrong password and a dead link answer the same body ("The password is wrong, or the link expired or was revoked"), so guessing passwords against a token reveals nothing about the token. The endpoint uses the existing error codes, so no client needs a new one.

### Rate limits and the human check

D1 counters, keyed by an HMAC-free SHA-256 prefix of the token (so unknown tokens are counted like real ones and the table holds no token) and by IP:

- every request: 60 per IP per 10 minutes;
- failed password attempts per token: after 3 in 15 minutes the next attempts need a solved human check (Turnstile, verified on the server, fail closed); after 10, the token is locked for the rest of the window (`429 rate_limited` with `Retry-After`, even with the right password);
- failed password attempts per IP: the human check after 5 in 15 minutes, a `429` after 20.

Failures are counted only when a password was wrong, with one counter write; the checks read the counters first without counting, so a correct password after two mistakes does not need the check.

### The access log

A page load served through a link session of an `authenticated` or `restricted` artifact is recorded like an account's opening, through the same per-isolate batch (no D1 write per request), as one row per artifact, link and 30-minute window in `access_events` (`user_id` holds the link ID, `link_id` marks it, `email` is empty). The owner's log shows the link's label and the window. No IP, user agent or other identity is stored. Openings of public artifacts are not recorded, as before.

### Plans

Creating a link needs `shareLinks` in the owner's plan (`requireOwnerFeature`, the artifact owner's plan, never the caller's). Listing and revoking never do: revoking reduces access and reading what exists is never behind a plan. When the plan loses the feature, nothing is deleted: `openShareLink`, the redemption and every delivery request refuse links of that owner, and when the plan returns, the same links work again. The dashboard says so.

### Who manages links

An admin or editor of the owner (`authorizeOn` with `access`, the action of the other sharing operations); a member gets `forbidden`, anyone else what a missing artifact gives. Creating is `artifacts:share` in the API and MCP, like every widening of access, and the MCP tool's description tells the agent to ask the user first. Listing and revoking are `artifacts:share` too: the list is sharing configuration.

### Lifecycle and restores

- Links, handoffs and link sessions cascade from the artifact, so a purge (and an account deletion, which purges every artifact) removes them; the access log's link rows go with the artifact's `erase_access_events` job.
- Revoked links stay (hidden from the list) for 30 days, the access log's retention, because their label names its entries. Then the maintenance job writes a `share_link` tombstone for each and deletes it; links that expired more than 30 days ago are deleted without one (a restore brings them back expired). `exportTombstones` exports the tombstones and every revoked link still in the database, and `applyTombstones` stores the markers and revokes those links again, so a D1 Time Travel restore cannot bring a revoked link back. A link created after the restore point simply disappears, which fails safe.
- The maintenance job deletes expired handoffs and link sessions in bounded batches, like read sessions.

### Operations

A suspension makes the artifact not servable, which ends every link at once (the state is read on every request) and refuses new entries. The operator finds the artifact behind a reported link without anyone sending the token around: the artifact's origin, which the visitor sees in the address bar, names it, and `operator find-share-link` reads a link or token from standard input, hashes it locally and prints the artifact and link IDs, never the token.

## Alternatives rejected

- **Token in the path** (`/s/<token>`, the plan's first sketch): leaks into request logs and makes previews fetch the token; see the table above.
- **Opening the link on the artifact origin** (`<id>.portifact.dev/__portifact/share?token=…`): the token would reach the artifact origin, where the artifact's own scripts run and its own logs and analytics may see the URL. The plan keeps every credential on `portifact.com`.
- **A read session with a null user**: read sessions end with a Better Auth session and carry a policy generation; a link session must end with the link instead and survive access changes. A separate table, cookie and purpose keeps both models simple and keeps a link session from ever passing as an account's.
- **Binding the handoff to a transaction cookie like the read entry**: the visitor starts on the app, not on the artifact origin, so there is no artifact-origin cookie to bind to without an extra round trip. Planting a link session in another browser (fixation) gives that browser exactly what sending it the link would, and a read session still wins, so the binding would add a round trip for no gain.
- **Showing link visitors the viewer without comments**: the viewer authorizes accounts and frames through review sessions; giving it a link mode would add a second, anonymous path into the app origin. The artifact itself is simpler and leaks nothing.
- **Slower password hashing (scrypt, Argon2 in WebAssembly)**: not in WebCrypto, a new dependency and CPU a Worker cannot spare; rate limits and the human check carry the rest.
- **Deleting links when the plan lapses**: a lower plan only refuses new work; deleting would also break links the owner may pay to restore.

## Open risks

- 100,000 PBKDF2 iterations is the platform's ceiling, not the recommended cost. A leaked database lets an attacker test short passwords offline faster than OWASP's guidance; the token must leak too for a password to matter.
- Browsers may store the full URL with the fragment in their global history before the script removes it; anyone with access to that history has the link.
- Fixation: any site can make a browser hold a link session for an artifact whose link it has. The browser then reads what the link grants, as it would by opening the link.
- The access log of link openings is best effort, like the account log (an evicted isolate loses its batch).
- The rate-limit counters are fixed windows in D1; a distributed guesser gets 10 attempts per token per 15 minutes in total, which is the point, but per-IP limits do little against a botnet. The human check is what slows that.
