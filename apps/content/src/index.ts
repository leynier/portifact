// Worker for artifact origins (`<id>.portifact.dev`). Serves user content only and holds no
// admin credentials; its only state changes are redeeming one-use sign-in codes under
// /__portifact/, adding served traffic to the owner's counter and recording openings by signed-in
// visitors in the owner's access log. See docs/security.md for the invariants enforced here.
import { ERROR_STATUS, REVIEW_SESSION, type ReviewKind } from "@portifact/contracts";
import {
  createAccessDb,
  createDb,
  type Db,
  type DeliveryArtifact,
  type DeliveryFile,
  findDeliveryArtifact,
  findPublishedFile,
  findRenderedPage,
} from "@portifact/db";
import {
  chargedBytes,
  effectiveState,
  isArtifactId,
  isLoggedOpening,
  normalizePath,
  type TrafficCycle,
  trafficCycle,
  trafficExhausted,
} from "@portifact/domain";
import { documentPolicy } from "@portifact/render/policy";
import { recordOpenings, recordTraffic } from "@portifact/services";
import { type LogOpening, OpeningLog } from "./access-log.ts";
import { type BudgetEnv, overTrafficLimit } from "./budget.ts";
import { DIAGRAM_PATH, diagramScript } from "./diagrams.ts";
import {
  BRIDGE_PATH,
  bridgeScript,
  cspNonce,
  injectBridge,
  injectReviewBanner,
  reviewStatusPage,
} from "./inject.ts";
import { injectedCookieCleanup } from "./injected.ts";
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
  handleReviewEnd,
  handleReviewExchange,
  REVIEW_CHECK_PATH,
  REVIEW_END_PATH,
  REVIEW_PATH,
  REVIEW_TAB_CHECK_PATH,
  REVIEW_TAB_PATH,
  type ReviewStep,
  strayFrameCookie,
} from "./review.ts";
import { type CountTraffic, TrafficMeter } from "./traffic.ts";
import {
  isTopLevelVisit,
  NO_BAR_PATH,
  noBarRedirect,
  skipsViewer,
  viewerLocation,
  viewerRedirect,
} from "./viewer.ts";

// The Durable Object class the TRAFFIC_LIMITER binding names (wrangler.jsonc).
export { TrafficLimiter } from "./traffic-limiter.ts";

export interface Env extends BudgetEnv {
  DB: D1Database;
  /** The access log database (`portifact-access`); delivery only adds openings to it. */
  ACCESS_DB: D1Database;
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
const PAGES: Record<
  | Page
  | "methodNotAllowed"
  | "serviceWorker"
  | "fileUnavailable"
  | "trafficExceeded"
  | "slowDown"
  | "reviewEnded"
  | "endRefused"
  | "noBarRefused",
  string
> = {
  notFound: "This artifact does not exist or is no longer available",
  signIn: "Sign in to open this artifact",
  unavailable: "Signing in to artifacts is temporarily unavailable. Try again later",
  browserRequired: "Open this artifact in a web browser to sign in",
  linkExpired: "This sign-in link has expired or was already used",
  methodNotAllowed: "Method not allowed",
  serviceWorker: "Service workers are not allowed on artifacts",
  fileUnavailable: "This file is temporarily unavailable",
  trafficExceeded: "This artifact used its traffic for this month. Try again next month",
  slowDown: "Too many requests right now. Try again in a minute",
  reviewEnded: "Review ended. You can close this tab",
  endRefused: "Use End review in the review tab to end the review",
  noBarRefused: "Open this link from the Portifact viewer to see the artifact without the bar",
};

/** The request headers every answer of this Worker depends on. */
const FETCH_METADATA_VARY = "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site";

/** Pages where retrying from the artifact's root is the way forward. */
const RETRY_PAGES = new Set<Page>(["signIn", "linkExpired"]);

const HTML_PAGE = "text/html; charset=utf-8";

/** One meter per isolate; every request of the isolate adds to it. */
let meter: TrafficMeter | undefined;

/** The isolate's meter, writing to the D1 binding of the request that creates it. */
export function isolateMeter(env: Env): TrafficMeter {
  meter ??= new TrafficMeter((deltas) => recordTraffic(createDb(env.DB), deltas, Date.now()));
  return meter;
}

/** One access log buffer per isolate, like the traffic meter. */
let openings: OpeningLog | undefined;

/** The isolate's access log buffer, writing through the bindings of the request that creates it. */
export function isolateOpenings(env: Env): OpeningLog {
  openings ??= new OpeningLog((batch) =>
    recordOpenings(createDb(env.DB), createAccessDb(env.ACCESS_DB), batch),
  );
  return openings;
}

export default {
  fetch: (request, env, ctx) => {
    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    return handle(
      request,
      env,
      Date.now(),
      (charge) => isolateMeter(env).count(charge, waitUntil),
      (opening) => isolateOpenings(env).record(opening, waitUntil),
    );
  },
} satisfies ExportedHandler<Env>;

const NO_TRAFFIC: CountTraffic = () => {};
const NO_OPENINGS: LogOpening = () => {};

/**
 * Answers one request. `countTraffic` is charged once for every authorized request served for an
 * artifact; requests refused before authorization (sign-in, unknown or unavailable artifacts)
 * and the 429 itself charge nothing. `logOpening` gets every page served to a signed-in visitor
 * who is not the owner of a `restricted` artifact (`isLoggedOpening`); anonymous visits, public and
 * `authenticated` artifacts and subresources are never logged.
 */
export async function handle(
  request: Request,
  env: Env,
  now: number,
  countTraffic: CountTraffic = NO_TRAFFIC,
  logOpening: LogOpening = NO_OPENINGS,
): Promise<Response> {
  const response = await route(request, env, now, countTraffic, logOpening);
  // Whatever a top-level page gets, a frame review cookie it carries was planted: clear it.
  const stray = strayFrameCookie(request);
  // Cookies siblings set on the shared domain: expired once they grow, on every answer, so the
  // visitor recovers on the first request that still reaches the Worker.
  const injected = injectedCookieCleanup(
    request.headers.get("Cookie"),
    new URL(request.url).pathname,
    env.CONTENT_DOMAIN,
  );
  const clearing = stray ? [stray, ...injected] : injected;
  const answered = new Response(response.body, response);
  for (const cookie of clearing) answered.headers.append("Set-Cookie", cookie);
  // Whether a request opens the viewer, is served in review mode or may use a session depends
  // on its fetch metadata, so no cache may reuse one answer for another kind of request.
  answered.headers.append("Vary", FETCH_METADATA_VARY);
  return answered;
}

async function route(
  request: Request,
  env: Env,
  now: number,
  countTraffic: CountTraffic,
  logOpening: LogOpening,
): Promise<Response> {
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
  if (url.pathname === REVIEW_TAB_PATH) {
    return reviewStepResponse(await handleReviewExchange(request, env, db, id, now, "tab"), env);
  }
  if (url.pathname === REVIEW_TAB_CHECK_PATH) {
    return reviewStepResponse(await handleReviewCheck(request, env, id, now, "tab"), env);
  }
  if (url.pathname === REVIEW_END_PATH) {
    return reviewStepResponse(await handleReviewEnd(request, env, db, id), env);
  }
  if (url.pathname === BRIDGE_PATH) return bridgeScript(request);
  if (url.pathname === DIAGRAM_PATH) return diagramScript(request);
  if (url.pathname === NO_BAR_PATH) {
    const response = noBarRedirect(request);
    return response ?? message(400, PAGES.noBarRefused);
  }

  const cycle = trafficCycle(now);
  const found = await findDeliveryArtifact(db, id, cycle.start);
  const artifact = found && isServable(found, now) ? found : null;
  const delivery: Delivery = { request, env, db, url, now, cycle, countTraffic, logOpening };
  // Review mode first: the viewer's iframe reads the pinned version with the bridge, and a
  // review tab reads it with the review banner.
  const review = await authorizeReview(request, env, db, id, artifact, now);
  if (review.kind === "review") {
    return serve(delivery, review.artifact, review.setCookies, review.userId, {
      mode: review.mode,
      versionId: review.versionId,
      sessionTag: review.sessionTag,
    });
  }
  if (review.kind === "status") {
    return reviewStatusPage(review.status, review.httpStatus, env.APP_ORIGIN, review.setCookies);
  }
  // Public visits are anonymous: no session names the visitor, so they are never logged.
  if (artifact?.accessMode === "public") return serve(delivery, artifact, [], null);
  // Protected, unknown or not servable (in any mode): all go through sign-in, so an anonymous
  // visitor cannot tell an archived or expired artifact from one that never existed.
  const decision = await authorizeRead(request, env, db, id, artifact, now);
  if (decision.kind !== "allow") return decisionResponse(decision);
  return serve(delivery, decision.artifact, decision.setCookies, decision.userId);
}

/** What serving a request needs besides the artifact. */
interface Delivery {
  request: Request;
  env: Env;
  db: Db;
  url: URL;
  now: number;
  cycle: TrafficCycle;
  countTraffic: CountTraffic;
  logOpening: LogOpening;
}

/**
 * The pinned version of a review session, where it runs (the viewer's frame or a review tab)
 * and the tag the bridge echoes to the viewer.
 */
interface ReviewServe {
  mode: ReviewKind;
  versionId: string;
  sessionTag: string;
}

/**
 * Step 6 of delivery (plan section 11), after authorization: an account whose traffic for the
 * cycle is used up gets 429 on every artifact; otherwise the file is served and charged, and a
 * page served to `visitorId` is an opening for the owner's access log.
 */
async function serve(
  delivery: Delivery,
  artifact: ServableArtifact,
  setCookies: string[],
  visitorId: string | null,
  reviewSession?: ReviewServe,
): Promise<Response> {
  const { request, cycle, now } = delivery;
  if (trafficExhausted(artifact.traffic)) {
    return withCookies(trafficExceeded(cycle.resetsAt, now), setCookies);
  }
  // Then budget protection (plan section 12): a tight per-visitor limit, public traffic first.
  // A refused request sends no file, so it charges no traffic.
  const isPublic = artifact.accessMode === "public" && reviewSession === undefined;
  const limitedUntil = await overTrafficLimit(request, delivery.env, delivery.db, isPublic, now);
  if (limitedUntil !== null) {
    const limited = withCookies(message(429, PAGES.slowDown), setCookies);
    limited.headers.set("Retry-After", String(Math.max(1, Math.ceil((limitedUntil - now) / 1000))));
    return limited;
  }
  const { response, bytes } = await serveFile(delivery, artifact, setCookies, reviewSession);
  delivery.countTraffic({
    ownerId: artifact.ownerId,
    cycleStart: cycle.start,
    bytes: chargedBytes(response.status, request.method, bytes),
  });
  if (
    response.status < 400 &&
    isLoggedOpening({
      navigation: isPageLoad(request),
      visitorId,
      ownerId: artifact.ownerId,
      accessMode: artifact.accessMode,
    })
  ) {
    delivery.logOpening({ artifactId: artifact.id, userId: visitorId as string, at: now });
  }
  return response;
}

/**
 * A page the visitor sees: a `GET` navigation, top-level or in a frame, except a frame that a
 * sibling artifact opened. Artifacts share one site, so the Lax read cookie goes along and the
 * page is served, but `frame-ancestors` keeps it from rendering there; logging it would let a
 * hostile artifact plant openings the visitor never saw.
 */
function isPageLoad(request: Request): boolean {
  const headers = request.headers;
  return (
    request.method === "GET" &&
    headers.get("Sec-Fetch-Mode") === "navigate" &&
    (headers.get("Sec-Fetch-Dest") === "document" || headers.get("Sec-Fetch-Site") !== "same-site")
  );
}

/** A response and the body bytes it sends, for the traffic counter. */
interface Served {
  response: Response;
  bytes: number;
}

const served = (response: Response, bytes = 0): Served => ({ response, bytes });

/**
 * Serves a file of the artifact's current version, or in review mode (`reviewSession`) of the
 * pinned version, with the bridge appended to its HTML.
 */
async function serveFile(
  { request, env, db, url }: Delivery,
  artifact: ServableArtifact,
  setCookies: string[],
  reviewSession?: ReviewServe,
): Promise<Served> {
  const review = reviewSession !== undefined;
  const resolved = await resolveFile(
    db,
    artifact,
    reviewSession?.versionId ?? artifact.currentVersionId,
    url.pathname,
  );
  if (resolved === "unrendered") {
    return served(withCookies(message(503, PAGES.fileUnavailable), setCookies));
  }
  if (!resolved) return served(withCookies(notFound(), setCookies));
  const { file, role } = resolved;
  if (!review && opensInViewer(request, artifact, file, role)) {
    const location = viewerLocation(env.APP_ORIGIN, artifact.id, url);
    // A redirect sends no file, so it charges the request and no bytes.
    if (location) return served(viewerRedirect(location, setCookies));
  }

  const headers = contentHeaders(artifact, env, review);
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  headers.set("Content-Type", file.contentType);
  const inject = review && role !== "original" && file.contentType.startsWith("text/html");
  // Only the bridge is a script; the review tab's banner is markup and keeps the page's policy.
  const nonce =
    inject && role === "page" && reviewSession?.mode === "frame" ? cspNonce() : undefined;
  if (role === "page") {
    // The page carries this policy as a <meta> too; the header also covers what a meta cannot,
    // and allows the diagram script only at its exact URL on this origin. In review mode the
    // meta is dropped and the header allows the bridge by its nonce.
    const policy = documentPolicy({ diagrams: true, origin: url.origin, ...(nonce && { nonce }) });
    headers.set("Content-Security-Policy", `${policy}; ${headers.get("Content-Security-Policy")}`);
  } else if (role === "original") {
    headers.set("Content-Disposition", attachment(file.path));
  }
  if (inject && reviewSession) {
    // The bridge or banner adds a few bytes to the page; the file's size is what is charged.
    const response = await serveWithBridge(request, env, file, headers, nonce, reviewSession);
    return served(response, file.size);
  }
  headers.set("ETag", `"${file.sha256}"`);
  headers.set("Accept-Ranges", "bytes");

  if (request.headers.get("If-None-Match") === `"${file.sha256}"`) {
    return served(new Response(null, { status: 304, headers }));
  }
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return served(new Response(null, { status: 200, headers }));
  }

  const object = await env.ARTIFACTS.get(file.r2Key, { range: request.headers });
  if (!object) return served(withCookies(message(503, PAGES.fileUnavailable), setCookies));
  // R2 reports a range even for whole-object reads; only answer 206 when the client asked for one.
  if (request.headers.has("Range") && object.range) {
    const { start, length } = byteSpan(object.range, file.size);
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${file.size}`);
    headers.set("Content-Length", String(length));
    return served(new Response(object.body, { status: 206, headers }), length);
  }
  headers.set("Content-Length", String(file.size));
  return served(new Response(object.body, { status: 200, headers }), file.size);
}

/**
 * The account's traffic for this cycle is used up: 429 `traffic_exceeded` on all its artifacts
 * until the next cycle. The page names no account, quota or amount.
 */
function trafficExceeded(resetsAt: number, now: number): Response {
  const response = message(ERROR_STATUS.traffic_exceeded, PAGES.trafficExceeded);
  response.headers.set("Retry-After", String(Math.max(1, Math.ceil((resetsAt - now) / 1000))));
  response.headers.set("Portifact-Error", "traffic_exceeded");
  return response;
}

/**
 * Review-mode HTML: rewritten on the way out (the bridge in the viewer's frame, the banner in a
 * review tab), so never cached, ranged or validated by ETag.
 */
async function serveWithBridge(
  request: Request,
  env: Env,
  file: DeliveryFile,
  headers: Headers,
  nonce: string | undefined,
  session: ReviewServe,
): Promise<Response> {
  headers.set("Cache-Control", "private, no-store");
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const object = await env.ARTIFACTS.get(file.r2Key);
  if (!object) return message(503, PAGES.fileUnavailable);
  const response = new Response(object.body, { status: 200, headers });
  if (session.mode === "tab") {
    return injectReviewBanner(response, REVIEW_SESSION.tabSessionTtlSeconds / 60);
  }
  return injectBridge(response, {
    appOrigin: env.APP_ORIGIN,
    path: file.path,
    nonce,
    sessionTag: session.sessionTag,
  });
}

type Resolved = { file: DeliveryFile; role: "file" | "page" | "original" };

/**
 * A top-level visit to a page (an HTML file of a site or a document's rendered page) of an
 * artifact with the Portifact bar opens in the viewer. Images, downloads and other files are
 * served as they are, and so is everything when the owner turned the bar off.
 */
function opensInViewer(
  request: Request,
  artifact: ServableArtifact,
  file: DeliveryFile,
  role: Resolved["role"],
): boolean {
  if (!artifact.bar || !isTopLevelVisit(request) || skipsViewer(request)) return false;
  return role === "page" || (role === "file" && file.contentType.startsWith("text/html"));
}

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
 * frame them, no other origin may load them, and they are never indexed.
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
  // Like embedding, indexing is an option of public artifacts only (plan section 4).
  if (!(isPublic && artifact.indexable)) headers.set("X-Robots-Tag", "noindex");
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
  if (step.kind === "end") {
    const page = step.done
      ? message(200, PAGES.reviewEnded, { retry: true })
      : message(400, PAGES.endRefused);
    page.headers.set("Referrer-Policy", "no-referrer");
    return withCookies(page, step.setCookies);
  }
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
