// Entry to protected artifacts on the artifact origin (plan section 4, "Entrada a un artifact
// protegido"):
//
// 1. A navigation without a read session gets a signed transaction cookie (artifact, nonce,
//    path) and goes to app.portifact.com/read/<id>?state=<nonce>. Each transaction has its own
//    cookie, so up to MAX_TRANSACTIONS tabs can sign in to one artifact at the same time.
// 2. The app checks the account and the policy and sends the browser back to
//    /__portifact/callback with a one-use code bound to this artifact and nonce.
// 3. The callback redeems the code and sets `__Host-pf_read`: a session ID plus signed claims
//    (artifact, user, policy generation) that are trusted without D1 for 60 seconds and only
//    while the artifact's policy generation is unchanged.
import { OpaqueToken, READ_SESSION, ReadClaims, ReadTransaction } from "@portifact/contracts";
import type { DeliveryArtifact, RegionalDb } from "@portifact/db";
import { randomToken, redeemReadHandoff, refreshReadSession } from "@portifact/services";
import {
  clearCookie,
  cookiesWithPrefix,
  cookieValue,
  MAX_VALUE_LENGTH,
  READ_COOKIE,
  seal,
  setCookie,
  TRANSACTION_COOKIE_PREFIX,
  transactionCookieName,
  unseal,
  usableSecret,
} from "./cookies.ts";

const SECOND_MS = 1000;
export const CALLBACK_PATH = "/__portifact/callback";
/** Sign-ins one browser may have open per artifact; starting another drops the oldest. */
export const MAX_TRANSACTIONS = 3;

export interface ReadEnv {
  /** Origin of the app that signs users in, for example `https://app.portifact.com`. */
  APP_ORIGIN: string;
  /** HMAC key for read session and transaction cookies (at least 32 characters). */
  READ_SESSION_SECRET?: string | undefined;
}

/** An artifact the Worker can serve: active, unexpired and with a current version. */
export type ServableArtifact = DeliveryArtifact & { currentVersionId: string };

export type Page = "signIn" | "unavailable" | "notFound" | "browserRequired" | "linkExpired";

/** What the content Worker does with a request for a protected (or unknown) artifact. */
export type ReadDecision =
  /** `userId` is the signed-in visitor the read session names, for the access log. */
  | { kind: "allow"; artifact: ServableArtifact; userId: string; setCookies: string[] }
  | { kind: "redirect"; location: string; setCookies: string[] }
  | { kind: "page"; status: number; page: Page; setCookies: string[] };

/** A response that is not the artifact: a redirect in the sign-in flow or a message page. */
export type SignInStep = Exclude<ReadDecision, { kind: "allow" }>;

/**
 * Whether the request may use the read cookie. Sibling artifacts are same-site, so their
 * `<script>`, `<img>` and CSS loads would carry it: only the artifact's own requests
 * (`same-origin`) and navigations, which never expose the response to the initiator, use it.
 */
function cookieUsable(request: Request): boolean {
  return (
    request.headers.get("Sec-Fetch-Site") === "same-origin" ||
    request.headers.get("Sec-Fetch-Mode") === "navigate"
  );
}

function isNavigation(request: Request): boolean {
  return request.method === "GET" && request.headers.get("Sec-Fetch-Mode") === "navigate";
}

const READ_PURPOSE = "pf_read";
const TRANSACTION_PURPOSE = "pf_read_tx";

async function readClaims(request: Request, secret: string, artifactId: string, now: number) {
  const value = cookieValue(request.headers.get("Cookie"), READ_COOKIE);
  if (!value) return null;
  const parsed = ReadClaims.safeParse(await unseal(secret, READ_PURPOSE, value));
  if (!parsed.success) return null;
  const claims = parsed.data;
  return claims.aid === artifactId && claims.sexp > now ? claims : null;
}

async function claimsCookie(
  secret: string,
  claims: Omit<ReadClaims, "v" | "exp">,
  now: number,
): Promise<string> {
  const value = await seal(secret, READ_PURPOSE, {
    v: 1,
    ...claims,
    exp: Math.min(now + READ_SESSION.claimsTtlSeconds * SECOND_MS, claims.sexp),
  } satisfies ReadClaims);
  return setCookie(READ_COOKIE, value, { maxAgeSeconds: (claims.sexp - now) / SECOND_MS });
}

/**
 * Authorizes a request for an artifact that is not served publicly. `artifact` is null when
 * the artifact is missing or not servable, whatever its access mode; without a session that
 * looks exactly like a protected artifact, so the response never tells an anonymous visitor
 * whether it exists.
 */
export async function authorizeRead(
  request: Request,
  env: ReadEnv,
  db: RegionalDb,
  artifactId: string,
  artifact: ServableArtifact | null,
  now: number,
): Promise<ReadDecision> {
  if (!request.headers.has("Sec-Fetch-Site")) {
    // Fail closed without fetch metadata, and without a redirect a client could loop on.
    return { kind: "page", status: 401, page: "browserRequired", setCookies: [] };
  }
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) {
    return { kind: "page", status: 503, page: "unavailable", setCookies: [] };
  }

  const setCookies: string[] = [];
  const claims = cookieUsable(request) ? await readClaims(request, secret, artifactId, now) : null;
  if (claims) {
    if (!artifact) {
      return {
        kind: "page",
        status: 404,
        page: "notFound",
        setCookies: [clearCookie(READ_COOKIE)],
      };
    }
    if (claims.exp > now && claims.gen === artifact.policyGeneration) {
      return { kind: "allow", artifact, userId: claims.uid, setCookies };
    }
    const renewed = await refreshReadSession(db, { sessionId: claims.sid, artifactId, now });
    if (renewed.ok && renewed.value.userId === claims.uid) {
      setCookies.push(
        await claimsCookie(
          secret,
          {
            sid: claims.sid,
            aid: artifactId,
            uid: claims.uid,
            gen: renewed.value.policyGeneration,
            sexp: renewed.value.expiresAt,
          },
          now,
        ),
      );
      return { kind: "allow", artifact, userId: claims.uid, setCookies };
    }
    // Access is gone: drop the session and let the app decide again, for this or another account.
    setCookies.push(clearCookie(READ_COOKIE));
  }

  if (!isNavigation(request)) return { kind: "page", status: 401, page: "signIn", setCookies };
  return startSignIn(request, env, secret, artifactId, now, setCookies);
}

async function startSignIn(
  request: Request,
  env: ReadEnv,
  secret: string,
  artifactId: string,
  now: number,
  setCookies: string[],
): Promise<SignInStep> {
  const url = new URL(request.url);
  const open = await openTransactions(request, secret, artifactId, now);
  // Room for the new one: the oldest open transactions beyond the cap are dropped.
  const dropped = open.live.slice(MAX_TRANSACTIONS - 1).map((entry) => entry.name);
  for (const name of [...open.stale, ...dropped]) setCookies.push(clearCookie(name));

  const nonce = randomToken();
  const transaction: ReadTransaction = {
    v: 1,
    aid: artifactId,
    nonce,
    path: `${url.pathname}${url.search}`,
    exp: now + READ_SESSION.transactionTtlSeconds * SECOND_MS,
  };
  setCookies.push(
    setCookie(transactionCookieName(nonce), await sealTransaction(secret, transaction), {
      maxAgeSeconds: READ_SESSION.transactionTtlSeconds,
    }),
  );
  const location = new URL(`/read/${artifactId}`, env.APP_ORIGIN);
  location.searchParams.set("state", nonce);
  return { kind: "redirect", location: location.toString(), setCookies };
}

/**
 * The sealed transaction, returning to `/` instead of the requested path when the path would
 * make the cookie too long to be read back.
 */
async function sealTransaction(secret: string, transaction: ReadTransaction): Promise<string> {
  const sealed = await seal(secret, TRANSACTION_PURPOSE, transaction);
  // The sealed value is longer than the path, so this also keeps the path within the schema.
  if (sealed.length <= MAX_VALUE_LENGTH) return sealed;
  return seal(secret, TRANSACTION_PURPOSE, { ...transaction, path: "/" });
}

interface OpenTransaction {
  name: string;
  transaction: ReadTransaction;
}

/**
 * The browser's transaction cookies on this origin: `live` ones (valid, for this artifact,
 * unexpired, under their own nonce's name), newest first, and the names of `stale` ones to
 * clear.
 */
async function openTransactions(
  request: Request,
  secret: string,
  artifactId: string,
  now: number,
): Promise<{ live: OpenTransaction[]; stale: string[] }> {
  const { values, duplicated } = cookiesWithPrefix(
    request.headers.get("Cookie"),
    TRANSACTION_COOKIE_PREFIX,
  );
  const live: OpenTransaction[] = [];
  const stale = [...duplicated];
  for (const [name, value] of values) {
    const parsed =
      value.length <= MAX_VALUE_LENGTH
        ? ReadTransaction.safeParse(await unseal(secret, TRANSACTION_PURPOSE, value))
        : null;
    const transaction = parsed?.success ? parsed.data : null;
    if (
      transaction &&
      transaction.aid === artifactId &&
      transaction.exp > now &&
      name === transactionCookieName(transaction.nonce)
    ) {
      live.push({ name, transaction });
    } else {
      stale.push(name);
    }
  }
  live.sort((a, b) => b.transaction.exp - a.transaction.exp);
  return { live: live.slice(0, MAX_TRANSACTIONS), stale };
}

/**
 * `/__portifact/callback?code=…`: redeems the app's handoff code for one of this browser's
 * open transactions and returns to its requested path with a read session. Every failure
 * answers the same page; it clears only transactions that are no longer usable, because
 * another tab may still be signing in with the others.
 */
export async function handleCallback(
  request: Request,
  env: ReadEnv,
  db: RegionalDb,
  artifactId: string,
  now: number,
): Promise<SignInStep> {
  const secret = env.READ_SESSION_SECRET;
  if (!usableSecret(secret)) {
    return { kind: "page", status: 503, page: "unavailable", setCookies: [] };
  }
  const open = await openTransactions(request, secret, artifactId, now);
  const cleared = open.stale.map(clearCookie);
  const failed: SignInStep = {
    kind: "page",
    status: 400,
    page: "linkExpired",
    setCookies: cleared,
  };
  if (!isNavigation(request)) return failed;

  const url = new URL(request.url);
  const codes = url.searchParams.getAll("code");
  const code = codes.length === 1 ? OpaqueToken.safeParse(codes[0]) : null;
  if (!code?.success || open.live.length === 0) return failed;

  const redeemed = await redeemReadHandoff(db, {
    code: code.data,
    artifactId,
    states: open.live.map((entry) => entry.transaction.nonce),
    now,
  });
  if (!redeemed.ok) return failed;
  const session = redeemed.value;
  const used = open.live.find((entry) => entry.transaction.nonce === session.state);
  if (!used) return failed;

  return {
    kind: "redirect",
    location: sameOriginPath(used.transaction.path, url.origin),
    setCookies: [
      ...cleared,
      clearCookie(used.name),
      await claimsCookie(
        secret,
        {
          sid: session.sessionId,
          aid: artifactId,
          uid: session.userId,
          gen: session.policyGeneration,
          sexp: session.expiresAt,
        },
        now,
      ),
    ],
  };
}

/**
 * The stored path as an absolute URL on this origin. Appending a path that starts with `/` to
 * the origin always ends the authority, so `//evil.example` or `/\evil.example` stay on this
 * host instead of becoming another origin, as they would as a relative `Location`.
 */
export function sameOriginPath(path: string, origin: string): string {
  return path.startsWith("/") ? `${origin}${path}` : `${origin}/`;
}
