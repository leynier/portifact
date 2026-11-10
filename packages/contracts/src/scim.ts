// SCIM 2.0 provisioning for a workspace (premium plan E2, decision 0017): the directory's token,
// the settings admins manage from the dashboard, and the limits of the protocol endpoints at
// `/scim/v2` on the app host. The protocol's own shapes (RFC 7643 and 7644) are parsed by hand in
// packages/domain (scim.ts), because directories send dialects a strict schema would refuse.
import { z } from "zod";

/** SCIM token IDs: `sc_` and 32 hex characters, a prefix no user, token or workspace ID has. */
export const SCIM_TOKEN_ID_PREFIX = "sc_";
export const ScimTokenId = z.string().regex(/^sc_[0-9a-f]{32}$/, "Invalid SCIM token id");
export type ScimTokenId = z.infer<typeof ScimTokenId>;

/** Whether an actor ID names a directory's SCIM token. */
export function isScimTokenId(id: string): boolean {
  return id.startsWith(SCIM_TOKEN_ID_PREFIX);
}

/**
 * The secret's recognizable prefix: the prefix and 43 base64url characters (32 random bytes).
 * Scanners match `pfsc_[A-Za-z0-9_-]{43}` (.gitleaks.toml).
 */
export const SCIM_TOKEN_SECRET_PREFIX = "pfsc_";
export const SCIM_TOKEN_SECRET = /^pfsc_[A-Za-z0-9_-]{43}$/;

/** Whether a bearer value has the shape of a SCIM token secret. */
export function isScimTokenSecret(value: string): boolean {
  return SCIM_TOKEN_SECRET.test(value);
}

/** IDs of the directory's users: `su_` and 32 hex characters, never derived from an address. */
export const ScimUserId = z.string().regex(/^su_[0-9a-f]{32}$/, "Invalid SCIM user id");

/** Safety caps and defaults; not plan values. */
export const SCIM = {
  /** Two, so a directory's token can be rotated without a gap. */
  tokensPerWorkspace: 2,
  maxDays: 366,
  defaultDays: 365,
  labelMaxLength: 80,
  /** The users a workspace's directory may hold, active or not: bounds every scan. */
  usersPerWorkspace: 5_000,
  /** The largest page a list answers, whatever `count` asks. */
  maxPageSize: 100,
  /** The largest request body the endpoints read. */
  maxBodyBytes: 64 * 1024,
  /** PATCH operations in one request. */
  maxOperations: 50,
  /** Requests per token and per workspace in a minute. */
  perTokenPerMinute: { max: 300, windowSeconds: 60 },
  perWorkspacePerMinute: { max: 600, windowSeconds: 60 },
  /**
   * How long a provisioned person who never signed in holds a seat after the directory last
   * wrote them; the directory's next write renews it. Then the pending row and, once nothing
   * links it to an account, the directory's copy of the address are deleted.
   */
  pendingDays: 90,
} as const;

/** The base path an admin pastes into the directory, after the app's origin. */
export const SCIM_BASE_PATH = "/scim/v2";

const Label = z
  .string()
  .trim()
  .min(1)
  .max(SCIM.labelMaxLength)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "No control characters");

/** `POST /api/v1/workspaces/:slug/scim/tokens`, dashboard session only. */
export const ScimTokenCreate = z.strictObject({
  label: Label,
  expiresInDays: z.int().min(1).max(SCIM.maxDays),
});
export type ScimTokenCreate = z.infer<typeof ScimTokenCreate>;

/** A SCIM token as admins see it: never the secret or its hash. */
export const ScimTokenView = z.object({
  id: ScimTokenId,
  label: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** To the hour; null until the directory first used it. */
  lastUsedAt: z.iso.datetime().nullable(),
  createdBy: z.object({ name: z.string() }).nullable(),
  expired: z.boolean(),
});
export type ScimTokenView = z.infer<typeof ScimTokenView>;

/** The create response: the only time the secret is shown. */
export const ScimTokenCreated = z.object({
  token: ScimTokenView,
  secret: z.string().regex(SCIM_TOKEN_SECRET),
});
export type ScimTokenCreated = z.infer<typeof ScimTokenCreated>;

/** `PATCH /api/v1/workspaces/:slug/scim`: what admins may change. */
export const ScimSettingsUpdate = z.strictObject({
  /** Whether a person the directory provisions without an account gets the invitation email. */
  invitationEmails: z.boolean(),
});
export type ScimSettingsUpdate = z.infer<typeof ScimSettingsUpdate>;

/** The Directory sync section of the Members page. */
export const ScimOverview = z.object({
  /** What the admin pastes into the directory as its base or tenant URL. */
  baseUrl: z.string(),
  /** Whether the workspace's plan includes `scim`; creating a token needs it. */
  available: z.boolean(),
  tokens: z.array(ScimTokenView),
  limit: z.int().min(1),
  invitationEmails: z.boolean(),
  /** The last hour the directory called, from its tokens; null before its first call. */
  lastSyncAt: z.iso.datetime().nullable(),
  /** People the directory provisioned who have not signed in yet. */
  pending: z.int().min(0),
});
export type ScimOverview = z.infer<typeof ScimOverview>;
