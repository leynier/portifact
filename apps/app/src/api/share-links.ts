// Share links (premium plan P4, decision 0008). The owner's routes under
// /api/v1/artifacts/:id/share-links create, list and revoke links (scope `artifacts:share`, like
// every widening of access; the MCP tools and `portifact share` call the same services and
// present them the same way). `POST /api/v1/share/open` is the visitor's: it takes no
// credentials, like the report endpoint, and answers the entry page on this origin only.
import {
  ERROR_STATUS,
  type ErrorCode,
  SHARE_LINKS,
  SHARE_OPEN_LIMITS,
  ShareLinkCreate,
  ShareLinkCreated,
  ShareLinkList,
  ShareLinkRevoked,
  ShareLinkView,
  ShareOpenInput,
  ShareOpenResult,
  shareLinkUrl,
} from "@portifact/contracts";
import { hitRateLimit, peekRateLimit } from "@portifact/db";
import { passwordGate, SHARE_MESSAGES } from "@portifact/domain";
import {
  createShareLink,
  hashSecret,
  listShareLinks,
  openShareLink,
  revokeShareLink,
  type ShareLinkListing,
  type ShareLinkRow,
} from "@portifact/services";
import { Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import type { FetchLike } from "../auth/deps.ts";
import { checkLimits } from "../auth/limits.ts";
import type { Env } from "../env.ts";
import { artifactDb, defaultDb } from "../regions.ts";
import { verifyTurnstile } from "../turnstile.ts";
import { type ApiContext, error, type Guarded, iso, readJson } from "./http.ts";

export const SHARE_OPEN_PATH = "/api/v1/share/open";

export function shareLinkView(row: ShareLinkRow): ShareLinkView {
  return ShareLinkView.parse({
    id: row.id,
    label: row.label,
    state: row.state,
    hasPassword: row.hasPassword,
    createdAt: iso(row.createdAt),
    expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
    lastUsedOn: row.lastUsedAt === null ? null : iso(row.lastUsedAt).slice(0, 10),
  });
}

export function shareLinkListView(listing: ShareLinkListing): ShareLinkList {
  return ShareLinkList.parse({
    artifactId: listing.artifactId,
    enabled: listing.enabled,
    links: listing.links.map(shareLinkView),
    activeLimit: SHARE_LINKS.activePerArtifact,
  });
}

export function shareLinkCreatedView(
  env: Pick<Env, "APP_ORIGIN">,
  created: { link: ShareLinkRow; token: string },
): ShareLinkCreated {
  return ShareLinkCreated.parse({
    link: shareLinkView(created.link),
    url: shareLinkUrl(authUrls(env.APP_ORIGIN).origin, created.token),
  });
}

/** The owner's routes, through `guarded` like every /api/v1 route. */
export function shareLinkRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  // No idempotency key: a stored replay would keep the token in D1. A retry makes a second link.
  api.post(
    "/api/v1/artifacts/:artifactId/share-links",
    guarded("artifacts:share", async (c, userId) => {
      const body = await readJson(c, ShareLinkCreate, 2048);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const result = await createShareLink(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        label: body.value.label,
        expiresAt: body.value.expiresAt === undefined ? null : Date.parse(body.value.expiresAt),
        password: body.value.password,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(shareLinkCreatedView(c.env, result.value), 201);
    }),
  );

  api.get(
    "/api/v1/artifacts/:artifactId/share-links",
    guarded("artifacts:share", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await listShareLinks(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(shareLinkListView(result.value));
    }),
  );

  api.delete(
    "/api/v1/artifacts/:artifactId/share-links/:linkId",
    guarded("artifacts:share", async (c, userId) => {
      const artifactId = c.req.param("artifactId") as string;
      const result = await revokeShareLink(await artifactDb(c.env, artifactId), {
        userId,
        artifactId,
        linkId: c.req.param("linkId") as string,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(ShareLinkRevoked.parse({ id: result.value.id, revoked: true }));
    }),
  );
}

export interface ShareOpenDeps {
  siteverify(env: Env): FetchLike;
  now(): number;
}

/**
 * The visitor's route. It never reads a session or a bearer token, so a signed-in visitor's
 * account plays no part. Counters are keyed by the IP and by a prefix of the token's hash (never
 * the token), so unknown tokens are limited exactly like real ones.
 */
export function shareOpenRoutes(deps: ShareOpenDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post(SHARE_OPEN_PATH, async (c: ApiContext) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex");
    const request = c.req.raw;
    if (
      request.headers.get("origin") !== authUrls(c.env.APP_ORIGIN).origin ||
      request.headers.get("sec-fetch-site") !== "same-origin"
    ) {
      return error(c, "forbidden", "Cross-origin request refused.");
    }
    const now = deps.now();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const perIp = await checkLimits(
      c.env.DB,
      [{ key: `share:ip:${ip}`, limit: SHARE_OPEN_LIMITS.perIp }],
      now,
    );
    if (!perIp.ok) return limited(c, perIp.retryAfterSeconds);

    const body = await readJson(c, ShareOpenInput, SHARE_LINKS.openBodyMaxBytes);
    if (!body.ok) return refuse(c, "not_found", SHARE_MESSAGES.unavailable);
    const { token, password, turnstileToken } = body.value;

    const windowMs = SHARE_OPEN_LIMITS.failureWindowSeconds * 1000;
    const tokenKey = `share:fail:${(await hashSecret(token)).slice(0, 32)}`;
    const ipKey = `share:ipfail:${ip}`;
    if (password !== undefined) {
      const [tokenFailures, ipFailures] = await Promise.all([
        peekRateLimit(c.env.DB, tokenKey, windowMs, now),
        peekRateLimit(c.env.DB, ipKey, windowMs, now),
      ]);
      const gate = passwordGate({ token: tokenFailures.count, ip: ipFailures.count });
      if (gate === "locked") {
        const resetAt = Math.max(tokenFailures.resetAt, ipFailures.resetAt);
        const response = refuse(c, "rate_limited", SHARE_MESSAGES.locked);
        response.headers.set("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
        return response;
      }
      if (gate === "human_check") {
        const verdict = turnstileToken
          ? await verifyTurnstile({
              secret: c.env.TURNSTILE_SECRET_KEY,
              token: turnstileToken,
              remoteIp: request.headers.get("cf-connecting-ip") ?? undefined,
              fetch: deps.siteverify(c.env),
            })
          : "failed";
        if (verdict === "unavailable") {
          return refuse(
            c,
            "capacity_unavailable",
            "The human check is unavailable. Try again later.",
          );
        }
        if (verdict !== "passed") {
          return refuse(c, "human_verification_required", SHARE_MESSAGES.humanCheck);
        }
      }
    }

    const outcome = await openShareLink(defaultDb(c.env), { token, password, now });
    switch (outcome.kind) {
      case "opened": {
        const location = new URL(
          `https://${outcome.artifactId}.${c.env.CONTENT_DOMAIN}/__portifact/link`,
        );
        location.searchParams.set("code", outcome.code);
        return c.json(ShareOpenResult.parse({ location: location.toString() }));
      }
      case "password_required":
        return refuse(c, "unauthenticated", SHARE_MESSAGES.passwordRequired);
      case "unavailable":
        return refuse(c, "not_found", SHARE_MESSAGES.unavailable);
      case "refused":
        await Promise.all([
          hitRateLimit(c.env.DB, tokenKey, windowMs, now),
          hitRateLimit(c.env.DB, ipKey, windowMs, now),
        ]);
        return refuse(c, "forbidden", SHARE_MESSAGES.refused);
    }
  });

  return routes;
}

/** Every refusal of the entry: the shared error body, never mentioning the token. */
function refuse(c: ApiContext, code: ErrorCode, message: string): Response {
  return c.json({ error: { code, message } }, ERROR_STATUS[code] as 400);
}

function limited(c: ApiContext, retryAfterSeconds: number): Response {
  const response = refuse(c, "rate_limited", "Too many requests. Try again later.");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}
