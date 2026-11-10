// The e2e stack's GitHub and Linear (decision 0018): the fake APIs of
// @portifact/services/testing, in memory, behind the app Worker's `integrationFetch` and the jobs
// run by the control route. Nothing leaves the machine. The tokens are made-up test values.
import { FakeIssueTrackers } from "@portifact/services/testing";

/** A GitHub token the fake accepts, acting as `e2e-bot` on `acme/site`. Not a secret. */
export const E2E_GITHUB_TOKEN = "github_pat_e2e_fake_token_0123456789abcdef";

export const e2eTrackers = new FakeIssueTrackers().github(E2E_GITHUB_TOKEN, "e2e-bot", [
  "acme/site",
]);
