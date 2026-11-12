// GitHub Actions OIDC in the CLI (decision 0024): with PORTIFACT_GITHUB_OIDC naming a workspace
// and the runner's ID token request variables, the CLI asks for an ID token with the workspace's
// audience, exchanges it and keeps the credential in memory only; never without the variable,
// never over PORTIFACT_TOKEN, never written, printed or passed to a child.
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnvironment } from "./child-env.ts";
import { forgetGitHubCredentials } from "./github-oidc.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

// Built at run time so nothing committed matches the secret scanner's rule for the prefix.
const secret = (fill: string) => ["pf", "st_", fill.repeat(43)].join("").slice(0, 48);
const FIRST = secret("A");
const SECOND = secret("B");
const STATIC = secret("S");
const REQUEST = "runner-request-token";

let server: FakeServer;
let h: Harness;

function runnerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ACTIONS_ID_TOKEN_REQUEST_URL: `${server.origin}/github/id-token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST,
    GITHUB_REPOSITORY_ID: "123",
    GITHUB_REPOSITORY_OWNER_ID: "45",
    ...extra,
  };
}

beforeEach(async () => {
  forgetGitHubCredentials();
  server = await startFakeServer();
  server.api.workspaces = [{ slug: "acme", name: "Acme Docs", role: "editor" }];
  server.github.requestToken = REQUEST;
  server.github.secrets = [FIRST, SECOND];
  for (const token of [FIRST, SECOND, STATIC]) {
    server.serviceTokens.set(token, {
      workspace: "acme",
      scopes: ["artifacts:read", "artifacts:write"],
    });
  }
});

afterEach(async () => {
  await h?.cleanup();
  await server.close();
});

function expectNoSecret(result: { stdout: string; stderr: string }) {
  for (const value of [FIRST, SECOND, REQUEST]) {
    expect(result.stdout).not.toContain(value);
    expect(result.stderr).not.toContain(value);
  }
}

describe("PORTIFACT_GITHUB_OIDC", () => {
  it("exchanges the run's ID token for the workspace's audience and publishes with it", async () => {
    h = await createHarness({ server, env: runnerEnv({ PORTIFACT_GITHUB_OIDC: "acme" }) });
    const folder = await h.files("site", { "index.html": "<h1>Preview</h1>" });
    const published = await h.invoke("publish", folder, "--key", "gh-123/pr-7", "--json");
    expect(published.code, published.stderr).toBe(0);
    expectNoSecret(published);
    expect(server.github.audiences).toEqual([`${server.origin}/workspaces/acme/github`]);
    expect(server.github.exchanges).toHaveLength(1);
    // The whole publish used the one credential: one exchange, every request with it.
    const api = server.requests.filter(
      (r) => r.path.startsWith("/api/v1/") && r.path !== "/api/v1/github/token",
    );
    expect(api.length).toBeGreaterThan(1);
    expect(api.every((r) => r.authorization === `Bearer ${FIRST}`)).toBe(true);
    // Nothing stored: no login, no file.
    expect(h.secrets?.entries.size).toBe(0);
    expect(await readdir(h.configDir).catch(() => [])).toEqual([]);
  });

  it("exchanges again once when the credential is refused, as after it expired", async () => {
    h = await createHarness({ server, env: runnerEnv({ PORTIFACT_GITHUB_OIDC: "acme" }) });
    server.serviceTokens.delete(FIRST);
    const listed = await h.invoke("list", "--json");
    expect(listed.code, listed.stderr).toBe(0);
    expect(server.github.exchanges).toHaveLength(2);
  });

  it("does nothing without the variable, even when the job can mint ID tokens", async () => {
    h = await createHarness({ server, env: runnerEnv() });
    const listed = await h.invoke("list", "--json");
    expect(listed.code).not.toBe(0);
    expect(server.github.audiences).toEqual([]);
    expect(server.github.exchanges).toEqual([]);
  });

  it("leaves PORTIFACT_TOKEN in charge when both are set", async () => {
    h = await createHarness({
      server,
      env: runnerEnv({ PORTIFACT_GITHUB_OIDC: "acme", PORTIFACT_TOKEN: STATIC }),
    });
    expect((await h.invoke("list", "--json")).code).toBe(0);
    expect(server.github.audiences).toEqual([]);
  });

  it("says how to fix a job without id-token: write", async () => {
    h = await createHarness({ server, env: { PORTIFACT_GITHUB_OIDC: "acme" } });
    const result = await h.invoke("list");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("id-token: write");
  });

  it("names the repository's IDs when the workspace refuses the run", async () => {
    h = await createHarness({ server, env: runnerEnv({ PORTIFACT_GITHUB_OIDC: "acme" }) });
    server.github.exchangeRefusal = {
      status: 401,
      body: {
        error: {
          code: "unauthenticated",
          message: "This GitHub token was not accepted for the workspace.",
        },
      },
    };
    const result = await h.invoke("list");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("repository ID 123 and owner ID 45");
    expectNoSecret(result);
  });

  it("refuses a variable that is not a workspace slug", async () => {
    h = await createHarness({ server, env: runnerEnv({ PORTIFACT_GITHUB_OIDC: "Not A Slug!" }) });
    const result = await h.invoke("list");
    expect(result.code).not.toBe(0);
    expect(server.github.audiences).toEqual([]);
  });

  it("is withheld from child processes", () => {
    expect(
      childEnvironment({
        PATH: "/usr/bin",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/id",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST,
        PORTIFACT_GITHUB_OIDC: "acme",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});
