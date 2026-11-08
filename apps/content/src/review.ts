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
import { OpaqueToken, REVIEW_SESSION, ReviewClaims } from "@portifact/contracts";
import type { Db } from "@portifact/db";
import { redeemReviewHandoff, refreshReviewSession } from "@portifact/services";
import { cookieValue, seal, unseal, usableSecret } from "./cookies.ts";
import type { ServableArtifact } from "./read-session.ts";

export const REVIEW_COOKIE = "__Host-pf_review";
export const REVIEW_PATH = "/__portifact/review";
export const REVIEW_CHECK_PATH = "/__portifact/review/check";

const SECOND_MS = 1000;
const REVIEW_PURPOSE = "pf_review";

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
  /** Serve the pinned version in review mode; `sessionTag` goes to the bridge. */
  | {
      kind: "review";
      artifact: ServableArtifact;
      versionId: string;
      sessionTag: string;
      setCookies: string[];
    }
  /** The session is over: tell the viewer, and drop the cookie. */
  | { kind: "status"; status: ReviewStatus; httpStatus: number; setCookies: string[] };

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
 * Whether a request may use the review cookie: the artifact's own requests (`same-origin`) and
 * the viewer's navigation of its iframe (`cross-site` and `navigate`). Siblings are always
 * `same-site`. Without fetch metadata the cookie is not used at all.
 */
export function reviewCookieUsable(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  return (
    site === "same-origin" ||
    (site === "cross-site" && request.headers.get("Sec-Fetch-Mode") === "navigate")
  );
}

async function claimsCookie(
  secret: string,
  claims: Omit<ReviewClaims, "v" | "exp">,
  now: number,
): Promise<string> {
  const value = await seal(secret, REVIEW_PURPOSE, {
    v: 1,
    ...claims,
    exp: Math.min(now + REVIEW_SESSION.claimsTtlSeconds * SECOND_MS, claims.sexp),
  } satisfies ReviewClaims);
  return reviewCookie(value, (claims.sexp - now) / SECOND_MS);
}

async function readClaims(
  request: Request,
  secret: string,
  artifactId: string,
  now: number,
): Promise<ReviewClaims | null> {
  const value = cookieValue(request.headers.get("Cookie"), REVIEW_COOKIE);
  if (!value) return null;
  const parsed = ReviewClaims.safeParse(await unseal(secret, REVIEW_PURPOSE, value));
  if (!parsed.success) return null;
  return parsed.data.aid === artifactId && parsed.data.sexp > now ? parsed.data : null;
}

const ended = (): ReviewDecision => ({
  kind: "status",
  status: "ended",
  httpStatus: 401,
  setCookies: [clearReviewCookie()],
});

/**
 * Decides whether a request is served in review mode. Claims are trusted without D1 while they
 * are unexpired and the artifact's policy generation is unchanged; after that the session, the
 * app session it came from and the access policy are checked again. The pinned version must
 * still be the artifact's current version.
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
  if (!usableSecret(secret) || !reviewCookieUsable(request)) return { kind: "none" };
  const claims = await readClaims(request, secret, artifactId, now);
  if (!claims) return { kind: "none" };
  if (!artifact || artifact.currentVersionId !== claims.vid) return ended();
  if (claims.exp > now && claims.gen === artifact.policyGeneration) {
    return {
      kind: "review",
      artifact,
      versionId: claims.vid,
      sessionTag: claims.tag,
      setCookies: [],
    };
  }
  const renewed = await refreshReviewSession(db, { sessionId: claims.sid, artifactId, now });
  if (
    !renewed.ok ||
    renewed.value.userId !== claims.uid ||
    renewed.value.versionId !== claims.vid
  ) {
    return ended();
  }
  const cookie = await claimsCookie(
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
  return {
    kind: "review",
    artifact,
    versionId: claims.vid,
    sessionTag: claims.tag,
    setCookies: [cookie],
  };
}

/** A redirect or a status page answered on the reserved review paths. */
export type ReviewStep =
  | { kind: "redirect"; location: string; setCookies: string[] }
  | { kind: "status"; status: ReviewStatus; httpStatus: number; setCookies: string[] }
  | { kind: "unavailable" };

/**
 * `/__portifact/review?code=…`: redeems the viewer's code. Only a cross-site iframe navigation
 * qualifies (`cross-site`, `navigate`, `iframe`), which stops a top-level visit or a sibling
 * artifact's direct request. It does not prove the viewer started it: an artifact framed in the
 * viewer can open an iframe to a redirector on another site that lands here with a code of its
 * own, and that arrives with the same metadata, planting its review session in the viewer's
 * partition. The session's tag, which the bridge echoes and the viewer compares with the one it
 * got with its code, is what exposes such a session.
 */
export async function handleReviewExchange(
  request: Request,
  env: ReviewEnv,
  db: Db,
  artifactId: string,
  now: number,
): Promise<ReviewStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "unavailable" };
  const failed: ReviewStep = { kind: "status", status: "failed", httpStatus: 400, setCookies: [] };
  const headers = request.headers;
  if (
    headers.get("Sec-Fetch-Site") !== "cross-site" ||
    headers.get("Sec-Fetch-Mode") !== "navigate" ||
    headers.get("Sec-Fetch-Dest") !== "iframe"
  ) {
    return failed;
  }
  const codes = new URL(request.url).searchParams.getAll("code");
  const code = codes.length === 1 ? OpaqueToken.safeParse(codes[0]) : null;
  if (!code?.success) return failed;
  const redeemed = await redeemReviewHandoff(db, { code: code.data, artifactId, now });
  if (!redeemed.ok) return failed;
  const session = redeemed.value;
  return {
    kind: "redirect",
    location: `${new URL(request.url).origin}${REVIEW_CHECK_PATH}`,
    setCookies: [
      await claimsCookie(
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
 * `/__portifact/review/check`: the exchange's redirect lands here. With the cookie, review
 * starts at the artifact's root; without it the browser dropped the partitioned cookie, and the
 * viewer is told so it can offer general comments instead.
 */
export async function handleReviewCheck(
  request: Request,
  env: ReviewEnv,
  artifactId: string,
  now: number,
): Promise<ReviewStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) return { kind: "unavailable" };
  const claims = reviewCookieUsable(request)
    ? await readClaims(request, secret, artifactId, now)
    : null;
  if (!claims) return { kind: "status", status: "unavailable", httpStatus: 409, setCookies: [] };
  return { kind: "redirect", location: `${new URL(request.url).origin}/`, setCookies: [] };
}
