// The fake GitHub Actions OIDC issuer of the e2e stack (decision 0024): the app Worker fetches
// its key set instead of GitHub's, so nothing leaves the machine. Never a real GitHub.
import { FakeGitHubIssuer } from "@portifact/services/testing";

export const e2eGitHubIssuer = new FakeGitHubIssuer();
