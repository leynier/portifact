// Shapes of review mode (plan section 4, "Modo revisión"): the one-use review code the viewer on
// app.portifact.com asks for, and the claims of the partitioned `__Host-pf_review` cookie that
// the artifact origin sets when the viewer's iframe redeems the code. See
// docs/decisions/0002-review-mode-cookies.md.
import { z } from "zod";
import { ArtifactId, ArtifactType } from "./core.ts";
import { OpaqueToken } from "./read.ts";

/**
 * Review sessions grant reading one version of one artifact, nothing else. Claims are trusted
 * without D1 for `claimsTtlSeconds`, like read sessions. A session in the viewer's frame lasts
 * `sessionTtlSeconds`; the fallback, a top-level review tab, keeps its cookie in the artifact's
 * own partition, where later visits in that browser carry it, so its session is much shorter.
 */
export const REVIEW_SESSION = {
  handoffTtlSeconds: 60,
  claimsTtlSeconds: 60,
  sessionTtlSeconds: 14_400,
  tabSessionTtlSeconds: 900,
} as const;

/**
 * Where a review code is redeemed: `frame` in the viewer's iframe, or `tab` in a top-level
 * review tab opened from the viewer when the browser drops the frame's partitioned cookie.
 */
export const ReviewKind = z.enum(["frame", "tab"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

/** Signed claims in the `__Host-pf_review` cookie of one artifact origin. Times in ms. */
export const ReviewClaims = z
  .object({
    v: z.literal(1),
    /** Review session ID, checked in D1 when the claims are renewed. */
    sid: OpaqueToken,
    aid: ArtifactId,
    /** The pinned version: the only one the session can read. */
    vid: z.string().min(1).max(64),
    uid: z.string().min(1).max(64),
    gen: z.number().int().positive(),
    /** Tag of the session, injected for the bridge to echo (see `ReviewStart.sessionTag`). */
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    exp: z.number().int().nonnegative(),
    sexp: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewClaims = z.infer<typeof ReviewClaims>;

/**
 * What the viewer gets for `POST /api/v1/artifacts/:id/review`: the URL its iframe opens (on
 * the artifact origin, with the one-use code), the pinned version and the artifact origin the
 * viewer must accept bridge messages from.
 */
export const ReviewStart = z.object({
  artifactId: ArtifactId,
  /** The artifact's name: anyone who may review it may read it. */
  name: z.string(),
  type: ArtifactType,
  url: z.url(),
  origin: z.url(),
  versionId: z.string(),
  /** The file the review opens on: the entrypoint of the pinned version. */
  entrypoint: z.string(),
  /**
   * Tag of the review session the code turns into. The bridge echoes the tag of the session its
   * page was served in; the viewer refuses a frame whose tag differs (a planted session).
   */
  sessionTag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  expiresAt: z.iso.datetime(),
});
export type ReviewStart = z.infer<typeof ReviewStart>;

/**
 * What the viewer gets for `POST /api/v1/artifacts/:id/review/tab`: the URL that opens the
 * artifact in a top-level review tab (on the artifact origin, with a one-use code) and when the
 * tab's session would end if it started now.
 */
export const ReviewTabStart = z.object({
  artifactId: ArtifactId,
  url: z.url(),
  origin: z.url(),
  versionId: z.string(),
  /** The code's expiry: the link must be opened before then. */
  expiresAt: z.iso.datetime(),
  /** How long the tab's session lasts once opened, in seconds. */
  sessionSeconds: z.number().int().positive(),
});
export type ReviewTabStart = z.infer<typeof ReviewTabStart>;
