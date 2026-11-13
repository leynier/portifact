// POST /api/v1/artifacts/:artifactId/previews: a one-use URL on the preview origin for a stored
// plan of an edit suggestion (decision 0027, "Previews"). Behind `SUGGESTIONS_ENABLED`; a dashboard
// helper for the viewer, so only the dashboard's session from the app's own pages may ask (the
// code is bound to that session), never a bearer token, and there is no MCP tool or CLI command.
// Who may get a code is decided only by the service (`issuePreviewCode`).
import { ArtifactId, PreviewRequest, PreviewResponse } from "@portifact/contracts";
import { suggestionsEnabled } from "@portifact/domain";
import { issuePreviewCode } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { artifactRegion } from "../regions.ts";
import type { AccountSessionLookup } from "./account.ts";
import { error, type Guarded, readJson } from "./http.ts";

export interface SuggestionPreviewDeps {
  /** The dashboard session behind a request, with its own ID. */
  accountSession?(env: Env): AccountSessionLookup;
  now(): number;
}

export function suggestionPreviewRoutes(
  api: Hono<{ Bindings: Env }>,
  guarded: Guarded,
  deps: SuggestionPreviewDeps,
) {
  api.post("/api/v1/artifacts/:artifactId/previews", async (c) => {
    // Switched off, the route does not exist.
    if (!suggestionsEnabled(c.env)) return error(c, "not_found", "Not found.");
    // Session only: a bearer token is refused before it is even checked.
    if (c.req.raw.headers.has("authorization")) {
      return error(c, "forbidden", "Previews are part of the dashboard.");
    }
    return guarded("annotations:write", async (c, userId) => {
      // `guarded` admitted the session from the app's own pages; the code is bound to its ID.
      const session = await deps.accountSession?.(c.env)(c.req.raw);
      if (!session || session.userId !== userId || !session.termsAccepted) {
        return error(c, "unauthenticated", "Sign in to preview suggestions.");
      }
      const artifactId = c.req.param("artifactId") as string;
      if (!ArtifactId.safeParse(artifactId).success) {
        return error(c, "not_found", "Artifact not found.");
      }
      const body = await readJson(c, PreviewRequest, 1_024);
      if (!body.ok) return body.response;
      const handles = await artifactRegion(c.env, artifactId);
      if (!handles.bucket) return error(c, "capacity_unavailable", "Previews are unavailable.");
      const issued = await issuePreviewCode(handles.db, handles.bucket, {
        userId,
        sessionId: session.sessionId,
        artifactId,
        digest: body.value.digest,
        now: deps.now(),
        contentDomain: c.env.CONTENT_DOMAIN,
      });
      if (!issued.ok) return error(c, issued.code, issued.message);
      const value = issued.value;
      return c.json(
        PreviewResponse.parse(
          value.state === "ready"
            ? { state: "ready", url: value.url, expiresAt: new Date(value.expiresAt).toISOString() }
            : value,
        ),
      );
    })(c);
  });
}
