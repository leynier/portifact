// POST /api/v1/documents/preview: renders a Markdown or TXT source the way a commit would, for
// the dashboard's document editor (plan section 6, "Documento"). Nothing is stored. Rendering is
// CPU work, so each user has a budget per window in the D1 rate-limit counters.
import {
  DocumentPreview,
  DocumentPreviewRequest,
  LIMITS,
  PREVIEW_LIMIT,
} from "@portifact/contracts";
import { hitRateLimit } from "@portifact/db";
import { previewDocument } from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { error, type Guarded, readJson } from "./http.ts";

/** A JSON string can escape each source byte into at most six characters. */
const MAX_BODY_BYTES = LIMITS.documentBytes * 6 + 4_096;

export function documentRoutes(api: Hono<{ Bindings: Env }>, guarded: Guarded, now: () => number) {
  api.post(
    "/api/v1/documents/preview",
    guarded("artifacts:write", async (c, userId) => {
      const at = now();
      const hit = await hitRateLimit(c.env.DB, `preview:${userId}`, PREVIEW_LIMIT.windowMs, at);
      if (hit.count > PREVIEW_LIMIT.requests) {
        const response = error(c, "rate_limited", "Too many previews. Wait a moment.");
        response.headers.set(
          "Retry-After",
          String(Math.max(1, Math.ceil((hit.resetAt - at) / 1000))),
        );
        return response;
      }
      const body = await readJson(c, DocumentPreviewRequest, MAX_BODY_BYTES);
      if (!body.ok) return body.response;
      const result = previewDocument(body.value);
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(DocumentPreview.parse(result.value));
    }),
  );
}
