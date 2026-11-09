// The viewer with the Portifact bar (plan section 8, "Flujo", decision of 2026-11-08). A visitor
// who opens a page of an artifact in the browser's own tab goes to the viewer on the app, which
// shows the Portifact bar, the page in a sandboxed frame and the comments sidebar. The frame's
// requests are frame navigations, so they are served as usual and never sent back to the viewer.
// See "The viewer" in docs/security.md for every condition.
import { viewerPath } from "@portifact/domain";
import { cookieValue, setCookie } from "./cookies.ts";

/**
 * The viewer's "Open without the Portifact bar" link: a top-level navigation here sets
 * `NO_BAR_COOKIE` on this artifact origin and continues to the page in `to`.
 */
export const NO_BAR_PATH = "/__portifact/raw";

/**
 * Host-only, first-party and `Lax`: while it holds `1`, top-level visits of this artifact get the
 * artifact itself instead of the viewer. It grants nothing; it only does for one browser what the
 * owner's opt-out does for everyone, because the bar is not a security boundary.
 */
export const NO_BAR_COOKIE = "__Host-pf_nobar";

/** How long the opt-out lasts in that browser. */
export const NO_BAR_SECONDS = 3600;

/**
 * The page a reserved path continues to: the request's one `to` parameter when `viewerPath`
 * accepts it, else the root. Whoever sets it can only pick another page of the same artifact.
 */
export function returnPath(request: Request): string {
  const values = new URL(request.url).searchParams.getAll("to");
  return (values.length === 1 ? viewerPath(values[0]) : null) ?? "/";
}

/** Whether this browser asked to see the artifact without the bar (`NO_BAR_COOKIE`). */
export function skipsViewer(request: Request): boolean {
  return cookieValue(request.headers.get("Cookie"), NO_BAR_COOKIE) === "1";
}

/**
 * `/__portifact/raw?to=<path>`: only a top-level navigation (the visitor followed the viewer's
 * link) sets the opt-out, so a sibling's subresource or frame cannot set it; anything else is
 * refused with no cookie. Null means refused.
 */
export function noBarRedirect(request: Request): Response | null {
  if (!isTopLevelVisit(request)) return null;
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${new URL(request.url).origin}${returnPath(request)}`,
      "Set-Cookie": setCookie(NO_BAR_COOKIE, "1", { maxAgeSeconds: NO_BAR_SECONDS }),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * Whether a request is a top-level page visit the viewer should show instead: a `GET` navigation
 * of the browser's own tab or window (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`).
 * Frames (the viewer's own, or another site's embed) are `iframe`, subresources are not
 * navigations, and clients without fetch metadata (crawlers, command-line tools) get the artifact
 * itself, so none of them is ever redirected. The caller decides only for artifacts the visitor
 * may read and only outside review mode, so a review tab keeps showing the artifact.
 */
export function isTopLevelVisit(request: Request): boolean {
  const headers = request.headers;
  return (
    request.method === "GET" &&
    headers.get("Sec-Fetch-Mode") === "navigate" &&
    headers.get("Sec-Fetch-Dest") === "document"
  );
}

/**
 * The viewer URL for a page of the artifact: `<app>/view/<id>`, with the path and query in
 * `path` unless it is the root. Null when the path cannot be carried (too long once encoded),
 * so the visitor gets the page itself rather than a different one. The fragment never reaches
 * the server; the browser keeps it across the redirect and the viewer passes it to the frame.
 */
export function viewerLocation(appOrigin: string, artifactId: string, url: URL): string | null {
  const path = viewerPath(`${url.pathname}${url.search}`);
  if (path === null) return null;
  const location = new URL(`/view/${artifactId}`, appOrigin);
  if (path !== "/") location.searchParams.set("path", path);
  return location.toString();
}

/** The redirect to the viewer: never cached, and the artifact URL never leaves as `Referer`. */
export function viewerRedirect(location: string, setCookies: string[]): Response {
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie);
  return response;
}
