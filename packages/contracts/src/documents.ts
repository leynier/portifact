// Shapes of the document preview (`POST /api/v1/documents/preview`, plan section 6, "Documento"):
// the dashboard's editor sends a Markdown or TXT source and gets back the page the renderer
// would store at commit. Nothing is stored and no artifact is involved.
import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const DocumentPreviewRequest = z.strictObject({
  type: z.enum(["markdown", "text"]),
  /** Page title, usually the artifact name. */
  name: z.string().trim().min(1).max(200),
  /** The source; the server also checks its UTF-8 size against the document limit. */
  source: z.string().max(LIMITS.documentBytes),
});
export type DocumentPreviewRequest = z.infer<typeof DocumentPreviewRequest>;

export const DocumentPreview = z.object({
  /** The complete rendered page, as untrusted markup for a sandboxed frame only. */
  html: z.string(),
  rendererVersion: z.string(),
});
export type DocumentPreview = z.infer<typeof DocumentPreview>;

/** Previews one user may render per window; rendering is CPU work on the Worker. */
export const PREVIEW_LIMIT = { requests: 120, windowMs: 10 * 60 * 1000 } as const;
