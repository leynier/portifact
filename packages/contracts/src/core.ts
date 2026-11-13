// Core shapes, limits and error codes shared by every interface.
// Every boundary validates with these schemas; see AGENTS.md "Architecture rules".
import { z } from "zod";

/** Artifact IDs: 10 lowercase base32 characters, used as the `<id>.portifact.dev` hostname label. */
export const ARTIFACT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const ArtifactId = z.string().regex(/^[a-z2-7]{10}$/, "Invalid artifact id");
export type ArtifactId = z.infer<typeof ArtifactId>;

export const ArtifactType = z.enum(["site", "markdown", "text"]);
export type ArtifactType = z.infer<typeof ArtifactType>;

/**
 * Who may open an artifact. `workspace` (every member of the owning workspace) and `domain`
 * (members plus verified addresses at the workspace's verified email domains) exist only for
 * artifacts a workspace owns (premium plan T2, decision 0010).
 */
export const AccessMode = z.enum(["public", "authenticated", "restricted", "workspace", "domain"]);
export type AccessMode = z.infer<typeof AccessMode>;

/** The modes that name a workspace's people; a transfer to another owner resets them. */
export const WORKSPACE_ACCESS_MODES = ["workspace", "domain"] as const;
export type WorkspaceAccessMode = (typeof WORKSPACE_ACCESS_MODES)[number];

/** Whether a mode exists only for workspace artifacts. */
export function isWorkspaceAccessMode(mode: AccessMode): mode is WorkspaceAccessMode {
  return (WORKSPACE_ACCESS_MODES as readonly string[]).includes(mode);
}

/** The modes a personal space can use, also the choices of the account's default. */
export const PersonalAccessMode = z.enum(["public", "authenticated", "restricted"]);
export type PersonalAccessMode = z.infer<typeof PersonalAccessMode>;

export const AnnotationsState = z.enum(["off", "open", "locked"]);
export type AnnotationsState = z.infer<typeof AnnotationsState>;

/**
 * Who sees an artifact's comment threads (plan section 8, "Permisos"). `owner`, the default:
 * each reader sees only the threads they started and the threads the owner started, each with
 * every reply in it. `everyone`: every reader sees every thread. The owner always sees all.
 */
export const CommentVisibility = z.enum(["owner", "everyone"]);
export type CommentVisibility = z.infer<typeof CommentVisibility>;

/**
 * Which threads one reader sees: `all`, or only their `own` and the owner's. A reader on the
 * list may have one set as an exception to the artifact's `CommentVisibility`.
 */
export const CommentScope = z.enum(["all", "own"]);
export type CommentScope = z.infer<typeof CommentScope>;

export const ArtifactState = z.enum([
  "draft",
  "active",
  "archived",
  "suspended",
  "purging",
  "deleted",
]);
export type ArtifactState = z.infer<typeof ArtifactState>;

export const Email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

/** Error codes shared by every interface. Adapters map them to HTTP statuses and messages. */
export const ErrorCode = z.enum([
  "invalid_input",
  "unauthenticated",
  "forbidden",
  "not_found",
  "version_conflict",
  "quota_exceeded",
  "traffic_exceeded",
  "upload_incomplete",
  "artifact_archived",
  "account_too_new_for_public",
  "capacity_unavailable",
  "rate_limited",
  "reauthentication_required",
  "human_verification_required",
  "sole_workspace_admin",
  "seats_exhausted",
  "plan_required",
  /** A workspace policy (decision 0015) does not allow the operation; the message names it. */
  "policy_refused",
  /**
   * The account must accept the current terms in the dashboard first (docs/legal.md, "API and
   * MCP clients"). Also the code the sign-in hooks refuse with (`TERMS_NOT_ACCEPTED`).
   */
  "terms_not_accepted",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * Which refusal an error is, when a page must tell two refusals of the same code apart without
 * reading the message: sent as `error.details.reason`. `comment_retention_guard`: a workspace's
 * comment retention rule could not be changed because its restore guard record could not be
 * read or written (decision 0023, "Restores").
 */
export const ERROR_DETAILS = [
  "comment_retention_guard",
  /** Mail to the account's address bounced or was reported (the account deletion code). */
  "email_suppressed",
  /**
   * A suggestion's or draft's plan is no longer the one the person confirmed (decision 0027):
   * review it again.
   */
  "plan_changed",
] as const;
export const ErrorDetail = z.enum(ERROR_DETAILS);
export type ErrorDetail = z.infer<typeof ErrorDetail>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * OAuth scopes for API and MCP tokens (plan section 5). A scope allows a class of action; the
 * permission on the specific artifact is always checked as well.
 */
export const OAuthScope = z.enum([
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "artifacts:delete",
  "annotations:read",
  "annotations:write",
  "annotations:moderate",
  /** Artifact data (decision 0026): describe, read, query, count and export an artifact's documents. */
  "data:read",
  /** Artifact data: declare collections and create, replace and delete documents. */
  "data:write",
]);
export type OAuthScope = z.infer<typeof OAuthScope>;

/** The identity behind a valid access token, as `GET /api/v1/me` returns it. */
export const TokenPrincipal = z.object({
  userId: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()),
});
export type TokenPrincipal = z.infer<typeof TokenPrincipal>;

/**
 * Limits on sending sign-in codes (plan section 5: cooldown, per email, per IP and a global
 * budget). Windows are in seconds. The global budget keeps sends under the monthly email
 * allowance of the admission limits (plan section 12).
 */
export const OTP_LIMITS = {
  codeTtlSeconds: 300,
  allowedAttempts: 3,
  perEmailCooldown: { max: 1, windowSeconds: 60 },
  perEmail: { max: 5, windowSeconds: 3_600 },
  perIp: { max: 20, windowSeconds: 3_600 },
  global: { max: 600, windowSeconds: 86_400 },
} as const;
