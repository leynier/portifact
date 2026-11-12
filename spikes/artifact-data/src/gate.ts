// The content Worker's first checks on `/__portifact/data/` (decision 0026, "Requests from the
// page"). Two gates, never mixed: the API gate (same origin only, for `fetch` and WebSockets from
// the artifact's own page) and the handoff gate (the one-use grant code arriving by navigation
// from the app, in a popup or in the viewer's frame).

export type GateResult = "allowed" | "refused";

/**
 * API requests: `Sec-Fetch-Site: same-origin` always; the exact `Origin` on writes and WebSocket
 * handshakes; JSON on writes. No fetch metadata fails closed.
 */
export function dataGate(request: Request, write: boolean): GateResult {
  const url = new URL(request.url);
  if (request.headers.get("Sec-Fetch-Site") !== "same-origin") return "refused";
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (write || upgrade) {
    if (request.headers.get("Origin") !== url.origin) return "refused";
  }
  if (write && !request.headers.get("Content-Type")?.startsWith("application/json")) {
    return "refused";
  }
  return "allowed";
}

/**
 * Starting a grant (`GET /__portifact/data/grant/begin`), finding 15: a `GET` navigation that the
 * artifact's own page opens (`same-origin`, top-level, the direct-visit and top-level-tab flows)
 * or that the viewer sends into its frame (`cross-site`, `iframe`). It only sets a transaction
 * cookie and answers a Portifact page, so it needs no code; a sibling's `same-site` navigation
 * is refused.
 */
export function beginGate(request: Request): GateResult {
  if (request.method !== "GET") return "refused";
  const headers = request.headers;
  if (headers.get("Sec-Fetch-Mode") !== "navigate") return "refused";
  const site = headers.get("Sec-Fetch-Site");
  const destination = headers.get("Sec-Fetch-Dest");
  if (site === "same-origin" && destination === "document") return "allowed";
  if (site === "cross-site" && destination === "iframe") return "allowed";
  return "refused";
}

/**
 * Redeeming a grant (`GET /__portifact/data/grant?code=…`): a `GET` navigation that arrives
 * `cross-site` from the app, as a top-level document (the popup and top-level-tab flows) or as
 * the viewer's frame. A sibling's `same-site` navigation is refused; the code is bound to the
 * transaction cookie only the beginning browser holds (`grants.ts`).
 */
export function redeemGate(request: Request, flow: "popup" | "frame"): GateResult {
  if (request.method !== "GET") return "refused";
  const headers = request.headers;
  if (headers.get("Sec-Fetch-Mode") !== "navigate") return "refused";
  if (headers.get("Sec-Fetch-Site") !== "cross-site") return "refused";
  const destination = headers.get("Sec-Fetch-Dest");
  if (flow === "popup" ? destination !== "document" : destination !== "iframe") return "refused";
  return "allowed";
}

/** The former name of `redeemGate`, kept for the first version's tests. */
export const handoffGate = redeemGate;
