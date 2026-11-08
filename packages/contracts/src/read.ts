// Shapes of the entry to protected artifacts: the read session cookie, the sign-in transaction
// and the one-use codes that connect app.portifact.com to an artifact origin.
import { z } from "zod";
import { ArtifactId } from "./core.ts";

/**
 * Entry to protected artifacts (plan section 4): the sign-in transaction kept by the artifact
 * origin, the one-use handoff code issued by the app, and the read session it becomes. Read
 * sessions carry signed claims that the content Worker trusts without D1 for at most
 * `claimsTtlSeconds`, so a revocation applies to later requests within that time.
 */
export const READ_SESSION = {
  transactionTtlSeconds: 600,
  handoffTtlSeconds: 60,
  claimsTtlSeconds: 60,
  sessionTtlSeconds: 43_200,
} as const;

/** One-use secrets in URLs and cookies: 32 random bytes in unpadded base64url. */
export const OpaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid token");

/** Signed claims in the `__Host-pf_read` cookie of one artifact origin. Times in ms. */
export const ReadClaims = z
  .object({
    v: z.literal(1),
    /** Read session ID, checked in D1 when the claims are renewed. */
    sid: OpaqueToken,
    aid: ArtifactId,
    uid: z.string().min(1).max(64),
    /** Policy generation the claims were checked against. */
    gen: z.number().int().positive(),
    /** When the claims stop being trusted without D1. */
    exp: z.number().int().nonnegative(),
    /** When the read session ends. */
    sexp: z.number().int().nonnegative(),
  })
  .strict();
export type ReadClaims = z.infer<typeof ReadClaims>;

/**
 * Signed sign-in transaction in the `__Host-pf_read_tx` cookie: it binds the browser, the
 * artifact and the requested path to the nonce that the handoff code is issued for.
 */
export const ReadTransaction = z
  .object({
    v: z.literal(1),
    aid: ArtifactId,
    nonce: OpaqueToken,
    /** Path and query to return to, on the same origin. */
    path: z.string().startsWith("/").max(2_048),
    exp: z.number().int().nonnegative(),
  })
  .strict();
export type ReadTransaction = z.infer<typeof ReadTransaction>;
