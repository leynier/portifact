// The GitHub Actions OIDC exchange (decision 0024): `POST /api/v1/github/token` takes a run's ID
// token and answers a short-lived service token, or one refusal whatever the reason. It takes no
// credentials, so it is rate limited per IP before anything else and per repository once the
// token is verified. Switched off (404) without `GITHUB_OIDC_ENABLED="true"`.
//
// D1 calls: a token that fails verification costs one (its address's failure counter); a
// verified token costs one batch of its address's and its repository's counters, the read of
// the workspace, rule and plan, and the batch that issues: three. Pinned in
// test/github-oidc-cost.test.ts.
import {
  GITHUB_EXCHANGE_REFUSED,
  GITHUB_TRUST,
  GitHubTokenExchange,
  GitHubTokenExchanged,
  githubAudience,
} from "@portifact/contracts";
import { hitRateLimit, hitRateLimits } from "@portifact/db";
import { type GitHubRefusal, logEvent } from "@portifact/domain";
import { exchangeGitHubToken, type SsoFetch } from "@portifact/services";
import { Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import { githubOidcEnabled, verifyGitHubToken } from "../auth/github-oidc.ts";
import type { Env } from "../env.ts";
import { regionsOf } from "../regions.ts";
import { type ApiContext, error, iso, readJson } from "./http.ts";

export const GITHUB_TOKEN_PATH = "/api/v1/github/token";

export interface GitHubOidcDeps {
  /** Fetches GitHub's key set; tests and the e2e stack inject a fake issuer. */
  fetch(env: Env): SsoFetch;
  now(): number;
}

function refused(c: ApiContext, reason: GitHubRefusal): Response {
  logEvent("warn", "github_oidc_refused", { reason });
  return c.json({ error: { code: "unauthenticated", message: GITHUB_EXCHANGE_REFUSED } }, 401);
}

function limited(c: ApiContext, resetAt: number, now: number): Response {
  logEvent("warn", "github_oidc_refused", { reason: "rate_limited" });
  const response = error(c, "rate_limited", "Too many token exchanges. Try again later.");
  response.headers.set("Retry-After", String(Math.max(1, Math.ceil((resetAt - now) / 1000))));
  return response;
}

export function githubOidcRoutes(deps: GitHubOidcDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post(GITHUB_TOKEN_PATH, async (c: ApiContext) => {
    c.header("Cache-Control", "no-store");
    if (!githubOidcEnabled(c.env)) return c.notFound();
    const now = deps.now();
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    // Requests that fail before verification are counted on their own, lower budget, after the
    // check: junk from an address (GitHub-hosted runners share them) never spends what a verified
    // exchange from the same address needs, and never keeps one from being verified.
    const failed = async (reason: GitHubRefusal) => {
      const hit = await hitRateLimit(
        c.env.DB,
        `github-oidc:ipfail:${ip}`,
        GITHUB_TRUST.rateWindowMs,
        now,
      );
      if (hit.count > GITHUB_TRUST.perIpFailureLimit) return limited(c, hit.resetAt, now);
      return refused(c, reason);
    };

    const body = await readJson(c, GitHubTokenExchange, GITHUB_TRUST.bodyMaxBytes);
    if (!body.ok) return failed("malformed");
    const audience = githubAudience(authUrls(c.env.APP_ORIGIN).origin, body.value.workspace);
    const verified = await verifyGitHubToken(deps.fetch(c.env), body.value.token, audience, now);
    if (!verified.ok) {
      if (verified.reason === "jwks_unavailable") {
        logEvent("error", "github_oidc_jwks_unavailable");
      }
      return failed(verified.reason);
    }
    const { claims } = verified;
    const [perIp, perRepository] = await hitRateLimits(
      c.env.DB,
      [`github-oidc:ip:${ip}`, `github-oidc:repo:${claims.repositoryId}`],
      GITHUB_TRUST.rateWindowMs,
      now,
    );
    if (perIp && perIp.count > GITHUB_TRUST.perIpLimit) return limited(c, perIp.resetAt, now);
    if (perRepository && perRepository.count > GITHUB_TRUST.perRepositoryLimit) {
      return limited(c, perRepository.resetAt, now);
    }
    const issued = await exchangeGitHubToken(regionsOf(c.env).global, {
      slug: body.value.workspace,
      claims,
      now,
    });
    if (!issued.ok) return refused(c, issued.reason);
    logEvent("log", "github_oidc_issued");
    return c.json(
      GitHubTokenExchanged.parse({
        token: issued.secret,
        expiresAt: iso(issued.expiresAt),
        workspace: issued.workspace,
        keyPrefix: issued.keyPrefix,
        scopes: issued.scopes,
      }),
    );
  });

  return routes;
}
