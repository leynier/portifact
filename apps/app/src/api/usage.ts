// GET /api/v1/usage (plan section 6, "Uso"): the account's quotas, current counters, 24-hour
// windows and block reasons. The MCP tool get_usage returns the same body through `usageView`.
import { AccountUsageView } from "@portifact/contracts";
import { personalScope } from "../regions.ts";
import { type AccountUsageReport, getAccountUsage, planView } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { error, type Guarded, iso } from "./http.ts";

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

export function usageRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/usage",
    guarded("artifacts:read", async (c, userId) => {
      const { actor, db } = await personalScope(c.env, userId);
      const report = await getAccountUsage(db, { actor, now: now() });
      if (!report.ok) return error(c, report.code, report.message);
      return c.json(usageView(report.value));
    }),
  );
}
