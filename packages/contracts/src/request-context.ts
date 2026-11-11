// The request context (decision 0020): the facts about how a request reaches Portifact that a
// workspace's request policies bind, built once by each Worker's entry from what the platform
// says, never from anything a client can set. It travels with the global database handle
// (`GlobalDb.request` in @portifact/db), so the only place a role is decided (`actorOn`) always
// has one and applies the policies there.

/**
 * - `request`: a request a Worker answers. `ip` is `CF-Connecting-IP` as Cloudflare sets it,
 *   null when it is missing or unreadable, which no network allowlist admits (fail closed).
 * - `background`: work no client is making right now (outbox jobs, maintenance scans, the
 *   operator tool, a Worker's deferred flushes). The policies were applied to the request that
 *   asked for it; there is no network to check.
 */
export type RequestContext = { kind: "request"; ip: string | null } | { kind: "background" };

/** Work no client is making right now (see `RequestContext`). */
export const BACKGROUND: RequestContext = Object.freeze({ kind: "background" });

/**
 * What a handle built without a context gets: a request from nowhere, which every network
 * allowlist refuses. A Worker that forgets to build its context fails closed, never open.
 */
export const UNKNOWN_REQUEST: RequestContext = Object.freeze({ kind: "request", ip: null });

/** The context of a request a Worker answers, from Cloudflare's `CF-Connecting-IP` only. */
export function requestContextOf(request: Request): RequestContext {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return { kind: "request", ip: ip ? ip : null };
}
