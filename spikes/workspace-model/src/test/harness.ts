import { env } from "cloudflare:test";
import { TERMS_VERSION } from "@portifact/contracts";
import { HUMAN_COOKIE, sealHumanCheck } from "../../../../apps/app/src/auth/human.ts";
import { sealAcceptance, TERMS_COOKIE } from "../../../../apps/app/src/auth/terms.ts";
import { AUTH_BASE_PATH, createAuth, ORIGIN, type SpikeAuthOptions } from "../auth.ts";
import { openEndpoint } from "../routes.ts";

export interface Harness {
  auth: ReturnType<typeof createAuth>;
  /** Straight to Better Auth, as if every endpoint were reachable. */
  raw: (path: string, init?: RequestInit) => Promise<Response>;
  /** Through the proposed allowlist (routes.ts), the way apps/app would route it. */
  gated: (path: string, init?: RequestInit) => Promise<Response>;
  /** Signs a user in with an email code and returns the session cookie. */
  signIn: (email: string, cookies?: string) => Promise<string>;
}

export function createHarness(options: SpikeAuthOptions = {}): Harness {
  const outbox: { email: string; otp: string }[] = [];
  const auth = createAuth(
    env,
    { sendOtp: async (email, otp) => void outbox.push({ email, otp }) },
    options,
  );

  const raw = (path: string, init?: RequestInit) =>
    auth.handler(new Request(`${ORIGIN}${AUTH_BASE_PATH}${path}`, init));

  const gated = async (path: string, init?: RequestInit) => {
    const request = new Request(`${ORIGIN}${AUTH_BASE_PATH}${path}`, init);
    const endpoint = openEndpoint(
      request.method,
      new URL(request.url).pathname.slice(AUTH_BASE_PATH.length),
    );
    if (!endpoint) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (
      endpoint.kind === "browser" &&
      request.method === "POST" &&
      request.headers.get("origin") !== ORIGIN
    ) {
      return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    }
    if (endpoint.kind === "scim") {
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      return auth.handler(new Request(request, { headers }));
    }
    return auth.handler(request);
  };

  const signIn = async (email: string, cookies?: string) => {
    const jar = cookies ?? (await newAccountCookies());
    const sent = await raw("/email-otp/send-verification-otp", json({ email, type: "sign-in" }));
    if (!sent.ok) throw new Error(`sending the code failed with ${sent.status}`);
    const otp = outbox.findLast((m) => m.email === email)?.otp;
    if (!otp) throw new Error("no code was delivered");
    const signedIn = await raw("/sign-in/email-otp", json({ email, otp }, { cookie: jar }));
    if (!signedIn.ok)
      throw new Error(`sign-in failed with ${signedIn.status}: ${await signedIn.text()}`);
    return sessionCookie(signedIn);
  };

  return { auth, raw, gated, signIn };
}

/** The terms acceptance and human check cookies a new account needs, as the login page gets them. */
export async function newAccountCookies(
  options: { terms?: boolean; human?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  const parts: string[] = [];
  if (options.terms !== false) {
    parts.push(
      `${TERMS_COOKIE}=${await sealAcceptance(env.BETTER_AUTH_SECRET, TERMS_VERSION, now)}`,
    );
  }
  if (options.human !== false) {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    parts.push(`${HUMAN_COOKIE}=${await sealHumanCheck(env.BETTER_AUTH_SECRET, nonce, now)}`);
  }
  return parts.join("; ");
}

export function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c.startsWith("__Host-pf.session_token=") && !c.endsWith("="))
    .join("; ");
}

export function json(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  };
}

export function get(headers: Record<string, string> = {}): RequestInit {
  return { method: "GET", headers };
}

export function uniqueEmail(label: string, domain = "example.org"): string {
  return `${label}-${crypto.randomUUID().slice(0, 8)}@${domain}`;
}
