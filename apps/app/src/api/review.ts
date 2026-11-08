// Review mode, the app's part (plan section 4, "Modo revisión"): the viewer at
// /review/<id> asks for a one-use review code and points its iframe at the artifact origin,
// which redeems it into a partitioned review session (apps/content/src/review.ts).
//
// Only the dashboard's session may ask, from the app's own pages: the code opens a browser
// session on the artifact origin, bound to the dashboard session that asked for it, so signing
// out ends it. Bearer tokens are refused, as on the account endpoints. Access is checked with
// the same rule as reading the artifact; a missing and a forbidden artifact look the same.
import { ArtifactId, ERROR_STATUS, type ErrorCode, ReviewStart } from "@portifact/contracts";
import { createDb } from "@portifact/db";
import { issueReviewHandoff } from "@portifact/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import { checkLimits, REVIEW_START_LIMIT } from "../auth/limits.ts";
import type { Env } from "../env.ts";
import { fromAppOrigin, hasSessionCookie } from "./access.ts";
import type { AccountSessionLookup } from "./account.ts";

export interface ReviewDeps {
  session(env: Env): AccountSessionLookup;
  now(): number;
}

type ReviewContext = Context<{ Bindings: Env }>;

export function reviewRoutes(deps: ReviewDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post("/api/v1/artifacts/:artifactId/review", async (c) => {
    c.header("Cache-Control", "no-store");
    const request = c.req.raw;
    if (request.headers.has("authorization")) {
      return error(c, "forbidden", "Review mode needs a dashboard session.");
    }
    if (!hasSessionCookie(request.headers.get("cookie"))) {
      return error(c, "unauthenticated", "Sign in to review this artifact.");
    }
    if (!fromAppOrigin(request, authUrls(c.env.APP_ORIGIN).origin)) {
      return error(c, "forbidden", "Cross-origin request refused.");
    }
    const session = await deps.session(c.env)(request);
    if (!session) return error(c, "unauthenticated", "Sign in to review this artifact.");

    const artifactId = c.req.param("artifactId");
    if (!ArtifactId.safeParse(artifactId).success) {
      return error(c, "not_found", "Artifact not found.");
    }
    const now = deps.now();
    const limit = await checkLimits(
      c.env.DB,
      [{ key: `review:user:${session.userId}`, limit: REVIEW_START_LIMIT }],
      now,
    );
    if (!limit.ok) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return error(c, "rate_limited", "Too many reviews opened. Try again in a few minutes.");
    }
    const issued = await issueReviewHandoff(createDb(c.env.DB), {
      artifactId,
      userId: session.userId,
      authSessionId: session.sessionId,
      now,
    });
    if (!issued.ok) return error(c, issued.code, issued.message);
    const origin = `https://${artifactId}.${c.env.CONTENT_DOMAIN}`;
    const url = new URL("/__portifact/review", origin);
    url.searchParams.set("code", issued.value.code);
    return c.json(
      ReviewStart.parse({
        artifactId,
        name: issued.value.name,
        type: issued.value.type,
        url: url.toString(),
        origin,
        versionId: issued.value.versionId,
        entrypoint: issued.value.entrypoint,
        sessionTag: issued.value.sessionTag,
        expiresAt: new Date(issued.value.expiresAt).toISOString(),
      }),
    );
  });

  return routes;
}

function error(c: ReviewContext, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}
