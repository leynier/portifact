// The grant's gates and codes (decision 0026, "The grant"): the content Worker's first checks on
// `/__portifact/data/`. Two navigation gates, never mixed with the API gate, and a one-use code
// that redeems only in the browser that began the grant, on the host it was issued for. Hashing
// happens in the adapter; these rules compare what it hashed.

/** The request headers the gates read (a `Headers` satisfies it). */
export interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The API gate: `Sec-Fetch-Site: same-origin` always; the exact origin on writes and WebSocket
 * handshakes; JSON on writes. No fetch metadata fails closed.
 */
export function apiGate(
  headers: HeaderSource,
  origin: string,
  write: boolean,
): "allowed" | "refused" {
  if (headers.get("Sec-Fetch-Site") !== "same-origin") return "refused";
  const upgrade = headers.get("Upgrade")?.toLowerCase() === "websocket";
  if ((write || upgrade) && headers.get("Origin") !== origin) return "refused";
  if (write && !headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return "refused";
  }
  return "allowed";
}

/**
 * Starting a grant (`GET /__portifact/data/grant/begin`): a `GET` navigation the artifact's own
 * page opens at the top level, or the viewer sends into its frame (`cross-site`, `iframe`). A
 * sibling's `same-site` navigation is refused.
 */
export function beginGate(method: string, headers: HeaderSource): "allowed" | "refused" {
  if (method !== "GET" || headers.get("Sec-Fetch-Mode") !== "navigate") return "refused";
  const site = headers.get("Sec-Fetch-Site");
  const destination = headers.get("Sec-Fetch-Dest");
  if (site === "same-origin" && destination === "document") return "allowed";
  if (site === "cross-site" && destination === "iframe") return "allowed";
  return "refused";
}

/**
 * Redeeming a grant (`GET /__portifact/data/grant?code=…`): a `GET` navigation arriving
 * `cross-site` from the app, as a top-level document (popup and top-level tab) or as the viewer's
 * frame.
 */
export function redeemGate(
  method: string,
  headers: HeaderSource,
  flow: "top" | "frame",
): "allowed" | "refused" {
  if (method !== "GET" || headers.get("Sec-Fetch-Mode") !== "navigate") return "refused";
  if (headers.get("Sec-Fetch-Site") !== "cross-site") return "refused";
  const expected = flow === "top" ? "document" : "iframe";
  return headers.get("Sec-Fetch-Dest") === expected ? "allowed" : "refused";
}

/** A code waiting to be redeemed, as D1 stores it: hashes only. */
export interface PendingCode {
  codeHash: string;
  nonceHash: string;
  host: string;
  grantId: string;
  expiresAt: number;
  used: boolean;
}

/** How long a code lives. */
export const GRANT_CODE_MS = 60_000;

/**
 * Whether a code redeems: unused, unexpired, on the host it was issued for, and presented with the
 * transaction cookie whose nonce it was bound to, so a code made in another browser (session
 * fixation) fails. The adapter consumes it with one guarded update on `used`.
 */
export function redeemable(
  pending: PendingCode | null,
  presented: { codeHash: string; nonceHash: string | null; host: string },
  now: number,
): boolean {
  return (
    pending !== null &&
    !pending.used &&
    pending.expiresAt > now &&
    pending.codeHash === presented.codeHash &&
    pending.host === presented.host &&
    pending.nonceHash === presented.nonceHash
  );
}
