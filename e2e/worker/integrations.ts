// The e2e stack's GitHub, Linear and Jira (decision 0018): the fake APIs of
// @portifact/services/testing, in memory, behind the app Worker's `integrationFetch` and the jobs
// run by the control route. Nothing leaves the machine. The tokens are made-up test values.
import { FakeIssueTrackers, FakeSlack } from "@portifact/services/testing";

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

/**
 * A Slack app the fake Slack knows (decision 0025): its bot token, in Slack's shape but assembled
 * here so no committed literal looks like a real token, and its signing secret. Not secrets.
 */
export const E2E_SLACK = {
  botToken: ["xoxb", "e2e", "fake", "slack", "bot", "0123456789"].join("-"),
  signingSecret: "e2e0".repeat(8),
  team: "E2E Slack",
  teamId: "T0E2E0001",
} as const;

export const e2eSlack = new FakeSlack().bot(E2E_SLACK.botToken, E2E_SLACK.team, E2E_SLACK.teamId);

/** The app Worker's one network for integrations: Slack's Web API to the fake Slack, the rest to the trackers. */
export function e2eIntegrationFetch(url: string, init: RequestInit): Promise<Response> {
  return new URL(url).origin === "https://slack.com"
    ? e2eSlack.fetch(url, init)
    : e2eTrackers.fetch(url, init);
}
