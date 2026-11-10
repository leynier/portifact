// GET /api/v1/artifacts/:id/access-log (plan sections 6 "Eventos", 11 and 13): the signed-in
// visitors who opened the artifact, newest first, for its owner only. The MCP tool
// get_access_logs returns the same body through `accessLogView`.
import { AccessLogQuery, AccessLogView } from "@portifact/contracts";
import { type AccessLogPage, getAccessLog } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { accessDbOf, artifactRegion } from "../regions.ts";
import { error, type Guarded, iso } from "./http.ts";

export function accessLogView(page: AccessLogPage): AccessLogView {
  return AccessLogView.parse({
    ...page,
    entries: page.entries.map((entry) => ({ ...entry, openedAt: iso(entry.openedAt) })),
  });
}

export function accessLogRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/artifacts/:artifactId/access-log",
    guarded("artifacts:read", async (c, userId) => {
      const query = AccessLogQuery.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
        since: c.req.query("since"),
      });
      if (!query.success) return error(c, "invalid_input", "Invalid cursor, limit or since.");
      const artifactId = c.req.param("artifactId") as string;
      const region = await artifactRegion(c.env, artifactId);
      const result = await getAccessLog(region.db, accessDbOf(region), {
        userId,
        artifactId,
        cursor: query.data.cursor,
        limit: query.data.limit,
        since: query.data.since === undefined ? undefined : Date.parse(query.data.since),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(accessLogView(result.value));
    }),
  );
}
