# 0002 Review-mode cookies

- Status: accepted for phase 0, pending a manual check in Safari on macOS and iOS before launch
- Date: 2026-11-08
- Spike: [spikes/review-cookies](../../spikes/review-cookies)

## Context

The trusted review viewer lives on `app.portifact.com/review/<id>` and shows the artifact in an iframe from `<id>.portifact.dev`. The two are different registrable sites. `portifact.dev` is not on the Public Suffix List, so every artifact is the same site as every other artifact.

The design under test, from the plan (section 4, "Modo revisión"):

1. The viewer asks its API for a one-time review code bound to user, artifact and version.
2. The iframe navigates to `https://<id>.portifact.dev/__portifact/review?code=…`.
3. The content Worker exchanges the code, sets `__Host-pf_review` with `Secure; HttpOnly; SameSite=None; Partitioned` (CHIPS) and redirects to the artifact path.
4. Every later request from that iframe (HTML, CSS, JS, images, fetch, in-frame navigation) carries the cookie. A normal top-level visit to the same artifact does not.

It must also hold that a sibling artifact cannot read or overwrite that cookie, and that the flow works with third-party cookies blocked. The plan lists the Storage Access API and then a top-level review tab as fallbacks if an engine cannot partition the cookie.

## Setup

- Two registrable domains stand in for production: `app.portifact.test` for `app.portifact.com`, and `art1.portifact-content.test` and `art2.portifact-content.test` for two artifacts on `portifact.dev`. `.test` is reserved and not on the Public Suffix List, so `art1` and `art2` are same-site, like two real artifacts.
- One Node HTTPS server plays both Workers and dispatches on the `Host` header. It uses a self-signed certificate that `openssl` generates for each run; the browsers run with `ignoreHTTPSErrors`.
- Host mapping is a local HTTP `CONNECT` proxy that sends the spike hosts to the HTTPS server and refuses everything else. All three engines accept a Playwright proxy, so the same mapping works everywhere without editing `/etc/hosts`.
- The viewer gets a code from `POST /api/review-codes` (exact `Origin` check), and the code is single use, expires in 60 seconds and is bound to the artifact and path. The exchange answers `303` with the review cookie plus an unpartitioned `SameSite=None` control cookie. The control cookie shows whether the engine really blocks third-party cookies in that run.
- The iframe has `sandbox="allow-scripts allow-same-origin allow-forms allow-storage-access-by-user-activation"`. Content responses send `frame-ancestors 'self' https://app.portifact.test`.
- The artifact page loads a stylesheet, a script, an image and a `fetch`, and has a link for in-frame navigation. The server logs, for every request, the review cookie values it received, the cookie names, and `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`.
- Playwright 1.64.1 with Chromium 156.0.8078.4, Firefox 157.0 and WebKit 27.2 (Playwright build 2370). The suite ran on Linux (Ubuntu 26.04, x64) and on macOS 26.6.2 (arm64), twice in a row on each, with the same results.

Third-party cookie settings per configuration:

| Configuration           | How third-party cookies are blocked                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium, 3PC blocked   | Persistent profile with `profile.cookie_controls_mode = 1`, the preference behind "Block third-party cookies". Needs the full browser (`channel: "chromium"`); the headless shell ignores profile preferences. |
| Firefox default         | `network.cookie.cookieBehavior = 5` (Total Cookie Protection, the default in Standard and Strict). Third-party cookies are partitioned, not blocked.                                                           |
| Firefox CHIPS opt-in    | `cookieBehavior = 5` with `network.cookie.cookieBehavior.optInPartitioning = true`: only cookies marked `Partitioned` survive in third-party contexts.                                                         |
| Firefox all 3PC blocked | `network.cookie.cookieBehavior = 1`, the "All third-party cookies" option in custom tracking protection.                                                                                                       |
| WebKit on macOS         | Default. WebKit blocks third-party cookies and Playwright has no switch to allow them. On macOS Playwright's WebKit uses Apple's network stack, the same cookie layer as Safari.                               |
| WebKit on Linux         | Default, same as above, but the cookie layer is libsoup (WPE). This is what GNOME Web uses, not Safari.                                                                                                        |

The control cookie confirmed each setting: it was missing from iframe requests in every configuration except Firefox default, where it was partitioned and sent, as designed.

## Results

The main design, with the content Worker's fetch-metadata rule described under findings:

| Configuration           | Partitioned cookie set | Sent on subresources | Isolated from top-level | Sibling cannot overwrite | Works with 3PC blocked |
| ----------------------- | ---------------------- | -------------------- | ----------------------- | ------------------------ | ---------------------- |
| Chromium, 3PC blocked   | Yes                    | Yes                  | Yes                     | Yes                      | Yes                    |
| Firefox default (TCP)   | Yes                    | Yes                  | Yes                     | Yes                      | Not applicable         |
| Firefox CHIPS opt-in    | Yes                    | Yes                  | Yes                     | Yes                      | Yes                    |
| Firefox all 3PC blocked | No                     | No                   | Not applicable          | Yes                      | No                     |
| WebKit on macOS         | Yes                    | Yes                  | Yes                     | Yes (see finding 2)      | Yes                    |
| WebKit on Linux         | No                     | No                   | Not applicable          | Yes                      | No                     |

"Sent on subresources" covers the document after the redirect, CSS, JS, image, `fetch` and a link followed inside the iframe. "Isolated from top-level" means a top-level visit to the same artifact in the same browser sent no review cookie on any request. "Sibling cannot overwrite" means that after `art2` ran every attack below, inside the viewer and as a top-level page, `art1` still received exactly one `__Host-pf_review` value, its own, and `art2` never saw it in `document.cookie`. Chromium reported the stored cookie with `partitionKey: "https://portifact.test"`; WebKit on macOS reported the same key.

Fallbacks, measured in every configuration (the Storage Access API only where the partitioned cookie failed):

| Configuration           | Storage Access API in the iframe                                                                                          | Top-level review tab                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Chromium, 3PC blocked   | Not needed                                                                                                                | Works; later top-level visits carry the cookie |
| Firefox default (TCP)   | Not needed                                                                                                                | Works; same trade-off                          |
| Firefox CHIPS opt-in    | Not needed                                                                                                                | Works; same trade-off                          |
| Firefox all 3PC blocked | Rejected with `NotAllowedError`, even after a first-party visit and click                                                 | Works; same trade-off                          |
| WebKit on macOS         | Not needed                                                                                                                | Works; same trade-off                          |
| WebKit on Linux         | Resolves, but cookies stay blocked: `document.cookie` writes are dropped, and so is `Set-Cookie` on a same-document fetch | Works; same trade-off                          |

## Findings

1. A sibling's credentialed requests carry the review cookie. When `art2` is open in the viewer (the same partition, `portifact.test`), `fetch("https://art1…/data.json", { credentials: "include", mode: "no-cors" })` reached `art1` with `art1`'s review cookie in every configuration where the cookie was stored, with `Sec-Fetch-Site: same-site`. CORS stops `art2` from reading a `fetch`, but `<script>`, `<img>` and CSS loads are no-cors and `Cross-Origin-Resource-Policy: same-site` would let `art2` use them. The spike's Worker therefore honors the review cookie only when `Sec-Fetch-Site` is `same-origin` (the artifact's own requests) or when it is `cross-site` with `Sec-Fetch-Mode: navigate` (the redirect that the viewer started, which arrives as `cross-site` because the redirect chain began on the viewer's site). Missing metadata fails closed, and review responses send `Cross-Origin-Resource-Policy: same-origin`. A sibling is always `same-site`, so it gets the public view. The tests break when this rule is removed.
2. WebKit on macOS accepts `__host-pf_review` (lowercase prefix) with `Domain=portifact-content.test` from a sibling's `document.cookie` and sends it to `art1` next to the real `__Host-pf_review`. Chromium, Firefox and WebKit on Linux reject it. It grants nothing as long as the content Worker matches cookie names exactly and case-sensitively; it must never case-fold names, and the injected-cookie cleanup should treat it as an injected cookie.
3. Every engine rejected `__Host-pf_review` with a `Domain` attribute, partitioned or not, and the nameless-cookie trick `=__Host-pf_review=…` that would serialize as `__Host-pf_review=…`. An unprefixed `pf_review` with `Domain` is accepted everywhere, as expected, and is ignored by the allowlist. Artifacts cannot set response headers, so `document.cookie` is their whole cookie-writing surface.
4. Fetch metadata was present on every request in all engines: the first document after the exchange is `cross-site`, `navigate`, `iframe`; its subresources and in-frame links are `same-origin`; a typed top-level visit is `none`.
5. Playwright disables Chromium's `ThirdPartyStoragePartitioning` feature by default. It does not affect cookies (the cookie was stored with a partition key), but storage partitioning tests in the future e2e suite should not rely on Playwright's Chromium defaults.

## Decision

Keep the partitioned cookie design from the plan: `__Host-pf_review` with `Path=/; Secure; HttpOnly; SameSite=None; Partitioned`, set by a one-time code exchange that runs inside the viewer iframe. It works with third-party cookies blocked in Chromium, in Firefox's default and CHIPS opt-in modes, and in WebKit on macOS, and it stays out of top-level visits. WebKit did not fail on macOS, so the WebKit-specific fallback in the plan is not needed.

Add these rules to the content Worker, as recorded in [security.md](../security.md):

- Honor the review cookie only for `Sec-Fetch-Site: same-origin`, or `cross-site` with `Sec-Fetch-Mode: navigate`. Fail closed without fetch metadata.
- Send `Cross-Origin-Resource-Policy: same-origin` on review-mode responses.
- Match cookie names exactly and case-sensitively, and require exactly one review value.
- Fetch metadata cannot tell the viewer's own frame navigation from one an artifact in the viewer bounces through a redirector on another site: both arrive as `cross-site`, `navigate`, `iframe`. The exchange therefore cannot stop a planted review session, and the viewer detects one instead: the bridge echoes a tag of the session its page runs in and the viewer compares it with the tag it got with its code (see "Review mode" in security.md).
- Detect a dropped cookie on the content origin: the exchange redirects through a reserved check path that verifies the cookie arrived, and otherwise answers a small page that tells the viewer (exact `targetOrigin`) that review mode is unavailable, so the viewer can offer the fallback. The spike shows the signal exists (the next request arrives without the cookie). Implemented as `/__portifact/review/check` (see "Review mode" in security.md).

## Fallbacks

- Storage Access API: not adopted. It is not needed where the partitioned cookie works, Firefox rejects it when all third-party cookies are blocked, and WebKit on Linux grants it without effect. Where it does work it exposes unpartitioned cookies, which would break top-level isolation anyway.
- Top-level review tab: the only fallback, for Firefox with all third-party cookies blocked, WebKit on Linux and any engine where the check above fails. It works in every configuration, but the cookie lands in the artifact's own partition, so later top-level visits in that browser carry it until it expires. Fetch metadata keeps a typed visit's document public (`Sec-Fetch-Site: none`), but its same-origin subresources come back in review mode. Limit the damage with a short review-session lifetime and an explicit end of review that clears the cookie, and offer only general comments in the tab, as the plan already says.

Built as recorded in "The review tab" in security.md: the viewer offers it when the check page reports `unavailable` or the bridge never answers; a tab code (`review_handoffs.kind`) redeemable only by a top-level cross-site navigation whose `Referer` is the app origin, which the viewer's `rel="noopener" referrerpolicy="origin"` link sends; a separate first-party cookie, `__Host-pf_review_tab` with `SameSite=Lax`, sealed under its own purpose and lasting 15 minutes instead of 4 hours; the cookie honored for `same-origin` requests and top-level document navigations, so every page served in review mode shows the banner; a banner of plain markup in a declarative shadow root instead of the bridge; and `/__portifact/review/end`, accepted only as a same-origin navigation, which deletes the session and clears the cookie. Comments stay in the viewer and there is no message channel between the tab and the viewer, so the tab adds nothing a page could forge.

A security review found that a sibling can plant a frame session in the artifact's own partition (framing a redirector to the exchange from a top-level sibling page, where the frame is first-party) and that it then outranked the tab on top-level visits. The rule since: the frame cookie is never honored for `Sec-Fetch-Dest: document`, since the viewer's frame navigations are always `iframe`; any `__Host-pf_review` a top-level document navigation carries is cleared with `Partitioned`, since a genuine one lives only in the viewer's partition; and the tab cookie is preferred when both are valid. Firefox sends `Sec-Fetch-Site: none` for the tab's first page after the exchange's same-origin redirects, so the tab cookie accepts any top-level document navigation rather than only `cross-site` or `same-origin`.

The plan's phase 0 risk ("Si WebKit falla, la alternativa es la Storage Access API") should be updated to say that WebKit passes and that the top-level tab is the fallback for Firefox with all third-party cookies blocked and for libsoup-based WebKit.

## Limits

- Playwright's WebKit is not Safari. On macOS it shares Safari's network and cookie layer, but Safari's own privacy settings and iOS were not tested. Check Safari on macOS and iOS by hand in the phase 9 browser matrix.
- Chromium was tested with the user preference only, not with enterprise policy or incognito.
- The servers are Node stand-ins for the Workers. Cookie and fetch-metadata behavior is decided by the browser, so this does not change the results, but the production Worker needs its own tests for the rules above.

## Reproduce

From the repository root:

```bash
bun install
bun run --cwd spikes/review-cookies browsers   # once; installs Chromium, Firefox and WebKit for Playwright
bun run spike:review-cookies
```

It needs `openssl` on the `PATH`. On Linux, WebKit also needs its system libraries (`npx playwright install-deps webkit`, which uses `sudo`). Run it on macOS for the WebKit verdict that stands in for Safari; the WebKit project switches its expected results by platform. The browser tests are not part of `bun run test`.
