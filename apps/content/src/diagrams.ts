// The diagram script (the pinned Mermaid build and Portifact's runner, packages/render) that
// rendered documents with Mermaid blocks load from their own origin. It is the same file on every
// artifact origin and holds no user content, so like the bridge it is served before any artifact
// lookup, without authorization, and charges no owner's traffic (docs/security.md).
export { DIAGRAM_PATH } from "@portifact/render/policy";

/**
 * Old documents keep loading the same path, so it carries no version: browsers keep the file an
 * hour and then revalidate it by its ETag, so a new build reaches them within the hour.
 */
export async function diagramScript(request: Request): Promise<Response> {
  // Imported on first use: an isolate that never serves the script never builds its string.
  const { DIAGRAM_SCRIPT, DIAGRAM_VERSION } = await import("@portifact/render/diagrams-bundle");
  const etag = `"${DIAGRAM_VERSION}"`;
  const headers = new Headers({
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    ETag: etag,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  });
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : DIAGRAM_SCRIPT, { headers });
}
