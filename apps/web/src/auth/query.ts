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

/**
 * Pages a sign-in may return to: the device page, the dashboard routes, the entry to a
 * protected artifact, which continues to the artifact after signing in, the viewer, a
 * workspace's members and the invitation page (whose token stays in the tab, never in `next`).
 */
const NEXT_PATHS = [
  /^\/device$/,
  /^\/$/,
  /^\/artifacts\/[A-Za-z0-9_-]+$/,
  /^\/account$/,
  /^\/members$/,
  /^\/invitations$/,
  /^\/read\/[a-z2-7]{10}$/,
  /^\/view\/[a-z2-7]{10}$/,
  // A space's pages, where a workspace's sign-in policies send a person to sign in again
  // (decision 0021) and bring them back.
  /^\/(publish|usage|plan|groups|policies|audit|service-tokens|webhooks|integrations|branding|settings|profile|apps)$/,
  /^\/artifacts\/[A-Za-z0-9_-]+\/(publish|edit|history)$/,
];

/**
 * Where to go after signing in, from the `next` parameter. Only same-origin paths of the
 * device page, the dashboard, the artifact entry and the viewer are accepted, so the login page cannot be
 * used to redirect elsewhere.
 */
export function safeNext(search: string, origin: string): string | undefined {
  const raw = new URLSearchParams(search).get("next");
  if (!raw?.startsWith("/") || raw.startsWith("//")) return undefined;
  // A path relative to the origin always parses; the origin check catches "/\evil.example".
  const url = new URL(raw, origin);
  if (url.origin !== origin || !NEXT_PATHS.some((path) => path.test(url.pathname))) {
    return undefined;
  }
  return `${url.pathname}${url.search}`;
}

/** The login page URL that comes back to `path` after signing in. */
export function loginUrl(path: string): string {
  return `/login?${new URLSearchParams({ next: path })}`;
}

/**
 * The login page asked to sign in again although a session exists (decision 0021): a workspace's
 * maximum session age refused the current one. It signs in alongside the old session, which it
 * never ends, and goes back to `path`.
 */
export function reauthUrl(path: string): string {
  return `/login?${new URLSearchParams({ reauth: "session_age", next: path })}`;
}

/**
 * The login page asked to sign in through single sign-on (decision 0021, "SSO required"): it fills
 * in the account's address, goes through the workspace's provider, which links to this account
 * and replaces this browser's session cookie with the new session (the old session is not
 * ended), and comes back to `path`.
 */
export function ssoReauthUrl(path: string): string {
  return `/login?${new URLSearchParams({ reauth: "sso", next: path })}`;
}
