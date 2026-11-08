// Acceptance of the terms and the 18+ confirmation (docs/legal.md). No account is created and
// no session is issued for an account that has not accepted the current TERMS_VERSION.
//
// The login page posts the acceptance to /api/auth/accept-terms before any sign-in method. A
// signed-in account records it at once. Before sign-in the Worker sets a short, HMAC-signed
// `__Host-pf_terms` cookie holding the version and the time of acceptance; the Better Auth
// hooks below require it to create an account, or to sign in an account whose recorded version
// is not current, and store it on the account. The cookie survives the Google and GitHub
// redirects (SameSite=Lax top-level navigation), so all three methods share one rule.
import { TERMS_NOT_ACCEPTED, TERMS_VERSION, TermsAcceptanceInput } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { needsTermsAcceptance } from "@portifact/domain";
import { APIError } from "better-auth/api";
import { and, eq, isNull, ne, or } from "drizzle-orm";

export const TERMS_COOKIE = "__Host-pf_terms";
/** Long enough to read a code from an email or finish a provider sign-in. */
export const TERMS_COOKIE_TTL_SECONDS = 30 * 60;
export const ACCEPT_TERMS_PATH = "/accept-terms";

const encoder = new TextEncoder();

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`portifact-terms-acceptance:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** The cookie value for an acceptance of `version` at `acceptedAt` (epoch milliseconds). */
export async function sealAcceptance(
  secret: string,
  version: string,
  acceptedAt: number,
): Promise<string> {
  const payload = `${version}.${acceptedAt}`;
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

export interface Acceptance {
  version: string;
  acceptedAt: Date;
}

/**
 * The acceptance in a cookie value, when it is signed with this secret, is for the current
 * version and is not older than the cookie lifetime. Anything else is undefined.
 */
export async function openAcceptance(
  secret: string,
  value: string,
  now: number,
): Promise<Acceptance | undefined> {
  const [version, issued, signature, ...rest] = value.split(".");
  if (!version || !issued || !signature || rest.length > 0) return undefined;
  if (version !== TERMS_VERSION || !/^\d{1,15}$/.test(issued)) return undefined;
  const acceptedAt = Number(issued);
  if (acceptedAt > now || now - acceptedAt > TERMS_COOKIE_TTL_SECONDS * 1000) return undefined;
  const bytes = fromBase64Url(signature);
  if (!bytes) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    bytes,
    encoder.encode(`${version}.${issued}`),
  );
  return valid ? { version, acceptedAt: new Date(acceptedAt) } : undefined;
}

/** A cookie by its exact, case-sensitive name (docs/security.md). */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function acceptanceCookie(value: string, maxAge: number): string {
  return `${TERMS_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Records the current version for a signed-in account, keeping an earlier acceptance of it. */
async function recordAcceptance(d1: D1Database, userId: string, acceptedAt: Date) {
  const { users } = schema.authSchema;
  await createDb(d1)
    .update(users)
    .set({ termsVersion: TERMS_VERSION, termsAcceptedAt: acceptedAt })
    .where(
      and(
        eq(users.id, userId),
        or(isNull(users.termsVersion), ne(users.termsVersion, TERMS_VERSION)),
      ),
    );
}

export interface AcceptTermsDeps {
  db: D1Database;
  secret: string;
  /** The signed-in account behind the request's session cookie, if any. */
  sessionUserId: (request: Request) => Promise<string | undefined>;
  now: number;
}

/** POST /api/auth/accept-terms: the user accepted the terms and confirmed they are 18 or older. */
export async function acceptTerms(request: Request, deps: AcceptTermsDeps): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  if (!TermsAcceptanceInput.safeParse(body).success) {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: "Accept the current terms and confirm you are 18 or older.",
        },
      },
      { status: 400 },
    );
  }
  const userId = await deps.sessionUserId(request);
  if (userId) {
    await recordAcceptance(deps.db, userId, new Date(deps.now));
    return Response.json({ version: TERMS_VERSION, recorded: true });
  }
  const sealed = await sealAcceptance(deps.secret, TERMS_VERSION, deps.now);
  const response = Response.json({ version: TERMS_VERSION, recorded: false });
  response.headers.append("Set-Cookie", acceptanceCookie(sealed, TERMS_COOKIE_TTL_SECONDS));
  return response;
}

function refused(): APIError {
  return new APIError("FORBIDDEN", {
    code: TERMS_NOT_ACCEPTED,
    message: "Accept the terms and confirm you are 18 or older to continue.",
  });
}

/** The parts of Better Auth's hook context these hooks read and write. */
export interface HookContext {
  headers?: Headers | undefined;
  request?: Request | undefined;
  setCookie?: (
    name: string,
    value: string,
    options: { maxAge: number; path: string; secure: boolean; httpOnly: boolean; sameSite: "lax" },
  ) => string;
}

/** Better Auth database hooks that enforce the acceptance on every sign-in method. */
export function termsHooks(d1: D1Database, secret: string) {
  const cookieOf = (ctx: HookContext | null) =>
    readCookie(ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie"), TERMS_COOKIE);
  const acceptanceFrom = async (ctx: HookContext | null) => {
    const value = cookieOf(ctx);
    return value ? openAcceptance(secret, value, Date.now()) : undefined;
  };

  return {
    user: {
      create: {
        before: async <T extends Record<string, unknown>>(user: T, ctx: HookContext | null) => {
          const acceptance = await acceptanceFrom(ctx);
          if (!acceptance) throw refused();
          return {
            data: {
              ...user,
              termsVersion: acceptance.version,
              termsAcceptedAt: acceptance.acceptedAt,
            },
          };
        },
      },
    },
    session: {
      create: {
        before: async (session: { userId: string }, ctx: HookContext | null) => {
          const { users } = schema.authSchema;
          const [user] = await createDb(d1)
            .select({ termsVersion: users.termsVersion })
            .from(users)
            .where(eq(users.id, session.userId));
          if (!needsTermsAcceptance(user?.termsVersion)) return;
          // An existing account that has not accepted the current terms accepts them now.
          const acceptance = await acceptanceFrom(ctx);
          if (!acceptance) throw refused();
          await recordAcceptance(d1, session.userId, acceptance.acceptedAt);
        },
        // The acceptance is used once: a later sign-in on this browser asks again.
        after: async (_session: unknown, ctx: HookContext | null) => {
          if (cookieOf(ctx)) {
            ctx?.setCookie?.(TERMS_COOKIE, "", {
              maxAge: 0,
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "lax",
            });
          }
        },
      },
    },
  };
}
