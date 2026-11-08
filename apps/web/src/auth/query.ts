// Query handling for the auth pages.

/**
 * The signed part of an authorization request's query, which the login and consent pages send
 * back as `oauth_query`. Same rule as Better Auth's client: keep `sig`, `ba_param` and every
 * parameter that `ba_param` lists, and nothing else. Returns undefined when the page was not
 * opened by an authorization request.
 */
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) return undefined;
  const signedNames = new Set(params.getAll("ba_param"));
  if (signedNames.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "sig" || key === "ba_param" || signedNames.has(key)) signed.append(key, value);
  }
  return signed.toString();
}

/** One value of a signed parameter, or undefined when it is missing or repeated. */
export function singleParam(query: string, name: string): string | undefined {
  const values = new URLSearchParams(query).getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

const NEXT_PATHS = new Set(["/device"]);
/** The entry to a protected artifact, which continues to the artifact after signing in. */
const READ_ENTRY = /^\/read\/[a-z2-7]{10}$/;

/**
 * Where to go after signing in, from the `next` parameter. Only same-origin paths of the auth
 * pages and the artifact entry are accepted, so the login page cannot be used to redirect
 * elsewhere.
 */
export function safeNext(search: string, origin: string): string | undefined {
  const raw = new URLSearchParams(search).get("next");
  if (!raw?.startsWith("/") || raw.startsWith("//")) return undefined;
  // A path relative to the origin always parses; the origin check catches "/\evil.example".
  const url = new URL(raw, origin);
  if (url.origin !== origin) return undefined;
  if (!NEXT_PATHS.has(url.pathname) && !READ_ENTRY.test(url.pathname)) return undefined;
  return `${url.pathname}${url.search}`;
}

/** The login page URL that comes back to `path` after signing in. */
export function loginUrl(path: string): string {
  return `/login?${new URLSearchParams({ next: path })}`;
}
