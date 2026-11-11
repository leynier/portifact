// GitHub Actions OIDC federation (premium plan T5, second delivery, decision 0024): a workspace
// admin trusts a GitHub repository by its numeric IDs, and a workflow run from it exchanges
// GitHub's ID token for a short-lived service token restricted to the repository's key namespace.
import { z } from "zod";
import { GitHubRepo } from "./integrations.ts";
import { SERVICE_TOKEN_SECRET } from "./service-tokens.ts";

/** GitHub's one public issuer and its key set (read from its discovery document, decision 0024). */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
/** The only signing algorithm GitHub announces, and the only one accepted. */
export const GITHUB_OIDC_ALGORITHMS = ["RS256"] as const;

/** Safety caps and timings; not plan values. */
export const GITHUB_TRUST = {
  perWorkspace: 20,
  /** How long an issued credential lives. */
  credentialMinutes: 15,
  /** Credentials are pruned this long after they expire, so their `jti` outlives any ID token. */
  pruneAfterMs: 60 * 60 * 1000,
  /** At most this many credential rows are pruned per run. */
  prunePerRun: 500,
  /** Clock skew allowed on `exp`, `nbf` and `iat`. */
  clockSkewSeconds: 60,
  /** The oldest `iat` and the longest `exp - iat` accepted. */
  maxTokenAgeSeconds: 60 * 60,
  /** Key set cache and forced refresh per isolate. */
  jwksCacheMs: 60 * 60 * 1000,
  jwksRefetchMs: 60 * 1000,
  /** Exchanges per IP (every attempt) and per repository (verified tokens), per window. */
  perIpLimit: 300,
  perRepositoryLimit: 60,
  rateWindowMs: 10 * 60 * 1000,
  /** The largest ID token read. */
  tokenMaxLength: 8192,
  refMaxLength: 255,
  environmentMaxLength: 255,
} as const;

/** Trust rule IDs: `gtr_` and 32 hex characters. */
export const GitHubTrustRuleId = z
  .string()
  .regex(/^gtr_[0-9a-f]{32}$/, "Invalid GitHub trust rule id");
export type GitHubTrustRuleId = z.infer<typeof GitHubTrustRuleId>;

/** GitHub's numeric IDs, as decimal text (the claims carry them as strings). */
export const GitHubNumericId = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, "Use the numeric ID GitHub shows.");
export type GitHubNumericId = z.infer<typeof GitHubNumericId>;

/**
 * Events a rule may trust. `pull_request_target` and `workflow_run` are privileged runs a fork's
 * pull request can start (`GITHUB_PRIVILEGED_EVENTS`); the rest a fork cannot start with an ID
 * token, except `pull_request` in a private repository with fork write tokens on (decision 0024).
 */
export const GITHUB_TRUST_EVENTS = [
  "push",
  "pull_request",
  "workflow_dispatch",
  "merge_group",
  "release",
  "schedule",
  "pull_request_target",
  "workflow_run",
] as const;
export const GitHubTrustEvent = z.enum(GITHUB_TRUST_EVENTS);
export type GitHubTrustEvent = z.infer<typeof GitHubTrustEvent>;
export const GITHUB_PRIVILEGED_EVENTS: readonly GitHubTrustEvent[] = [
  "pull_request_target",
  "workflow_run",
];
export const GITHUB_DEFAULT_EVENTS: readonly GitHubTrustEvent[] = ["pull_request", "push"];

/** Scopes a rule may give: never `artifacts:share` (decision 0024). */
export const GITHUB_TRUST_SCOPES = [
  "artifacts:read",
  "artifacts:write",
  "artifacts:delete",
] as const;
export const GitHubTrustScope = z.enum(GITHUB_TRUST_SCOPES);
export type GitHubTrustScope = z.infer<typeof GitHubTrustScope>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
const Ref = z
  .string()
  .min(1)
  .max(GITHUB_TRUST.refMaxLength)
  .regex(/^refs\/[^\s]+$/, "Use a full ref such as refs/heads/main.");
const Environment = z.string().min(1).max(GITHUB_TRUST.environmentMaxLength).regex(NO_CONTROL);

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

const RuleFields = {
  repository: GitHubRepo,
  repositoryId: GitHubNumericId,
  repositoryOwnerId: GitHubNumericId,
  events: z
    .array(GitHubTrustEvent)
    .min(1)
    .max(GITHUB_TRUST_EVENTS.length)
    .refine(unique, "Repeated event"),
  ref: Ref.nullable(),
  environment: Environment.nullable(),
  scopes: z
    .array(GitHubTrustScope)
    .min(1)
    .max(GITHUB_TRUST_SCOPES.length)
    .refine(unique, "Repeated scope"),
  /**
   * Required true when `events` holds a privileged event: the admin saw what it means
   * (decision 0024, "Events").
   */
  privilegedConfirmed: z.boolean().default(false),
};

/** `POST /api/v1/workspaces/:slug/github-trust`, dashboard session only. */
export const GitHubTrustRuleCreate = z.strictObject({
  ...RuleFields,
  ref: RuleFields.ref.default(null),
  environment: RuleFields.environment.default(null),
  scopes: RuleFields.scopes.default(["artifacts:read", "artifacts:write"]),
});
export type GitHubTrustRuleCreate = z.infer<typeof GitHubTrustRuleCreate>;

/** `PATCH /api/v1/workspaces/:slug/github-trust/:ruleId`: the whole rule, read at `revision`. */
export const GitHubTrustRuleUpdate = z.strictObject({
  ...RuleFields,
  ref: RuleFields.ref.default(null),
  environment: RuleFields.environment.default(null),
  revision: z.int().min(0),
});
export type GitHubTrustRuleUpdate = z.infer<typeof GitHubTrustRuleUpdate>;

export const GitHubTrustRuleView = z.object({
  id: GitHubTrustRuleId,
  repository: z.string(),
  repositoryId: GitHubNumericId,
  repositoryOwnerId: GitHubNumericId,
  events: z.array(GitHubTrustEvent),
  ref: z.string().nullable(),
  environment: z.string().nullable(),
  scopes: z.array(GitHubTrustScope),
  /** The publish key prefix its credentials are restricted to. */
  keyPrefix: z.string(),
  /** Credentials issued for it that have not expired yet. */
  liveCredentials: z.int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.object({ name: z.string() }).nullable(),
  revision: z.int().min(0),
});
export type GitHubTrustRuleView = z.infer<typeof GitHubTrustRuleView>;

export const GitHubTrustRuleList = z.object({
  items: z.array(GitHubTrustRuleView),
  /** Whether the workspace's plan includes service tokens; creating and changing need it. */
  available: z.boolean(),
  /** Whether this deployment offers the federation (`GITHUB_OIDC_ENABLED`). */
  enabled: z.boolean(),
  limit: z.int().min(1),
  /** The audience a workflow asks GitHub for. */
  audience: z.string(),
});
export type GitHubTrustRuleList = z.infer<typeof GitHubTrustRuleList>;

/** `POST /api/v1/github/token`: no credentials. */
export const GitHubTokenExchange = z.strictObject({
  workspace: z.string().min(1).max(64),
  token: z.string().min(1).max(GITHUB_TRUST.tokenMaxLength),
});
export type GitHubTokenExchange = z.infer<typeof GitHubTokenExchange>;

export const GitHubTokenExchanged = z.object({
  token: z.string().regex(SERVICE_TOKEN_SECRET),
  expiresAt: z.iso.datetime(),
  workspace: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(GitHubTrustScope),
});
export type GitHubTokenExchanged = z.infer<typeof GitHubTokenExchanged>;

/** The one refusal of the exchange, whatever the reason (decision 0024). */
export const GITHUB_EXCHANGE_REFUSED = "This GitHub token was not accepted for the workspace.";

/**
 * The audience a workflow asks GitHub for: names this deployment (its app origin) and the
 * workspace, so a token minted for another service, deployment or workspace never matches.
 */
export function githubAudience(appOrigin: string, workspaceSlug: string): string {
  return `${appOrigin}/workspaces/${workspaceSlug}/github`;
}

/** The publish key namespace of a repository's credentials. */
export function githubKeyPrefix(repositoryId: string): string {
  return `gh-${repositoryId}/`;
}
