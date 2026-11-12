// How a request to the app Worker authenticated (decision 0021), recorded on the request context
// where it authenticates, from the rows the lookup already read: never a header or anything else
// a client sends. `actorOn` then applies a workspace's sign-in policies (maximum session age,
// allowed clients) with it. These are the only places the app reads a session or introspects a
// token (scripts/request-context.test.ts checks it), so no path acts without a recorded
// credential: one that forgot would fail closed.
import { clientKindOf, parseSignInMethod } from "@portifact/contracts";
import { recordRequestCredential } from "@portifact/db";
import { needsTermsAcceptance } from "@portifact/domain";
import type { Auth } from "./auth.ts";
import { AUTH_TIME_CLAIM, SIGN_IN_METHOD_CLAIM } from "./introspection.ts";
import type { IntrospectionPayload } from "./resource.ts";

type FoundSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;

/**
 * The dashboard's session behind a request's cookie, recording it as the request's credential:
 * signed in at the session row's `created_at`, which Better Auth keeps when it extends the
 * session (`updateSession` sets only `expiresAt` and `updatedAt` in the pinned version), and how
 * it signed in from the row's `sign_in_method` (decision 0021, "SSO required"), which the session
 * hook wrote when it created the row (sign-in-method.ts).
 */
export async function sessionOf(auth: Auth, env: object, headers: Headers): Promise<FoundSession> {
  const found = await auth.api.getSession({ headers });
  if (found) {
    recordRequestCredential(env, {
      kind: "session",
      userId: found.user.id,
      signedInAt: new Date(found.session.createdAt).getTime(),
      method: parseSignInMethod(found.session.signInMethod),
    });
  }
  return found;
}

/**
 * Records an active OAuth access token as the request's credential: its client from the token
 * row (`client_id`), and the sign-in it descends from (`AUTH_TIME_CLAIM`, null when the row does
 * not say, which a maximum session age refuses) and its method (`SIGN_IN_METHOD_CLAIM`, null
 * when not known, which "SSO required" refuses).
 */
export function recordToken(env: object, payload: IntrospectionPayload): void {
  if (payload.active !== true || !payload.sub || !payload.client_id) return;
  const authTime = payload[AUTH_TIME_CLAIM];
  recordRequestCredential(env, {
    kind: "oauth",
    userId: payload.sub,
    clientId: payload.client_id,
    client: clientKindOf(payload.client_id),
    signedInAt: typeof authTime === "number" ? authTime * 1000 : null,
    method: parseSignInMethod(payload[SIGN_IN_METHOD_CLAIM]),
    termsAccepted: !needsTermsAcceptance(payload.portifact_terms_version),
  });
}

/** Records a workspace's service token as the request's credential: it has no sign-in. */
export function recordServiceToken(env: object, tokenId: string): void {
  recordRequestCredential(env, { kind: "service_token", userId: tokenId });
}
