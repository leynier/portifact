import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { beginGate, dataGate, redeemGate } from "../../artifact-data/src/gate.ts";
import {
  beginTransaction,
  type GrantClaims,
  issueCode,
  type KeyRing,
  newVisitorId,
  openValue,
  type PendingGrant,
  redeem,
  sealValue,
  sha256,
} from "../../artifact-data/src/grants.ts";
import {
  APP_HOST,
  APP_ORIGIN,
  type ArtifactId,
  artifactFromHost,
  artifactHost,
  artifactOrigin,
  GRANT_COOKIE,
  REDIRECT_HOST,
  SESSION_COOKIE,
  TX_COOKIE,
} from "./hosts.ts";
import { artifactPage, consentPage, messagePage, viewerPage } from "./pages.ts";
import { selfSignedCertificate } from "./tls.ts";

// One HTTPS server plays the app Worker (sign-in stand-in, the viewer, the consent control and
// the code API) and the content Worker (the two gates, the redemption, `me` and a write), using
// the rules of decision 0026's prototype (`spikes/artifact-data/src/gate.ts` and `grants.ts`).
// Cookies are decided by the browsers, which is what this experiment measures.

export interface Grant {
  id: string;
  artifact: ArtifactId;
  user: string;
  visitor: string;
  revokedAt: number | null;
}

export interface Write {
  artifact: ArtifactId;
  visitor: string;
  text: string;
}

export interface Redemption {
  artifact: ArtifactId;
  flow: string;
  outcome: "gate_refused" | "code_refused" | "redeemed";
}

export interface GrantServer {
  port: number;
  grants: Map<string, Grant>;
  writes: Write[];
  redemptions: Redemption[];
  /** Every code the app issued, in order: the tests' view of what a page cannot see. */
  issued: { code: string; user: string; host: string }[];
  claimsMs: number;
  /**
   * Test instrumentation: the next Allow issues its code but answers it as a link instead of
   * redirecting, so a test holds a live code the browser that asked has not redeemed yet.
   */
  holdNextCode: boolean;
  close(): Promise<void>;
}

interface Session {
  user: string;
  name: string;
}

const RING: KeyRing = { current: "k1", keys: { k1: randomBytes(32).toString("base64url") } };
const GRANT_DAYS_MS = 30 * 86_400_000;

/** The parts of a `Request` the gates read, without Node's fetch rewriting fetch metadata. */
function asRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === "string") headers.set(name.toLowerCase(), value);
  return {
    method: req.method ?? "GET",
    url: url.toString(),
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
  } as unknown as Request;
}

export function parseCookies(headerValue: string | undefined): Array<[string, string]> {
  if (!headerValue) return [];
  return headerValue
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part): [string, string] => {
      const index = part.indexOf("=");
      return index === -1 ? ["", part] : [part.slice(0, index), part.slice(index + 1)];
    });
}

/** Exactly one value under the exact, case-sensitive name, or nothing (decision 0002). */
function onlyCookie(req: IncomingMessage, name: string): string | null {
  const values = parseCookies(req.headers.cookie)
    .filter(([key]) => key === name)
    .map(([, value]) => value);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function cookie(name: string, value: string, partitioned: boolean, maxAge: number): string {
  const site = partitioned ? "SameSite=None; Partitioned" : "SameSite=Lax";
  return `${name}=${value}; Path=/; Secure; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const CONTENT_HEADERS = {
  ...NO_STORE,
  "Content-Security-Policy": `frame-ancestors 'self' ${APP_ORIGIN}`,
  "X-Content-Type-Options": "nosniff",
};

export async function startServer(options: { claimsMs?: number } = {}): Promise<GrantServer> {
  const claimsMs = options.claimsMs ?? 60_000;
  const sessions = new Map<string, Session>();
  const pending = new Map<string, { pending: PendingGrant; user: string; artifact: ArtifactId }>();
  const grants = new Map<string, Grant>();
  const journal = new Map<string, string>();
  const writes: Write[] = [];
  const redemptions: Redemption[] = [];
  const issued: GrantServer["issued"] = [];
  const state = { grants, writes, redemptions, issued, claimsMs, holdNextCode: false };

  function sessionOf(req: IncomingMessage): Session | null {
    const token = onlyCookie(req, SESSION_COOKIE);
    return token === null ? null : (sessions.get(token) ?? null);
  }

  /** The app issues a one-use code for the person, bound to the nonce's hash and the host. */
  async function issue(session: Session, host: string, nonceHash: string): Promise<string | null> {
    const artifact = artifactFromHost(host);
    if (artifact === undefined || !/^[A-Za-z0-9_-]{43}$/.test(nonceHash)) return null;
    // The journal: one visitor ID per person and artifact, reused by later grants.
    const key = `${session.user}|${artifact}`;
    const visitor = journal.get(key) ?? newVisitorId();
    journal.set(key, visitor);
    const grantId = `g_${randomBytes(9).toString("base64url")}`;
    grants.set(grantId, { id: grantId, artifact, user: session.user, visitor, revokedAt: null });
    const { code, pending: entry } = await issueCode(nonceHash, host, grantId, Date.now());
    pending.set(entry.codeHash, { pending: entry, user: session.user, artifact });
    issued.push({ code, user: session.user, host });
    return code;
  }

  /**
   * The grant cookie's claims, renewed against the grant row once they expire (every 60 seconds
   * in production, `claimsMs` here): a revoked grant stops at the next renewal.
   */
  async function grantOf(
    req: IncomingMessage,
    artifact: ArtifactId,
  ): Promise<{ claims: GrantClaims & { partitioned: boolean }; renewed: string | null } | null> {
    const value = onlyCookie(req, GRANT_COOKIE);
    if (value === null) return null;
    const claims = await openValue<GrantClaims & { partitioned: boolean }>(RING, value);
    if (claims === null || claims.artifact !== artifact) return null;
    const now = Date.now();
    if (claims.claimsUntil > now) return { claims, renewed: null };
    const grant = grants.get(claims.grant);
    if (grant === undefined || grant.revokedAt !== null || claims.grantUntil <= now) return null;
    const next = { ...claims, claimsUntil: now + claimsMs };
    return { claims: next, renewed: await sealValue(RING, next) };
  }

  async function handleApp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET" && url.pathname === "/test/signin") {
      // The stand-in for signing in: a first-party session cookie on the app.
      const token = randomBytes(18).toString("base64url");
      const user = url.searchParams.get("user") ?? "alice";
      sessions.set(token, { user, name: url.searchParams.get("name") ?? user });
      res.writeHead(200, {
        "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        "Content-Type": "text/plain",
        ...NO_STORE,
      });
      res.end(`signed in as ${user}`);
      return;
    }
    const viewer = /^\/view\/(art[12])$/.exec(url.pathname);
    if (req.method === "GET" && viewer?.[1]) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `frame-src ${artifactOrigin(viewer[1] as ArtifactId)}; frame-ancestors 'none'`,
        ...NO_STORE,
      });
      res.end(viewerPage(viewer[1] as ArtifactId));
      return;
    }
    if (req.method === "GET" && url.pathname === "/data/consent") {
      // The control Portifact draws for the direct-visit, popup and tab flows.
      const session = sessionOf(req);
      const host = url.searchParams.get("host") ?? "";
      const nonceHash = url.searchParams.get("nonceHash") ?? "";
      // Not `no-referrer`: with it the form's POST carries `Origin: null` and is refused.
      res.writeHead(session === null ? 401 : 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "Cache-Control": "no-store",
        "Referrer-Policy": "strict-origin",
      });
      res.end(consentPage(session?.name ?? null, host, nonceHash));
      return;
    }
    if (req.method === "POST" && url.pathname === "/data/consent") {
      const session = sessionOf(req);
      if (req.headers.origin !== APP_ORIGIN || session === null) {
        res.writeHead(403, NO_STORE).end();
        return;
      }
      const form = new URLSearchParams(await body(req));
      const host = form.get("host") ?? "";
      const code = await issue(session, host, form.get("nonceHash") ?? "");
      if (code === null) {
        res.writeHead(400, NO_STORE).end();
        return;
      }
      const location = `https://${host}/__portifact/data/grant?flow=popup&code=${encodeURIComponent(code)}`;
      if (state.holdNextCode) {
        state.holdNextCode = false;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_STORE });
        res.end(`<!doctype html><title>held</title><a id="held" href="${location}">continue</a>`);
        return;
      }
      res.writeHead(303, { Location: location, ...NO_STORE });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/data/grant-codes") {
      const session = sessionOf(req);
      if (req.headers.origin !== APP_ORIGIN || session === null) {
        res.writeHead(403, NO_STORE).end();
        return;
      }
      const input = JSON.parse(await body(req)) as { artifact?: string; nonceHash?: string };
      const artifact = input.artifact === "art2" ? "art2" : "art1";
      const code = await issue(session, artifactHost(artifact), input.nonceHash ?? "");
      res.writeHead(code === null ? 400 : 200, { "Content-Type": "application/json", ...NO_STORE });
      res.end(JSON.stringify({ code }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/data/grants/revoke") {
      const session = sessionOf(req);
      if (req.headers.origin !== APP_ORIGIN || session === null) {
        res.writeHead(403, NO_STORE).end();
        return;
      }
      const input = JSON.parse(await body(req)) as { artifact?: string };
      let revoked = 0;
      for (const grant of grants.values()) {
        if (
          grant.user === session.user &&
          grant.artifact === input.artifact &&
          grant.revokedAt === null
        ) {
          grant.revokedAt = Date.now();
          revoked += 1;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json", ...NO_STORE });
      res.end(JSON.stringify({ revoked }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_STORE });
      res.end("<!doctype html><title>app</title><p>app</p>");
      return;
    }
    res.writeHead(404, NO_STORE).end();
  }

  async function handleContent(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    artifact: ArtifactId,
  ): Promise<void> {
    const host = artifactHost(artifact);
    const request = asRequest(req, url);
    const frame = url.searchParams.get("flow") === "frame";
    const send = (
      status: number,
      type: string,
      text: string,
      extra: Record<string, string | string[]> = {},
    ) => {
      res.writeHead(status, { "Content-Type": type, ...CONTENT_HEADERS, ...extra });
      res.end(text);
    };
    switch (url.pathname) {
      case "/":
        send(200, "text/html; charset=utf-8", artifactPage(artifact));
        return;
      case "/__portifact/data/grant/begin": {
        if (beginGate(request) === "refused") {
          send(403, "text/plain", "refused");
          return;
        }
        const { nonce, nonceHash } = await beginTransaction();
        const tx = cookie(TX_COOKIE, await sealValue(RING, { nonce }), frame, 300);
        if (frame) {
          // The nonce's hash goes to the viewer only, by its exact origin.
          send(
            200,
            "text/html; charset=utf-8",
            messagePage({ type: "grant-begin", nonceHash }, "parent", APP_ORIGIN),
            { "Set-Cookie": tx },
          );
          return;
        }
        const consent = new URL(`${APP_ORIGIN}/data/consent`);
        consent.searchParams.set("host", host);
        consent.searchParams.set("nonceHash", nonceHash);
        res.writeHead(303, { Location: consent.toString(), "Set-Cookie": tx, ...NO_STORE });
        res.end();
        return;
      }
      case "/__portifact/data/grant": {
        const unavailable = () =>
          frame
            ? send(
                200,
                "text/html; charset=utf-8",
                messagePage({ type: "grant-unavailable" }, "parent", APP_ORIGIN),
              )
            : send(403, "text/plain", "this code cannot be used here");
        if (redeemGate(request, frame ? "frame" : "popup") === "refused") {
          redemptions.push({ artifact, flow: frame ? "frame" : "popup", outcome: "gate_refused" });
          send(403, "text/plain", "refused");
          return;
        }
        const code = url.searchParams.get("code") ?? "";
        const sealed = onlyCookie(req, TX_COOKIE);
        const tx = sealed === null ? null : await openValue<{ nonce: string }>(RING, sealed);
        const entry = pending.get(await sha256(code));
        const result = await redeem(entry?.pending, code, tx?.nonce ?? null, host, Date.now());
        if (!result.ok || entry === undefined) {
          redemptions.push({ artifact, flow: frame ? "frame" : "popup", outcome: "code_refused" });
          unavailable();
          return;
        }
        redemptions.push({ artifact, flow: frame ? "frame" : "popup", outcome: "redeemed" });
        const grant = grants.get(result.grantId) as Grant;
        const now = Date.now();
        const claims = {
          grant: grant.id,
          artifact,
          visitor: grant.visitor,
          claimsUntil: now + claimsMs,
          grantUntil: now + GRANT_DAYS_MS,
          partitioned: frame,
        };
        res.writeHead(303, {
          Location: `/__portifact/data/grant/check?flow=${frame ? "frame" : "popup"}`,
          "Set-Cookie": [
            cookie(GRANT_COOKIE, await sealValue(RING, claims), frame, GRANT_DAYS_MS / 1000),
            cookie(TX_COOKIE, "", frame, 0),
          ],
          ...NO_STORE,
        });
        res.end();
        return;
      }
      case "/__portifact/data/grant/check": {
        // Detects a dropped cookie, as review mode's check path does (decision 0002).
        const held = await grantOf(req, artifact);
        if (held === null) {
          send(
            200,
            "text/html; charset=utf-8",
            frame
              ? messagePage({ type: "grant-unavailable" }, "parent", APP_ORIGIN)
              : "<!doctype html><title>unavailable</title><p id=unavailable>Saving is unavailable in this browser.</p>",
          );
          return;
        }
        if (frame) {
          res.writeHead(303, { Location: "/", ...NO_STORE });
          res.end();
          return;
        }
        // The popup tells its opener (same origin) and closes; a same-tab visit goes home.
        send(
          200,
          "text/html; charset=utf-8",
          `<!doctype html><title>saved</title><p id=granted>Saved.</p><script>
if (window.opener) { window.opener.postMessage({ type: "granted" }, location.origin); window.close(); }
else { location.replace("/"); }
</script>`,
        );
        return;
      }
      case "/__portifact/data/me": {
        if (dataGate(request, false) === "refused") {
          send(403, "application/json", JSON.stringify({ error: "forbidden" }));
          return;
        }
        const held = await grantOf(req, artifact);
        const extra: Record<string, string> = {};
        if (held?.renewed)
          extra["Set-Cookie"] = cookie(
            GRANT_COOKIE,
            held.renewed,
            held.claims.partitioned,
            GRANT_DAYS_MS / 1000,
          );
        send(
          200,
          "application/json",
          JSON.stringify(
            held === null ? { granted: false } : { granted: true, visitor: held.claims.visitor },
          ),
          extra,
        );
        return;
      }
      case "/__portifact/data/c/notes": {
        if (req.method !== "POST" || dataGate(request, true) === "refused") {
          send(403, "application/json", JSON.stringify({ error: "forbidden" }));
          return;
        }
        const held = await grantOf(req, artifact);
        if (held === null) {
          send(403, "application/json", JSON.stringify({ error: "forbidden" }));
          return;
        }
        const input = JSON.parse(await body(req)) as { text?: unknown };
        writes.push({ artifact, visitor: held.claims.visitor, text: String(input.text ?? "") });
        const extra: Record<string, string> = {};
        if (held.renewed)
          extra["Set-Cookie"] = cookie(
            GRANT_COOKIE,
            held.renewed,
            held.claims.partitioned,
            GRANT_DAYS_MS / 1000,
          );
        send(201, "application/json", JSON.stringify({ by: held.claims.visitor }), extra);
        return;
      }
      default:
        send(404, "text/plain", "not found");
    }
  }

  const server: Server = createServer(selfSignedCertificate(), (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const url = new URL(req.url ?? "/", `https://${host}`);
    const fail = () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    };
    if (host === APP_HOST) {
      handleApp(req, res, url).catch(fail);
      return;
    }
    if (host === REDIRECT_HOST) {
      res.writeHead(302, { Location: url.searchParams.get("to") ?? "/", ...NO_STORE });
      res.end();
      return;
    }
    const artifact = artifactFromHost(host);
    if (artifact) {
      handleContent(req, res, url, artifact).catch(fail);
      return;
    }
    res.writeHead(421).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
