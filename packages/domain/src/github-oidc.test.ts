import { describe, expect, it } from "vitest";
import {
  checkGitHubTrustRule,
  type GitHubClaims,
  type GitHubTrustRuleCheck,
  githubClaims,
  githubClaimsVerdict,
  githubCredentialLabel,
  githubSetText,
  storedGitHubEvents,
  storedGitHubScopes,
} from "./github-oidc.ts";

const PAYLOAD = {
  jti: "4a1c-jti",
  repository_id: "123456",
  repository_owner_id: "777",
  repository: "acme/site",
  event_name: "pull_request",
  ref: "refs/pull/7/merge",
  run_id: "9001",
  run_attempt: "2",
};

const RULE: GitHubTrustRuleCheck = {
  repositoryId: "123456",
  repositoryOwnerId: "777",
  events: ["pull_request", "push"],
  ref: null,
  environment: null,
};

const claims = (over: Partial<GitHubClaims> = {}): GitHubClaims => ({
  ...(githubClaims(PAYLOAD) as GitHubClaims),
  ...over,
});

describe("githubClaims", () => {
  it("reads the claims a rule needs", () => {
    expect(githubClaims({ ...PAYLOAD, environment: "preview" })).toEqual({
      jti: "4a1c-jti",
      repositoryId: "123456",
      repositoryOwnerId: "777",
      repository: "acme/site",
      eventName: "pull_request",
      ref: "refs/pull/7/merge",
      environment: "preview",
      runId: "9001",
      runAttempt: 2,
    });
    expect(githubClaims(PAYLOAD)?.environment).toBeNull();
  });

  it.each([
    ["jti", undefined],
    ["repository_id", undefined],
    ["repository_owner_id", undefined],
    ["repository", undefined],
    ["event_name", undefined],
    ["ref", undefined],
    ["run_id", undefined],
    ["run_attempt", undefined],
    ["repository_id", 123456],
    ["repository_id", "0123"],
    ["repository_id", "12a"],
    ["repository_owner_id", "-1"],
    ["repository", "acme"],
    ["repository", "acme/.."],
    ["run_id", "abc"],
    ["run_attempt", "0"],
    ["environment", ""],
    ["environment", 7],
    ["jti", ""],
  ])("refuses %s = %j", (field, value) => {
    const payload: Record<string, unknown> = { ...PAYLOAD, [field]: value };
    if (value === undefined) delete payload[field];
    expect(githubClaims(payload)).toBeNull();
  });
});

describe("githubClaimsVerdict", () => {
  it.each<[string, GitHubClaims, GitHubTrustRuleCheck, string | null]>([
    ["the rule's repository and event", claims(), RULE, null],
    ["a push", claims({ eventName: "push", ref: "refs/heads/main" }), RULE, null],
    // Bound to IDs: the same name with another ID is another repository.
    ["the same name with another ID", claims({ repositoryId: "999" }), RULE, "no_rule"],
    // A renamed repository keeps its ID and is still trusted, whatever its name now.
    ["a renamed repository with the same ID", claims({ repository: "acme/renamed" }), RULE, null],
    // A repository transferred to another owner keeps its ID but not its owner's.
    ["another owner", claims({ repositoryOwnerId: "778" }), RULE, "owner"],
    ["an event the rule does not trust", claims({ eventName: "workflow_dispatch" }), RULE, "event"],
    [
      "pull_request_target, a privileged run a fork can start",
      claims({ eventName: "pull_request_target" }),
      RULE,
      "event",
    ],
    ["a ref other than the rule's", claims(), { ...RULE, ref: "refs/heads/main" }, "ref"],
    [
      "the rule's ref",
      claims({ eventName: "push", ref: "refs/heads/main" }),
      { ...RULE, ref: "refs/heads/main" },
      null,
    ],
    [
      "no environment when one is required",
      claims(),
      { ...RULE, environment: "preview" },
      "environment",
    ],
    [
      "another environment",
      claims({ environment: "production" }),
      { ...RULE, environment: "preview" },
      "environment",
    ],
    [
      "the rule's environment",
      claims({ environment: "preview" }),
      { ...RULE, environment: "preview" },
      null,
    ],
    // Exact, not a prefix or a case-insensitive match.
    [
      "a ref prefix",
      claims({ ref: "refs/heads/main-2" }),
      { ...RULE, ref: "refs/heads/main" },
      "ref",
    ],
    [
      "an environment in another case",
      claims({ environment: "Preview" }),
      { ...RULE, environment: "preview" },
      "environment",
    ],
  ])("%s", (_name, given, rule, refusal) => {
    const verdict = githubClaimsVerdict(given, rule);
    expect(verdict.ok ? null : verdict.reason).toBe(refusal);
  });
});

describe("checkGitHubTrustRule", () => {
  it.each([
    [["pull_request", "push"], false, true],
    [["pull_request_target"], false, false],
    [["workflow_run", "push"], false, false],
    [["pull_request_target"], true, true],
  ] as const)("events %j confirmed %s: allowed %s", (events, privilegedConfirmed, allowed) => {
    expect(checkGitHubTrustRule({ events, privilegedConfirmed }).ok).toBe(allowed);
  });
});

describe("stored sets", () => {
  it("keeps catalog order and drops unknown values", () => {
    expect(githubSetText(["push", "pull_request"] as const, ["pull_request", "push"])).toBe(
      "push pull_request",
    );
    expect(storedGitHubEvents("pull_request bogus push")).toEqual(["push", "pull_request"]);
    // A scope a rule may never give is never read back from storage.
    expect(storedGitHubScopes("artifacts:share artifacts:write")).toEqual(["artifacts:write"]);
  });

  it("labels a credential by repository and run within a token label's length", () => {
    expect(githubCredentialLabel("acme/site", "9001")).toBe("GitHub acme/site run 9001");
    expect(githubCredentialLabel(`acme/${"r".repeat(100)}`, "9001")).toHaveLength(80);
  });
});
