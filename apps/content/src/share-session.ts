// Link sessions on the artifact origin (premium plan P4, decision 0008). The entry page on the app
// sends a share link's visitor to `/__portifact/link?code=…` with a one-use code; this redeems it
// into a link session behind `__Host-pf_link`: a session ID plus sealed claims (artifact, link)
// that are trusted without D1 for 60 seconds. The token of the link never reaches this origin.
// A link session reads the artifact's current version and nothing else; a read session, when the
// browser has a usable one, always wins (see authorizeRead).
import { OpaqueToken, ShareClaims } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { entitlements, hasFeature } from "@portifact/domain";
import { redeemShareHandoff, refreshShareSession } from "@portifact/services";
import { clearCookie, cookieValue, seal, setCookie, unseal, usableSecret } from "./cookies.ts";
import type { ReadDecision, ReadEnv, RequestHosts, ServableArtifact } from "./read-session.ts";

const SECOND_MS = 1000;
const CLAIMS_TTL_SECONDS = 60;

/** Where the entry page sends a link's visitor with a one-use code. */
export const LINK_PATH = "/__portifact/link";
/** Host-only link session cookie; its value is sealed under its own purpose. */
export const SHARE_COOKIE = "__Host-pf_link";
const SHARE_PURPOSE = "pf_link";

/** Same rule as the read cookie: only the artifact's own requests and navigations use it. */
function cookieUsable(request: Request): boolean {
  return (
    request.headers.get("Sec-Fetch-Site") === "same-origin" ||
    request.headers.get("Sec-Fetch-Mode") === "navigate"
  );
}

async function claimsCookie(
  secret: string,
  claims: Omit<ShareClaims, "v" | "exp">,
  now: number,
): Promise<string> {
  const value = await seal(secret, SHARE_PURPOSE, {
    v: 1,
    ...claims,
    exp: Math.min(now + CLAIMS_TTL_SECONDS * SECOND_MS, claims.sexp),
  } satisfies ShareClaims);
  return setCookie(SHARE_COOKIE, value, { maxAgeSeconds: (claims.sexp - now) / SECOND_MS });
}

/** What redeeming a code answers: the artifact's root with a session, or the same failure page. */
export type LinkStep =
  | { kind: "redirect"; location: string; setCookies: string[] }
  | { kind: "page"; status: number; setCookies: string[] }
  | { kind: "unavailable" };

/**
 * `/__portifact/link?code=…`: only a top-level `GET` navigation that comes from another site (the
 * entry page on the app) may redeem, so a sibling artifact (`same-site`) or a frame cannot. Every
 * failure answers the same page.
 */
export async function handleLinkCallback(
  request: Request,
  env: ReadEnv,
  db: RegionalDb,
  artifactId: string,
  now: number,
  hosts: RequestHosts,
): Promise<LinkStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "unavailable" };
  const failed: LinkStep = { kind: "page", status: 400, setCookies: [] };
  const headers = request.headers;
  if (
    request.method !== "GET" ||
    headers.get("Sec-Fetch-Mode") !== "navigate" ||
    headers.get("Sec-Fetch-Dest") !== "document" ||
    headers.get("Sec-Fetch-Site") !== "cross-site"
  ) {
    return failed;
  }
  const codes = new URL(request.url).searchParams.getAll("code");
  const code = codes.length === 1 ? OpaqueToken.safeParse(codes[0]) : null;
  if (!code?.success) return failed;
  const redeemed = await redeemShareHandoff(db, { code: code.data, artifactId, ...hosts, now });
  if (!redeemed.ok) return failed;
  const session = redeemed.value;
  return {
    kind: "redirect",
    location: `${new URL(request.url).origin}/`,
    setCookies: [
      await claimsCookie(
        secret,
        { sid: session.sessionId, aid: artifactId, lid: session.linkId, sexp: session.expiresAt },
        now,
      ),
    ],
  };
}

/**
 * The decision for a request that carries this origin's link cookie, or null without one (or
 * when the request may not use it). A link opens only while the artifact is servable and its
 * owner's plan includes share links, both read from the delivery lookup at no extra cost; the
 * link and its session are rechecked in D1 once the claims are 60 seconds old.
 */
export async function authorizeLink(
  request: Request,
  env: ReadEnv,
  db: RegionalDb,
  artifactId: string,
  artifact: ServableArtifact | null,
  now: number,
  /** Claims expiring within this are renewed against D1 now (live updates' renewals). */
  freshWithin = 0,
): Promise<ReadDecision | null> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret) || !cookieUsable(request)) return null;
  const value = cookieValue(request.headers.get("Cookie"), SHARE_COOKIE);
  if (!value) return null;
  const parsed = ShareClaims.safeParse(await unseal(secret, SHARE_PURPOSE, value));
  const claims = parsed.success ? parsed.data : null;
  // Only the page that says the link ended clears the cookie. The open page's own requests (a
  // favicon, a poll) usually find the ended session first; clearing there would leave the
  // visitor's next page load without a cookie, and they would be sent to sign in instead of
  // being told why. A dead cookie grants nothing meanwhile: every use is checked again.
  const navigation = request.headers.get("Sec-Fetch-Mode") === "navigate";
  const ended: ReadDecision = {
    kind: "page",
    status: navigation ? 403 : 401,
    page: "shareEnded",
    setCookies: navigation ? [clearCookie(SHARE_COOKIE)] : [],
  };
  if (!claims || claims.aid !== artifactId || claims.sexp <= now) return ended;
  if (!artifact || !hasFeature(entitlements(artifact.plan, now), "shareLinks")) return ended;
  if (claims.exp > now + freshWithin) {
    const credential = { id: `link:${claims.sid}`, expiresAt: claims.exp };
    return {
      kind: "allow",
      artifact,
      userId: null,
      linkId: claims.lid,
      setCookies: [],
      credential,
    };
  }
  const renewed = await refreshShareSession(db, {
    sessionId: claims.sid,
    artifactId,
    linkId: claims.lid,
    now,
  });
  if (!renewed.ok) return ended;
  return {
    kind: "allow",
    artifact,
    userId: null,
    linkId: claims.lid,
    credential: {
      id: `link:${claims.sid}`,
      expiresAt: Math.min(now + CLAIMS_TTL_SECONDS * SECOND_MS, renewed.value.expiresAt),
    },
    setCookies: [
      await claimsCookie(
        secret,
        { sid: claims.sid, aid: artifactId, lid: claims.lid, sexp: renewed.value.expiresAt },
        now,
      ),
    ],
  };
}
