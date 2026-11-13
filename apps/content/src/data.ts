// The page's routes of artifact data (decision 0026, delivery 6), reserved under
// `/__portifact/data/` on the artifact's own origin (and its custom host):
//
// - `grant/begin` (a top-level navigation from the artifact's own page, or the viewer's
//   navigation of its frame): a sealed transaction cookie holding a nonce. The frame flow posts
//   the nonce's SHA-256 to the viewer by its exact origin; the top-level flow (tab or popup) goes
//   to the app's control with it.
// - `grant?flow=…&code=…` (a cross-site navigation from the app): redeems the one-use code with
//   this browser's transaction, on this host, into `__Host-pf_grant` (partitioned in the frame).
// - `grant/check`: whether the cookie was kept; the frame tells the viewer, the popup its opener.
// - `me`, `c/<collection>[/<id>]`, `mine`: the data API, same-origin only (`apiGate`), after the
//   reading authorization, the network policy, the traffic quota and budget protection.
// - `live` (a WebSocket upgrade) and `live/renew`: live updates (delivery 7), the same gate and
//   reading authorization; a connection lasts a minute unless the page renews it.
// - `data.js`: the client script.
//
// The grant's claims are renewed against D1 every 60 seconds (`renewDataGrant`), so revoking,
// signing out of the app or losing access ends writes within a minute. Without a grant `me` says
// only `granted: false`, the same for everyone. Nothing here writes D1 per request.
import {
  DATA_GRANT,
  DataGrantClaims,
  DataGrantTransaction,
  type DataMe,
  ERROR_STATUS,
  type ErrorCode,
  OpaqueToken,
} from "@portifact/contracts";
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  CollectionName,
  DataQuery,
  DocumentId,
  ExportCursor,
  LiveSocketId,
  type PageCaller,
  type PageDataCommand,
  type StorageReport,
} from "@portifact/contracts/artifact-data";
import type { RegionalDb } from "@portifact/db";
import { apiGate, beginGate, redeemGate } from "@portifact/domain/artifact-data";
import {
  type DataObjects,
  dataLiveEnabled,
  nonceDigest,
  openLiveConnection,
  pageDataCommand,
  randomToken,
  redeemDataGrantCode,
  renewDataGrant,
  renewLiveConnection,
} from "@portifact/services";
import { cookieValue, MAX_VALUE_LENGTH, seal, unseal, usableSecret } from "./cookies.ts";
import { cspNonce } from "./inject.ts";
import type { ServableArtifact } from "./read-session.ts";

export const DATA_PREFIX = "/__portifact/data/";
export const GRANT_COOKIE = "__Host-pf_grant";
export const GRANT_TX_COOKIE = "__Host-pf_grant_tx";
export const DATA_SCRIPT_PATH = `${DATA_PREFIX}data.js`;

const GRANT_PURPOSE = "pf_grant";
const TX_PURPOSE = "pf_grant_tx";
const SECOND_MS = 1000;
/** The largest request body the data API reads: above every plan's document size. */
const BODY_LIMIT = 80 * 1024;

export interface DataEnv {
  APP_ORIGIN: string;
  READ_SESSION_SECRET?: string | undefined;
  ARTIFACT_DATA_ENABLED?: string | undefined;
  DATA_LIVE_ENABLED?: string | undefined;
}

/** Whether a path is one of the data routes (routed before the `GET`/`HEAD` check). */
export function isDataPath(pathname: string): boolean {
  return pathname.startsWith(DATA_PREFIX);
}

/** What reading authorization found: the artifact, cookies to set, and whether a person reads. */
export interface DataReader {
  artifact: ServableArtifact;
  setCookies: string[];
  signedIn: boolean;
  /** The owner plan's per-artifact data limits, from the plan the delivery lookup holds. */
  limits: ArtifactDataLimits;
  /**
   * The read, link or review session that allowed the request and how long its claims hold, or
   * null for an anonymous reader of a public artifact. Never sent to the page.
   */
  credential: { id: string; expiresAt: number } | null;
}

/** What the content Worker gives the data routes. */
export interface DataContext {
  request: Request;
  env: DataEnv;
  db: RegionalDb;
  region: string;
  artifactId: string;
  /** The exact host of the request: codes redeem only on the host they were issued for. */
  host: string;
  /** The artifact's custom host when the request came on it, else null. */
  customHost: string | null;
  now: number;
  objects: DataObjects | null;
  /**
   * Authorizes reading the artifact (a public artifact, or a read, review or link session);
   * claims expiring within `freshWithin` are renewed against D1 first.
   */
  read(freshWithin?: number): Promise<DataReader | null>;
  /**
   * The delivery gates after authorization (the network policy, the traffic quota, budget
   * protection): a refusal, or null to go on.
   */
  gate(reader: DataReader): Promise<Response | null>;
  /** Charges one answered request to the owner's traffic. */
  charge(reader: DataReader, bytes: number): void;
  /** Keeps the object's newest storage report, written in a batch. */
  keepStorage(artifactId: string, report: StorageReport): void;
}

/** The data routes: 404 while artifact data is off, as if they did not exist. */
export async function handleData(context: DataContext): Promise<Response> {
  const { env, request } = context;
  const path = new URL(request.url).pathname.slice(DATA_PREFIX.length);
  if (env.ARTIFACT_DATA_ENABLED !== "true") return apiError("not_found", "Not found.");
  if (path === "data.js") return clientScript(request);
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret))
    return apiError("capacity_unavailable", "Unavailable. Try again later.");
  if (path === "grant/begin") return begin(context, secret);
  if (path === "grant") return redeem(context, secret);
  if (path === "grant/check") return check(context, secret);
  return api(context, secret, path);
}

// The grant's cookies.

type Flow = "frame" | "top";

function flowOf(url: URL): Flow {
  return url.searchParams.get("flow") === "frame" ? "frame" : "top";
}

/**
 * Host-only and HttpOnly. In the viewer's frame partitioned (CHIPS) with `SameSite=None`, so it
 * lives only in the viewer's partition; at the top level `SameSite=Lax`.
 */
function grantCookie(name: string, value: string, maxAgeSeconds: number, flow: Flow): string {
  const site = flow === "frame" ? "SameSite=None; Partitioned" : "SameSite=Lax";
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; Secure; HttpOnly; ${site}`;
}

const clearGrant = (flow: Flow) => grantCookie(GRANT_COOKIE, "", 0, flow);
const clearTransaction = (flow: Flow) => grantCookie(GRANT_TX_COOKIE, "", 0, flow);

async function sealClaims(secret: string, claims: DataGrantClaims): Promise<string> {
  return grantCookie(
    GRANT_COOKIE,
    await seal(secret, GRANT_PURPOSE, claims),
    (claims.gexp - claims.exp + DATA_GRANT.claimsTtlSeconds * SECOND_MS) / SECOND_MS,
    claims.part ? "frame" : "top",
  );
}

async function transaction(
  request: Request,
  secret: string,
  artifactId: string,
  now: number,
): Promise<DataGrantTransaction | null> {
  const value = cookieValue(request.headers.get("Cookie"), GRANT_TX_COOKIE);
  if (value === null || value.length > MAX_VALUE_LENGTH) return null;
  const parsed = DataGrantTransaction.safeParse(await unseal(secret, TX_PURPOSE, value));
  if (!parsed.success) return null;
  return parsed.data.aid === artifactId && parsed.data.exp > now ? parsed.data : null;
}

/**
 * The grant the request carries, renewed when its claims are older than a minute. A partitioned
 * (frame) grant is never honored on a top-level document: a genuine one lives in the viewer's
 * partition and never reaches one, so a sibling planted it.
 */
async function grantOf(
  context: DataContext,
  secret: string,
  /** Claims expiring within this are renewed against D1 now (live updates' renewals). */
  freshWithin = 0,
): Promise<{ claims: DataGrantClaims | null; setCookies: string[] }> {
  const { request, artifactId, now } = context;
  const value = cookieValue(request.headers.get("Cookie"), GRANT_COOKIE);
  if (value === null) return { claims: null, setCookies: [] };
  const parsed = DataGrantClaims.safeParse(await unseal(secret, GRANT_PURPOSE, value));
  if (!parsed.success || parsed.data.aid !== artifactId) return { claims: null, setCookies: [] };
  const claims = parsed.data;
  if (claims.part && request.headers.get("Sec-Fetch-Dest") === "document") {
    return { claims: null, setCookies: [] };
  }
  const flow: Flow = claims.part ? "frame" : "top";
  if (claims.gexp <= now) return { claims: null, setCookies: [clearGrant(flow)] };
  if (claims.exp > now + freshWithin) return { claims, setCookies: [] };
  const renewed = await renewDataGrant(context.db, { grantId: claims.gid, artifactId, now });
  if (!renewed.ok) return { claims: null, setCookies: [clearGrant(flow)] };
  const next: DataGrantClaims = {
    ...claims,
    name: renewed.value.name.slice(0, 200),
    w: renewed.value.write,
    exp: Math.min(now + DATA_GRANT.claimsTtlSeconds * SECOND_MS, renewed.value.expiresAt),
    gexp: renewed.value.expiresAt,
  };
  return { claims: next, setCookies: [await sealClaims(secret, next)] };
}

// The three grant steps.

/**
 * `grant/begin?flow=frame|top`: only the artifact's own top-level page or the viewer's frame
 * navigation (`beginGate`), for a reader of the artifact. Sets the transaction, then hands the
 * nonce's hash to the viewer (frame) or the app's control (top).
 */
async function begin(context: DataContext, secret: string): Promise<Response> {
  const { request, env, artifactId, now } = context;
  if (beginGate(request.method, request.headers) === "refused") return refusedPage();
  const reader = await context.read();
  if (reader === null) return refusedPage();
  const url = new URL(request.url);
  const flow = flowOf(url);
  const nonce = randomToken();
  const back = url.searchParams.get("to");
  const tx: DataGrantTransaction = {
    v: 1,
    aid: artifactId,
    nonce,
    flow,
    path: back?.startsWith("/") && !back.startsWith("//") && back.length <= 1024 ? back : "/",
    exp: now + DATA_GRANT.transactionTtlSeconds * SECOND_MS,
  };
  const txCookie = grantCookie(
    GRANT_TX_COOKIE,
    await seal(secret, TX_PURPOSE, tx),
    DATA_GRANT.transactionTtlSeconds,
    flow,
  );
  const nonceHash = await nonceDigest(nonce);
  if (flow === "frame") {
    return withCookies(
      messagePage({ type: "portifact:data-grant-begin", nonceHash }, "parent", env.APP_ORIGIN),
      [...reader.setCookies, txCookie],
    );
  }
  const control = new URL("/data/grant", env.APP_ORIGIN);
  control.searchParams.set("artifact", artifactId);
  control.searchParams.set("nonce", nonceHash);
  if (context.customHost !== null) control.searchParams.set("host", context.customHost);
  return withCookies(redirect(control.toString()), [...reader.setCookies, txCookie]);
}

/**
 * `grant?flow=…&code=…`: a cross-site navigation from the app (`redeemGate`). The code redeems
 * only with this browser's transaction nonce, on this host, once. Every failure answers alike.
 */
async function redeem(context: DataContext, secret: string): Promise<Response> {
  const { request, env, artifactId, now } = context;
  const url = new URL(request.url);
  const flow = flowOf(url);
  const unavailable = () =>
    flow === "frame"
      ? messagePage({ type: "portifact:data-grant-unavailable" }, "parent", env.APP_ORIGIN)
      : refusedPage();
  if (redeemGate(request.method, request.headers, flow) === "refused") return refusedPage();
  const codes = url.searchParams.getAll("code");
  const code = codes.length === 1 ? OpaqueToken.safeParse(codes[0]) : null;
  const tx = await transaction(request, secret, artifactId, now);
  if (!code?.success || tx === null || tx.flow !== flow) return unavailable();
  const redeemed = await redeemDataGrantCode(context.db, {
    code: code.data,
    artifactId,
    nonceHash: await nonceDigest(tx.nonce),
    host: context.host,
    now,
  });
  if (!redeemed.ok) return withCookies(unavailable(), [clearTransaction(flow)]);
  const grant = redeemed.value;
  const claims: DataGrantClaims = {
    v: 1,
    gid: grant.grantId as DataGrantClaims["gid"],
    aid: artifactId,
    vid: grant.visitorId,
    name: grant.name.slice(0, 200),
    w: grant.write,
    exp: Math.min(now + DATA_GRANT.claimsTtlSeconds * SECOND_MS, grant.expiresAt),
    gexp: grant.expiresAt,
    part: flow === "frame",
  };
  const checkUrl = `${DATA_PREFIX}grant/check?${new URLSearchParams({ flow, to: tx.path })}`;
  return withCookies(redirect(checkUrl), [
    clearTransaction(flow),
    await sealClaims(secret, claims),
  ]);
}

/**
 * `grant/check`: whether the browser kept the grant cookie (a partitioned one may be refused). The
 * frame tells the viewer `granted` or `unavailable` (then the viewer offers the top-level tab);
 * a popup tells its opener, on this origin, and closes; a same-tab visit returns to the page.
 */
async function check(context: DataContext, secret: string): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const flow = flowOf(url);
  const to = url.searchParams.get("to") ?? "/";
  const back = to.startsWith("/") && !to.startsWith("//") ? to : "/";
  const held = await grantOf(context, secret);
  if (flow === "frame") {
    const type =
      held.claims === null ? "portifact:data-grant-unavailable" : "portifact:data-granted";
    return withCookies(
      messagePage({ type, to: back }, "parent", env.APP_ORIGIN, back),
      held.setCookies,
    );
  }
  if (held.claims === null) return withCookies(refusedPage(), held.setCookies);
  return withCookies(openerPage(back), held.setCookies);
}

// The API.

/** Which command a request is, or a refusal. */
async function commandOf(
  request: Request,
  path: string,
): Promise<{ command: PageDataCommand; status: number } | { refused: Response }> {
  const bad = (message: string) => ({ refused: apiError("invalid_input", message) });
  const method = request.method;
  if (path === "mine" && method === "GET") {
    const raw = new URL(request.url).searchParams.get("after");
    if (raw === null) return { command: { kind: "export_mine", after: null }, status: 200 };
    const at = raw.indexOf(":");
    const after = ExportCursor.safeParse({ collection: raw.slice(0, at), id: raw.slice(at + 1) });
    if (at < 0 || !after.success) return bad("Invalid cursor.");
    return { command: { kind: "export_mine", after: after.data }, status: 200 };
  }
  const parts = path.split("/");
  if (parts[0] !== "c" || parts.length < 2 || parts.length > 3) {
    return { refused: apiError("not_found", "Not found.") };
  }
  const collection = CollectionName.safeParse(parts[1]);
  if (!collection.success) return bad("Invalid collection.");
  if (parts.length === 2) {
    if (method === "GET") {
      const raw = new URL(request.url).searchParams.get("q");
      let extra: unknown = {};
      if (raw !== null) {
        try {
          extra = JSON.parse(raw);
        } catch {
          return bad("Invalid query.");
        }
      }
      const query = DataQuery.safeParse({
        ...(typeof extra === "object" && extra !== null ? extra : {}),
        collection: collection.data,
      });
      if (!query.success) return bad("Invalid query.");
      return { command: { kind: "query", query: query.data }, status: 200 };
    }
    if (method === "POST") {
      const body = await jsonBody(request);
      if (body === null) return bad("Send one JSON object.");
      return { command: { kind: "create", collection: collection.data, body }, status: 201 };
    }
    return { refused: apiError("invalid_input", "Method not allowed.", 405) };
  }
  const id = DocumentId.safeParse(parts[2]);
  if (!id.success) return { refused: apiError("not_found", "No such document.") };
  if (method === "GET") {
    return { command: { kind: "get", collection: collection.data, id: id.data }, status: 200 };
  }
  if (method === "DELETE") {
    return { command: { kind: "remove", collection: collection.data, id: id.data }, status: 200 };
  }
  if (method === "PUT") {
    const body = await jsonBody(request);
    if (body === null) return bad("Send one JSON object.");
    return {
      command: { kind: "replace", collection: collection.data, id: id.data, body },
      status: 200,
    };
  }
  return { refused: apiError("invalid_input", "Method not allowed.", 405) };
}

/**
 * `me`, `c/…` and `mine`: same-origin requests of the artifact's own page (`apiGate`; writes
 * also carry the exact origin and JSON), for a reader of the artifact, after the delivery gates.
 * The caller is the grant holder or a reader; never what the page says.
 */
async function api(context: DataContext, secret: string, path: string): Promise<Response> {
  const { request } = context;
  const write = request.method !== "GET" && request.method !== "HEAD";
  const origin = new URL(request.url).origin;
  if (apiGate(request.headers, origin, write) === "refused") {
    return apiError("forbidden", "Only the artifact's own page may use its data.");
  }
  if (path !== "me" && path !== "mine" && path !== "live" && path !== "live/renew") {
    if (!path.startsWith("c/")) return apiError("not_found", "Not found.");
  }
  // Live updates renew from claims fresh enough to outlast the next renewal, so a connection never
  // outlives the credential that holds it by more than the claims' own minute.
  const fresh = path === "live" || path === "live/renew" ? LIVE_FRESH_MS : 0;
  const reader = await context.read(fresh);
  if (reader === null) return apiError("not_found", "Not found.");
  const refusal = await context.gate(reader);
  if (refusal !== null) return refusal;
  const held = await grantOf(context, secret, fresh);
  const setCookies = [...reader.setCookies, ...held.setCookies];
  if (path === "live" || path === "live/renew") {
    return live(context, reader, held.claims, setCookies, path);
  }
  if (path === "me") {
    const me: DataMe =
      held.claims === null
        ? { granted: false }
        : {
            granted: true,
            visitor: { id: held.claims.vid, name: held.claims.name },
            write: held.claims.w,
          };
    return answered(context, reader, apiJson(me, 200), setCookies);
  }
  const parsed = await commandOf(request, path);
  if ("refused" in parsed) return answered(context, reader, parsed.refused, setCookies);
  const caller: PageCaller =
    held.claims === null
      ? { kind: "reader" }
      : { kind: "visitor", author: held.claims.vid, canWrite: held.claims.w };
  if (
    caller.kind === "reader" &&
    parsed.command.kind !== "get" &&
    parsed.command.kind !== "query"
  ) {
    return answered(
      context,
      reader,
      apiError("forbidden", "Ask the visitor to allow this page to save first."),
      setCookies,
    );
  }
  const key = request.headers.get("Idempotency-Key");
  const { result, storage } = await pageDataCommand(
    context.db,
    { objects: context.objects },
    {
      artifactId: context.artifactId,
      region: context.region,
      limits: reader.limits,
      caller,
      command: parsed.command,
      idempotencyKey: key !== null && key.length > 0 && key.length <= 128 ? key : null,
      now: context.now,
    },
  );
  if (storage !== null) context.keepStorage(context.artifactId, storage);
  // A replay says only that the operation was done: the object keeps no body to answer with.
  const response = result.ok
    ? result.value.replayed
      ? apiJson({ replayed: true }, 200)
      : apiJson(result.value.value, parsed.status)
    : apiError(result.code, result.message);
  return answered(context, reader, response, setCookies);
}

// Live updates (delivery 7).

/** Claims expiring within this are renewed before a live connect or renewal. */
const LIVE_FRESH_MS = 30_000;

/**
 * The credential a connection is bound to and when it stops holding: the visitor's grant, or the
 * reader's own read, link or review session (named by a hash of its ID, which never leaves this
 * Worker or the object); an anonymous reader of a public artifact is bound to the artifact staying
 * public, which every renewal checks. A connection is renewed only by the same credential, checked
 * live at each renewal, so knowing its ID grants nothing.
 */
async function liveCredential(
  claims: DataGrantClaims | null,
  reader: DataReader,
  now: number,
): Promise<{ principal: string; expiresAt: number }> {
  if (claims !== null) {
    return { principal: `grant:${claims.gid}`, expiresAt: Math.min(claims.exp, claims.gexp) };
  }
  if (reader.credential === null) {
    return { principal: "public", expiresAt: now + ARTIFACT_DATA.live.deadlineMs };
  }
  const [kind] = reader.credential.id.split(":", 1);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reader.credential.id)),
  );
  return {
    principal: `${kind}:${btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}`,
    expiresAt: reader.credential.expiresAt,
  };
}

/**
 * `live` opens a connection (`GET` with `Upgrade: websocket`, the exact origin), `live/renew`
 * (`POST` JSON `{ socket }`) keeps it another minute. The caller is the grant holder, bound to the
 * grant's ID, or a reader, bound to reading this artifact now: renewing needs the same grant, or
 * any current reading of the artifact plus the connection's ID, which only its own socket learned.
 */
async function live(
  context: DataContext,
  reader: DataReader,
  claims: DataGrantClaims | null,
  setCookies: string[],
  path: string,
): Promise<Response> {
  const { request } = context;
  const deps = { objects: context.objects, enabled: dataLiveEnabled(context.env) };
  const held = await liveCredential(claims, reader, context.now);
  const caller = {
    artifactId: context.artifactId,
    author: claims === null ? null : claims.vid,
    principal: held.principal,
    expiresAt: held.expiresAt,
    limits: reader.limits,
    now: context.now,
  };
  if (path === "live") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return answered(
        context,
        reader,
        apiError("invalid_input", "Open a WebSocket.", 426),
        setCookies,
      );
    }
    const opened = await openLiveConnection(context.db, deps, caller);
    if (!opened.ok) {
      return answered(context, reader, apiError(opened.code, opened.message), setCookies);
    }
    context.charge(reader, 0);
    const headers = new Headers();
    for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 101, webSocket: opened.value.webSocket, headers });
  }
  if (request.method !== "POST") {
    return answered(
      context,
      reader,
      apiError("invalid_input", "Method not allowed.", 405),
      setCookies,
    );
  }
  const body = await jsonBody(request);
  const socket = LiveSocketId.safeParse(body?.socket);
  if (!socket.success) {
    return answered(context, reader, apiError("invalid_input", "Name the connection."), setCookies);
  }
  const renewed = await renewLiveConnection(context.db, deps, { ...caller, socketId: socket.data });
  const response = renewed.ok
    ? apiJson(renewed.value, 200)
    : apiError(renewed.code, renewed.message);
  return answered(context, reader, response, setCookies);
}

function answered(
  context: DataContext,
  reader: DataReader,
  response: Response,
  setCookies: string[],
): Response {
  const length = Number(response.headers.get("Content-Length") ?? "0");
  context.charge(reader, Number.isFinite(length) ? length : 0);
  return withCookies(response, setCookies);
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > BODY_LIMIT) return null;
  const text = await request.text();
  if (text.length > BODY_LIMIT) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Answers.

const API_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Robots-Tag": "noindex",
};

function apiJson(value: unknown, status: number): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { ...API_HEADERS, "Content-Length": String(new TextEncoder().encode(body).length) },
  });
}

function apiError(code: ErrorCode, message: string, status?: number): Response {
  return apiJson({ error: { code, message } }, status ?? ERROR_STATUS[code]);
}

function withCookies(response: Response, setCookies: string[]): Response {
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

/** JSON for an inline script: nothing in it can end the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function page(body: string, nonce: string, frameAncestors: string): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Portifact</title><body>${body}</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors ${frameAncestors}`,
    },
  });
}

/**
 * A Portifact page on the artifact origin that posts one message to its parent (the viewer) by the
 * app's exact origin, then optionally returns the frame to the artifact's page.
 */
function messagePage(message: unknown, to: "parent", appOrigin: string, then?: string): Response {
  const nonce = cspNonce();
  const next = then === undefined ? "" : `location.replace(${scriptJson(then)});`;
  return page(
    `<script nonce="${nonce}">window.${to}.postMessage(${scriptJson(message)}, ${scriptJson(appOrigin)});${next}</script>`,
    nonce,
    appOrigin,
  );
}

/** The top-level flow's end: a popup tells its opener on this origin and closes; a tab returns. */
function openerPage(back: string): Response {
  const nonce = cspNonce();
  return page(
    `<p>Saved. You can close this window.</p><script nonce="${nonce}">if (window.opener) { window.opener.postMessage({ type: "portifact:data-granted" }, location.origin); window.close(); } else { location.replace(${scriptJson(back)}); }</script>`,
    nonce,
    "'none'",
  );
}

function refusedPage(): Response {
  const response = page(
    "<main><h1>Saving is not available here</h1><p>Open the artifact again and choose to save from there.</p></main>",
    cspNonce(),
    "'none'",
  );
  return new Response(response.body, { status: 403, headers: response.headers });
}

/** The client script, the same for every artifact: no identifier, no state. */
function clientScript(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : CLIENT_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

/**
 * `window.portifact.data`: `me()`, `collection(name)` with `list(query)`, `get(id)`,
 * `create(body)`, `replace(id, body)` and `remove(id)`, `mine(after)`, `live(collections, onChange)`
 * (live updates, delivery 7; `close()` ends them), and `allow()`, which starts
 * the grant: in the viewer's frame it asks the viewer (which draws the control and reloads the
 * frame once granted), otherwise it opens the top-level flow in a popup, which answers on this
 * origin only, and falls back to this tab. Every write carries an
 * idempotency key, so a retry of the same call applies once.
 */
export const CLIENT_SCRIPT = `(() => {
  "use strict";
  const base = "/__portifact/data/";
  const call = async (method, path, body, key) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key !== undefined) headers["idempotency-key"] = key;
    const response = await fetch(base + path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((value && value.error && value.error.message) || "Request failed");
      error.code = (value && value.error && value.error.code) || "unavailable";
      error.status = response.status;
      throw error;
    }
    return value;
  };
  // An idempotency key carries its issue time, so a retry of the same call is the same operation.
  const key = () => String(Date.now()).padStart(13, "0") + "." + crypto.randomUUID().replaceAll("-", "");
  const collection = (name) => {
    const at = "c/" + encodeURIComponent(name);
    return {
      list: (query) => call("GET", at + (query ? "?q=" + encodeURIComponent(JSON.stringify(query)) : "")),
      get: (id) => call("GET", at + "/" + encodeURIComponent(id)),
      create: (body) => call("POST", at, body, key()),
      replace: (id, body) => call("PUT", at + "/" + encodeURIComponent(id), body, key()),
      remove: (id) => call("DELETE", at + "/" + encodeURIComponent(id), undefined, key()),
    };
  };
  const allow = () =>
    new Promise((resolve) => {
      const done = (event) => {
        if (event.origin !== location.origin) return;
        const type = event.data && event.data.type;
        if (type !== "portifact:data-granted" && type !== "portifact:data-grant-unavailable") return;
        window.removeEventListener("message", done);
        resolve(type === "portifact:data-granted");
      };
      window.addEventListener("message", done);
      const to = location.pathname + location.search;
      if (window.parent !== window) {
        window.parent.postMessage({ type: "portifact:data-grant-request", to }, "*");
        return;
      }
      const url = base + "grant/begin?" + new URLSearchParams({ flow: "top", to });
      const popup = window.open(url, "portifact-grant", "popup,width=520,height=640");
      if (!popup) location.assign(url);
    });
  const mine = (after) => call("GET", "mine" + (after ? "?after=" + encodeURIComponent(after) : ""));
  // Live updates: follows collections' changes over one WebSocket, renewed every 20 seconds
  // (a connection lasts a minute), reconnecting after a deadline or a reset (4001, 4003) and
  // stopping for good when the day's messages are spent or the author's data was erased.
  const live = (names, onChange) => {
    let socket = null;
    let timer = null;
    let closed = false;
    let wait = 1000;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const open = () => {
      if (closed) return;
      const url = new URL(base + "live", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.addEventListener("message", (event) => {
        let message = null;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message && typeof message.connected === "string") {
          wait = 1000;
          const id = message.connected;
          for (const name of names) socket.send(JSON.stringify({ subscribe: name }));
          stop();
          timer = setInterval(() => {
            call("POST", "live/renew", { socket: id }).catch(() => {});
          }, 20000);
          return;
        }
        if (message && typeof message.collection === "string" && typeof message.kind === "string") {
          onChange(message);
        }
      });
      socket.addEventListener("close", (event) => {
        stop();
        if (closed || event.code === 4029 || event.code === 4410 || event.code === 4008) return;
        setTimeout(open, wait);
        wait = Math.min(wait * 2, 60000);
      });
    };
    open();
    return Object.freeze({
      close: () => {
        closed = true;
        stop();
        if (socket !== null) socket.close(1000);
      },
    });
  };
  window.portifact = Object.freeze({
    ...(window.portifact || {}),
    data: Object.freeze({ me: () => call("GET", "me"), collection, mine, allow, live }),
  });
})();
`;
