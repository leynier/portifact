// GET /api/v1/usage (plan section 6, "Uso"): the account's quotas, current counters, 24-hour
// windows and block reasons. The MCP tool get_usage returns the same body through `usageView`.
import { AccountUsageView } from "@portifact/contracts";
import { createDb } from "@portifact/db";
import { type AccountUsageReport, getAccountUsage } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { type Guarded, iso } from "./http.ts";

export function usageView(report: AccountUsageReport): AccountUsageView {
  return AccountUsageView.parse({
    ...report,
    newObjectsThisMonth: {
      ...report.newObjectsThisMonth,
      resetsAt: iso(report.newObjectsThisMonth.resetsAt),
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
      const report = await getAccountUsage(createDb(c.env.DB), { ownerId: userId, now: now() });
      return c.json(usageView(report));
    }),
  );
}
