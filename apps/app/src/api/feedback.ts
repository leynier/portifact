// GET /api/v1/feedback (premium plan T9): the open threads of every artifact of the caller's
// personal space, or of a workspace with `?workspace=<slug>`, newest activity first. The services
// decide what the caller sees with the per-artifact rules; a workspace needs the `workspaces`
// feature. The MCP tool list_open_feedback and `portifact feedback` return the same body. Bodies,
// quotes and author names are untrusted data written by reviewers.
import { FeedbackQuery } from "@portifact/contracts";
import { listOpenFeedback } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { feedbackPage } from "../mcp/present.ts";
import { ownerScope } from "../regions.ts";
import { error, type Guarded, workspaceParam } from "./http.ts";

export function feedbackRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/feedback",
    guarded("annotations:read", async (c, userId) => {
      const query = FeedbackQuery.safeParse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
        since: c.req.query("since") || undefined,
        mine: c.req.query("mine") || undefined,
      });
      if (!query.success) return error(c, "invalid_input", "Invalid cursor, limit, since or mine.");
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db, owner } = scope.value;
      const result = await listOpenFeedback(db, {
        actor,
        cursor: query.data.cursor,
        limit: query.data.limit,
        since: query.data.since === undefined ? undefined : Date.parse(query.data.since),
        mine: query.data.mine,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(feedbackPage(c.env, result.value, owner));
    }),
  );
}
