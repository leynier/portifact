import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Credentials, KEYRING_SERVICE } from "./credentials.ts";
import { credentialsFrom } from "./session.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const NOW = Date.parse("2026-11-08T12:00:00Z");
const key = () => `${KEYRING_SERVICE}\u0000${server.origin}`;

function store(credentials: Credentials) {
  h.secrets?.entries.set(key(), JSON.stringify(credentials));
}

function stored(): Credentials | undefined {
  const value = h.secrets?.entries.get(key());
  return value === undefined ? undefined : JSON.parse(value);
}

/** A login that happened before the test, with an access token valid for an hour. */
function signedIn(overrides: Partial<Credentials> = {}) {
  const pair = server.issue();
  const credentials: Credentials = {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresAt: NOW + 3_600_000,
    scopes: ["artifacts:read", "offline_access"],
    ...overrides,
  };
  store(credentials);
  return { ...pair, credentials };
}

function expectNoSecrets(output: { stdout: string; stderr: string }) {
  for (const token of server.issuedTokens) {
    expect(output.stdout + output.stderr).not.toContain(token);
  }
}

describe("portifact whoami", () => {
  it("shows the account behind the stored token", async () => {
    signedIn();

    const result = await h.invoke("whoami");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        `Signed in to ${server.origin}`,
        "User: user-123",
        "Client: portifact-cli",
        "Scopes: artifacts:read, offline_access",
        "",
      ].join("\n"),
    );
    expect(server.requests.filter((r) => r.path === "/api/auth/oauth2/token")).toHaveLength(0);
  });

  it("prints a stable JSON result with --json", async () => {
    signedIn();

    const result = await h.invoke("whoami", "--json");

    expect(JSON.parse(result.stdout)).toEqual({
      server: server.origin,
      userId: "user-123",
      clientId: "portifact-cli",
      scopes: ["artifacts:read", "offline_access"],
    });
    expectNoSecrets(result);
  });

  it("says when the token has no scopes", async () => {
    signedIn();
    const pair = server.issue([]);
    store({ accessToken: pair.accessToken, expiresAt: NOW + 3_600_000, scopes: [] });

    expect((await h.invoke("whoami")).stdout).toContain("Scopes: none");
  });

  it("exits 3 with a JSON error when not signed in", async () => {
    const result = await h.invoke("whoami", "--json");

    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: "unauthenticated",
        message: `Not signed in to ${server.origin}. Run \`portifact login\` to sign in.`,
      },
    });
    expect(server.requests).toHaveLength(0);
  });

  it("refreshes an access token about to expire and stores the rotated pair", async () => {
    const { refreshToken } = signedIn({ expiresAt: NOW + 30_000 });

    const result = await h.invoke("whoami");

    expect(result.code).toBe(0);
    const refresh = server.requests.find((r) => r.form.grant_type === "refresh_token");
    expect(refresh?.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "portifact-cli",
    });
    const latest = server.issuedTokens.slice(-2);
    expect(stored()).toEqual({
      accessToken: latest[0],
      refreshToken: latest[1],
      expiresAt: NOW + 3_600_000,
      scopes: ["artifacts:read", "offline_access"],
    });
    expect(server.requests.at(-1)?.authorization).toBe(`Bearer ${latest[0]}`);
    expectNoSecrets(result);
  });

  it("keeps the refresh token when the server does not rotate it", async () => {
    const { refreshToken } = signedIn({ expiresAt: NOW - 1 });
    server.rotateRefreshTokens = false;

    expect((await h.invoke("whoami")).code).toBe(0);
    expect(stored()?.refreshToken).toBe(refreshToken);
    expect(stored()?.accessToken).toBe(server.issuedTokens.at(-2));
  });

  it("refreshes once and retries when the API rejects a token it thought valid", async () => {
    const { accessToken } = signedIn();
    const entry = server.accessTokens.get(accessToken);
    if (entry) entry.revoked = true;

    const result = await h.invoke("whoami");

    expect(result.code).toBe(0);
    expect(server.requests.filter((r) => r.path === "/api/v1/me")).toHaveLength(2);
  });

  it("exits 3 and removes the credentials when the refresh token was revoked", async () => {
    const { refreshToken } = signedIn({ expiresAt: NOW - 1 });
    server.refreshTokens.delete(refreshToken);

    const result = await h.invoke("whoami", "--json");

    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "unauthenticated",
      message: `Your session on ${server.origin} has expired or was revoked. Run \`portifact login\` to sign in again.`,
    });
    expect(stored()).toBeUndefined();
  });

  it("uses credentials another process refreshed meanwhile instead of signing out", async () => {
    const { refreshToken } = signedIn({ expiresAt: NOW - 1 });
    // Another portifact process redeemed the refresh token right after this one read it.
    server.refreshTokens.delete(refreshToken);
    const newer = server.issue();
    const secrets = h.secrets;
    if (!secrets) throw new Error("expected a keyring");
    const get = secrets.get.bind(secrets);
    let originReads = 0;
    secrets.get = async (options) => {
      const value = await get(options);
      if (options.name === server.origin && ++originReads === 1) {
        store({
          accessToken: newer.accessToken,
          refreshToken: newer.refreshToken,
          expiresAt: NOW + 3_600_000,
          scopes: ["artifacts:read"],
        });
      }
      return value;
    };

    const result = await h.invoke("whoami");

    expect(result.code).toBe(0);
    expect(stored()?.refreshToken).toBe(newer.refreshToken);
    expect(server.requests.at(-1)?.authorization).toBe(`Bearer ${newer.accessToken}`);
  });

  it("exits 3 when the access token is rejected and there is no refresh token", async () => {
    const pair = server.issue();
    server.accessTokens.delete(pair.accessToken);
    store({ accessToken: pair.accessToken, expiresAt: NOW + 3_600_000, scopes: [] });

    const result = await h.invoke("whoami");

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("has expired or was revoked");
  });

  it("exits 3 when even a freshly refreshed token is rejected", async () => {
    signedIn({ expiresAt: NOW - 1 });
    const realFetch = h.runtime.fetch;
    h.runtime.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      return String(input).endsWith("/api/v1/me") ? new Response(null, { status: 401 }) : response;
    };

    expect((await h.invoke("whoami")).code).toBe(3);
  });

  it("fails with exit 1 when the refresh endpoint is unavailable, keeping the credentials", async () => {
    const { credentials } = signedIn({ expiresAt: NOW - 1 });
    server.refreshStatus = 503;

    const result = await h.invoke("whoami", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("server_error");
    expect(stored()).toEqual(credentials);
  });

  it("fails with exit 1 when the API answers with an unexpected body", async () => {
    signedIn();
    h.runtime.fetch = async () => Response.json({ unexpected: true });

    const result = await h.invoke("whoami", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("server_error");
  });

  it("fails with exit 1 when the API answers with a server error", async () => {
    signedIn();
    h.runtime.fetch = async () => new Response("<html>", { status: 502 });

    expect((await h.invoke("whoami")).code).toBe(1);
  });
});

describe("portifact logout", () => {
  it("revokes both tokens on the server, then removes them from this device", async () => {
    const { accessToken, refreshToken } = signedIn();

    const result = await h.invoke("logout");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Signed out of ${server.origin}. The tokens were revoked and removed from this device.\n`,
    );
    const revocations = server.requests.filter((r) => r.path === "/api/auth/oauth2/revoke");
    expect(revocations.map((r) => r.form)).toEqual([
      { token: refreshToken, token_type_hint: "refresh_token", client_id: "portifact-cli" },
      { token: accessToken, token_type_hint: "access_token", client_id: "portifact-cli" },
    ]);
    expect(stored()).toBeUndefined();
    expectNoSecrets(result);

    expect((await h.invoke("whoami")).code).toBe(3);
  });

  it("revokes only the access token when there is no refresh token", async () => {
    const pair = server.issue();
    store({ accessToken: pair.accessToken, expiresAt: NOW + 3_600_000, scopes: [] });

    const result = await h.invoke("logout", "--json");

    expect(JSON.parse(result.stdout)).toEqual({ server: server.origin, wasSignedIn: true });
    expect(server.revokedTokens()).toEqual([pair.accessToken]);
  });

  it("succeeds without contacting the server when not signed in", async () => {
    const text = await h.invoke("logout");
    expect(text).toEqual({
      code: 0,
      stdout: `Not signed in to ${server.origin}. Nothing to do.\n`,
      stderr: `Using the Portifact server at ${server.origin}.\n`,
    });

    const json = await h.invoke("logout", "--json");
    expect(JSON.parse(json.stdout)).toEqual({ server: server.origin, wasSignedIn: false });
    expect(server.requests).toHaveLength(0);
  });

  it("keeps the credentials and exits 1 when the server cannot revoke them", async () => {
    const { credentials } = signedIn();
    server.revokeStatus = 503;

    const result = await h.invoke("logout", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "network_error",
      message: `Could not revoke your tokens on ${server.origin}, so they were kept on this device. Run \`portifact logout\` again.`,
    });
    expect(stored()).toEqual(credentials);
  });

  it("keeps the credentials when the server cannot be reached", async () => {
    const { credentials } = signedIn();
    h.runtime.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    expect((await h.invoke("logout")).code).toBe(1);
    expect(stored()).toEqual(credentials);
  });

  it("treats a definitive refusal from the server as done", async () => {
    signedIn();
    server.revokeStatus = 401;

    expect((await h.invoke("logout")).code).toBe(0);
    expect(stored()).toBeUndefined();
  });
});

describe("credentialsFrom", () => {
  it("assumes an hour and keeps earlier scopes when the server omits them", () => {
    const previous: Credentials = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
      scopes: ["artifacts:read"],
    };
    expect(credentialsFrom({ access_token: "b", token_type: "Bearer" }, 1000, previous)).toEqual({
      accessToken: "b",
      refreshToken: "r",
      expiresAt: 1000 + 3_600_000,
      scopes: ["artifacts:read"],
    });
    expect(credentialsFrom({ access_token: "c", token_type: "bearer" }, 0)).toEqual({
      accessToken: "c",
      expiresAt: 3_600_000,
      scopes: [],
    });
  });
});
