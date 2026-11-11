// Rules of GitHub Actions OIDC federation (decision 0024). Pure: the app verifies the token's
// signature and times, the services read and write rows, and these functions decide what a
// verified token's claims are worth against a workspace's trust rule.
import {
  GITHUB_PRIVILEGED_EVENTS,
  GITHUB_TRUST_EVENTS,
  GITHUB_TRUST_SCOPES,
  type GitHubTrustEvent,
  type GitHubTrustScope,
  SERVICE_TOKENS,
} from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

const NUMERIC = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/** The claims a rule is checked against, read from a token whose signature and times passed. */
export interface GitHubClaims {
  jti: string;
  repositoryId: string;
  repositoryOwnerId: string;
  /** The `owner/name` GitHub put in the token: shown and logged for people, never compared. */
  repository: string;
  eventName: string;
  ref: string;
  /** Absent when the job uses no environment. */
  environment: string | null;
  runId: string;
  runAttempt: number;
}

/**
 * Why an exchange was refused. Logged as this enum only; the caller always gets one answer
 * (decision 0024, "The exchange").
 */
export type GitHubRefusal =
  | "rate_limited"
  | "malformed"
  | "signature"
  | "jwks_unavailable"
  | "claims"
  | "no_workspace"
  | "no_rule"
  | "owner"
  | "event"
  | "ref"
  | "environment"
  | "plan"
  | "replayed";

/** The rule as checked: what the admin trusted. */
export interface GitHubTrustRuleCheck {
  repositoryId: string;
  repositoryOwnerId: string;
  events: readonly GitHubTrustEvent[];
  ref: string | null;
  environment: string | null;
}

const text = (value: unknown, max = 255): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

/**
 * Reads the claims a rule needs from a verified payload; null when one is missing or has
 * another shape than GitHub gives (`repository_id` and the run's numbers are decimal strings).
 */
export function githubClaims(payload: Record<string, unknown>): GitHubClaims | null {
  const jti = text(payload.jti, 200);
  const repositoryId = text(payload.repository_id, 20);
  const repositoryOwnerId = text(payload.repository_owner_id, 20);
  const repository = text(payload.repository, 140);
  const eventName = text(payload.event_name, 64);
  const ref = text(payload.ref);
  const runId = text(payload.run_id, 20);
  const runAttempt = text(payload.run_attempt, 4);
  const environment = payload.environment === undefined ? null : text(payload.environment);
  if (
    !jti ||
    !repositoryId ||
    !NUMERIC.test(repositoryId) ||
    !repositoryOwnerId ||
    !NUMERIC.test(repositoryOwnerId) ||
    !repository ||
    !REPOSITORY.test(repository) ||
    !eventName ||
    !ref ||
    !runId ||
    !NUMERIC.test(runId) ||
    !runAttempt ||
    !NUMERIC.test(runAttempt) ||
    (payload.environment !== undefined && environment === null)
  ) {
    return null;
  }
  return {
    jti,
    repositoryId,
    repositoryOwnerId,
    repository,
    eventName,
    ref,
    environment,
    runId,
    runAttempt: Number(runAttempt),
  };
}

/**
 * Whether a rule admits the claims. The rule was found by the token's `repository_id`; this
 * checks the ID again (a rule is never matched by name), then the owner's ID (a repository
 * transferred to another owner stops until the admin updates the rule), the event, and the ref
 * and environment when the rule sets them, exactly.
 */
export function githubClaimsVerdict(
  claims: GitHubClaims,
  rule: GitHubTrustRuleCheck,
): GitHubVerdict {
  if (claims.repositoryId !== rule.repositoryId) return { ok: false, reason: "no_rule" };
  if (claims.repositoryOwnerId !== rule.repositoryOwnerId) return { ok: false, reason: "owner" };
  if (!(rule.events as readonly string[]).includes(claims.eventName)) {
    return { ok: false, reason: "event" };
  }
  if (rule.ref !== null && claims.ref !== rule.ref) return { ok: false, reason: "ref" };
  if (rule.environment !== null && claims.environment !== rule.environment) {
    return { ok: false, reason: "environment" };
  }
  return { ok: true };
}

export type GitHubVerdict = { ok: true } | { ok: false; reason: GitHubRefusal };

/** Saving a rule that trusts a privileged event needs the admin's confirmation. */
export function checkGitHubTrustRule(input: {
  events: readonly GitHubTrustEvent[];
  privilegedConfirmed: boolean;
}): Result<void> {
  const privileged = input.events.some((event) => GITHUB_PRIVILEGED_EVENTS.includes(event));
  if (privileged && !input.privilegedConfirmed) {
    return fail(
      "invalid_input",
      "Trusting pull_request_target or workflow_run lets runs started by a fork's pull request publish. Confirm it to save.",
    );
  }
  return ok(undefined);
}

/** The label of a credential: the repository and the run, cut to a token label's length. */
export function githubCredentialLabel(repository: string, runId: string): string {
  return `GitHub ${repository} run ${runId}`.slice(0, SERVICE_TOKENS.labelMaxLength);
}

/** Events as stored (space-separated, in catalog order); an unknown one is dropped. */
export function storedGitHubEvents(stored: string): GitHubTrustEvent[] {
  const set = new Set(stored.split(" "));
  return GITHUB_TRUST_EVENTS.filter((event) => set.has(event));
}

/** Scopes as stored; an unknown one is dropped, so a stored `artifacts:share` gives nothing. */
export function storedGitHubScopes(stored: string): GitHubTrustScope[] {
  const set = new Set(stored.split(" "));
  return GITHUB_TRUST_SCOPES.filter((scope) => set.has(scope));
}

/** Events or scopes for storage: catalog order, space-separated. */
export function githubSetText<T extends string>(
  catalog: readonly T[],
  values: readonly T[],
): string {
  const set = new Set(values);
  return catalog.filter((value) => set.has(value)).join(" ");
}
