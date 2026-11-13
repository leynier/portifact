// The content Worker's first checks on `/__portifact/data/` (decision 0026, "Requests from the
// page"). Two gates, never mixed: the API gate (same origin only, for `fetch` and WebSockets from
// the artifact's own page) and the handoff gate (the one-use grant code arriving by navigation
// from the app, in a popup or in the viewer's frame).

import * as production from "@portifact/domain/artifact-data";

export type GateResult = "allowed" | "refused";

/** The production API gate (`apiGate`) over a request. */
export function dataGate(request: Request, write: boolean): GateResult {
  return production.apiGate(request.headers, new URL(request.url).origin, write);
}

/** The production start gate (`beginGate`) over a request. */
export function beginGate(request: Request): GateResult {
  return production.beginGate(request.method, request.headers);
}

/** The production redeem gate (`redeemGate`) over a request. */
export function redeemGate(request: Request, flow: "popup" | "frame"): GateResult {
  return production.redeemGate(request.method, request.headers, flow === "popup" ? "top" : "frame");
}

/** The former name of `redeemGate`, kept for the first version's tests. */
export const handoffGate = redeemGate;
