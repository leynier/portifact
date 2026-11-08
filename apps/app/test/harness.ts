import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TERMS_VERSION } from "@portifact/contracts";
import type { MultipartConfig } from "@portifact/domain";
import { type Auth, createAuth } from "../src/auth/auth.ts";
import { type AuthDeps, createClientMetadataFetch } from "../src/auth/deps.ts";
import type { EmailMessage } from "../src/auth/email.ts";
import { createWorker } from "../src/index.ts";

export const ORIGIN = "https://app.portifact.com";
export const ISSUER = `${ORIGIN}/api/auth`;
export const API_RESOURCE = `${ORIGIN}/api/v1`;
export const MCP_RESOURCE = `${ORIGIN}/mcp`;
export const SESSION_COOKIE = "__Host-pf.session_token";

/** Tokens the fake siteverify knows: a solved challenge, a failed one and a provider outage. */
export const HUMAN_TOKEN = "turnstile-solved";
export const FAILED_HUMAN_TOKEN = "turnstile-failed";
export const OUTAGE_HUMAN_TOKEN = "turnstile-outage";

/** What the login page sends when the box is checked. */
export const TERMS_ACCEPTANCE = { version: TERMS_VERSION, acceptTerms: true, confirmAdult: true };

export interface Harness {
  /** Sends a request to the Worker as if it arrived at app.portifact.com (or a full URL). */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Signs a user in with an email code and returns the Cookie header value. */
  signIn: (email: string) => Promise<string>;
  /**
   * Accepts the terms like the login page does before any sign-in method and returns the
   * acceptance cookie (`name=value`) to send with the sign-in.
   */
  acceptTerms: () => Promise<string>;
  /**
   * Solves the login page's human check (`/api/auth/verify-human`) and returns its cookie
   * (`name=value`). Each call stands for a fresh challenge.
   */
  verifyHuman: () => Promise<string>;
  /** Everything the login page sends before a sign-in that may create an account. */
  beforeSignIn: () => Promise<string>;
  /** A server-side Better Auth instance over the same D1 database, for seeding and checks. */
  auth: Auth;
  /** Every email the fake sender accepted. */
  outbox: EmailMessage[];
  /** Client ID Metadata Documents the fake network serves, keyed by URL. */
  clientMetadata: Map<string, unknown>;
  /** URLs the fake network was asked for. */
  fetchedMetadata: string[];
  /** Tokens and remote IPs the fake siteverify was asked about, in order. */
  siteverifyCalls: { secret: string; token: string; remoteIp: string | null }[];
}

export function createHarness(
  options: {
    env?: Partial<Cloudflare.Env>;
    multipart?: MultipartConfig;
    /** Replaces the fake sender, for example to fail the way Email Service does. */
    email?: AuthDeps["email"];
  } = {},
): Harness {
  const outbox: EmailMessage[] = [];
  const clientMetadata = new Map<string, unknown>();
  const fetchedMetadata: string[] = [];
  const siteverifyCalls: Harness["siteverifyCalls"] = [];
  const workerEnv = { ...env, ...options.env } as Cloudflare.Env;
  const deps: AuthDeps = {
    ...(options.multipart ? { multipart: options.multipart } : {}),
    email: options.email ?? {
      send: async (message) => {
        outbox.push(message);
      },
    },
    // The production transport over a fake network. Documents carry an ETag, as chatgpt.com's
    // does, so a revalidation after max-age is answered 304 Not Modified.
    fetchClientMetadata: createClientMetadataFetch(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      fetchedMetadata.push(url);
      const document = clientMetadata.get(url);
      if (!document) return new Response("not found", { status: 404 });
      const headers = { "cache-control": "max-age=300", etag: `W/"${etagOf(document)}"` };
      if (new Headers(init?.headers).get("if-none-match") === headers.etag) {
        return new Response(null, { status: 304, headers });
      }
      return Response.json(document, { headers });
    }),
    // Siteverify as Cloudflare documents it; each token passes once, like the real one.
    siteverify: async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
        throw new Error(`unexpected siteverify URL ${url}`);
      }
      const form = init?.body as FormData;
      const token = String(form.get("response"));
      const secret = String(form.get("secret"));
      const remoteIp = form.get("remoteip") === null ? null : String(form.get("remoteip"));
      siteverifyCalls.push({ secret, token, remoteIp });
      if (token === OUTAGE_HUMAN_TOKEN) return new Response("unavailable", { status: 500 });
      const spent = siteverifyCalls.filter((call) => call.token === token).length > 1;
      const success = token.startsWith(HUMAN_TOKEN) && !spent;
      return Response.json({
        success,
        "error-codes": success ? [] : [spent ? "timeout-or-duplicate" : "invalid-input-response"],
      });
    },
  };
  const worker = createWorker(() => deps);

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const url = path.startsWith("https://") ? path : `${ORIGIN}${path}`;
    const response = await worker.fetch(new Request(url, init), workerEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  const acceptTerms = async (): Promise<string> => {
    const response = await request("/api/auth/accept-terms", json(TERMS_ACCEPTANCE));
    if (!response.ok) throw new Error(`accepting the terms failed with ${response.status}`);
    return cookieHeader(response);
  };

  let challenges = 0;
  const verifyHuman = async (): Promise<string> => {
    const response = await request(
      "/api/auth/verify-human",
      json({ token: `${HUMAN_TOKEN}-${++challenges}-${crypto.randomUUID()}` }),
    );
    if (!response.ok) throw new Error(`the human check failed with ${response.status}`);
    return cookieHeader(response);
  };

  const beforeSignIn = async (): Promise<string> =>
    `${await acceptTerms()}; ${await verifyHuman()}`;

  const signIn = async (email: string): Promise<string> => {
    // This helper is not about limits: start every sign-in with fresh counters.
    await env.DB.exec("DELETE FROM rate_limits");
    const terms = await beforeSignIn();
    const sent = await request(
      "/api/auth/email-otp/send-verification-otp",
      json({ email, type: "sign-in" }),
    );
    if (!sent.ok) throw new Error(`sending the code failed with ${sent.status}`);
    const otp = codeFrom(outbox.findLast((message) => message.to === email));
    const signedIn = await request(
      "/api/auth/sign-in/email-otp",
      json({ email, otp }, { cookie: terms }),
    );
    if (!signedIn.ok) throw new Error(`signing in failed with ${signedIn.status}`);
    return cookieHeader(signedIn);
  };

  return {
    request,
    signIn,
    acceptTerms,
    verifyHuman,
    beforeSignIn,
    auth: createAuth(workerEnv, deps),
    outbox,
    clientMetadata,
    fetchedMetadata,
    siteverifyCalls,
  };
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

/** A stable validator for a fake metadata document: changes whenever the document does. */
function etagOf(document: unknown): string {
  let hash = 0;
  for (const char of JSON.stringify(document)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(16);
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
