// Service tokens (premium plan T4, decision 0011): a workspace's credential for automation, with
// a fixed role and scopes, and the stable publish keys (T5) a CI job publishes under.
import { z } from "zod";

/** Service token IDs: `st_` and 32 hex characters, a prefix no user, artifact or workspace has. */
export const SERVICE_TOKEN_ID_PREFIX = "st_";
export const ServiceTokenId = z.string().regex(/^st_[0-9a-f]{32}$/, "Invalid service token id");
export type ServiceTokenId = z.infer<typeof ServiceTokenId>;

/** Whether a caller ID names a service token rather than a person. */
export function isServiceTokenId(id: string): boolean {
  return id.startsWith(SERVICE_TOKEN_ID_PREFIX);
}

/**
 * The secret's recognizable prefix. A secret is the prefix and 43 base64url characters (32
 * random bytes); scanners match `pfst_[A-Za-z0-9_-]{43}` (.gitleaks.toml).
 */
export const SERVICE_TOKEN_SECRET_PREFIX = "pfst_";
export const SERVICE_TOKEN_SECRET = /^pfst_[A-Za-z0-9_-]{43}$/;

/** Whether a bearer value has the shape of a service token secret. */
export function isServiceTokenSecret(value: string): boolean {
  return SERVICE_TOKEN_SECRET.test(value);
}

/** Safety caps and defaults; not plan values. */
export const SERVICE_TOKENS = {
  perWorkspace: 20,
  maxDays: 366,
  defaultDays: 90,
  /** `last_used_at` is written at most once per this period per token. */
  lastUsedPeriodMs: 60 * 60 * 1000,
  labelMaxLength: 80,
} as const;

/** Roles a token may hold: never `admin`. */
export const SERVICE_TOKEN_ROLES = ["editor", "member"] as const;
export const ServiceTokenRole = z.enum(SERVICE_TOKEN_ROLES);
export type ServiceTokenRole = z.infer<typeof ServiceTokenRole>;

/**
 * Scopes a token may hold: the artifact scopes only. Never the annotation scopes (comments need
 * a person) and never `credentials:manage`.
 */
export const SERVICE_TOKEN_SCOPES = [
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "artifacts:delete",
] as const;
export const ServiceTokenScope = z.enum(SERVICE_TOKEN_SCOPES);
export type ServiceTokenScope = z.infer<typeof ServiceTokenScope>;

/**
 * Publish keys: 1 to 128 characters of letters, digits, `.`, `_`, `/` and `-`, starting with a
 * letter or digit. Unique per owner while the artifact exists.
 */
export const PUBLISH_KEY_MAX = 128;
export const PublishKey = z
  .string()
  .max(PUBLISH_KEY_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Invalid key");
export type PublishKey = z.infer<typeof PublishKey>;

/** A token's optional limit on which artifacts it reaches. */
export const ServiceTokenRestriction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  /** Only artifacts the token created. */
  z.object({ kind: z.literal("own") }),
  /** Only artifacts whose publish key starts with `prefix`; every publish needs such a key. */
  z.object({ kind: z.literal("key"), prefix: PublishKey }),
]);
export type ServiceTokenRestriction = z.infer<typeof ServiceTokenRestriction>;

const Label = z
  .string()
  .trim()
  .min(1)
  .max(SERVICE_TOKENS.labelMaxLength)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "No control characters");

/** `POST /api/v1/workspaces/:slug/service-tokens`, dashboard session only. */
export const ServiceTokenCreate = z.strictObject({
  label: Label,
  role: ServiceTokenRole,
  scopes: z
    .array(ServiceTokenScope)
    .min(1)
    .max(SERVICE_TOKEN_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, "Repeated scope"),
  expiresInDays: z.int().min(1).max(SERVICE_TOKENS.maxDays),
  restriction: ServiceTokenRestriction.default({ kind: "none" }),
});
export type ServiceTokenCreate = z.infer<typeof ServiceTokenCreate>;

/** A token as admins see it: never the secret or its hash. */
export const ServiceTokenView = z.object({
  id: ServiceTokenId,
  label: z.string(),
  role: ServiceTokenRole,
  scopes: z.array(ServiceTokenScope),
  restriction: ServiceTokenRestriction,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** To the hour; null until first used. */
  lastUsedAt: z.iso.datetime().nullable(),
  /** The admin who created it, by name; null once their account is deleted. */
  createdBy: z.object({ name: z.string() }).nullable(),
  expired: z.boolean(),
});
export type ServiceTokenView = z.infer<typeof ServiceTokenView>;

export const ServiceTokenList = z.object({
  items: z.array(ServiceTokenView),
  /** Whether the workspace's plan includes service tokens; creating needs it. */
  available: z.boolean(),
  limit: z.int().min(1),
});
export type ServiceTokenList = z.infer<typeof ServiceTokenList>;

/** The create response: the only time the secret is shown. */
export const ServiceTokenCreated = z.object({
  token: ServiceTokenView,
  secret: z.string().regex(SERVICE_TOKEN_SECRET),
});
export type ServiceTokenCreated = z.infer<typeof ServiceTokenCreated>;
