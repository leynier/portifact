// Cookies injected by sibling artifacts. portifact.dev is not on the Public Suffix List, so any
// artifact can set `Domain=portifact.dev` cookies (for any path) that every other artifact origin
// then receives. They never grant anything: authorization reads only Portifact's exact host-only
// names. They can still grow the Cookie header until requests fail, so once the foreign cookies
// a request carries pass a size limit, the response expires them on the shared domain. See
// docs/security.md, "Injected cookies".
import { READ_COOKIE, TRANSACTION_COOKIE_PREFIX } from "./cookies.ts";
import { REVIEW_COOKIE, REVIEW_TAB_COOKIE } from "./review.ts";
import { SHARE_COOKIE } from "./share-session.ts";
import { NO_BAR_COOKIE } from "./viewer.ts";

/**
 * Bytes of foreign `name=value` pairs a request may carry before they are cleared. Well below
 * the platform's request header limit (Cloudflare: 128 KB in total), and far above what an
 * artifact's own cookies or an analytics script's `Domain` cookies use, which keep working.
 */
export const FOREIGN_COOKIE_LIMIT = 8 * 1024;
/**
 * Bytes of `Set-Cookie` one response spends on clearing; later requests clear the rest. The
 * largest name is always cleared whole, so a single cookie name near the browsers' 4 KiB cap
 * can take one response over it (at most MAX_CLEANUP_PATHS * 2 headers).
 */
export const CLEANUP_BUDGET = 16 * 1024;
/** Cookie paths tried per request: `/` and the prefixes of the requested path. */
export const MAX_CLEANUP_PATHS = 8;

const OWN_NAMES = new Set([
  READ_COOKIE,
  REVIEW_COOKIE,
  REVIEW_TAB_COOKIE,
  NO_BAR_COOKIE,
  SHARE_COOKIE,
]);

/** One of Portifact's cookies on artifact origins, by exact, case-sensitive name. */
export function isPortifactCookie(name: string): boolean {
  return OWN_NAMES.has(name) || name.startsWith(TRANSACTION_COOKIE_PREFIX);
}

/** A foreign name that imitates ours (`__host-pf_read`, `pf_review`, `pf_link`): cleared at any size. */
function imitatesPortifact(name: string): boolean {
  return /pf_(read|review)|pf_link$/i.test(name);
}

/** Names that can be written back in a `Set-Cookie` header unchanged. */
function clearable(name: string): boolean {
  if (name === "") return false;
  for (let at = 0; at < name.length; at++) {
    const code = name.charCodeAt(at);
    if (code < 0x20 || code >= 0x7f) return false;
  }
  return true;
}

/**
 * `Set-Cookie` headers that expire the foreign cookies of a request on the shared domain: all of
 * them once their size passes FOREIGN_COOKIE_LIMIT, otherwise only names that imitate ours.
 * Portifact's own `__Host-` cookies are never touched, and neither are the artifact's own
 * host-only cookies, because a `Domain` cookie is a different cookie from a host-only one of the
 * same name. The Cookie header does not say which path or partition a cookie was set for, so
 * each name is expired at every path the request could have matched, unpartitioned and
 * partitioned, largest cookies first, within CLEANUP_BUDGET.
 */
export function injectedCookieCleanup(
  header: string | null,
  pathname: string,
  domain: string,
): string[] {
  if (!header) return [];
  const sizes = new Map<string, number>();
  let foreignBytes = 0;
  for (const raw of header.split(";")) {
    const part = raw.trim();
    const separator = part.indexOf("=");
    const name = separator === -1 ? "" : part.slice(0, separator).trim();
    if (isPortifactCookie(name)) continue;
    foreignBytes += part.length;
    if (clearable(name)) sizes.set(name, Math.max(sizes.get(name) ?? 0, part.length));
  }
  const over = foreignBytes > FOREIGN_COOKIE_LIMIT;
  // Imitations first, then the largest: both are what a response should clear before the rest.
  const rank = ([name, size]: [string, number]) =>
    imitatesPortifact(name) ? Number.POSITIVE_INFINITY : size;
  const names = [...sizes]
    .filter(([name]) => over || imitatesPortifact(name))
    .sort((a, b) => rank(b) - rank(a))
    .map(([name]) => name);
  const paths = cookiePaths(pathname);
  const cleared: string[] = [];
  let spent = 0;
  // Whole names at a time: a name this response expires everywhere is gone from the next
  // request, so the next response moves on to other names instead of repeating these.
  for (const name of names) {
    const lines = paths.flatMap((path) =>
      ["", "; Partitioned"].map(
        (partition) =>
          `${name}=; Max-Age=0; Domain=${domain}; Path=${path}; Secure; SameSite=None${partition}`,
      ),
    );
    const bytes = lines.reduce((sum, line) => sum + line.length, 0);
    if (cleared.length > 0 && spent + bytes > CLEANUP_BUDGET) break;
    cleared.push(...lines);
    spent += bytes;
  }
  return cleared;
}

/**
 * Every cookie path a browser would send along with a request for `pathname` (RFC 6265, 5.1.4):
 * `/`, then each prefix ending before or at a `/`. `/a/b` gives `/`, `/a`, `/a/` and `/a/b`.
 */
export function cookiePaths(pathname: string): string[] {
  const paths = new Set(["/"]);
  for (let at = 1; at <= pathname.length && paths.size < MAX_CLEANUP_PATHS; at++) {
    if (at < pathname.length && pathname[at] !== "/") continue;
    paths.add(pathname.slice(0, at));
    if (at < pathname.length) paths.add(pathname.slice(0, at + 1));
  }
  return [...paths].slice(0, MAX_CLEANUP_PATHS);
}
