// The public abuse channel (plan section 13): `POST /api/v1/reports` takes a report from anyone,
// signed in or not, sent by the report page on this origin (`/report`). It needs no credentials,
// so it accepts only the app's own pages (exact Origin and same-origin fetch metadata, which a
// sibling artifact cannot fake, and a JSON body, which a cross-site form cannot send), limits
// requests per IP, per artifact and globally in the D1 counters, and answers the same whether
// or not the artifact exists.
import {
  AbuseReportInput,
  AbuseReportReceipt,
  REPORT_LIMITS,
  reportedArtifactId,
} from "@portifact/contracts";
import { regionsOf } from "../regions.ts";
import { submitAbuseReport } from "@portifact/services";
import { Hono } from "hono";
import { authUrls } from "../auth/config.ts";
import { checkLimits } from "../auth/limits.ts";
import type { Env } from "../env.ts";
import { type ApiContext, error, readJson } from "./http.ts";

export const REPORTS_PATH = "/api/v1/reports";

export function reportRoutes(deps: { now(): number }) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post(REPORTS_PATH, async (c: ApiContext) => {
    c.header("Cache-Control", "no-store");
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
      [{ key: `report:ip:${ip}`, limit: REPORT_LIMITS.perIp }],
      now,
    );
    if (!perIp.ok) return limited(c, perIp.retryAfterSeconds);

    const body = await readJson(c, AbuseReportInput, REPORT_LIMITS.bodyMaxBytes);
    if (!body.ok) return body.response;
    const artifactId = reportedArtifactId(body.value.artifact, c.env.CONTENT_DOMAIN);
    if (!artifactId) {
      return error(c, "invalid_input", "artifact: Enter the artifact's address or ID.");
    }
    const wider = await checkLimits(
      c.env.DB,
      [
        { key: `report:artifact:${artifactId}`, limit: REPORT_LIMITS.perArtifact },
        { key: "report:global", limit: REPORT_LIMITS.global },
      ],
      now,
    );
    if (!wider.ok) return limited(c, wider.retryAfterSeconds);

    await submitAbuseReport(regionsOf(c.env).global, {
      artifactId,
      reason: body.value.reason,
      details: body.value.details,
      email: body.value.email,
      now,
    });
    return c.json(AbuseReportReceipt.parse({ received: true }), 202);
  });

  return routes;
}

function limited(c: ApiContext, retryAfterSeconds: number): Response {
  const response = error(c, "rate_limited", "Too many reports. Try again later.");
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}
