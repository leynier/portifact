// How a session signed in (decision 0021, "SSO required"), recorded by the server in the statement
// that creates the session: Better Auth's session `create.before` hook returns it as a field of the
// row it inserts. It is decided from the endpoint that is creating the session, the path of the
// request Better Auth is answering, never from anything else a client sends: only the endpoints
// the allowlist reaches (routes.ts) create sessions, and each signs in one way.
import { type SignInMethod, SsoProviderId, signInMethodText } from "@portifact/contracts";
import { AUTH_BASE_PATH } from "./config.ts";

const SOCIAL_CALLBACK = /^\/callback\/(google|github)$/;
const SSO_CALLBACK = /^\/sso\/callback\/([^/]+)$/;

/**
 * The method of a session created while answering `path` (under the auth base path): an email
 * code at `/sign-in/email-otp`, Google or GitHub at their callbacks, a workspace's provider at its
 * callback (the ID the callback verified the flow against). Null anywhere else: the session's
 * method is then not known, which "SSO required" refuses.
 */
export function signInMethodForPath(path: string): SignInMethod | null {
  if (path === "/sign-in/email-otp") return { kind: "code" };
  const social = SOCIAL_CALLBACK.exec(path);
  if (social?.[1] === "google" || social?.[1] === "github") {
    return { kind: "social", provider: social[1] };
  }
  const sso = SSO_CALLBACK.exec(path);
  if (sso?.[1] && SsoProviderId.safeParse(sso[1]).success) {
    return { kind: "sso", providerId: sso[1] };
  }
  return null;
}

/** The path under the auth base path of the request a Better Auth hook runs for, or null. */
function authPathOf(ctx: { request?: Request | undefined } | null | undefined): string | null {
  const url = ctx?.request?.url;
  if (!url) return null;
  const path = new URL(url).pathname;
  return path.startsWith(`${AUTH_BASE_PATH}/`) ? path.slice(AUTH_BASE_PATH.length) : null;
}

/** The stored method for a session the hook is about to create, or null when not known. */
export function sessionSignInMethod(
  ctx: { request?: Request | undefined } | null | undefined,
): string | null {
  const path = authPathOf(ctx);
  const method = path === null ? null : signInMethodForPath(path);
  return method === null ? null : signInMethodText(method);
}
