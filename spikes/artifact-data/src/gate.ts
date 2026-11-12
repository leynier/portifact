// The content Worker's first check on `/__portifact/data/` (decision 0026, "Requests from the
// page"), before any lookup: only the artifact's own origin, never a sibling artifact (same site,
// different origin) and never a client without fetch metadata.

export type GateResult = "allowed" | "refused";

/**
 * A data request is allowed only from a page of the same origin: `Sec-Fetch-Site: same-origin`
 * on every request, plus an exact `Origin` on writes and WebSocket handshakes (browsers send it
 * there). A request without fetch metadata fails closed.
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
