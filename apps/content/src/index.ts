// Worker for artifact origins (`<id>.portifact.dev`). Serves user content only and holds no
// admin credentials; its only state change is redeeming one-use sign-in codes under
// /__portifact/. See docs/security.md for the invariants enforced here.
import {
  createDb,
  type Db,
  type DeliveryArtifact,
  type DeliveryFile,
  findDeliveryArtifact,
  findPublishedFile,
  findRenderedPage,
} from "@portifact/db";
import { effectiveState, isArtifactId, normalizePath } from "@portifact/domain";
import { documentPolicy } from "@portifact/render/policy";
import { BRIDGE_PATH, bridgeScript, cspNonce, injectBridge, reviewStatusPage } from "./inject.ts";
import {
  authorizeRead,
  CALLBACK_PATH,
  handleCallback,
  type Page,
  type ServableArtifact,
  type SignInStep,
} from "./read-session.ts";
import {
  authorizeReview,
  handleReviewCheck,
  handleReviewExchange,
  REVIEW_CHECK_PATH,
  REVIEW_PATH,
  type ReviewStep,
} from "./review.ts";

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  /** Registrable domain of artifact origins, for example `portifact.dev`. */
  CONTENT_DOMAIN: string;
  /**
   * Origin of the app: it signs visitors in to protected artifacts and may frame artifacts (the
   * review viewer), for example `https://app.portifact.com`.
   */
  APP_ORIGIN: string;
  /** HMAC key of read session cookies (secret, at least 32 characters). */
  READ_SESSION_SECRET?: string | undefined;
}

/** Reserved path that sends a visitor to the report form for this artifact. */
export const REPORT_PATH = "/__portifact/report";

/** User-facing text of the pages this Worker answers itself. */
const PAGES: Record<Page | "methodNotAllowed" | "serviceWorker" | "fileUnavailable", string> = {
  notFound: "This artifact does not exist or is no longer available",
  signIn: "Sign in to open this artifact",
  unavailable: "Signing in to artifacts is temporarily unavailable. Try again later",
  browserRequired: "Open this artifact in a web browser to sign in",
  linkExpired: "This sign-in link has expired or was already used",
  methodNotAllowed: "Method not allowed",
  serviceWorker: "Service workers are not allowed on artifacts",
  fileUnavailable: "This file is temporarily unavailable",
};

/** Pages where retrying from the artifact's root is the way forward. */
const RETRY_PAGES = new Set<Page>(["signIn", "linkExpired"]);

const HTML_PAGE = "text/html; charset=utf-8";

export default {
  fetch: (request, env) => handle(request, env, Date.now()),
} satisfies ExportedHandler<Env>;

export async function handle(request: Request, env: Env, now: number): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return message(405, PAGES.methodNotAllowed, { allow: "GET, HEAD" });
  }
  // Blocks service worker registration: a worker could intercept requests the platform must see.
  if (request.headers.get("Service-Worker") === "script") {
    return message(403, PAGES.serviceWorker);
  }

  const url = new URL(request.url);
  const id = artifactIdFromHost(url.hostname, env.CONTENT_DOMAIN);
  if (!id) return notFound();

  if (url.pathname === REPORT_PATH) {
    // Every artifact has a predictable report link; the form lives on the app, where reports are
    // stored. It answers the same for any ID, so it reveals nothing about the artifact.
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${env.APP_ORIGIN}/report?${new URLSearchParams({ artifact: id })}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  const db = createDb(env.DB);
  if (url.pathname === CALLBACK_PATH) {
    return decisionResponse(await handleCallback(request, env, db, id, now));
  }
  if (url.pathname === REVIEW_PATH) {
    return reviewStepResponse(await handleReviewExchange(request, env, db, id, now), env);
  }
  if (url.pathname === REVIEW_CHECK_PATH) {
    return reviewStepResponse(await handleReviewCheck(request, env, id, now), env);
  }
  if (url.pathname === BRIDGE_PATH) return bridgeScript(request);

  const found = await findDeliveryArtifact(db, id);
  const artifact = found && isServable(found, now) ? found : null;
  // Review mode first: the viewer's iframe reads the pinned version with the bridge.
  const review = await authorizeReview(request, env, db, id, artifact, now);
  if (review.kind === "review") {
    return serve(request, env, db, review.artifact, url, review.setCookies, {
      versionId: review.versionId,
      sessionTag: review.sessionTag,
    });
  }
  if (review.kind === "status") {
    return reviewStatusPage(review.status, review.httpStatus, env.APP_ORIGIN, review.setCookies);
  }
  if (artifact?.accessMode === "public") return serve(request, env, db, artifact, url, []);
  // Protected, unknown or not servable (in any mode): all go through sign-in, so an anonymous
  // visitor cannot tell an archived or expired artifact from one that never existed.
  const decision = await authorizeRead(request, env, db, id, artifact, now);
  if (decision.kind !== "allow") return decisionResponse(decision);
  return serve(request, env, db, decision.artifact, url, decision.setCookies);
}

/** The pinned version of a review session and the tag the bridge echoes to the viewer. */
interface ReviewServe {
  versionId: string;
  sessionTag: string;
}

/**
 * Serves a file of the artifact's current version, or in review mode (`reviewSession`) of the
 * pinned version, with the bridge appended to its HTML.
 */
async function serve(
  request: Request,
  env: Env,
  db: Db,
  artifact: ServableArtifact,
  url: URL,
  setCookies: string[],
  reviewSession?: ReviewServe,
): Promise<Response> {
  const review = reviewSession !== undefined;
  const resolved = await resolveFile(
    db,
    artifact,
    reviewSession?.versionId ?? artifact.currentVersionId,
    url.pathname,
  );
  if (resolved === "unrendered") {
    return withCookies(message(503, PAGES.fileUnavailable), setCookies);
  }
  if (!resolved) return withCookies(notFound(), setCookies);
  const { file, role } = resolved;

  const headers = contentHeaders(artifact, env, review);
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  headers.set("Content-Type", file.contentType);
  const inject = review && role !== "original" && file.contentType.startsWith("text/html");
  const nonce = inject && role === "page" ? cspNonce() : undefined;
  if (role === "page") {
    // The page carries this policy as a <meta> too; the header also covers what a meta cannot.
    // In review mode the meta is dropped and the header allows the bridge by its nonce.
    const scripts = nonce === undefined ? "" : `; script-src 'nonce-${nonce}'`;
    headers.set(
      "Content-Security-Policy",
      `${documentPolicy(false)}${scripts}; ${headers.get("Content-Security-Policy")}`,
    );
  } else if (role === "original") {
    headers.set("Content-Disposition", attachment(file.path));
  }
  if (inject && reviewSession) {
    return serveWithBridge(request, env, file, headers, nonce, reviewSession.sessionTag);
  }
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
  if (!object) return withCookies(message(503, PAGES.fileUnavailable), setCookies);
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

/** Review-mode HTML: rewritten on the way out, so never cached, ranged or validated by ETag. */
async function serveWithBridge(
  request: Request,
  env: Env,
  file: DeliveryFile,
  headers: Headers,
  nonce: string | undefined,
  sessionTag: string,
): Promise<Response> {
  headers.set("Cache-Control", "private, no-store");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const object = await env.ARTIFACTS.get(file.r2Key);
  if (!object) return message(503, PAGES.fileUnavailable);
  const response = new Response(object.body, { status: 200, headers });
  return injectBridge(response, { appOrigin: env.APP_ORIGIN, path: file.path, nonce, sessionTag });
}

type Resolved = { file: DeliveryFile; role: "file" | "page" | "original" };

/**
 * Finds what a path serves. A document's root is its rendered page, rendered once at publish;
 * its original is a download at its own path, and Markdown assets are files like a site's.
 */
async function resolveFile(
  db: Db,
  artifact: ServableArtifact,
  versionId: string,
  pathname: string,
): Promise<Resolved | "unrendered" | null> {
  const isDocument = artifact.type !== "site" && artifact.entrypoint !== null;
  if (isDocument && pathname === "/") {
    const page = await findRenderedPage(db, versionId, artifact.entrypoint as string);
    return page ? { file: page, role: "page" } : "unrendered";
  }
  const path = requestedPath(pathname);
  if (path === null) return null;
  const file =
    (await findPublishedFile(db, versionId, path)) ??
    (hasExtension(path) ? null : await findPublishedFile(db, versionId, `${path}/index.html`));
  if (!file) return null;
  return { file, role: isDocument && file.path === artifact.entrypoint ? "original" : "file" };
}

/** Download disposition with an ASCII fallback and the exact UTF-8 name (RFC 6266). */
export function attachment(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
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

function isServable(artifact: DeliveryArtifact, now: number): artifact is ServableArtifact {
  if (artifact.currentVersionId === null) return false;
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

/**
 * Headers every artifact response carries; user content cannot override them. Protected
 * responses are `same-origin` for CORP, so a sibling artifact cannot load them as scripts,
 * images or styles even when the browser sends the read cookie along. Review responses are
 * treated as protected whatever the access mode: only the viewer and the artifact itself may
 * frame them, and no other origin may load them.
 */
function contentHeaders(artifact: DeliveryArtifact, env: Env, review: boolean): Headers {
  const isPublic = artifact.accessMode === "public" && !review;
  const embeddable = isPublic && artifact.embeddable;
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": isPublic ? "no-cache" : "private, no-cache",
    "Content-Security-Policy": embeddable
      ? "frame-ancestors *"
      : `frame-ancestors 'self' ${env.APP_ORIGIN}`,
    "Cross-Origin-Resource-Policy": embeddable
      ? "cross-origin"
      : isPublic
        ? "same-site"
        : "same-origin",
  });
  if (!artifact.indexable) headers.set("X-Robots-Tag", "noindex");
  return headers;
}

function notFound(): Response {
  return message(404, PAGES.notFound);
}

function withCookies(response: Response, setCookies: string[]): Response {
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

/** Answers of the reserved review paths: redirects within the origin, or a status page. */
function reviewStepResponse(step: ReviewStep, env: Env): Response {
  if (step.kind === "unavailable") return message(503, PAGES.unavailable);
  if (step.kind === "status") {
    return reviewStatusPage(step.status, step.httpStatus, env.APP_ORIGIN, step.setCookies);
  }
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: step.location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
  return withCookies(response, step.setCookies);
}

/** Sign-in redirects and pages: never cached and never leaking the URL through Referer. */
function decisionResponse(decision: SignInStep): Response {
  const response =
    decision.kind === "redirect"
      ? new Response(null, {
          status: 303,
          headers: { Location: decision.location, "Cache-Control": "no-store" },
        })
      : message(decision.status, PAGES[decision.page], { retry: RETRY_PAGES.has(decision.page) });
  response.headers.set("Referrer-Policy", "no-referrer");
  return withCookies(response, decision.setCookies);
}

function message(
  status: number,
  text: string,
  options: { allow?: string; retry?: boolean } = {},
): Response {
  const link = options.retry
    ? '<a href="/">Open the artifact again</a>'
    : '<a href="https://portifact.com">Portifact</a>';
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Portifact</title><body><main><h1>${text}</h1><p>${link}</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": HTML_PAGE,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      ...(options.allow ? { Allow: options.allow } : {}),
    },
  });
}
