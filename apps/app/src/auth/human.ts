// The human check on account creation (plan section 13, docs/security.md "Human check"). No
// account is created, by any sign-in method, without a solved Turnstile challenge; existing
// accounts sign in without one.
//
// The login page renders the widget and posts its token to /api/auth/verify-human before a
// sign-in. The Worker verifies it with siteverify and answers with a short, HMAC-signed
// `__Host-pf_human` cookie holding a random nonce. The `user.create.before` hook requires that
// cookie and claims its nonce once in the D1 counters, so one solved challenge creates at most
// one account. The cookie survives the Google and GitHub redirects like the terms cookie, so all
// three methods share one rule.
import { HUMAN_VERIFICATION_REQUIRED, HumanCheckInput } from "@portifact/contracts";
import { hitRateLimit } from "@portifact/db";
import type { HumanVerdict } from "@portifact/domain";
import { APIError } from "better-auth/api";
import { fromBase64Url, type HookContext, readCookie, toBase64Url } from "./terms.ts";

export const HUMAN_COOKIE = "__Host-pf_human";
/** As long as the terms cookie: enough to read a code from an email or finish a provider sign-in. */
export const HUMAN_COOKIE_TTL_SECONDS = 30 * 60;
export const VERIFY_HUMAN_PATH = "/verify-human";

const encoder = new TextEncoder();

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`portifact-human-check:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The cookie value for a check solved at `issuedAt` (epoch milliseconds). */
export async function sealHumanCheck(
  secret: string,
  nonce: string,
  issuedAt: number,
): Promise<string> {
  const payload = `${nonce}.${issuedAt}`;
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

/** The nonce in a cookie value signed with this secret and not older than the cookie lifetime. */
export async function openHumanCheck(
  secret: string,
  value: string,
  now: number,
): Promise<string | undefined> {
  const [nonce, issued, signature, ...rest] = value.split(".");
  if (!nonce || !issued || !signature || rest.length > 0) return undefined;
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce) || !/^\d{1,15}$/.test(issued)) return undefined;
  const issuedAt = Number(issued);
  if (issuedAt > now || now - issuedAt > HUMAN_COOKIE_TTL_SECONDS * 1000) return undefined;
  const bytes = fromBase64Url(signature);
  if (!bytes) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    encoder.encode(`${nonce}.${issued}`),
  );
  return valid ? nonce : undefined;
}

function humanCookie(value: string, maxAge: number): string {
  return `${HUMAN_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export interface VerifyHumanDeps {
  secret: string;
  /** Verifies a Turnstile token for this request's IP (../turnstile.ts). */
  verify: (token: string) => Promise<HumanVerdict>;
  now: number;
}

function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** POST /api/auth/verify-human: the login page's widget was solved. */
export async function verifyHuman(request: Request, deps: VerifyHumanDeps): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const input = HumanCheckInput.safeParse(body);
  if (!input.success) {
    return apiError(400, "invalid_input", "Send the token of the human check.");
  }
  const verdict = await deps.verify(input.data.token);
  if (verdict === "unavailable") {
    return apiError(
      503,
      "capacity_unavailable",
      "The human check is unavailable right now. Try again in a few minutes.",
    );
  }
  if (verdict === "failed") {
    return apiError(
      403,
      HUMAN_VERIFICATION_REQUIRED,
      "The human check failed or expired. Complete it again.",
    );
  }
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)).buffer);
  const sealed = await sealHumanCheck(deps.secret, nonce, deps.now);
  const response = Response.json({ verified: true });
  response.headers.append("Set-Cookie", humanCookie(sealed, HUMAN_COOKIE_TTL_SECONDS));
  return response;
}

function refused(): APIError {
  return new APIError("FORBIDDEN", {
    code: HUMAN_VERIFICATION_REQUIRED,
    message: "Complete the human check to create your account.",
  });
}

/** Better Auth hook pieces that require a solved check to create an account. */
export function humanHooks(d1: D1Database, secret: string) {
  const cookieOf = (ctx: HookContext | null) =>
    readCookie(ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie"), HUMAN_COOKIE);

  return {
    /** Throws unless the request carries a valid check that was never used before. */
    requireForNewUser: async (ctx: HookContext | null): Promise<void> => {
      const value = cookieOf(ctx);
      const now = Date.now();
      const nonce = value ? await openHumanCheck(secret, value, now) : undefined;
      if (!nonce) throw refused();
      // Single use: the first account created with this check claims it. The window outlives
      // the cookie, so the counter cannot reset while the cookie is still accepted.
      const claim = await hitRateLimit(
        d1,
        `human:${nonce}`,
        2 * HUMAN_COOKIE_TTL_SECONDS * 1000,
        now,
      );
      if (claim.count > 1) throw refused();
    },
    /** A session was created: the check is spent, so the browser drops it. */
    clear: (ctx: HookContext | null): void => {
      if (cookieOf(ctx)) {
        ctx?.setCookie?.(HUMAN_COOKIE, "", {
          maxAge: 0,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        });
      }
    },
  };
}
