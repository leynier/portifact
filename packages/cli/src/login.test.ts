import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatUserCode, LOGIN_SCOPES } from "./commands.ts";
import { CREDENTIALS_FILE, KEYRING_SERVICE } from "./credentials.ts";
import { type FakeServer, startFakeServer, USER_CODE } from "./testing/fake-server.ts";
import { createHarness, FakeSecrets, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let harnesses: Harness[] = [];

beforeEach(async () => {
  server = await startFakeServer();
});

afterEach(async () => {
  await Promise.all(harnesses.map((h) => h.cleanup()));
  harnesses = [];
  await server.close();
});

async function harness(options: Partial<Parameters<typeof createHarness>[0]> = {}) {
  const h = await createHarness({ server, ...options });
  harnesses.push(h);
  return h;
}

/** No issued token, and not the device code, may appear in anything the CLI prints. */
function expectNoSecrets(output: { stdout: string; stderr: string }) {
  const printed = output.stdout + output.stderr;
  for (const token of server.issuedTokens) expect(printed).not.toContain(token);
  expect(printed).not.toContain("device-code-not-for-display");
}

function storedKeyring(h: Harness): Record<string, unknown> | undefined {
  const value = h.secrets?.entries.get(`${KEYRING_SERVICE}\u0000${server.origin}`);
  return value === undefined ? undefined : JSON.parse(value);
}

describe("portifact login", () => {
  it("signs in with the device flow and stores the tokens in the OS credential store", async () => {
    const h = await harness();
    server.pollOutcomes = ["pending", "approve"];

    const result = await h.invoke("login");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Signed in to ${server.origin} as user user-123.\n`);
    expect(result.stderr).toContain(`  ${server.origin}/device\n`);
    expect(result.stderr).toContain("confirm that it shows this code: WDJB-MJHT");
    expect(result.stderr).toContain("The code expires in 10 minutes.");
    expect(result.stderr).not.toContain("Warning");
    expectNoSecrets(result);

    const codeRequest = server.requests.find((r) => r.path === "/api/auth/device/code");
    expect(codeRequest?.form).toEqual({
      client_id: "portifact-cli",
      scope: LOGIN_SCOPES.join(" "),
      resource: `${server.origin}/api/v1`,
    });
    expect(LOGIN_SCOPES).toContain("offline_access");
    expect(LOGIN_SCOPES).toContain("artifacts:write");

    const stored = storedKeyring(h);
    expect(stored).toMatchObject({
      accessToken: server.issuedTokens[0],
      refreshToken: server.issuedTokens[1],
      expiresAt: Date.parse("2026-11-08T12:00:10Z") + 3_600_000,
    });
    expect(server.requests.at(-1)?.authorization).toBe(`Bearer ${server.issuedTokens[0]}`);
  });

  it("prints a stable JSON result with --json and keeps instructions on stderr", async () => {
    const h = await harness();
    server.pollOutcomes = ["approve"];

    const result = await h.invoke("login", "--json");

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      server: server.origin,
      userId: "user-123",
      clientId: "portifact-cli",
      scopes: LOGIN_SCOPES,
      credentialStore: "keyring",
    });
    expect(result.stderr).toContain(USER_CODE.slice(0, 4));
    expectNoSecrets(result);
  });

  it("polls at the server's interval and waits five seconds longer after each slow_down", async () => {
    const h = await harness();
    server.device.interval = 2;
    server.pollOutcomes = ["pending", "slow_down", "pending", "slow_down", "approve"];

    const result = await h.invoke("login");

    expect(result.code).toBe(0);
    expect(h.sleeps).toEqual([2000, 2000, 7000, 7000, 12000]);
  });

  it("uses the RFC 8628 default interval when the server omits one", async () => {
    const h = await harness();
    server.device.interval = undefined;
    server.pollOutcomes = ["approve"];

    expect((await h.invoke("login")).code).toBe(0);
    expect(h.sleeps).toEqual([5000]);
  });

  it("keeps polling through temporary server failures", async () => {
    const h = await harness();
    server.pollOutcomes = ["server_error", "server_error", "approve"];

    expect((await h.invoke("login")).code).toBe(0);
    expect(h.sleeps).toHaveLength(3);
  });

  it("keeps polling when a poll cannot reach the server", async () => {
    const h = await harness();
    server.pollOutcomes = ["approve"];
    let failed = false;
    h.runtime.fetch = async (input, init) => {
      if (!failed && String(input).endsWith("/oauth2/token")) {
        failed = true;
        throw new TypeError("fetch failed");
      }
      return fetch(input, init);
    };

    expect((await h.invoke("login")).code).toBe(0);
    expect(h.sleeps).toHaveLength(2);
  });

  it("exits 4 and stores nothing when the user denies the request", async () => {
    const h = await harness();
    server.pollOutcomes = ["pending", "denied"];

    const result = await h.invoke("login", "--json");

    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: "authorization_denied",
        message: "The login request was denied. Run `portifact login` to try again.",
      },
    });
    expect(h.secrets?.entries.size).toBe(0);
  });

  it("exits 4 when the server reports the code expired", async () => {
    const h = await harness();
    server.pollOutcomes = ["pending", "expired"];

    const result = await h.invoke("login");

    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error: The login code expired before it was approved.");
    expect(h.secrets?.entries.size).toBe(0);
  });

  it("stops polling once the code's lifetime has passed, without waiting for the server", async () => {
    const h = await harness();
    server.device.expiresIn = 12;

    const result = await h.invoke("login");

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("The code expires in 1 minute.");
    const polls = server.requests.filter((r) => r.path === "/api/auth/oauth2/token");
    expect(polls).toHaveLength(2);
  });

  it("opens the complete verification URL in a browser when a person is at the terminal", async () => {
    const h = await harness({ interactive: true });
    server.pollOutcomes = ["approve"];

    const result = await h.invoke("login");

    expect(h.opened).toEqual([`${server.origin}/device?user_code=${USER_CODE}`]);
    expect(result.stderr).toContain("Opened the page in your browser.");
  });

  it("opens the plain verification URL when the server sends no complete one", async () => {
    const h = await harness({ interactive: true, browserOpens: false });
    server.device.verificationUriComplete = null;
    server.pollOutcomes = ["approve"];

    const result = await h.invoke("login");

    expect(h.opened).toEqual([`${server.origin}/device`]);
    expect(result.stderr).not.toContain("Opened the page");
  });

  it("does not open a browser with --no-browser or when not interactive", async () => {
    const interactive = await harness({ interactive: true });
    server.pollOutcomes = ["approve"];
    await interactive.invoke("login", "--no-browser");
    expect(interactive.opened).toEqual([]);

    const scripted = await harness({ interactive: false });
    server.pollOutcomes = ["approve"];
    expect((await scripted.invoke("login")).code).toBe(0);
    expect(scripted.opened).toEqual([]);
  });

  it("refuses a verification page on another origin and never opens it", async () => {
    const h = await harness({ interactive: true });
    server.device.verificationUriComplete = "https://evil.example/device?user_code=X";

    const result = await h.invoke("login");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sent a response the CLI did not expect");
    expect(h.opened).toEqual([]);
    expect(server.requests.some((r) => r.path === "/api/auth/oauth2/token")).toBe(false);
  });

  it("refuses a verification page that is not a URL", async () => {
    const h = await harness();
    server.device.verificationUri = "not a url";

    expect((await h.invoke("login")).code).toBe(1);
  });

  it("fails with exit 1 on a device poll error it does not know", async () => {
    const h = await harness();
    server.pollOutcomes = ["pending", "invalid_client"];

    const result = await h.invoke("login", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("server_error");
  });

  it("fails with exit 1 when the device code response is not valid JSON or misses fields", async () => {
    const h = await harness();
    for (const body of ["<html>", JSON.stringify({ device_code: "x" })]) {
      server.device.body = body;
      const result = await h.invoke("login", "--json");
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("server_error");
    }
  });

  it("fails with exit 1 when the server refuses the device code request", async () => {
    const h = await harness();
    server.device.status = 400;

    const result = await h.invoke("login", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("server_error");
  });

  it("reports rate limiting on the device code request", async () => {
    const h = await harness();
    server.device.status = 429;

    const result = await h.invoke("login", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("rate_limited");
  });

  it("fails with a network error when the server cannot be reached", async () => {
    const h = await harness({ env: { PORTIFACT_APP_ORIGIN: "http://127.0.0.1:9" } });

    const result = await h.invoke("login", "--json");

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: "network_error",
        message: "Could not reach http://127.0.0.1:9. Check your connection and try again.",
      },
    });
  });

  it("revokes the refresh token of an earlier login on the same device", async () => {
    const h = await harness();
    server.pollOutcomes = ["approve"];
    await h.invoke("login");
    const firstRefresh = server.issuedTokens[1];

    server.pollOutcomes = ["approve"];
    expect((await h.invoke("login")).code).toBe(0);

    expect(server.revokedTokens()).toEqual([firstRefresh]);
    expect(storedKeyring(h)?.refreshToken).toBe(server.issuedTokens[3]);
  });

  it("announces a server override on stderr", async () => {
    const h = await harness();
    server.pollOutcomes = ["approve"];

    const result = await h.invoke("login");

    expect(result.stderr.split("\n")[0]).toBe(`Using the Portifact server at ${server.origin}.`);
  });
});

describe("formatUserCode", () => {
  it("splits an 8-character code in two groups and leaves other codes as they are", () => {
    expect(formatUserCode("WDJBMJHT")).toBe("WDJB-MJHT");
    expect(formatUserCode("WDJB-MJHT")).toBe("WDJB-MJHT");
    expect(formatUserCode("ABC123")).toBe("ABC123");
  });
});

describe("credential storage without an OS credential store", () => {
  for (const [label, secrets] of [
    ["the runtime has none", undefined],
    ["the store fails", new FakeSecrets(false)],
  ] as const) {
    it(`saves to a 0600 file with a warning when ${label}`, async () => {
      const h = await harness({ secrets });
      server.pollOutcomes = ["approve"];

      const result = await h.invoke("login");

      const file = join(h.configDir, CREDENTIALS_FILE);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        `Warning: no system credential store is available, so your credentials are saved in ${file}, readable only by your user account.`,
      );
      expectNoSecrets(result);
      if (process.platform !== "win32") {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(h.configDir)).mode & 0o777).toBe(0o700);
      }

      const whoami = await h.invoke("whoami", "--json");
      expect(whoami.code).toBe(0);
      expect(JSON.parse(whoami.stdout).userId).toBe("user-123");
    });
  }

  it("prints the warning on --json too, on stderr only", async () => {
    const h = await harness({ secrets: undefined });
    server.pollOutcomes = ["approve"];

    const result = await h.invoke("login", "--json");

    expect(JSON.parse(result.stdout).credentialStore).toBe("file");
    expect(result.stderr).toContain("Warning:");
  });
});
