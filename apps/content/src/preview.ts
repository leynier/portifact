// The preview origin of edit suggestions (decision 0027, "Previews"): `preview.<content domain>`,
// a reserved host no artifact ID can name, answered before any artifact lookup. It shows untrusted
// content built by the app, so it carries no credentials and changes nothing but the one-use code
// it redeems: it reads no cookie, sets none, charges no traffic, logs no opening or view, and
// never applies a custom domain, a share link, a read or review session or the viewer redirect.
// Only `GET /p/<code>` from a frame is served; everything else gets the same refusal.
import { PREVIEW_CODES, previewHost, requestContextOf } from "@portifact/contracts";
import { regionsFromEnv, withRequestContext } from "@portifact/db";
import { PREVIEW_POLICY, previewHeaders } from "@portifact/domain/suggestions";
import { redeemPreviewCode } from "@portifact/services";
import type { Env } from "./index.ts";

/** Whether a request is for the preview host of this deployment's content domain. */
export function isPreviewHost(hostname: string, contentDomain: string): boolean {
  return hostname === previewHost(contentDomain);
}

const REFUSED = "This preview has expired or was already used";

/** The one refusal of the host: plain text, nothing to run, load or cache, no cookie. */
function refusal(env: Env, status: 404 | 405): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Security-Policy": `${PREVIEW_POLICY}; frame-ancestors ${env.APP_ORIGIN}; sandbox`,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (status === 405) headers.Allow = "GET";
  return new Response(REFUSED, { status, headers });
}

/**
 * Answers a request on the preview host. A code is redeemed only by a frame's `GET`, so a link
 * opened in a tab, a prefetch or a subresource never spends it, and a refused request reads
 * nothing but its own headers.
 */
export async function handlePreview(request: Request, env: Env, now: number): Promise<Response> {
  if (request.method !== "GET") return refusal(env, 405);
  const url = new URL(request.url);
  if (url.search !== "") return refusal(env, 404);
  if (!url.pathname.startsWith(PREVIEW_CODES.pathPrefix)) return refusal(env, 404);
  if (request.headers.get("Sec-Fetch-Dest") !== "iframe") return refusal(env, 404);
  const code = url.pathname.slice(PREVIEW_CODES.pathPrefix.length);
  // The request context (decision 0020): the re-check reaches `actorOn`, which applies a
  // workspace's network policy to this request.
  const regions = regionsFromEnv(withRequestContext(env, requestContextOf(request)));
  const document = await redeemPreviewCode(regions, code, now);
  if (document === undefined) return refusal(env, 404);
  return new Response(document, { status: 200, headers: previewHeaders(env.APP_ORIGIN) });
}
