// Grants of artifact data (decision 0026, "The grant", delivery 6): one person's consent, for one
// artifact host and one browser, that the page may know them by an opaque per-artifact ID and
// their display name and save what they enter. The control is drawn on the app; the content
// Worker redeems a one-use code into the `__Host-pf_grant` cookie, whose sealed claims are
// renewed against the grant every 60 seconds.
import { z } from "zod";
import { ArtifactId } from "./core.ts";
import { OpaqueToken } from "./read.ts";

export const DATA_GRANT = {
  /** How long the begin step's transaction cookie lives, in seconds. */
  transactionTtlSeconds: 300,
  /** How long a one-use code lives, in seconds (`GRANT_CODE_MS` in the domain). */
  codeTtlSeconds: 60,
  /** Claims are trusted without D1 this long, then renewed against the grant. */
  claimsTtlSeconds: 60,
  /** A grant lasts at most this long, and never past the app session that gave it. */
  grantTtlSeconds: 30 * 86_400,
  /** Codes one person may ask for per artifact a minute. */
  codesPerMinute: 10,
  /** Ended grants and their codes are deleted this long after they ended. */
  endedKeepMs: 30 * 86_400_000,
} as const;

/** A grant's ID: `dg_` and 16 random bytes in base64url. */
export const DataGrantId = z.string().regex(/^dg_[A-Za-z0-9_-]{22}$/, "Invalid grant id");
export type DataGrantId = z.infer<typeof DataGrantId>;

/** How the browser reached the control: the viewer's frame, or a top-level page (tab or popup). */
export const DataGrantFlow = z.enum(["frame", "top"]);
export type DataGrantFlow = z.infer<typeof DataGrantFlow>;

/**
 * Asking the app for a code (`POST /api/v1/data/grants`, dashboard session only): the artifact,
 * the SHA-256 of the beginning browser's nonce (base64url, from the artifact origin), and the
 * custom host the page runs on, or none for the `.dev` host. Untrusted input: the host must be
 * the artifact's own.
 */
export const DataGrantCodeRequest = z.strictObject({
  artifactId: ArtifactId,
  nonceHash: OpaqueToken,
  host: z.string().min(1).max(253).nullable().optional(),
  /** Where the code is redeemed: in the viewer's frame or in a top-level page. */
  flow: DataGrantFlow,
});
export type DataGrantCodeRequest = z.infer<typeof DataGrantCodeRequest>;

/** The code, shown once, and where to redeem it. */
export const DataGrantCode = z.strictObject({
  code: OpaqueToken,
  redeemUrl: z.string().url(),
  expiresAt: z.iso.datetime(),
});
export type DataGrantCode = z.infer<typeof DataGrantCode>;

/**
 * What the control shows before the person chooses (`GET /api/v1/data/grants/control`): the
 * artifact's host and owner, the name the page will learn, and whether a grant is open already.
 */
export const DataGrantControl = z.strictObject({
  artifactId: ArtifactId,
  artifactName: z.string(),
  host: z.string(),
  owner: z.strictObject({ kind: z.enum(["user", "workspace"]), name: z.string() }),
  displayName: z.string(),
  grantDays: z.number().int().positive(),
});
export type DataGrantControl = z.infer<typeof DataGrantControl>;

/** One artifact the person shared data with, for "Data you shared". */
export const DataGrantView = z.strictObject({
  artifactId: ArtifactId,
  artifactName: z.string().nullable(),
  host: z.string(),
  /** Grants open now (one per browser); zero once revoked or expired. */
  openGrants: z.number().int().min(0),
  firstGrantedAt: z.iso.datetime(),
  lastGrantedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});
export type DataGrantView = z.infer<typeof DataGrantView>;

export const DataGrantList = z.strictObject({ items: z.array(DataGrantView) });
export type DataGrantList = z.infer<typeof DataGrantList>;

export const DataGrantRevocation = z.strictObject({
  artifactId: ArtifactId,
  revoked: z.number().int().min(0),
});
export type DataGrantRevocation = z.infer<typeof DataGrantRevocation>;

/** Sealed claims in the `__Host-pf_grant` cookie of one artifact host. Times in ms. */
export const DataGrantClaims = z.strictObject({
  v: z.literal(1),
  /** The grant, checked in D1 when the claims are renewed. */
  gid: DataGrantId,
  aid: ArtifactId,
  /** The opaque per-artifact visitor ID: the only identity the page learns besides `name`. */
  vid: z.string().regex(/^v_[A-Za-z0-9_-]{16,64}$/),
  name: z.string().max(200),
  /** Whether the account accepted the current terms at the last renewal: writes need it. */
  w: z.boolean(),
  /** Claims are trusted until then; the grant is renewed after. */
  exp: z.number().int().nonnegative(),
  /** End of the grant. */
  gexp: z.number().int().nonnegative(),
  /** Set in the viewer's frame: a partitioned cookie, never honored on a top-level page. */
  part: z.boolean(),
});
export type DataGrantClaims = z.infer<typeof DataGrantClaims>;

/** The begin step's transaction, in its own sealed cookie: the nonce the code is bound to. */
export const DataGrantTransaction = z.strictObject({
  v: z.literal(1),
  aid: ArtifactId,
  nonce: OpaqueToken,
  flow: DataGrantFlow,
  /** Where a top-level flow returns once granted, on this origin. */
  path: z.string().startsWith("/").max(1024),
  exp: z.number().int().nonnegative(),
});
export type DataGrantTransaction = z.infer<typeof DataGrantTransaction>;

/** What `GET /__portifact/data/me` answers: nothing about who is there without a grant. */
export const DataMe = z.union([
  z.strictObject({ granted: z.literal(false) }),
  z.strictObject({
    granted: z.literal(true),
    visitor: z.strictObject({ id: z.string(), name: z.string() }),
    /** Whether the page may write as the visitor now (the current terms accepted). */
    write: z.boolean(),
  }),
]);
export type DataMe = z.infer<typeof DataMe>;
