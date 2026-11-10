// The end-to-end stack: the e2e Worker (both real Workers, one local D1 and R2) running in
// workerd through wrangler, an HTTPS front end that gives browsers the production-like hosts,
// the CONNECT proxy that maps those hosts for every engine, and a local control endpoint for
// the test runner. Started once per run by global-setup.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import {
  CONTENT_SITE,
  CONTROL_COOKIE,
  CONTROL_HOST,
  isStackHost,
  REDIRECT_HOST,
  REVIEW_COOKIE,
} from "./hosts.ts";
import { startProxy } from "./proxy.ts";
import { selfSignedCertificate } from "./tls.ts";
import { FAKE_TURNSTILE_SCRIPT, TURNSTILE_HOST, TURNSTILE_SCRIPT_PATH } from "./turnstile-fake.ts";

/** One request a browser sent to an artifact host, as the content Worker received it. */
export interface ContentRequest {
  host: string;
  path: string;
  status: number;
  cookieNames: string[];
  site: string | null;
  mode: string | null;
  dest: string | null;
}

export interface Stack {
  proxyUrl: string;
  controlUrl: string;
  /** The HTTPS front end, for clients outside a browser that set the stack host themselves. */
  frontUrl: string;
  close(): Promise<void>;
}

const E2E_DIR = new URL("..", import.meta.url).pathname;
/** Cloudflare's limit on request and response headers, 128 KB in total each. */
const HEADER_LIMIT = 128 * 1024;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "upgrade", "host"]);

/** A Worker response as raw HTTP, so headers and bytes pass through untouched. */
interface Raw {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function readBody(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function setCookies(raw: Raw): string[] {
  const value = raw.headers["set-cookie"];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function cookieNames(header: string | undefined): string[] {
  return (header ?? "")
    .split(";")
    .map((part) => part.split("=", 1)[0]?.trim() ?? "")
    .filter(Boolean);
}

function send(target: ServerResponse, raw: Raw, extraCookies: string[] = []) {
  const headers = { ...raw.headers };
  const cookies = [...setCookies(raw), ...extraCookies];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  target.writeHead(raw.status, headers);
  target.end(raw.body);
}

export async function startStack(): Promise<Stack> {
  const persist = mkdtempSync(join(tmpdir(), "pf-e2e-state-"));
  // The control and access log databases of both regions (decision 0005), each with its
  // migrations; every control database gets the same history.
  for (const database of [
    "portifact-e2e",
    "portifact-e2e-access",
    "portifact-e2e-eu",
    "portifact-e2e-access-eu",
  ]) {
    execFileSync(
      "npx",
      ["wrangler", "d1", "migrations", "apply", database, "--local", "--persist-to", persist],
      { cwd: E2E_DIR, stdio: "ignore", env: { ...process.env, CI: "1" } },
    );
  }
  const worker = await unstable_startWorker({
    config: join(E2E_DIR, "wrangler.jsonc"),
    dev: {
      persist,
      server: { hostname: "127.0.0.1", port: 0, secure: true },
      inspector: false,
      logLevel: "warn",
      watch: false,
    },
  });
  await worker.ready;

  const requests: ContentRequest[] = [];
  const address = await worker.url;
  // Node's fetch would rewrite Sec-Fetch-Mode, which the Workers check, so requests go out as raw
  // HTTP. wrangler's dev server takes the URL the Worker sees from MF-Original-URL.
  const forward = async (url: string, request: IncomingMessage): Promise<Raw> => {
    const headers: Record<string, string | string[]> = { "MF-Original-URL": url };
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    const body = await readBody(request);
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: address.hostname,
          port: address.port,
          path: new URL(url).pathname + new URL(url).search,
          method: request.method,
          headers,
          rejectUnauthorized: false,
          // Responses that expire injected cookies carry many Set-Cookie headers; Cloudflare
          // allows 128 KB of response headers.
          maxHeaderSize: HEADER_LIMIT,
        },
        (incoming) => {
          readBody(incoming).then(
            (bytes) =>
              resolve({
                status: incoming.statusCode ?? 502,
                headers: incoming.headers,
                body: bytes,
              }),
            reject,
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };

  const tls = selfSignedCertificate();
  // Cloudflare refuses requests whose headers pass 128 KB in total; Node's default (16 KiB) would
  // refuse the oversized Cookie headers the injected-cookie test needs to reach the Worker.
  const front = createHttpsServer(
    { key: tls.key, cert: tls.cert, maxHeaderSize: HEADER_LIMIT },
    async (request, response) => {
      try {
        const host = request.headers.host ?? "";
        const url = `https://${host}${request.url ?? "/"}`;
        if (host === TURNSTILE_HOST) {
          if (new URL(url).pathname !== TURNSTILE_SCRIPT_PATH) {
            response.writeHead(404).end();
            return;
          }
          response
            .writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" })
            .end(FAKE_TURNSTILE_SCRIPT);
          return;
        }
        if (host === REDIRECT_HOST) {
          const to = new URL(url).searchParams.get("to") ?? "";
          const target = URL.canParse(to) ? new URL(to) : null;
          if (target?.protocol !== "https:" || !isStackHost(target.hostname)) {
            response.writeHead(400).end();
            return;
          }
          response.writeHead(302, { location: target.href, "cache-control": "no-store" }).end();
          return;
        }
        const result = await forward(url, request);
        const extra: string[] = [];
        if (host.endsWith(`.${CONTENT_SITE}`)) {
          const path = new URL(url).pathname;
          requests.push({
            host,
            path,
            status: result.status,
            cookieNames: cookieNames(request.headers.cookie),
            site: (request.headers["sec-fetch-site"] as string | undefined) ?? null,
            mode: (request.headers["sec-fetch-mode"] as string | undefined) ?? null,
            dest: (request.headers["sec-fetch-dest"] as string | undefined) ?? null,
          });
          // Next to the review cookie, an ordinary third-party cookie: if the browser keeps it,
          // third-party cookies are not blocked in this run.
          const setsReview = setCookies(result).some((cookie) =>
            cookie.startsWith(`${REVIEW_COOKIE}=`),
          );
          if (path === "/__portifact/review" && setsReview) {
            extra.push(`${CONTROL_COOKIE}=1; Path=/; Secure; SameSite=None`);
          }
        }
        send(response, result, extra);
      } catch (error) {
        response.writeHead(502).end(String(error));
      }
    },
  );
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const proxy = await startProxy((front.address() as AddressInfo).port);

  const control = createHttpServer(async (request, response) => {
    try {
      const path = request.url ?? "/";
      if (path === "/requests") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(requests));
        return;
      }
      send(response, await forward(`https://${CONTROL_HOST}${path}`, request));
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));

  return {
    proxyUrl: proxy.url,
    controlUrl: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
    frontUrl: `https://127.0.0.1:${(front.address() as AddressInfo).port}`,
    async close() {
      await proxy.close();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await worker.dispose();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}
