// Review-mode HTML: the served page with the bridge script appended, and the pages that tell the
// viewer review cannot go on. The original bytes in R2 never change; only the review response
// is rewritten, and it is never cached.

import { REVIEW_CHANNEL, REVIEW_PROTOCOL } from "@portifact/bridge";
import { BRIDGE_SCRIPT, BRIDGE_VERSION } from "@portifact/bridge/bundle";
import type { ReviewStatus } from "./review.ts";

export const BRIDGE_PATH = "/__portifact/bridge.js";

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ATTRIBUTE_ESCAPES[char] ?? char);
}

/** A random CSP nonce for one response. */
export function cspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export interface InjectOptions {
  appOrigin: string;
  /** The served file of the version, which targets refer to. */
  path: string;
  /** Tag of the review session the page is served in; the bridge echoes it to the viewer. */
  sessionTag: string;
  /**
   * For a page rendered by Portifact: the nonce the response's CSP allows the bridge with. The
   * page's own CSP `<meta>` is dropped, because the header carries the same policy plus the nonce.
   */
  nonce?: string | undefined;
}

/**
 * Appends the bridge to an HTML response. A site's own markup stays as it is, including any CSP
 * it declares; if that CSP blocks the bridge, the viewer notices the silence and offers general
 * comments.
 */
export function injectBridge(response: Response, options: InjectOptions): Response {
  let renderer: string | undefined;
  const rewriter = new HTMLRewriter();
  if (options.nonce !== undefined) {
    rewriter.on("meta[http-equiv]", {
      element(element) {
        const name = element.getAttribute("http-equiv")?.toLowerCase();
        if (name === "content-security-policy") element.remove();
      },
    });
    rewriter.on('meta[name="generator"]', {
      element(element) {
        const match = /^portifact-render ([0-9A-Za-z.+-]{1,32})$/.exec(
          element.getAttribute("content") ?? "",
        );
        if (match) renderer = `portifact-render@${match[1]}`;
      },
    });
  }
  rewriter.onDocument({
    end(end) {
      const attributes = [
        `src="${BRIDGE_PATH}?v=${BRIDGE_VERSION}"`,
        `data-app-origin="${escapeAttribute(options.appOrigin)}"`,
        `data-path="${escapeAttribute(options.path)}"`,
        `data-session-tag="${escapeAttribute(options.sessionTag)}"`,
        ...(renderer ? [`data-renderer="${escapeAttribute(renderer)}"`] : []),
        ...(options.nonce !== undefined ? [`nonce="${escapeAttribute(options.nonce)}"`] : []),
      ];
      end.append(`<script ${attributes.join(" ")}></script>`, { html: true });
    },
  });
  return rewriter.transform(response);
}

/** Where the review tab's banner links to end review (see `handleReviewEnd`). */
export const REVIEW_END_HREF = "/__portifact/review/end";

const BANNER_STYLE = [
  ":host{all:initial;display:block}",
  ".bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:#111;color:#fff;font:15px/1.4 system-ui,sans-serif;border-bottom:2px solid #fff}",
  "p{margin:0}",
  "strong{font-weight:700}",
  "a{color:#111;background:#fff;padding:6px 12px;border-radius:4px;font-weight:700;text-decoration:none}",
  "a:hover{text-decoration:underline}",
  "a:focus-visible{outline:3px solid #fff;outline-offset:2px}",
].join("");

/**
 * The review tab's banner: says the tab is in review mode, how long it lasts, where comments are
 * written, and links to end it. It is plain markup in a declarative shadow root, so the page's
 * styles do not restyle it and it needs no script; a site whose own CSP blocks inline
 * styles shows it unstyled. The page's scripts run in the same document and can hide it, which
 * is why the session is short and the viewer says how to end it too.
 */
export function reviewBanner(minutes: number): string {
  return `<div role="region" aria-label="Portifact review" data-portifact-ignore><template shadowrootmode="open"><style>${BANNER_STYLE}</style><div class="bar"><p><strong>Review tab.</strong> You are reviewing the version shown here. Write comments in the review viewer. This review ends by itself within ${minutes} minutes.</p><a href="${REVIEW_END_HREF}">End review</a></div></template></div>`;
}

/**
 * Adds the review banner to an HTML response of the review tab, at the start of the body, or at
 * the end of the document when the markup has no body tag. Nothing else in the page changes.
 */
export function injectReviewBanner(response: Response, minutes: number): Response {
  const banner = reviewBanner(minutes);
  let placed = false;
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        if (placed) return;
        placed = true;
        element.prepend(banner, { html: true });
      },
    })
    .onDocument({
      end(end) {
        if (!placed) end.append(banner, { html: true });
      },
    })
    .transform(response);
}

/** The bridge bundle. Its URL carries the bundle's version, so a matching URL is immutable. */
export function bridgeScript(request: Request): Response {
  const version = new URL(request.url).searchParams.get("v");
  return new Response(request.method === "HEAD" ? null : BRIDGE_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control":
        version === BRIDGE_VERSION ? "public, max-age=31536000, immutable" : "no-cache",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}

const STATUS_TEXT: Record<ReviewStatus, string> = {
  unavailable: "Review mode is not available in this browser",
  ended: "This review session has ended. Reload the review to continue",
  failed: "This review link has expired or was already used",
};

/**
 * A page that tells the viewer, and only the viewer's exact origin, why review cannot go on.
 * Its one inline script is allowed by a nonce; it posts a fixed message and reads nothing.
 */
export function reviewStatusPage(
  status: ReviewStatus,
  httpStatus: number,
  appOrigin: string,
  setCookies: string[],
): Response {
  const nonce = cspNonce();
  const message = JSON.stringify({
    channel: REVIEW_CHANNEL,
    v: REVIEW_PROTOCOL,
    type: "status",
    status,
  });
  const target = JSON.stringify(appOrigin);
  const script =
    `if (window.parent !== window) window.parent.postMessage(${message}, ${target});`.replace(
      /</g,
      "\\u003c",
    );
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portifact</title><body><main><h1>${STATUS_TEXT[status]}</h1></main><script nonce="${nonce}">${script}</script></body></html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors ${appOrigin}`,
  });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status: httpStatus, headers });
}
