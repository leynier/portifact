// Review mode, the app's part (plan section 4, "Modo revisión"): the viewer at
// /view/<id> asks for a one-use review code and points its iframe at the artifact origin,
// which redeems it into a partitioned review session (apps/content/src/review.ts). Where the
// browser drops that cookie, the viewer asks for a tab code instead and offers a link that opens
// the artifact in a top-level review tab with a short first-party session.
//
// Only the dashboard's session may ask, from the app's own pages: the code opens a browser
// session on the artifact origin, bound to the dashboard session that asked for it, so signing
// out ends it. Bearer tokens are refused, as on the account endpoints. Access is checked with
// the same rule as reading the artifact; a missing and a forbidden artifact look the same.
import {
  ArtifactId,
  ERROR_STATUS,
  type ErrorCode,
  REVIEW_SESSION,
  type ReviewKind,
  ReviewStart,
  ReviewTabStart,
  ViewerInfo,
} from "@portifact/contracts";
import { createDb } from "@portifact/db";
import {
  getViewerArtifact,
  type IssuedReviewHandoff,
  issueReviewHandoff,
} from "@portifact/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import { checkLimits, REVIEW_START_LIMIT, VIEWER_LOOKUP_LIMIT } from "../auth/limits.ts";
import type { Env } from "../env.ts";
import { fromAppOrigin, hasSessionCookie } from "./access.ts";
import type { AccountSessionLookup } from "./account.ts";

export interface ReviewDeps {
  session(env: Env): AccountSessionLookup;
  /**
   * The signed-in user of the viewer, or undefined: a session of an account that has not
   * accepted the current terms counts as none, like on the dashboard.
   */
  viewer(env: Env): (request: Request) => Promise<string | undefined>;
  now(): number;
}

type ReviewContext = Context<{ Bindings: Env }>;

export function reviewRoutes(deps: ReviewDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post("/api/v1/artifacts/:artifactId/review", async (c) => {
    const issued = await issue(c, deps, "frame");
    if (!issued.ok) return issued.response;
    const { artifactId, origin, value } = issued;
    return c.json(
      ReviewStart.parse({
        artifactId,
        name: value.name,
        type: value.type,
        url: exchangeUrl(origin, "/__portifact/review", value.code),
        origin,
        versionId: value.versionId,
        entrypoint: value.entrypoint,
        sessionTag: value.sessionTag,
        expiresAt: new Date(value.expiresAt).toISOString(),
      }),
    );
  });

  // The fallback for browsers that drop the frame's partitioned cookie: a code that only a
  // top-level navigation started from this app may redeem, into a short first-party session.
  routes.post("/api/v1/artifacts/:artifactId/review/tab", async (c) => {
    const issued = await issue(c, deps, "tab");
    if (!issued.ok) return issued.response;
    const { artifactId, origin, value } = issued;
    return c.json(
      ReviewTabStart.parse({
        artifactId,
        url: exchangeUrl(origin, "/__portifact/review/tab", value.code),
        origin,
        versionId: value.versionId,
        expiresAt: new Date(value.expiresAt).toISOString(),
        sessionSeconds: REVIEW_SESSION.tabSessionTtlSeconds,
      }),
    );
  });

  // What the viewer with the Portifact bar shows about the artifact. A dashboard helper with no
  // state, for the app's own pages only: it needs no session (anonymous visitors of a public
  // artifact see the bar too), so it refuses bearer tokens and anything that is not a
  // same-origin request, and a protected artifact answers 404 until the visitor signs in.
  routes.get("/api/v1/artifacts/:artifactId/viewer", async (c) => {
    c.header("Cache-Control", "no-store");
    const request = c.req.raw;
    if (request.headers.has("authorization")) {
      return error(c, "forbidden", "The viewer is part of the dashboard.");
    }
    if (request.headers.get("sec-fetch-site") !== "same-origin") {
      return error(c, "forbidden", "Cross-origin request refused.");
    }
    const artifactId = c.req.param("artifactId") ?? "";
    if (!ArtifactId.safeParse(artifactId).success) {
      return error(c, "not_found", "Artifact not found.");
    }
    // It answers without a session, so it is limited per IP like the other open endpoints.
    const now = deps.now();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limit = await checkLimits(
      c.env.DB,
      [{ key: `viewer:ip:${ip}`, limit: VIEWER_LOOKUP_LIMIT }],
      now,
    );
    if (!limit.ok) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return error(c, "rate_limited", "Too many artifacts opened. Try again in a few minutes.");
    }
    const userId = hasSessionCookie(request.headers.get("cookie"))
      ? ((await deps.viewer(c.env)(request)) ?? null)
      : null;
    const found = await getViewerArtifact(createDb(c.env.DB), { artifactId, userId, now });
    if (!found.ok) return error(c, found.code, found.message);
    return c.json(
      ViewerInfo.parse({
        artifactId,
        origin: `https://${artifactId}.${c.env.CONTENT_DOMAIN}`,
        ...found.value,
      }),
    );
  });

  return routes;
}

type Issued =
  | { ok: true; artifactId: string; origin: string; value: IssuedReviewHandoff }
  | { ok: false; response: Response };

/**
 * The checks every review code goes through: the dashboard session only (no bearer token), from
 * the app's own pages, within the per-account limit, and the same access rule as reading.
 */
async function issue(c: ReviewContext, deps: ReviewDeps, kind: ReviewKind): Promise<Issued> {
  c.header("Cache-Control", "no-store");
  const refuse = (code: ErrorCode, message: string): Issued => ({
    ok: false,
    response: error(c, code, message),
  });
  const request = c.req.raw;
  if (request.headers.has("authorization")) {
    return refuse("forbidden", "Review mode needs a dashboard session.");
  }
  if (!hasSessionCookie(request.headers.get("cookie"))) {
    return refuse("unauthenticated", "Sign in to review this artifact.");
  }
  if (!fromAppOrigin(request, authUrls(c.env.APP_ORIGIN).origin)) {
    return refuse("forbidden", "Cross-origin request refused.");
  }
  const session = await deps.session(c.env)(request);
  if (!session) return refuse("unauthenticated", "Sign in to review this artifact.");

  const artifactId = c.req.param("artifactId") ?? "";
  if (!ArtifactId.safeParse(artifactId).success) {
    return refuse("not_found", "Artifact not found.");
  }
  const now = deps.now();
  const limit = await checkLimits(
    c.env.DB,
    [{ key: `review:user:${session.userId}:${artifactId}`, limit: REVIEW_START_LIMIT }],
    now,
  );
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfterSeconds));
    return refuse(
      "rate_limited",
      "Too many reviews of this artifact opened. Try again in a few minutes.",
    );
  }
  const issued = await issueReviewHandoff(createDb(c.env.DB), {
    artifactId,
    userId: session.userId,
    authSessionId: session.sessionId,
    now,
    kind,
  });
  if (!issued.ok) return refuse(issued.code, issued.message);
  return {
    ok: true,
    artifactId,
    origin: `https://${artifactId}.${c.env.CONTENT_DOMAIN}`,
    value: issued.value,
  };
}

/** The exchange URL on the artifact origin, built from the validated ID, never from input. */
function exchangeUrl(origin: string, path: string, code: string): string {
  const url = new URL(path, origin);
  url.searchParams.set("code", code);
  return url.toString();
}

function error(c: ReviewContext, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}
