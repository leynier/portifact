// GET /api/v1/search (premium plan T8, decision 0012): searching inside the text of the current
// versions of a space's active artifacts, for its admins and editors (or a service token within
// its reach) on a plan with content search. `?workspace=<slug>` names the space like on
// GET /api/v1/artifacts. The MCP tool search_content and `portifact search` return the same body.
import { type OwnerView, SearchQuery, SearchResults } from "@portifact/contracts";
import { type SearchPage, searchContent } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { artifactListItem } from "../mcp/present.ts";
import { ownerScope } from "../regions.ts";
import { error, type Guarded, workspaceParam } from "./http.ts";

export function searchResults(env: Env, page: SearchPage, owner: OwnerView): SearchResults {
  return SearchResults.parse({
    items: page.items.map((hit) => ({
      artifact: artifactListItem(env, hit.artifact, owner),
      path: hit.path,
      snippet: hit.snippet,
      partial: hit.partial,
    })),
    nextCursor: page.nextCursor,
  });
}

export function searchRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.get(
    "/api/v1/search",
    guarded("artifacts:read", async (c, userId) => {
      const query = SearchQuery.safeParse({
        q: c.req.query("q"),
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      if (!query.success) return error(c, "invalid_input", "Invalid q, cursor or limit.");
      const workspace = workspaceParam(c);
      if (!workspace.ok) return error(c, "not_found", "Workspace not found.");
      const scope = await ownerScope(c.env, userId, workspace.slug);
      if (!scope.ok) return error(c, scope.code, scope.message);
      const { actor, db, owner } = scope.value;
      const page = await searchContent(db, {
        actor,
        query: query.data.q,
        cursor: query.data.cursor,
        limit: query.data.limit,
        now: now(),
      });
      if (!page.ok) return error(c, page.code, page.message);
      return c.json(searchResults(c.env, page.value, owner));
    }),
  );
}
