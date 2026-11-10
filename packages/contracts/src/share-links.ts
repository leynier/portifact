// Shapes of share links (premium plan P4, decision 0008): a link that lets anyone who holds it
// read one artifact without an account, optionally behind a password and until an expiry. The
// owner creates, lists and revokes links through `/api/v1/artifacts/:id/share-links`, the MCP
// tools create_share_link, list_share_links and revoke_share_link and `portifact share`; a
// visitor opens one through the entry page `app.portifact.com/s#<token>`.
import { z } from "zod";
import { ArtifactId } from "./core.ts";
import { OpaqueToken } from "./read.ts";

/** Safety caps and lifetimes of share links; not plan values. */
export const SHARE_LINKS = {
  /** Links that are neither revoked nor expired, per artifact. */
  activePerArtifact: 20,
  labelMaxLength: 80,
  passwordMinLength: 8,
  passwordMaxLength: 200,
  /** The latest expiry a link can have, counted from its creation. */
  maxExpiryDays: 365,
  /** A link session's longest life; it also ends with the link's expiry. */
  sessionTtlSeconds: 43_200,
  /** The one-use code that carries the visitor from the app to the artifact origin. */
  handoffTtlSeconds: 60,
  /** PBKDF2-HMAC-SHA-256 iterations: the most workerd accepts (decision 0008). */
  passwordIterations: 100_000,
  passwordSaltBytes: 16,
  /** Largest body `POST /api/v1/share/open` reads. */
  openBodyMaxBytes: 1024,
} as const;

/** Rate limits of opening links (decision 0008, "Rate limits and the human check"). */
export const SHARE_OPEN_LIMITS = {
  /** Every open request, per IP. */
  perIp: { max: 60, windowSeconds: 600 },
  /** Failed passwords per token before the human check, and before the token is locked. */
  tokenHumanCheckAfter: 3,
  tokenLockAfter: 10,
  /** Failed passwords per IP before the human check, and before the IP is refused. */
  ipHumanCheckAfter: 5,
  ipLockAfter: 20,
  failureWindowSeconds: 900,
} as const;

/** The entry page's path on the app origin; the token goes in the fragment. */
export const SHARE_ENTRY_PATH = "/s";

export function shareLinkUrl(appOrigin: string, token: string): string {
  return `${appOrigin}${SHARE_ENTRY_PATH}#${token}`;
}

/** `sl_` and 32 lowercase hex characters, a shape no user or artifact ID has. */
export const ShareLinkId = z.string().regex(/^sl_[0-9a-f]{32}$/, "Invalid share link id");
export type ShareLinkId = z.infer<typeof ShareLinkId>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const ShareLinkLabel = z
  .string()
  .trim()
  .min(1, "Give the link a label.")
  .max(SHARE_LINKS.labelMaxLength, `A label has at most ${SHARE_LINKS.labelMaxLength} characters.`)
  .refine((value) => !CONTROL.test(value), "A label cannot hold control characters.");

export const ShareLinkPassword = z
  .string()
  .min(
    SHARE_LINKS.passwordMinLength,
    `A password has at least ${SHARE_LINKS.passwordMinLength} characters.`,
  )
  .max(
    SHARE_LINKS.passwordMaxLength,
    `A password has at most ${SHARE_LINKS.passwordMaxLength} characters.`,
  );

/** Body of `POST /api/v1/artifacts/:id/share-links`. */
export const ShareLinkCreate = z.strictObject({
  label: ShareLinkLabel,
  /** ISO date and time; omitted for a link that lasts until it is revoked. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  password: ShareLinkPassword.optional(),
});
export type ShareLinkCreate = z.infer<typeof ShareLinkCreate>;

export const ShareLinkState = z.enum(["active", "expired"]);
export type ShareLinkState = z.infer<typeof ShareLinkState>;

/** One link as the owner sees it. Never the token. */
export const ShareLinkView = z.object({
  id: ShareLinkId,
  label: z.string(),
  state: ShareLinkState,
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  /** The UTC day the link was last opened, `YYYY-MM-DD`, or null. */
  lastUsedOn: z.iso.date().nullable(),
});
export type ShareLinkView = z.infer<typeof ShareLinkView>;

export const ShareLinkList = z.object({
  artifactId: ArtifactId,
  /** Whether the owner's plan includes share links now; when false, links do not open. */
  enabled: z.boolean(),
  /** Newest first; revoked links are not listed. */
  links: z.array(ShareLinkView),
  activeLimit: z.number().int().positive(),
});
export type ShareLinkList = z.infer<typeof ShareLinkList>;

/** The create response: the only time the link URL (and its token) is ever shown. */
export const ShareLinkCreated = z.object({
  link: ShareLinkView,
  url: z.url(),
});
export type ShareLinkCreated = z.infer<typeof ShareLinkCreated>;

export const ShareLinkRevoked = z.object({ id: ShareLinkId, revoked: z.literal(true) });
export type ShareLinkRevoked = z.infer<typeof ShareLinkRevoked>;

/** Body of `POST /api/v1/share/open`, sent by the entry page. */
export const ShareOpenInput = z.strictObject({
  token: OpaqueToken,
  password: z.string().min(1).max(SHARE_LINKS.passwordMaxLength).optional(),
  turnstileToken: z.string().min(1).max(2048).optional(),
});
export type ShareOpenInput = z.infer<typeof ShareOpenInput>;

/** Where the entry page sends the visitor: the artifact origin's handoff, with a one-use code. */
export const ShareOpenResult = z.object({ location: z.url() });
export type ShareOpenResult = z.infer<typeof ShareOpenResult>;

/** Signed claims in the `__Host-pf_link` cookie of one artifact origin. Times in ms. */
export const ShareClaims = z
  .object({
    v: z.literal(1),
    /** Link session ID, checked in D1 when the claims are renewed. */
    sid: OpaqueToken,
    aid: ArtifactId,
    lid: ShareLinkId,
    /** When the claims stop being trusted without D1. */
    exp: z.number().int().nonnegative(),
    /** When the link session ends. */
    sexp: z.number().int().nonnegative(),
  })
  .strict();
export type ShareClaims = z.infer<typeof ShareClaims>;

const artifactId = ArtifactId.describe(
  "The artifact ID, as list_artifacts or get_artifact return it.",
);

/** Input of the MCP tool create_share_link. */
export const CreateShareLinkInput = z.object({
  artifactId,
  label: ShareLinkLabel.describe(
    "A name for the link that only the owner sees, for example who it is for. At most 80 characters.",
  ),
  expiresAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      "ISO 8601 date and time when the link stops working, at most 365 days ahead. Omit it for a link that works until it is revoked.",
    ),
  password: ShareLinkPassword.optional().describe(
    "A password of at least 8 characters that visitors must type. Only set one the user gave you, and never repeat it back.",
  ),
});
export type CreateShareLinkInput = z.infer<typeof CreateShareLinkInput>;

export const ListShareLinksInput = z.object({ artifactId });
export type ListShareLinksInput = z.infer<typeof ListShareLinksInput>;

export const RevokeShareLinkInput = z.object({
  artifactId,
  linkId: ShareLinkId.describe("The link's id, as list_share_links returns it."),
});
export type RevokeShareLinkInput = z.infer<typeof RevokeShareLinkInput>;
