// Anonymous grants of artifact data (decision 0026, delivery 9, "Anonymous writers"): the consent
// control's facts and the one-use code for a visitor without an account, on a public artifact
// whose owner opened its data to anyone. No credentials: these routes never read a session or a
// bearer token, so a signed-in visitor's account plays no part. They answer only same-origin
// requests from the app's own pages (the grant page and the viewer), behind
// `DATA_ANONYMOUS_ENABLED`, and like any unknown route while it is off. The code needs a solved
// human check and is limited per network address (keyed by a hash of it, never the address) and
// per artifact; everything that does not open answers like a missing artifact.
import {
  AnonymousDataGrantCodeRequest,
  AnonymousDataGrantControl,
  ArtifactId,
  DataGrantCode,
} from "@portifact/contracts";
import {
  anonymousDataGrantControl,
  customDomainsServing,
  dataAnonymousEnabled,
  issueAnonymousDataGrantCode,
  pageWritesEnabled,
} from "@portifact/services";
import { Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import type { FetchLike } from "../auth/deps.ts";
import type { Env } from "../env.ts";
import { artifactDb } from "../regions.ts";
import { verifyTurnstile } from "../turnstile.ts";
import { type ApiContext, error, iso, readJson } from "./http.ts";

export const ANONYMOUS_GRANTS_PATH = "/api/v1/data/anonymous-grants";

export interface AnonymousGrantDeps {
  siteverify(env: Env): FetchLike;
  now(): number;
}

/** Only the app's own pages, never another site or a script without fetch metadata. */
function sameOrigin(c: ApiContext, write: boolean): boolean {
  const headers = c.req.raw.headers;
  if (headers.get("sec-fetch-site") !== "same-origin") return false;
  return !write || headers.get("origin") === authUrls(c.env.APP_ORIGIN).origin;
}

/** The custom host the page runs on, or null for its `.dev` host. Untrusted input. */
function requestedHost(c: ApiContext, artifactId: string, host: string | null | undefined) {
  return host === undefined || host === null || host === `${artifactId}.${c.env.CONTENT_DOMAIN}`
    ? null
    : host;
}

/** A hash of the request's network address: the per-address limit's key, never the address. */
async function addressKey(c: ApiContext): Promise<string> {
  const address = c.req.raw.headers.get("cf-connecting-ip") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function anonymousGrantRoutes(deps: AnonymousGrantDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get(`${ANONYMOUS_GRANTS_PATH}/:artifactId/control`, async (c: ApiContext) => {
    c.header("Cache-Control", "no-store");
    if (!dataAnonymousEnabled(c.env)) return error(c, "not_found", "Not found.");
    if (!sameOrigin(c, false)) return error(c, "forbidden", "Cross-origin request refused.");
    const artifactId = ArtifactId.safeParse(c.req.param("artifactId"));
    if (!artifactId.success) return error(c, "not_found", "Artifact not found.");
    const result = await anonymousDataGrantControl(await artifactDb(c.env, artifactId.data), {
      artifactId: artifactId.data,
      requestedHost: requestedHost(c, artifactId.data, c.req.query("host")),
      contentDomain: c.env.CONTENT_DOMAIN,
      customDomains: customDomainsServing(c.env),
      enabled: true,
      now: deps.now(),
    });
    if (!result.ok) return error(c, result.code, result.message);
    return c.json(AnonymousDataGrantControl.parse(result.value));
  });

  routes.post(ANONYMOUS_GRANTS_PATH, async (c: ApiContext) => {
    c.header("Cache-Control", "no-store");
    if (!dataAnonymousEnabled(c.env)) return error(c, "not_found", "Not found.");
    if (!sameOrigin(c, true)) return error(c, "forbidden", "Cross-origin request refused.");
    // An anonymous grant exists only to write: none while page writes are paused.
    if (!pageWritesEnabled(c.env)) {
      return error(c, "capacity_unavailable", "Saving from pages is paused. Try again later.");
    }
    const body = await readJson(c, AnonymousDataGrantCodeRequest, 4096);
    if (!body.ok) return body.response;
    const input = body.value;
    const verdict = await verifyTurnstile({
      secret: c.env.TURNSTILE_SECRET_KEY,
      token: input.turnstileToken,
      remoteIp: c.req.raw.headers.get("cf-connecting-ip") ?? undefined,
      fetch: deps.siteverify(c.env),
    });
    if (verdict === "unavailable") {
      return error(c, "capacity_unavailable", "The human check is unavailable. Try again later.");
    }
    if (verdict !== "passed") {
      return error(c, "human_verification_required", "Confirm you are human, then try again.");
    }
    const result = await issueAnonymousDataGrantCode(await artifactDb(c.env, input.artifactId), {
      artifactId: input.artifactId,
      nonceHash: input.nonceHash,
      requestedHost: requestedHost(c, input.artifactId, input.host),
      contentDomain: c.env.CONTENT_DOMAIN,
      customDomains: customDomainsServing(c.env),
      enabled: true,
      addressKey: await addressKey(c),
      now: deps.now(),
    });
    if (!result.ok) return error(c, result.code, result.message);
    const redeem = new URL(`https://${result.value.host}/__portifact/data/grant`);
    redeem.searchParams.set("flow", input.flow);
    redeem.searchParams.set("anon", "1");
    redeem.searchParams.set("code", result.value.code);
    return c.json(
      DataGrantCode.parse({
        code: result.value.code,
        redeemUrl: redeem.toString(),
        expiresAt: iso(result.value.expiresAt),
      }),
    );
  });

  return routes;
}
