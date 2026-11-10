// The one-click unsubscribe of comment notices (docs/security.md, "Comment notices"):
// `POST /api/v1/notices/unsubscribe` turns comment notices off for the user a signed link names,
// without a session. Mail clients post `List-Unsubscribe=One-Click` to the URL of the email's
// `List-Unsubscribe` header (RFC 8058), the token in its query; the unsubscribe page on this
// origin (`/unsubscribe`) posts the token as JSON after a click. A `GET` changes nothing, so link
// scanners that prefetch the email's links cannot unsubscribe anyone. The token is the only
// authorization and changes only that one preference; requests are limited per IP, and the answer
// is the same whether or not the account still exists.
import { UnsubscribeInput, UnsubscribeResult, UnsubscribeToken } from "@portifact/contracts";
import { unsubscribeCommentNotices } from "@portifact/services";
import { Hono } from "hono";
import { checkLimits, type Limit } from "../auth/limits.ts";
import type { Env } from "../env.ts";
import { regionsOf } from "../regions.ts";
import { type ApiContext, error } from "./http.ts";

export const UNSUBSCRIBE_PATH = "/api/v1/notices/unsubscribe";

/** Requests per IP: a person clicks once or twice; anything more is guessing or a loop. */
export const UNSUBSCRIBE_LIMIT: Limit = { max: 30, windowSeconds: 600 };

/** Bytes of a request body: a token, or the one-click form field. */
const BODY_MAX_BYTES = 1_024;

/** The token from the query (one-click and the page's link) or a JSON body (the page). */
async function tokenOf(request: Request): Promise<string | undefined> {
  const fromQuery = new URL(request.url).searchParams.get("token");
  if (fromQuery !== null) return fromQuery;
  if (!request.headers.get("content-type")?.startsWith("application/json")) return undefined;
  const text = await request.text();
  if (text.length > BODY_MAX_BYTES) return undefined;
  try {
    const parsed = UnsubscribeInput.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.token : undefined;
  } catch {
    return undefined;
  }
}

export function noticeRoutes(deps: { now(): number }) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post(UNSUBSCRIBE_PATH, async (c: ApiContext) => {
    c.header("Cache-Control", "no-store");
    const now = deps.now();
    const ip = c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
    const limit = await checkLimits(
      c.env.DB,
      [{ key: `unsubscribe:ip:${ip}`, limit: UNSUBSCRIBE_LIMIT }],
      now,
    );
    if (!limit.ok) {
      const response = error(c, "rate_limited", "Too many requests. Try again later.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const secret = c.env.UNSUBSCRIBE_SECRET;
    if (!secret) {
      return error(
        c,
        "capacity_unavailable",
        "Unsubscribing is not available right now. Turn comment notices off in your settings.",
      );
    }
    const token = UnsubscribeToken.safeParse(await tokenOf(c.req.raw));
    const result = token.success
      ? await unsubscribeCommentNotices(regionsOf(c.env).global, {
          token: token.data,
          secret,
          now,
        })
      : null;
    if (!result?.ok) {
      return error(
        c,
        "invalid_input",
        result?.message ??
          "This unsubscribe link does not work any more. Turn comment notices off in your settings instead.",
      );
    }
    return c.json(UnsubscribeResult.parse(result.value));
  });

  return routes;
}
