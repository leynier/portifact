import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { ORIGIN } from "../config.ts";
import type { AuthDeps } from "../deps.ts";

export interface Harness {
  // Sends a request to the app as if it arrived at app.portifact.com.
  request: (path: string, init?: RequestInit) => Promise<Response>;
  // Signs a user in with email OTP and returns the session cookie header value.
  signIn: (email: string) => Promise<string>;
  // A server-side Better Auth instance over the same D1 database, for seeding.
  auth: ReturnType<typeof createAuth>;
  // Client ID Metadata Documents the fake network serves, keyed by URL.
  clientMetadata: Map<string, unknown>;
  // URLs the fake network was asked for.
  fetchedMetadata: string[];
}

export function createHarness(): Harness {
  const outbox: { email: string; otp: string }[] = [];
  const clientMetadata = new Map<string, unknown>();
  const fetchedMetadata: string[] = [];
  const deps: AuthDeps = {
    sendOtp: async (email, otp) => {
      outbox.push({ email, otp });
    },
    fetchClientMetadata: async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      fetchedMetadata.push(url);
      const document = clientMetadata.get(url);
      if (!document) return new Response("not found", { status: 404 });
      return Response.json(document, { headers: { "cache-control": "max-age=300" } });
    },
  };
  const app = createApp(deps);

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  const signIn = async (email: string): Promise<string> => {
    const sent = await request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
    if (!sent.ok) throw new Error(`sending the OTP failed with ${sent.status}`);
    const otp = outbox.findLast((message) => message.email === email)?.otp;
    if (!otp) throw new Error("no OTP was delivered");
    const signedIn = await request("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, otp }),
    });
    if (!signedIn.ok) throw new Error(`signing in failed with ${signedIn.status}`);
    const cookies = signedIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .filter((cookie): cookie is string => Boolean(cookie));
    return cookies.join("; ");
  };

  return { request, signIn, auth: createAuth(env, deps), clientMetadata, fetchedMetadata };
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
