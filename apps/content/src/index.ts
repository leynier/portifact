// Worker for artifact origins (`<id>.portifact.dev`). Serves user content only; it holds no
// credentials and changes no state. See docs/security.md for the invariants enforced here.
import {
  createDb,
  type DeliveryArtifact,
  findDeliveryArtifact,
  findPublishedFile,
} from "@portifact/db";
import { effectiveState, isArtifactId, normalizePath } from "@portifact/domain";

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  /** Registrable domain of artifact origins, for example `portifact.dev`. */
  CONTENT_DOMAIN: string;
  /** Origin allowed to frame artifacts (the review viewer), for example `https://app.portifact.com`. */
  APP_ORIGIN: string;
}

const HTML_PAGE = "text/html; charset=utf-8";

export default {
  fetch: (request, env) => handle(request, env, Date.now()),
} satisfies ExportedHandler<Env>;

export async function handle(request: Request, env: Env, now: number): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return message(405, "Method not allowed", "GET, HEAD");
  }
  // Blocks service worker registration: a worker could intercept requests the platform must see.
  if (request.headers.get("Service-Worker") === "script") {
    return message(403, "Service workers are not allowed on artifacts");
  }

  const url = new URL(request.url);
  const id = artifactIdFromHost(url.hostname, env.CONTENT_DOMAIN);
  if (!id) return notFound();

  const db = createDb(env.DB);
  const artifact = await findDeliveryArtifact(db, id);
  if (!artifact || !artifact.currentVersionId || !isServable(artifact, now)) return notFound();
  if (artifact.accessMode !== "public") {
    return message(401, "This artifact is private. Signing in to open it is not available yet");
  }

  const path = requestedPath(url.pathname);
  if (path === null) return notFound();

  const file =
    (await findPublishedFile(db, artifact.currentVersionId, path)) ??
    (hasExtension(path)
      ? null
      : await findPublishedFile(db, artifact.currentVersionId, `${path}/index.html`));
  if (!file) return notFound();

  const headers = contentHeaders(artifact, env);
  headers.set("Content-Type", file.contentType);
  headers.set("ETag", `"${file.sha256}"`);
  headers.set("Accept-Ranges", "bytes");

  if (request.headers.get("If-None-Match") === `"${file.sha256}"`) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return new Response(null, { status: 200, headers });
  }

  const object = await env.ARTIFACTS.get(file.r2Key, { range: request.headers });
  if (!object) return message(503, "This file is temporarily unavailable");
  // R2 reports a range even for whole-object reads; only answer 206 when the client asked for one.
  if (request.headers.has("Range") && object.range) {
    const { start, length } = byteSpan(object.range, file.size);
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${file.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(object.body, { status: 200, headers });
}

/** `<id>.portifact.dev` to `<id>`; anything else (apex, nested labels, bad IDs) is not an artifact. */
export function artifactIdFromHost(hostname: string, domain: string): string | null {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return isArtifactId(label) ? label : null;
}

/** Maps a URL path to a canonical artifact path, with `index.html` for directories. */
export function requestedPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative;
  const result = normalizePath(candidate);
  return result.ok ? result.value : null;
}

function isServable(artifact: DeliveryArtifact, now: number): boolean {
  const state = effectiveState(
    {
      state: artifact.state,
      expiresAt: artifact.expiresAt === null ? null : new Date(artifact.expiresAt),
      archivedAt: artifact.archivedAt === null ? null : new Date(artifact.archivedAt),
    },
    new Date(now),
  );
  return state === "active";
}

/** Resolves an R2 range (offset/length or suffix) to the served byte span of a file. */
export function byteSpan(range: R2Range, size: number): { start: number; length: number } {
  // The runtime fills unused R2Range fields with undefined, so read them as optional values.
  const r = range as { offset?: number; length?: number; suffix?: number };
  if (r.suffix !== undefined) return { start: size - r.suffix, length: r.suffix };
  const start = r.offset ?? 0;
  return { start, length: r.length ?? size - start };
}

function hasExtension(path: string): boolean {
  return /\.[^/]+$/.test(path);
}

/** Headers every artifact response carries; user content cannot override them. */
function contentHeaders(artifact: DeliveryArtifact, env: Env): Headers {
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": artifact.accessMode === "public" ? "no-cache" : "private, no-cache",
    "Content-Security-Policy": artifact.embeddable
      ? "frame-ancestors *"
      : `frame-ancestors 'self' ${env.APP_ORIGIN}`,
    "Cross-Origin-Resource-Policy": artifact.embeddable ? "cross-origin" : "same-site",
  });
  if (!artifact.indexable) headers.set("X-Robots-Tag", "noindex");
  return headers;
}

function notFound(): Response {
  return message(404, "This artifact does not exist or is no longer available");
}

function message(status: number, text: string, allow?: string): Response {
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portifact</title><body><main><h1>${text}</h1><p><a href="https://portifact.com">Portifact</a></p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": HTML_PAGE,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      ...(allow ? { Allow: allow } : {}),
    },
  });
}
