// Review mode on the artifact origin (plan section 4, "Modo revisión", and
// docs/decisions/0002-review-mode-cookies.md):
//
// 1. The viewer on app.portifact.com gets a one-use code from its API and points its iframe at
//    /__portifact/review?code=…. Only that cross-site iframe navigation may redeem it.
// 2. The exchange sets `__Host-pf_review` (Secure; HttpOnly; SameSite=None; Partitioned), so
//    the cookie lives in the viewer's partition only, and redirects through
//    /__portifact/review/check, which verifies the cookie came back. If the browser dropped it,
//    the check page tells the viewer that review mode is unavailable here.
// 3. Requests that carry the cookie and pass the fetch-metadata gate are served from the pinned
//    version, with the bridge injected into HTML and `Cross-Origin-Resource-Policy: same-origin`.
//    A sibling artifact in the same partition sends the cookie too, but always as `same-site`,
//    so it gets the normal public or sign-in answer instead.
//
// The fallback, where the browser drops partitioned cookies in frames, is a top-level review
// tab: the viewer links to /__portifact/review/tab?code=… with a tab code, which only a
// top-level navigation from the app may redeem. It sets `__Host-pf_review_tab` (first-party,
// SameSite=Lax) for a short session, the pages show a banner instead of the bridge, and
// /__portifact/review/end ends the session and clears the cookie.
import { OpaqueToken, REVIEW_SESSION, ReviewClaims, type ReviewKind } from "@portifact/contracts";
import type { Db } from "@portifact/db";
import { endReviewSession, redeemReviewHandoff, refreshReviewSession } from "@portifact/services";
import { cookieValue, seal, setCookie, unseal, usableSecret } from "./cookies.ts";
import type { ServableArtifact } from "./read-session.ts";

export const REVIEW_COOKIE = "__Host-pf_review";
export const REVIEW_TAB_COOKIE = "__Host-pf_review_tab";
export const REVIEW_PATH = "/__portifact/review";
export const REVIEW_CHECK_PATH = "/__portifact/review/check";
export const REVIEW_TAB_PATH = "/__portifact/review/tab";
export const REVIEW_TAB_CHECK_PATH = "/__portifact/review/tab/check";
export const REVIEW_END_PATH = "/__portifact/review/end";

const SECOND_MS = 1000;

export interface ReviewEnv {
  APP_ORIGIN: string;
  READ_SESSION_SECRET?: string | undefined;
}

/** What the viewer is told when review mode cannot go on in its iframe. */
export type ReviewStatus = "unavailable" | "ended" | "failed";

/** What a request gets in review mode. */
export type ReviewDecision =
  /** No usable review session: serve as usual. */
  | { kind: "none" }
  /**
   * Serve the pinned version in review mode: with the bridge in the viewer's frame, with the
   * review banner in a review tab. `sessionTag` goes to the bridge.
   */
  | {
      kind: "review";
      mode: ReviewKind;
      artifact: ServableArtifact;
      /** The signed-in reviewer, for the access log. */
      userId: string;
      versionId: string;
      sessionTag: string;
      setCookies: string[];
    }
  /** The session is over: tell the viewer, and drop the cookie. */
  | { kind: "status"; status: ReviewStatus; httpStatus: number; setCookies: string[] };

/**
 * One way a review session reaches the artifact origin: its cookie, the purpose its claims are
 * sealed under (so a frame cookie never validates as a tab cookie) and which requests may use it.
 */
interface Channel {
  mode: ReviewKind;
  cookie: string;
  purpose: string;
  set(value: string, maxAgeSeconds: number): string;
  usable(request: Request): boolean;
}

/**
 * `Set-Cookie` for the review cookie: host-only, partitioned (CHIPS) and `SameSite=None`, which
 * a cookie set and sent inside a cross-site iframe needs.
 */
export function reviewCookie(value: string, maxAgeSeconds: number): string {
  return `${REVIEW_COOKIE}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`;
}

/** Clearing a partitioned cookie needs the same partition attributes. */
export function clearReviewCookie(): string {
  return reviewCookie("", 0);
}

/**
 * `Set-Cookie` for the review tab's cookie: host-only, first-party and `SameSite=Lax`, so it is
 * sent on top-level navigations but never inside a cross-site frame such as the viewer's.
 */
export function reviewTabCookie(value: string, maxAgeSeconds: number): string {
  return setCookie(REVIEW_TAB_COOKIE, value, { maxAgeSeconds });
}

/**
 * Whether a request may use the review cookie: the artifact's own requests (`same-origin`) and
 * the viewer's navigation of its iframe (`cross-site` and `navigate`), never a top-level
 * document. Siblings are always `same-site`. Without fetch metadata the cookie is not used at
 * all.
 *
 * The viewer's frame navigations are always `Sec-Fetch-Dest: iframe`. A frame cookie that comes
 * with a top-level document was planted: a sibling framed a redirector to this artifact's
 * exchange, so the code was redeemed in a frame under the `portifact.dev` top-level site and the
 * partitioned cookie landed in the partition of this artifact's own top-level visits (Firefox
 * keeps it even with all third-party cookies blocked, because that frame is first-party). See
 * `strayFrameCookie`, which clears it.
 */
export function reviewCookieUsable(request: Request): boolean {
  const headers = request.headers;
  if (headers.get("Sec-Fetch-Dest") === "document") return false;
  const site = headers.get("Sec-Fetch-Site");
  return (
    site === "same-origin" ||
    (site === "cross-site" && headers.get("Sec-Fetch-Mode") === "navigate")
  );
}

/**
 * The `Set-Cookie` that clears a frame review cookie a top-level document navigation carries,
 * or null. A genuine frame cookie lives in the viewer's partition (keyed by the app's site) and
 * never reaches a top-level visit of the artifact, so one seen here sits in the artifact's own
 * partition and was planted by a sibling. It is cleared with the partition attributes, which in
 * a top-level response address exactly that partition, before the page's subresources (which
 * would be `same-origin`) can carry it. The name is matched exactly, whatever its values.
 */
export function strayFrameCookie(request: Request): string | null {
  const headers = request.headers;
  if (headers.get("Sec-Fetch-Mode") !== "navigate") return null;
  if (headers.get("Sec-Fetch-Dest") !== "document") return null;
  const carried = (headers.get("Cookie") ?? "")
    .split(";")
    .some((part) => part.slice(0, part.indexOf("=")).trim() === REVIEW_COOKIE);
  return carried ? clearReviewCookie() : null;
}

/**
 * Whether a request may use the review tab's cookie: the artifact's own requests
 * (`same-origin`) and top-level navigations (`navigate` to a `document`) from anywhere, so the
 * banner shows on every page the tab opens, also on a later visit in that browser while the
 * session lasts. A sibling's subresource or frame request carries the cookie too (they are
 * same-site) and gets the normal answer; a sibling's top-level navigation shows the user the
 * page and banner and lets the sibling read nothing. Without fetch metadata it is not used.
 */
export function reviewTabCookieUsable(request: Request): boolean {
  const headers = request.headers;
  // Keep any top-level document navigation, whatever its `Sec-Fetch-Site`: Firefox sends `none`
  // for the tab's first `/` after the exchange's same-origin 303 chain, so narrowing this to
  // `cross-site` or `same-origin` would drop the tab's first page out of review mode.
  return (
    headers.get("Sec-Fetch-Site") === "same-origin" ||
    (headers.get("Sec-Fetch-Mode") === "navigate" && headers.get("Sec-Fetch-Dest") === "document")
  );
}

const FRAME: Channel = {
  mode: "frame",
  cookie: REVIEW_COOKIE,
  purpose: "pf_review",
  set: reviewCookie,
  usable: reviewCookieUsable,
};

const TAB: Channel = {
  mode: "tab",
  cookie: REVIEW_TAB_COOKIE,
  purpose: "pf_review_tab",
  set: reviewTabCookie,
  usable: reviewTabCookieUsable,
};

async function claimsCookie(
  channel: Channel,
  secret: string,
  claims: Omit<ReviewClaims, "v" | "exp">,
  now: number,
): Promise<string> {
  const value = await seal(secret, channel.purpose, {
    v: 1,
    ...claims,
    exp: Math.min(now + REVIEW_SESSION.claimsTtlSeconds * SECOND_MS, claims.sexp),
  } satisfies ReviewClaims);
  return channel.set(value, (claims.sexp - now) / SECOND_MS);
}

/** The channel's claims for this artifact, signature checked, whatever their expiry. */
async function sealedClaims(
  channel: Channel,
  request: Request,
  secret: string,
  artifactId: string,
): Promise<ReviewClaims | null> {
  const value = cookieValue(request.headers.get("Cookie"), channel.cookie);
  if (!value) return null;
  const parsed = ReviewClaims.safeParse(await unseal(secret, channel.purpose, value));
  if (!parsed.success) return null;
  return parsed.data.aid === artifactId ? parsed.data : null;
}

async function readClaims(
  channel: Channel,
  request: Request,
  secret: string,
  artifactId: string,
  now: number,
): Promise<ReviewClaims | null> {
  const claims = await sealedClaims(channel, request, secret, artifactId);
  return claims && claims.sexp > now ? claims : null;
}

const ended = (channel: Channel): ReviewDecision => ({
  kind: "status",
  status: "ended",
  httpStatus: 401,
  setCookies: [channel.set("", 0)],
});

/**
 * Decides whether a request is served in review mode, through the review tab's cookie first and
 * then the viewer's frame cookie. Claims are trusted without D1 while they are unexpired and the
 * artifact's policy generation is unchanged; after that the session, the app session it came
 * from and the access policy are checked again. The pinned version must still be the artifact's
 * current version.
 */
export async function authorizeReview(
  request: Request,
  env: ReviewEnv,
  db: Db,
  artifactId: string,
  artifact: ServableArtifact | null,
  now: number,
): Promise<ReviewDecision> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "none" };
  // The tab first: a top-level visit that also carries a frame cookie can only carry a planted
  // one, which never outranks the visitor's own tab session.
  for (const channel of [TAB, FRAME]) {
    if (!channel.usable(request)) continue;
    const decision = await authorizeChannel(
      channel,
      request,
      secret,
      db,
      artifactId,
      artifact,
      now,
    );
    if (decision.kind !== "none") return decision;
  }
  return { kind: "none" };
}

async function authorizeChannel(
  channel: Channel,
  request: Request,
  secret: string,
  db: Db,
  artifactId: string,
  artifact: ServableArtifact | null,
  now: number,
): Promise<ReviewDecision> {
  const claims = await readClaims(channel, request, secret, artifactId, now);
  if (!claims) return { kind: "none" };
  if (!artifact || artifact.currentVersionId !== claims.vid) return ended(channel);
  const review = (setCookies: string[]): ReviewDecision => ({
    kind: "review",
    mode: channel.mode,
    artifact,
    userId: claims.uid,
    versionId: claims.vid,
    sessionTag: claims.tag,
    setCookies,
  });
  if (claims.exp > now && claims.gen === artifact.policyGeneration) return review([]);
  const renewed = await refreshReviewSession(db, { sessionId: claims.sid, artifactId, now });
  if (
    !renewed.ok ||
    renewed.value.userId !== claims.uid ||
    renewed.value.versionId !== claims.vid
  ) {
    return ended(channel);
  }
  const cookie = await claimsCookie(
    channel,
    secret,
    {
      sid: claims.sid,
      aid: artifactId,
      vid: claims.vid,
      uid: claims.uid,
      gen: renewed.value.policyGeneration,
      tag: claims.tag,
      sexp: renewed.value.expiresAt,
    },
    now,
  );
  return review([cookie]);
}

/** A redirect or a page answered on the reserved review paths. */
export type ReviewStep =
  | { kind: "redirect"; location: string; setCookies: string[] }
  | { kind: "status"; status: ReviewStatus; httpStatus: number; setCookies: string[] }
  /** The review tab's "End review": `done` once the session is over and its cookie cleared. */
  | { kind: "end"; done: boolean; setCookies: string[] }
  | { kind: "unavailable" };

/**
 * Whether a request is the navigation that may redeem a code of this kind.
 *
 * Frame codes: a cross-site iframe navigation (`cross-site`, `navigate`, `iframe`), which stops
 * a top-level visit or a sibling artifact's direct request. It does not prove the viewer started
 * it: an artifact framed in the viewer can open an iframe to a redirector on another site that
 * lands here with a code of its own, and that arrives with the same metadata, planting its
 * review session in the viewer's partition. The session's tag, which the bridge echoes and the
 * viewer compares with the one it got with its code, is what exposes such a session.
 *
 * Tab codes: a cross-site top-level navigation (`cross-site`, `navigate`, `document`) whose
 * `Referer` is the app's origin, which the viewer's link sends with `referrerpolicy="origin"`.
 * An artifact (in the viewer's frame, a tab or a popup) or any other site starts navigations
 * with its own origin as the referrer or none, so it cannot redeem a tab code of its own in the
 * visitor's browser. Pages on the app origin are the dashboard's own and never redirect to
 * artifact origins on input.
 */
function redeemable(kind: ReviewKind, request: Request, env: ReviewEnv): boolean {
  const headers = request.headers;
  if (headers.get("Sec-Fetch-Site") !== "cross-site") return false;
  if (headers.get("Sec-Fetch-Mode") !== "navigate") return false;
  if (kind === "frame") return headers.get("Sec-Fetch-Dest") === "iframe";
  return headers.get("Sec-Fetch-Dest") === "document" && refererOrigin(request) === env.APP_ORIGIN;
}

function refererOrigin(request: Request): string | null {
  const referer = request.headers.get("Referer");
  if (!referer || !URL.canParse(referer)) return null;
  return new URL(referer).origin;
}

/**
 * `/__portifact/review?code=…` (`kind` frame) and `/__portifact/review/tab?code=…` (`kind`
 * tab): redeems a code of that kind, sets the matching cookie and redirects to the matching
 * check path. See `redeemable` for who may redeem each.
 */
export async function handleReviewExchange(
  request: Request,
  env: ReviewEnv,
  db: Db,
  artifactId: string,
  now: number,
  kind: ReviewKind = "frame",
): Promise<ReviewStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "unavailable" };
  const failed: ReviewStep = { kind: "status", status: "failed", httpStatus: 400, setCookies: [] };
  if (!redeemable(kind, request, env)) return failed;
  const codes = new URL(request.url).searchParams.getAll("code");
  const code = codes.length === 1 ? OpaqueToken.safeParse(codes[0]) : null;
  if (!code?.success) return failed;
  const redeemed = await redeemReviewHandoff(db, { code: code.data, artifactId, kind, now });
  if (!redeemed.ok) return failed;
  const session = redeemed.value;
  const channel = kind === "tab" ? TAB : FRAME;
  return {
    kind: "redirect",
    location: `${new URL(request.url).origin}${kind === "tab" ? REVIEW_TAB_CHECK_PATH : REVIEW_CHECK_PATH}`,
    setCookies: [
      await claimsCookie(
        channel,
        secret,
        {
          sid: session.sessionId,
          aid: artifactId,
          vid: session.versionId,
          uid: session.userId,
          gen: session.policyGeneration,
          tag: session.sessionTag,
          sexp: session.expiresAt,
        },
        now,
      ),
    ],
  };
}

/**
 * `/__portifact/review/check` and `/__portifact/review/tab/check`: the exchange's redirect lands
 * here. With the cookie, review starts at the artifact's root; without it the browser dropped
 * the cookie, and the page says so (posting it to the viewer when framed).
 */
export async function handleReviewCheck(
  request: Request,
  env: ReviewEnv,
  artifactId: string,
  now: number,
  kind: ReviewKind = "frame",
): Promise<ReviewStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "unavailable" };
  const channel = kind === "tab" ? TAB : FRAME;
  const claims = channel.usable(request)
    ? await readClaims(channel, request, secret, artifactId, now)
    : null;
  if (!claims) return { kind: "status", status: "unavailable", httpStatus: 409, setCookies: [] };
  return { kind: "redirect", location: `${new URL(request.url).origin}/`, setCookies: [] };
}

/**
 * `/__portifact/review/end`: the review tab's "End review". Only a navigation from the artifact
 * itself (`same-origin`) ends anything, so another site or a sibling cannot end a visitor's
 * review. It deletes the session, so its claims are never renewed, and clears the cookie, so
 * the next request is a normal visit. Ending twice, or without a session, just clears the
 * cookie again. The artifact's own scripts can follow this link too, which only ends review.
 */
export async function handleReviewEnd(
  request: Request,
  env: ReviewEnv,
  db: Db,
  artifactId: string,
): Promise<ReviewStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "unavailable" };
  const headers = request.headers;
  if (
    request.method !== "GET" ||
    headers.get("Sec-Fetch-Site") !== "same-origin" ||
    headers.get("Sec-Fetch-Mode") !== "navigate"
  ) {
    return { kind: "end", done: false, setCookies: [] };
  }
  const claims = await sealedClaims(TAB, request, secret, artifactId);
  if (claims) await endReviewSession(db, { sessionId: claims.sid, artifactId });
  return { kind: "end", done: true, setCookies: [reviewTabCookie("", 0)] };
}
