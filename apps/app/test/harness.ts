import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Auth, createAuth } from "../src/auth/auth.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import type { EmailMessage } from "../src/auth/email.ts";
import { createWorker } from "../src/index.ts";

export const ORIGIN = "https://app.portifact.com";
export const ISSUER = `${ORIGIN}/api/auth`;
export const API_RESOURCE = `${ORIGIN}/api/v1`;
export const MCP_RESOURCE = `${ORIGIN}/mcp`;
export const SESSION_COOKIE = "__Host-pf.session_token";

export interface Harness {
  /** Sends a request to the Worker as if it arrived at app.portifact.com (or a full URL). */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Signs a user in with an email code and returns the Cookie header value. */
  signIn: (email: string) => Promise<string>;
  /** A server-side Better Auth instance over the same D1 database, for seeding and checks. */
  auth: Auth;
  /** Every email the fake sender accepted. */
  outbox: EmailMessage[];
  /** Client ID Metadata Documents the fake network serves, keyed by URL. */
  clientMetadata: Map<string, unknown>;
  /** URLs the fake network was asked for. */
  fetchedMetadata: string[];
}

export function createHarness(): Harness {
  const outbox: EmailMessage[] = [];
  const clientMetadata = new Map<string, unknown>();
  const fetchedMetadata: string[] = [];
  const deps: AuthDeps = {
    email: {
      send: async (message) => {
        outbox.push(message);
      },
    },
    fetchClientMetadata: async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      fetchedMetadata.push(url);
      const document = clientMetadata.get(url);
      if (!document) return new Response("not found", { status: 404 });
      return Response.json(document, { headers: { "cache-control": "max-age=300" } });
    },
  };
  const worker = createWorker(() => deps);

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const url = path.startsWith("https://") ? path : `${ORIGIN}${path}`;
    const response = await worker.fetch(new Request(url, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  const signIn = async (email: string): Promise<string> => {
    // This helper is not about limits: start every sign-in with fresh counters.
    await env.DB.exec("DELETE FROM rate_limits");
    const sent = await request(
      "/api/auth/email-otp/send-verification-otp",
      json({ email, type: "sign-in" }),
    );
    if (!sent.ok) throw new Error(`sending the code failed with ${sent.status}`);
    const otp = codeFrom(outbox.findLast((message) => message.to === email));
    const signedIn = await request("/api/auth/sign-in/email-otp", json({ email, otp }));
    if (!signedIn.ok) throw new Error(`signing in failed with ${signedIn.status}`);
    return cookieHeader(signedIn);
  };

  return { request, signIn, auth: createAuth(env, deps), outbox, clientMetadata, fetchedMetadata };
}

/** The six-digit code in a sign-in email. */
export function codeFrom(message: EmailMessage | undefined): string {
  const code = message?.text.match(/sign-in code is (\d{6})/)?.[1];
  if (!code) throw new Error("no sign-in code was delivered");
  return code;
}

/** The Cookie header a browser would send back after this response. */
export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((cookie): cookie is string => Boolean(cookie) && !cookie?.endsWith("="))
    .join("; ");
}

export function form(values: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  };
}

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  };
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
