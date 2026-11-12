// The e2e stack's GitHub, Linear and Jira (decision 0018): the fake APIs of
// @portifact/services/testing, in memory, behind the app Worker's `integrationFetch` and the jobs
// run by the control route. Nothing leaves the machine. The tokens are made-up test values.
import { FakeIssueTrackers } from "@portifact/services/testing";

/** A GitHub token the fake accepts, acting as `e2e-bot` on `acme/site`. Not a secret. */
export const E2E_GITHUB_TOKEN = "github_pat_e2e_fake_token_0123456789abcdef";

/** A Jira site, cloud ID, account and API token the fake gateway accepts. Not secrets. */
export const E2E_JIRA = {
  site: "acme-e2e",
  cloudId: "0e2e0e2e-5566-4778-899a-abbccddeeff0",
  account: "e2e-jira-bot@example.test",
  token: "ATATT3x-e2e-fake-jira-token-0123456789",
} as const;

export const e2eTrackers = new FakeIssueTrackers()
  .github(E2E_GITHUB_TOKEN, "e2e-bot", ["acme/site"])
  .jiraSite({ site: E2E_JIRA.site, cloudId: E2E_JIRA.cloudId })
  .jira(E2E_JIRA.account, E2E_JIRA.token, {
    displayName: "E2E Jira Bot",
    cloudId: E2E_JIRA.cloudId,
    projects: [{ key: "ENG", name: "Engineering" }],
  });
