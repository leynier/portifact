// GET /api/v1/usage (plan section 6, "Uso"): the account's quotas, current counters, 24-hour
// windows and block reasons. The MCP tool get_usage returns the same body through `usageView`.
import { AccountUsageView, GraceForecastView } from "@portifact/contracts";
import { regionsFromEnv } from "@portifact/db";
import {
  type AccountUsageReport,
  type GraceForecast,
  getAccountUsage,
  getGraceForecast,
  planView,
} from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { accessDbOf, ownerScope } from "../regions.ts";
import { error, type Guarded, iso, workspaceParam } from "./http.ts";

export function usageView(report: AccountUsageReport): AccountUsageView {
  return AccountUsageView.parse({
    ...report,
    plan: planView(report.plan),
    newObjectsThisMonth: {
      ...report.newObjectsThisMonth,
      resetsAt: iso(report.newObjectsThisMonth.resetsAt),
    },
    trafficThisMonth: {
      ...report.trafficThisMonth,
      resetsAt: iso(report.trafficThisMonth.resetsAt),
    },
    publicAccessFrom: iso(report.publicAccessFrom),
    blocks: report.blocks.map((block) => ({
      ...block,
      until: block.until === null ? null : iso(block.until),
    })),
  });
}

/** What a running grace will let go, as `GET /api/v1/grace-forecast` shows it. */
export function graceForecastView(forecast: GraceForecast): GraceForecastView {
  return GraceForecastView.parse({
    ownerId: forecast.ownerId,
    grace: planView(forecast.owner).grace ?? null,
    kinds: forecast.kinds.map((kind) => ({ ...kind, from: iso(kind.from) })),
  });
}

export function usageRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/usage",
    guarded("artifacts:read", async (c, userId) => {
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      const report = await getAccountUsage(db, { actor, now: now() });
      if (!report.ok) return error(c, report.code, report.message);
      return c.json(usageView(report.value));
    }),
  );

  // The space's "Download your data" page (decision 0022): what a running grace will let go, as
  // counts and dates. A read like the usage body (`usage`); the dashboard and the CLI read it, and
  // MCP has no tool for it: moving a space's data out is not something an agent does inline.
  api.get(
    "/api/v1/grace-forecast",
    guarded("artifacts:read", async (c, userId) => {
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db } = scope.value;
      const access = accessDbOf(regionsFromEnv(c.env).get(actor.region));
      const forecast = await getGraceForecast(db, access, { actor, now: now() });
      if (!forecast.ok) return error(c, forecast.code, forecast.message);
      return c.json(graceForecastView(forecast.value));
    }),
  );
}
