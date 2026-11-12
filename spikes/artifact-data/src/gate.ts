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
 * The grant handoff (`GET /__portifact/data/grant?code=…`): a `GET` navigation that arrives
 * `cross-site` from the app, as a top-level document (the popup flow) or as the viewer's frame
 * (the in-viewer flow). A sibling artifact's navigation is `same-site` and refused; the code
 * itself is bound to a transaction cookie only this browser holds (`grants.ts`).
 */
export function handoffGate(request: Request, flow: "popup" | "frame"): GateResult {
  if (request.method !== "GET") return "refused";
  const headers = request.headers;
  if (headers.get("Sec-Fetch-Mode") !== "navigate") return "refused";
  if (headers.get("Sec-Fetch-Site") !== "cross-site") return "refused";
  const destination = headers.get("Sec-Fetch-Dest");
  if (flow === "popup" ? destination !== "document" : destination !== "iframe") return "refused";
  return "allowed";
}
