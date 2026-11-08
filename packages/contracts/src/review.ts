// Shapes of review mode (plan section 4, "Modo revisión"): the one-use review code the viewer on
// app.portifact.com asks for, and the claims of the partitioned `__Host-pf_review` cookie that
// the artifact origin sets when the viewer's iframe redeems the code. See
// docs/decisions/0002-review-mode-cookies.md.
import { z } from "zod";
import { ArtifactId, ArtifactType } from "./core.ts";
import { OpaqueToken } from "./read.ts";

/**
 * Review sessions grant reading one version of one artifact inside the viewer, nothing else.
 * Claims are trusted without D1 for `claimsTtlSeconds`, like read sessions; the session itself
 * is short because the fallback (a top-level review tab) would keep it in the artifact's own
 * cookie partition.
 */
export const REVIEW_SESSION = {
  handoffTtlSeconds: 60,
  claimsTtlSeconds: 60,
  sessionTtlSeconds: 14_400,
} as const;

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
  expiresAt: z.iso.datetime(),
});
export type ReviewStart = z.infer<typeof ReviewStart>;
