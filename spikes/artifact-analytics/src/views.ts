// What a page view is (spike S3, premium plan P8). The content Worker decides it in `serve`, after
// authorization, the traffic quota and budget protection, from what it already knows about the
// request and its answer; it never reads or writes anything for it. One visit is one view:
//
// - With the Portifact bar on, a top-level visit is answered with the 303 to the viewer, and the
//   viewer's frame then loads the page. The frame's load is the view; the redirect is not, so the
//   visit counts once. A visit that starts at the viewer (a copied `/view/<id>` link, a reload of
//   the viewer) reaches the content Worker only through the frame, so it counts too.
// - With the bar off, or with this browser's opt-out, the top-level document is the view.
// - Every further page of a site the visitor opens (in the frame or at top level) is another view:
//   these are page views, not visits. Navigations a single-page app does in script never reach the
//   Worker and are not counted.
// - Subresources (images, scripts, styles, fetches) are not navigations and are never views, and
//   neither are files that are not pages (an image or a download opened in a tab).
// - A frame a sibling artifact opens (`Sec-Fetch-Site: same-site`, not a document) is not a view:
//   `frame-ancestors` keeps it from rendering, so counting it would let a hostile artifact add views
//   nobody saw (the same rule as `isPageLoad` for the access log). Another site's frame of an
//   embeddable public artifact is a view: the page is shown there.
// - Clients without fetch metadata (crawlers, link previews, command-line tools) are not counted.
//   Browsers automated to look like visitors are; the counts are an indicator, never an audit.
// - The owner's own visits with a session (the viewer always opens a review session for a
//   signed-in visitor, owner included) are not counted. The owner visiting without a session
//   (a public artifact with the bar off, signed out) cannot be told apart and counts as anonymous.
// - Only answers below 400 that send the page or confirm it (200, 206 and 304: a reload that
//   revalidates is a view) count; refusals, 404, 429 and the redirect do not. HEAD never counts.
// - Nothing is counted for an owner whose plan does not include analytics.

/** What delivery knows about a request it answered for an artifact. */
export interface ServedPage {
  method: string;
  fetchMode: string | null;
  fetchDest: string | null;
  fetchSite: string | null;
  status: number;
  /** The answer is a page: a site's `text/html` file or a document's rendered page. */
  isPage: boolean;
  /** The answer is the 303 that sends a top-level visit to the viewer. */
  viewerRedirect: boolean;
  /** The signed-in visitor a read or review session names; null for an anonymous visit. */
  visitorId: string | null;
  ownerId: string;
  /** The owner's plan includes analytics (`entitlements(plan).features`, already in the lookup). */
  analytics: boolean;
}

export type ViewKind = "anonymous" | "signedIn";

const COUNTED_STATUS = new Set([200, 206, 304]);
const FRAME_DESTS = new Set(["iframe", "frame"]);

/** The kind of view a served request is, or null when it is not a view. */
export function pageView(page: ServedPage): ViewKind | null {
  if (!page.analytics || page.viewerRedirect || !page.isPage) return null;
  if (page.method !== "GET" || page.fetchMode !== "navigate") return null;
  if (!COUNTED_STATUS.has(page.status)) return null;
  const topLevel = page.fetchDest === "document";
  const shownFrame = FRAME_DESTS.has(page.fetchDest ?? "") && page.fetchSite !== "same-site";
  if (!topLevel && !shownFrame) return null;
  if (page.visitorId === null) return "anonymous";
  if (page.visitorId === page.ownerId) return null;
  return "signedIn";
}

/** The fetch metadata of a request, as `ServedPage` takes it. */
export function fetchMetadata(request: Request) {
  const headers = request.headers;
  return {
    method: request.method,
    fetchMode: headers.get("Sec-Fetch-Mode"),
    fetchDest: headers.get("Sec-Fetch-Dest"),
    fetchSite: headers.get("Sec-Fetch-Site"),
  };
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day that contains `at`. */
export function utcDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}
