import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import {
  APP_HOST,
  type ArtifactId,
  artifactFromHost,
  CONTROL_COOKIE,
  isArtifactId,
  REVIEW_COOKIE,
} from "./hosts.ts";
import { artifactPage, artifactScript, artifactStyle, pixelSvg, viewerPage } from "./pages.ts";
import { selfSignedCertificate } from "./tls.ts";

// One HTTPS server plays both Workers: `app` (viewer and code API) and `content` (artifact
// delivery and the one-time code exchange). It dispatches on the Host header.

export interface ContentRequest {
  artifact: ArtifactId;
  path: string;
  // Every value the browser sent under the exact review cookie name.
  reviewValues: string[];
  // True when exactly one review value was sent and it is a live session for this artifact.
  sessionValid: boolean;
  // True when the session is valid and the fetch metadata allows review mode.
  review: boolean;
  control: boolean;
  cookieNames: string[];
  secFetchSite: string | undefined;
  secFetchMode: string | undefined;
  secFetchDest: string | undefined;
}

interface ReviewCode {
  artifact: ArtifactId;
  path: string;
  expiresAt: number;
}

export interface SpikeServer {
  port: number;
  requests: ContentRequest[];
  sessions: Map<string, ArtifactId>;
  close(): Promise<void>;
}

const CODE_TTL_MS = 60_000;

function token(): string {
  return randomBytes(18).toString("base64url");
}

export function parseCookieHeader(header: string | undefined): Array<[string, string]> {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part): [string, string] => {
      const index = part.indexOf("=");
      // A nameless cookie is serialized as its bare value.
      return index === -1 ? ["", part] : [part.slice(0, index), part.slice(index + 1)];
    });
}

export function isSafeNextPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

// The review cookie is honored only for requests the artifact makes to itself, and for the
// navigation that the trusted viewer started (it reaches the artifact as cross-site, because
// the redirect chain began on the viewer's site). A sibling artifact is always `same-site`, so
// its credentialed requests fall back to the public view even when the browser attaches the
// cookie. Missing metadata fails closed.
export function reviewAllowedByFetchMetadata(
  site: string | undefined,
  mode: string | undefined,
): boolean {
  if (site === "same-origin") return true;
  return site === "cross-site" && mode === "navigate";
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

const CONTENT_HEADERS = {
  "Content-Security-Policy": `frame-ancestors 'self' https://${APP_HOST}`,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startServer(): Promise<SpikeServer> {
  const codes = new Map<string, ReviewCode>();
  const sessions = new Map<string, ArtifactId>();
  const requests: ContentRequest[] = [];

  async function handleApp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const viewer = /^\/review\/([a-z0-9]+)$/.exec(url.pathname);
    if (req.method === "GET" && viewer?.[1] && isArtifactId(viewer[1])) {
      const path = url.searchParams.get("path") ?? "/";
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "Cache-Control": "no-store",
      });
      res.end(viewerPage(viewer[1], isSafeNextPath(path) ? path : "/"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/review-codes") {
      // Real API: exact Origin check, CSRF, session and ACL. The spike only checks Origin.
      if (req.headers.origin !== `https://${APP_HOST}`) {
        res.writeHead(403).end();
        return;
      }
      const body: unknown = JSON.parse(await readBody(req));
      const artifact = (body as { artifact?: unknown }).artifact;
      const path = (body as { path?: unknown }).path;
      if (typeof artifact !== "string" || !isArtifactId(artifact) || typeof path !== "string") {
        res.writeHead(400).end();
        return;
      }
      const code = token();
      codes.set(code, {
        artifact,
        path: isSafeNextPath(path) ? path : "/",
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ code }));
      return;
    }
    res.writeHead(404).end();
  }

  function handleContent(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    artifact: ArtifactId,
  ): void {
    if (url.pathname === "/__portifact/review") {
      const code = url.searchParams.get("code") ?? "";
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.artifact !== artifact || entry.expiresAt < Date.now()) {
        res.writeHead(403, {
          "Content-Type": "text/plain",
          ...CONTENT_HEADERS,
          "Referrer-Policy": "no-referrer",
        });
        res.end("invalid or used review code");
        return;
      }
      const session = token();
      sessions.set(session, artifact);
      res.writeHead(303, {
        Location: entry.path,
        "Set-Cookie": [
          `${REVIEW_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
          `${CONTROL_COOKIE}=1; Path=/; Secure; SameSite=None`,
        ],
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    const pairs = parseCookieHeader(req.headers.cookie);
    const reviewValues = pairs.filter(([name]) => name === REVIEW_COOKIE).map(([, v]) => v);
    const [onlyValue] = reviewValues;
    const sessionValid =
      reviewValues.length === 1 && onlyValue !== undefined && sessions.get(onlyValue) === artifact;
    const secFetchSite = header(req, "sec-fetch-site");
    const secFetchMode = header(req, "sec-fetch-mode");
    const review = sessionValid && reviewAllowedByFetchMetadata(secFetchSite, secFetchMode);
    requests.push({
      artifact,
      path: url.pathname,
      reviewValues,
      sessionValid,
      review,
      control: pairs.some(([name]) => name === CONTROL_COOKIE),
      cookieNames: pairs.map(([name]) => name),
      secFetchSite,
      secFetchMode,
      secFetchDest: header(req, "sec-fetch-dest"),
    });

    const mode = review ? "review" : "public";
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, {
        "Content-Type": type,
        ...CONTENT_HEADERS,
        // Review bytes are never usable by a sibling through no-cors loads.
        "Cross-Origin-Resource-Policy": review ? "same-origin" : "same-site",
      });
      res.end(body);
    };
    switch (url.pathname) {
      case "/":
      case "/other.html":
        send(200, "text/html; charset=utf-8", artifactPage(artifact, mode));
        return;
      case "/app.js":
        send(200, "text/javascript; charset=utf-8", artifactScript);
        return;
      case "/style.css":
        send(200, "text/css; charset=utf-8", artifactStyle);
        return;
      case "/pixel.svg":
        send(200, "image/svg+xml", pixelSvg);
        return;
      case "/data.json":
        send(
          200,
          "application/json",
          JSON.stringify({ artifact, mode, reviewValues, cookieNames: pairs.map(([n]) => n) }),
        );
        return;
      default:
        send(404, "text/plain", "not found");
    }
  }

  const server: Server = createServer(selfSignedCertificate(), (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const url = new URL(req.url ?? "/", `https://${host}`);
    if (host === APP_HOST) {
      handleApp(req, res, url).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    const artifact = artifactFromHost(host);
    if (artifact) {
      handleContent(req, res, url, artifact);
      return;
    }
    res.writeHead(421).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
