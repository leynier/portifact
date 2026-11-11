// Worker for artifact origins (`<id>.portifact.dev`, and while custom domains are switched on an
// artifact's active custom host, decision 0006). Serves user content only and holds no
// admin credentials; its only state changes are redeeming one-use sign-in codes under
// /__portifact/, adding served traffic to the owner's counter, recording openings by signed-in
// visitors in the owner's access log and counting page views for owners with analytics. See docs/security.md for the invariants enforced here.
import {
  BRAND_LOGO_PATH,
  DEFAULT_REGION,
  ERROR_STATUS,
  REVIEW_SESSION,
  type ReviewKind,
  requestContextOf,
} from "@portifact/contracts";
import {
  type AccessDb,
  type DeliveryArtifact,
  type DeliveryFile,
  findPublishedFile,
  findRenderedPage,
  type Region,
  type RegionalDb,
  type RegionHandles,
  type Regions,
  regionsFromEnv,
  withBindings,
  withRequestContext,
} from "@portifact/db";
import {
  canonicalLocation,
  chargedBytes,
  classifyHost,
  effectiveState,
  entitlements,
  hasFeature,
  isArtifactId,
  isLoggedLinkOpening,
  isLoggedOpening,
  networkDecision,
  normalizePath,
  pageView,
  type TrafficCycle,
  trafficCycle,
  trafficExhausted,
  viewsExpireAt,
} from "@portifact/domain";
import { documentPolicy } from "@portifact/render/policy";
import {
  customDomainsServing,
  findBrandLogo,
  recordOpenings,
  recordTraffic,
  recordViews,
} from "@portifact/services";
import { type LogOpening, OpeningLog } from "./access-log.ts";
import { type BudgetEnv, overTrafficLimit } from "./budget.ts";
import { hintAgrees, isolateHosts, resolveCustomHost } from "./custom-hosts.ts";
import { DIAGRAM_VERSION, diagramScript, isDiagramPath } from "./diagrams.ts";
import { deliveryRegion, lookupDelivery } from "./directory.ts";
import {
  BRIDGE_PATH,
  bannerLocale,
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
import { authorizeLink, handleLinkCallback, LINK_PATH, type LinkStep } from "./share-session.ts";
import { type CountTraffic, TrafficMeter } from "./traffic.ts";
import {
  isTopLevelVisit,
  NO_BAR_PATH,
  noBarRedirect,
  skipsViewer,
  viewerLocation,
  viewerRedirect,
} from "./viewer.ts";
import { type CountView, ViewMeter } from "./views.ts";

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
  /**
   * Exactly `"true"` serves artifacts on their active custom hosts and redirects old `.dev`
   * links there (decision 0006). Anything else, or nothing, answers every other host 404 and
   * serves exactly as before custom domains existed.
   */
  CUSTOM_DOMAINS_ENABLED?: string | undefined;
}

/** Whether this deployment serves custom hosts: the same condition the app decides with. */
function customDomainsOn(env: Env): boolean {
  return customDomainsServing(env);
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
  | "noBarRefused"
  | "networkRefused",
  string
> = {
  notFound: "This artifact does not exist or is no longer available",
  signIn: "Sign in to open this artifact",
  unavailable: "Signing in to artifacts is temporarily unavailable. Try again later",
  browserRequired: "Open this artifact in a web browser to sign in",
  linkExpired: "This sign-in link has expired or was already used",
  shareEnded: "This share link has expired or was revoked",
  methodNotAllowed: "Method not allowed",
  serviceWorker: "Service workers are not allowed on artifacts",
  fileUnavailable: "This file is temporarily unavailable",
  trafficExceeded: "This artifact used its traffic for this month. Try again next month",
  slowDown: "Too many requests right now. Try again in a minute",
  reviewEnded: "Review ended. You can close this tab",
  endRefused: "Use End review in the review tab to end the review",
  noBarRefused: "Open this link from the Portifact viewer to see the artifact without the bar",
  networkRefused:
    "This workspace only allows access from its approved networks. Connect from one of them, or ask a workspace admin",
};

/** The request headers every answer of this Worker depends on. */
const FETCH_METADATA_VARY = "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site";

/** Pages where retrying from the artifact's root is the way forward. */
const RETRY_PAGES = new Set<Page>(["signIn", "linkExpired", "shareEnded"]);

const HTML_PAGE = "text/html; charset=utf-8";

/**
 * One meter per region per isolate; every request of the isolate adds to its artifact's region's
 * (decision 0005): an owner is in one region, so each pending batch is one regional upsert.
 */
const meters = new Map<Region, TrafficMeter>();

/** The isolate's meter for a region, writing to the D1 binding of the request that creates it. */
export function isolateMeter(env: Env, region: Region = DEFAULT_REGION): TrafficMeter {
  let meter = meters.get(region);
  if (!meter) {
    meter = new TrafficMeter((deltas) =>
      recordTraffic(regionsFromEnv(env).get(region).db, deltas, Date.now()),
    );
    meters.set(region, meter);
  }
  return meter;
}

/** One access log buffer per region per isolate, like the traffic meter. */
const openingLogs = new Map<Region, OpeningLog>();

/** The isolate's access log buffer for a region, in that region's access log database. */
export function isolateOpenings(env: Env, region: Region = DEFAULT_REGION): OpeningLog {
  let log = openingLogs.get(region);
  if (!log) {
    log = new OpeningLog((batch) => {
      const handles = regionsFromEnv(env).get(region);
      return recordOpenings(handles.db, accessDbOf(handles), batch);
    });
    openingLogs.set(region, log);
  }
  return log;
}

/** One view meter per region per isolate, like the traffic meter. */
const viewMeters = new Map<Region, ViewMeter>();

/** The isolate's view meter for a region, in that region's access log database. */
export function isolateViews(env: Env, region: Region = DEFAULT_REGION): ViewMeter {
  let meter = viewMeters.get(region);
  if (!meter) {
    meter = new ViewMeter((deltas) => {
      const handles = regionsFromEnv(env).get(region);
      return recordViews(handles.db.global, accessDbOf(handles), deltas);
    });
    viewMeters.set(region, meter);
  }
  return meter;
}

export default {
  fetch: (request, env, ctx) => {
    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    return handle(
      request,
      env,
      Date.now(),
      (charge, region) => isolateMeter(env, region).count(charge, waitUntil),
      (opening, region) => isolateOpenings(env, region).record(opening, waitUntil),
      (view, region) => isolateViews(env, region).count(view, waitUntil),
    );
  },
} satisfies ExportedHandler<Env>;

const NO_TRAFFIC: CountTraffic = () => {};
const NO_OPENINGS: LogOpening = () => {};
const NO_VIEWS: CountView = () => {};

/**
 * Answers one request. `countTraffic` is charged once for every authorized request served for an
 * artifact; requests refused before authorization (sign-in, unknown or unavailable artifacts)
 * and the 429 itself charge nothing. `logOpening` gets every page served to a signed-in visitor
 * who is not the owner of a `restricted` artifact (`isLoggedOpening`); anonymous visits, public and
 * `authenticated` artifacts and subresources are never logged. `countView` gets every page view
 * (`pageView`) of an artifact whose owner's plan includes analytics.
 */
export async function handle(
  request: Request,
  env: Env,
  now: number,
  countTraffic: CountTraffic = NO_TRAFFIC,
  logOpening: LogOpening = NO_OPENINGS,
  countView: CountView = NO_VIEWS,
): Promise<Response> {
  const response = await route(request, env, now, countTraffic, logOpening, countView);
  // Whatever a top-level page gets, a frame review cookie it carries was planted: clear it.
  const stray = strayFrameCookie(request);
  // Cookies siblings set on the shared domain: expired once they grow, on every answer, so the
  // visitor recovers on the first request that still reaches the Worker. Only on the content
  // domain: on a custom host the other cookies are the customer's own sites', and without the
  // Public Suffix List the Worker cannot name their registrable domain (they still grant nothing).
  const url = new URL(request.url);
  const onContentDomain =
    url.hostname === env.CONTENT_DOMAIN || url.hostname.endsWith(`.${env.CONTENT_DOMAIN}`);
  const injected = onContentDomain
    ? injectedCookieCleanup(request.headers.get("Cookie"), url.pathname, env.CONTENT_DOMAIN)
    : [];
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
  workerEnv: Env,
  now: number,
  countRegionTraffic: CountTraffic,
  logRegionOpening: LogOpening,
  countRegionView: CountView,
): Promise<Response> {
  // The request context (decision 0020): read and review sessions renew through `actorOn`, which
  // applies a workspace's network policy to this request.
  let env = withRequestContext(workerEnv, requestContextOf(request));
  if (request.method !== "GET" && request.method !== "HEAD") {
    return message(405, PAGES.methodNotAllowed, { allow: "GET, HEAD" });
  }
  // Blocks service worker registration: a worker could intercept requests the platform must see.
  if (request.headers.get("Service-Worker") === "script") {
    return message(403, PAGES.serviceWorker);
  }

  const url = new URL(request.url);
  const regions = regionsFromEnv(env);
  const cycle = trafficCycle(now);
  // `<id>.portifact.dev` as always; any other host only while custom domains are on.
  let id = artifactIdFromHost(url.hostname, env.CONTENT_DOMAIN);
  let handles: RegionHandles;
  let resolved: DeliveryArtifact | null | undefined;
  if (id) {
    // The region that holds the artifact, from the global directory (decision 0005).
    // Cached per isolate: a warm request reads nothing here.
    handles = await deliveryRegion(regions, id, now);
  } else {
    const host = classifyHost(url.hostname, env.CONTENT_DOMAIN);
    if (host.kind !== "custom" || !customDomainsOn(env)) return notFound();
    // The customer's domain gets no HSTS from Portifact (it would outlive the attachment and
    // could bind their other sites), so plain http is upgraded here, before anything else.
    if (url.protocol === "http:") return httpsUpgrade(url);
    // Portifact's own scripts need no artifact, like on `.dev`.
    if (url.pathname === BRIDGE_PATH) return bridgeScript(request);
    if (isDiagramPath(url.pathname)) return diagramScript(request);
    const target = await resolveCustomHost(regions, isolateHosts(), url.hostname, cycle.start, now);
    if (!target) return notFound();
    id = target.artifact.id;
    handles = regions.get(target.region);
    resolved = target.artifact;
  }
  // Everything below reads the artifact's region: its database, its bucket (as `ARTIFACTS`, so
  // every read of the bytes uses it) and its traffic, opening and view counters.
  const db = handles.db;
  const region = handles.region;
  if (handles.bucket) env = withBindings(env, { ARTIFACTS: handles.bucket });
  const countTraffic: CountTraffic = (charge) => countRegionTraffic(charge, region);
  const logOpening: LogOpening = (opening) => logRegionOpening(opening, region);
  const countView: CountView = (view) => countRegionView(view, region);
  // The exact host a one-use code must have been issued for, and the artifact's `.dev` host.
  const hosts = { host: url.hostname, devHost: `${id}.${env.CONTENT_DOMAIN}` };

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

  if (url.pathname === CALLBACK_PATH) {
    return decisionResponse(await handleCallback(request, env, db, id, now, hosts));
  }
  if (url.pathname === LINK_PATH) {
    return linkStepResponse(await handleLinkCallback(request, env, db, id, now, hosts));
  }
  if (url.pathname === REVIEW_PATH) {
    return reviewStepResponse(
      await handleReviewExchange(request, env, db, id, now, "frame", hosts),
      env,
    );
  }
  if (url.pathname === REVIEW_CHECK_PATH) {
    return reviewStepResponse(await handleReviewCheck(request, env, id, now), env);
  }
  if (url.pathname === REVIEW_TAB_PATH) {
    return reviewStepResponse(
      await handleReviewExchange(request, env, db, id, now, "tab", hosts),
      env,
    );
  }
  if (url.pathname === REVIEW_TAB_CHECK_PATH) {
    return reviewStepResponse(await handleReviewCheck(request, env, id, now, "tab"), env);
  }
  if (url.pathname === REVIEW_END_PATH) {
    return reviewStepResponse(await handleReviewEnd(request, env, db, id), env);
  }
  if (url.pathname === BRIDGE_PATH) return bridgeScript(request);
  if (isDiagramPath(url.pathname)) return diagramScript(request);
  if (url.pathname.startsWith(BRAND_LOGO_PATH)) {
    return brandLogo(request, env, db, id, url.pathname.slice(BRAND_LOGO_PATH.length), now);
  }
  if (url.pathname === NO_BAR_PATH) {
    const response = noBarRedirect(request);
    return response ?? message(400, PAGES.noBarRefused);
  }

  const found =
    resolved === undefined ? await lookupDelivery(regions, db, id, cycle.start, now) : resolved;
  const artifact = found && isServable(found, now) ? found : null;
  const delivery: Delivery = {
    request,
    env,
    db,
    url,
    now,
    cycle,
    countTraffic,
    logOpening,
    countView,
    onDevHost: resolved === undefined,
    customDomains: customDomainsOn(env),
    regions,
  };
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
  // A read session wins; a share link's session is tried before sign-in starts (decision 0008).
  const decision = await authorizeRead(
    request,
    env,
    db,
    id,
    artifact,
    now,
    () => authorizeLink(request, env, db, id, artifact, now),
    // Sign-in comes back to the host the visitor started on.
    resolved === undefined ? null : url.hostname,
  );
  if (decision.kind !== "allow") return decisionResponse(decision);
  return serve(
    delivery,
    decision.artifact,
    decision.setCookies,
    decision.userId,
    undefined,
    decision.linkId,
  );
}

/** What serving a request needs besides the artifact. */
interface Delivery {
  request: Request;
  env: Env;
  db: RegionalDb;
  url: URL;
  now: number;
  cycle: TrafficCycle;
  countTraffic: CountTraffic;
  logOpening: LogOpening;
  countView: CountView;
  /** The request came on `<id>.portifact.dev`, not on a custom host. */
  onDevHost: boolean;
  /** Custom domains are switched on in this deployment. */
  customDomains: boolean;
  /** For the `.dev` redirect, which also needs the global table's agreement (`hintAgrees`). */
  regions: Regions;
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
  /** The share link whose session authorized the request; it names no visitor. */
  linkId?: string,
): Promise<Response> {
  const { request, cycle, now } = delivery;
  // A workspace's network policy (decision 0020), part of authorization, so a refusal charges
  // nothing: it binds the signed-in readers of a `workspace` artifact, who are all its members,
  // on every request. The allowlist came with the artifact lookup, so it adds no read. Members
  // reading another mode are bound when their session renews (`actorOn`), within a minute;
  // public visitors and share links are for people outside and are never bound.
  const network = networkDecision({
    accessMode: artifact.accessMode,
    networks: artifact.networks,
    signedIn: visitorId !== null && linkId === undefined,
    ip: request.headers.get("CF-Connecting-IP"),
  });
  if (network !== "allowed") {
    // A stored list that does not parse refuses (fail closed) and is logged by owner, no address.
    if (network === "unreadable") {
      console.error(
        JSON.stringify({
          event: "workspace_network_policy_unreadable",
          workspaceId: artifact.ownerId,
        }),
      );
    }
    return withCookies(message(403, PAGES.networkRefused), setCookies);
  }
  // The plan came with the artifact lookup, so the quota and the view count add no read.
  const plan = entitlements(artifact.plan, now);
  if (trafficExhausted(artifact.traffic, plan.limits)) {
    return withCookies(trafficExceeded(cycle.resetsAt, now), setCookies);
  }
  // Then budget protection (plan section 12): a tight per-visitor limit, public traffic first.
  // A refused request sends no file, so it charges no traffic.
  const isPublic = artifact.accessMode === "public" && reviewSession === undefined;
  const limitedUntil = await overTrafficLimit(
    request,
    delivery.env,
    delivery.db.global,
    isPublic,
    now,
  );
  if (limitedUntil !== null) {
    const limited = withCookies(message(429, PAGES.slowDown), setCookies);
    limited.headers.set("Retry-After", String(Math.max(1, Math.ceil((limitedUntil - now) / 1000))));
    return limited;
  }
  const { response, bytes, page, redirect, canonical } = await serveFile(
    delivery,
    artifact,
    setCookies,
    reviewSession,
    linkId !== undefined,
  );
  delivery.countTraffic({
    ownerId: artifact.ownerId,
    cycleStart: cycle.start,
    bytes: chargedBytes(response.status, request.method, bytes),
  });
  // The redirect of an old `.dev` link to the custom host is charged as a request but is neither a
  // view nor an opening: the visit it leads to is, so nothing is counted twice.
  if (canonical) return response;
  const view = pageView({
    method: request.method,
    fetchMode: request.headers.get("Sec-Fetch-Mode"),
    fetchDest: request.headers.get("Sec-Fetch-Dest"),
    fetchSite: request.headers.get("Sec-Fetch-Site"),
    status: response.status,
    isPage: page,
    viewerRedirect: redirect,
    // A share link's session names no visitor: its page loads are anonymous views.
    visitorId: linkId === undefined ? visitorId : null,
    ownerId: artifact.ownerId,
    analytics: hasFeature(plan, "analytics"),
  });
  if (view !== null) {
    delivery.countView({
      artifactId: artifact.id,
      ownerId: artifact.ownerId,
      at: now,
      visitorId: view === "signedIn" ? visitorId : null,
      expiresAt: viewsExpireAt(now, plan),
    });
  }
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
  if (
    linkId !== undefined &&
    response.status < 400 &&
    isLoggedLinkOpening({ navigation: isPageLoad(request), accessMode: artifact.accessMode })
  ) {
    delivery.logOpening({ artifactId: artifact.id, userId: linkId, linkId, at: now });
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

/**
 * A response, the body bytes it sends (for the traffic counter), whether it is a page the
 * visitor sees (an HTML file or a rendered page) and whether it is the redirect to the viewer
 * (for the view count).
 */
interface Served {
  response: Response;
  bytes: number;
  page: boolean;
  redirect: boolean;
  /** The 308 of an old `.dev` link to the artifact's custom host. */
  canonical?: boolean;
}

const served = (response: Response, bytes = 0): Served => ({
  response,
  bytes,
  page: false,
  redirect: false,
});

/**
 * Serves a file of the artifact's current version, or in review mode (`reviewSession`) of the
 * pinned version, with the bridge appended to its HTML.
 */
async function serveFile(
  { request, env, db, url, onDevHost, customDomains, regions }: Delivery,
  artifact: ServableArtifact,
  setCookies: string[],
  reviewSession?: ReviewServe,
  /** Served through a share link: never the viewer, never referrers, framed only by itself. */
  link = false,
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
  const page = isPage(file, role);
  // A link visitor has no account for the viewer to show: they get the artifact itself.
  if (!review && !link && opensInViewer(request, artifact, file, role)) {
    const location = viewerLocation(env.APP_ORIGIN, artifact.id, url);
    // A redirect sends no file, so it charges the request and no bytes.
    if (location) {
      return { ...served(viewerRedirect(location, setCookies)), page, redirect: true };
    }
  }
  // With the bar off, an old `.dev` link to a page goes to the artifact's custom host: decided
  // here, after authorization, so an anonymous visitor of a protected artifact never learns its
  // domain; with the bar on the viewer above won and frames the custom host itself.
  const location = canonicalLocation({
    onDevHost,
    customHost: customDomains ? artifact.customHost : null,
    // The owner's setting, not this browser's opt-out: a visitor who left the viewer on `.dev`
    // stays there, since the custom host would show them the viewer again.
    bar: artifact.bar,
    topLevelPage: isTopLevelVisit(request) && page,
    review,
    link,
    pathAndQuery: `${url.pathname}${url.search}`,
  });
  // The regional column alone is not enough: the global row must be active for this artifact
  // too, as the isolate's hint says (a warm isolate reads nothing more). A host whose row is
  // provisioning, detaching or another owner's would send readers, path and query included, to
  // a name someone else may control, or to a 404.
  if (location && (await hintAgrees(regions, artifact.customHost as string, artifact.id))) {
    return { ...served(canonicalRedirect(location, setCookies)), page, canonical: true };
  }
  const sent = (response: Response, bytes = 0): Served => ({ ...served(response, bytes), page });

  const headers = contentHeaders(artifact, env, review, link);
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
    const policy = documentPolicy({
      diagrams: true,
      origin: url.origin,
      diagramVersion: DIAGRAM_VERSION,
      ...(nonce && { nonce }),
    });
    headers.set("Content-Security-Policy", `${policy}; ${headers.get("Content-Security-Policy")}`);
  } else if (role === "original") {
    headers.set("Content-Disposition", attachment(file.path));
  }
  if (inject && reviewSession) {
    // The bridge or banner adds a few bytes to the page; the file's size is what is charged.
    const response = await serveWithBridge(request, env, file, headers, nonce, reviewSession);
    return sent(response, file.size);
  }
  headers.set("ETag", `"${file.sha256}"`);
  headers.set("Accept-Ranges", "bytes");

  if (request.headers.get("If-None-Match") === `"${file.sha256}"`) {
    return sent(new Response(null, { status: 304, headers }));
  }
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return sent(new Response(null, { status: 200, headers }));
  }

  const object = await env.ARTIFACTS.get(file.r2Key, { range: request.headers });
  if (!object) return sent(withCookies(message(503, PAGES.fileUnavailable), setCookies));
  // R2 reports a range even for whole-object reads; only answer 206 when the client asked for one.
  if (request.headers.has("Range") && object.range) {
    const { start, length } = byteSpan(object.range, file.size);
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${file.size}`);
    headers.set("Content-Length", String(length));
    return sent(new Response(object.body, { status: 206, headers }), length);
  }
  headers.set("Content-Length", String(file.size));
  return sent(new Response(object.body, { status: 200, headers }), file.size);
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
    return injectReviewBanner(
      response,
      REVIEW_SESSION.tabSessionTtlSeconds / 60,
      bannerLocale(request.headers.get("Accept-Language")),
    );
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
  return isPage(file, role);
}

/** A page: a document's rendered page or an HTML file of a site. */
function isPage(file: DeliveryFile, role: Resolved["role"]): boolean {
  return role === "page" || (role === "file" && file.contentType.startsWith("text/html"));
}

/**
 * Finds what a path serves. A document's root is its rendered page, rendered once at publish;
 * its original is a download at its own path, and Markdown assets are files like a site's.
 */
async function resolveFile(
  db: RegionalDb,
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
function contentHeaders(
  artifact: DeliveryArtifact,
  env: Env,
  review: boolean,
  link = false,
): Headers {
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
  if (link) {
    // A link visitor's pages send no referrer and are framed by nothing but the artifact itself.
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
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

/** The share link callback: the artifact's root with a session, or one failure page. */
function linkStepResponse(step: LinkStep): Response {
  if (step.kind === "unavailable") return message(503, PAGES.unavailable);
  const response =
    step.kind === "redirect"
      ? new Response(null, {
          status: 303,
          headers: { Location: step.location, "Cache-Control": "no-store" },
        })
      : message(step.status, PAGES.shareEnded);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex");
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

/**
 * An old `.dev` link to a page, sent to the same path on the custom host. Never cached: it
 * depends on the visitor's access and on the domain staying attached. No HSTS on the custom host.
 */
function canonicalRedirect(location: string, setCookies: string[]): Response {
  return withCookies(
    new Response(null, {
      status: 308,
      headers: {
        Location: location,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
      },
    }),
    setCookies,
  );
}

/** Plain `http` on a custom host: the same URL on `https`, without HSTS. */
function httpsUpgrade(url: URL): Response {
  const target = new URL(url);
  target.protocol = "https:";
  return new Response(null, {
    status: 308,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

/** The region's access log database; the content Worker is always bound to it. */
function accessDbOf(handles: RegionHandles): AccessDb {
  if (!handles.accessDb) throw new Error(`Region ${handles.region} has no access log binding`);
  return handles.accessDb;
}

/**
 * The owner's logo for a branded viewer bar (premium plan P9), at
 * `/__portifact/brand/<sha256>`: only for an image request (`Sec-Fetch-Dest: image`, so never a
 * document, and nothing without fetch metadata), only the current logo of this artifact's owner
 * while the artifact is servable and the brand is shown. The bytes were checked as a PNG, JPEG or
 * WebP file when uploaded; it is sent with that exact type, `nosniff` and a policy that runs
 * nothing, and it is immutable because its address is its SHA-256. It is Portifact's chrome
 * around the artifact, not the artifact, so it is not charged as traffic (at most 100 KB, cached
 * for a year).
 */
async function brandLogo(
  request: Request,
  env: Env,
  db: RegionalDb,
  artifactId: string,
  sha256: string,
  now: number,
): Promise<Response> {
  if (request.headers.get("Sec-Fetch-Dest") !== "image") return notFound();
  const logo = await findBrandLogo(db, { artifactId, sha256, now });
  const object = logo ? await env.ARTIFACTS.get(logo.key) : null;
  if (!logo || !object) return notFound();
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": logo.type,
      "Content-Length": String(object.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // The viewer on the app's origin is another site, so it needs `cross-origin`.
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    },
  });
}
