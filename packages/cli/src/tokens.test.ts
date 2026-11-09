import { CREDENTIALS_SCOPE, OAuthScope } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYRING_SERVICE } from "./credentials.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";
import { parseTokenId } from "./tokens.ts";

let server: FakeServer;
let h: Harness;

const SCOPES = [...OAuthScope.options, CREDENTIALS_SCOPE, "offline_access"];
const MCP = "https://claude.ai/oauth/claude-code-client-metadata";

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  server.otherApps.push({
    clientId: MCP,
    // A registered name is untrusted: it must not reach the terminal as control sequences.
    name: "Claude\u001b[31m Code‮\n",
    firstParty: false,
    resources: ["mcp"],
    scopes: ["artifacts:read", "offline_access"],
    approvedAt: "2026-11-01T10:00:00.000Z",
    lastIssuedAt: "2026-11-08T09:00:00.000Z",
    expiresAt: null,
  });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

function json(output: { stdout: string }) {
  return JSON.parse(output.stdout);
}

function stored(harness: Harness = h): string | undefined {
  return harness.secrets?.entries.get(`${KEYRING_SERVICE}\u0000${server.origin}`);
}

function expectNoTokens(output: { stdout: string; stderr: string }) {
  for (const token of server.issuedTokens) {
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
  }
}

function deletes() {
  return server.requests.filter(
    (r) => r.method === "DELETE" && r.path.startsWith("/api/v1/tokens"),
  );
}

describe("portifact tokens list", () => {
  it("lists every app as a table, marks this CLI and strips control characters from names", async () => {
    h.signIn(SCOPES);
    const result = await h.invoke("tokens", "list");
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+APP\s+USES\s+LAST TOKEN\s+EXPIRES\s+SCOPES$/);
    expect(lines[1]).toMatch(
      /^portifact-cli\s+Portifact CLI \(this CLI\)\s+api\s+2026-11-08 12:00 UTC/,
    );
    expect(lines[1]).toContain("credentials:manage");
    expect(lines[2]).toMatch(
      /^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata\s+Claude\[31m Code\s+mcp\s+2026-11-08 09:00 UTC\s+never\s+artifacts:read offline_access$/,
    );
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u202e");
    expect(lines.at(-1)).toContain("revoking it ends every token it holds for your account");
    expectNoTokens(result);
  });

  it("prints the API's list as JSON with --json", async () => {
    h.signIn(SCOPES);
    const result = await h.invoke("tokens", "list", "--json");
    expect(result.code).toBe(0);
    const body = json(result);
    expect(
      body.items.map((item: { clientId: string; current: boolean }) => [
        item.clientId,
        item.current,
      ]),
    ).toEqual([
      ["portifact-cli", true],
      [MCP, false],
    ]);
    expect(body.items[1]).toEqual({ ...server.otherApps[0], current: false });
    expectNoTokens(result);
  });

  it("asks for a new login when the session predates token management", async () => {
    h.signIn([...OAuthScope.options, "offline_access"]);
    const result = await h.invoke("tokens", "list", "--json");
    expect(result.code).toBe(5);
    expect(json(result)).toEqual({
      error: {
        code: "forbidden",
        message:
          "This device's session does not allow that action. Run `portifact login` to sign in again.",
      },
    });
  });

  it("says so when not signed in", async () => {
    const result = await h.invoke("tokens", "list");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("portifact login");
  });
});

describe("portifact tokens revoke", () => {
  it("refuses to revoke without --yes when no terminal can confirm, before any request", async () => {
    h.signIn(SCOPES);
    const result = await h.invoke("tokens", "revoke", MCP, "--json");
    expect(result.code).toBe(2);
    expect(json(result).error).toEqual({
      code: "invalid_input",
      message: `Revoking disconnects the app on every device. Run \`portifact tokens revoke ${MCP} --yes\` to confirm without a prompt.`,
    });
    expect(server.requests).toEqual([]);
    expect(server.otherApps).toHaveLength(1);
  });

  it("revokes another app with --yes and keeps this device signed in", async () => {
    h.signIn(SCOPES);
    const result = await h.invoke("tokens", "revoke", MCP, "--yes", "--json");
    expect(result.code).toBe(0);
    expect(json(result)).toEqual({
      clientId: MCP,
      revoked: true,
      current: false,
      signedOut: false,
    });
    expect(deletes().map((r) => r.path)).toEqual([`/api/v1/tokens/${encodeURIComponent(MCP)}`]);
    expect(server.otherApps).toEqual([]);
    expect(stored()).toBeDefined();
    expect((await h.invoke("whoami")).code).toBe(0);
  });

  it("asks to type revoke at a terminal, naming the app, and revokes on the answer", async () => {
    const prompted = await createHarness({ server, answers: ["revoke"] });
    prompted.signIn(SCOPES);
    const result = await prompted.invoke("tokens", "revoke", MCP);
    expect(result.code).toBe(0);
    expect(prompted.prompts).toEqual([
      `This revokes every token "Claude[31m Code" (${MCP}) holds for your account, on every device, and its approval.\nType "revoke" to confirm: `,
    ]);
    expect(result.stdout).toBe(
      `Revoked the tokens of ${MCP}. It has to ask for your approval again to reconnect.\n`,
    );
    await prompted.cleanup();
  });

  it("cancels on any other answer and revokes nothing", async () => {
    const prompted = await createHarness({ server, answers: ["yes"] });
    prompted.signIn(SCOPES);
    const result = await prompted.invoke("tokens", "revoke", MCP);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Nothing was revoked: the confirmation was not "revoke".');
    expect(deletes()).toEqual([]);
    expect(server.otherApps).toHaveLength(1);
    await prompted.cleanup();
  });

  it("answers an unknown app as not found, before prompting or with --yes", async () => {
    const prompted = await createHarness({ server, answers: ["revoke"] });
    prompted.signIn(SCOPES);
    const asked = await prompted.invoke("tokens", "revoke", "no-such-app", "--json");
    expect(asked.code).toBe(5);
    expect(json(asked).error.code).toBe("not_found");
    expect(prompted.prompts).toEqual([]);
    expect(deletes()).toEqual([]);
    await prompted.cleanup();

    h.signIn(SCOPES);
    const forced = await h.invoke("tokens", "revoke", "no-such-app", "--yes", "--json");
    expect(forced.code).toBe(5);
    expect(json(forced)).toEqual({
      error: { code: "not_found", message: "No app with that ID is connected to this account." },
    });
  });

  it("revoking this CLI warns first, then signs this device out like logout", async () => {
    const prompted = await createHarness({ server, answers: ["revoke"] });
    prompted.signIn(SCOPES);
    const result = await prompted.invoke("tokens", "revoke", "portifact-cli", "--json");
    expect(result.code).toBe(0);
    expect(prompted.prompts[0]).toContain(
      "That includes this CLI, so you will be signed out here too.",
    );
    expect(json(result)).toEqual({
      clientId: "portifact-cli",
      revoked: true,
      current: true,
      signedOut: true,
    });
    expect(stored(prompted)).toBeUndefined();
    const after = await prompted.invoke("whoami");
    expect(after.code).toBe(3);
    expectNoTokens(result);
    await prompted.cleanup();
  });

  it("prints the sign-out as text when revoking this CLI with --yes", async () => {
    h.signIn(SCOPES);
    const result = await h.invoke("tokens", "revoke", "portifact-cli", "--yes");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `Revoked the CLI's tokens on every device and signed out of ${server.origin} here. Run \`portifact login\` to sign in again.\n`,
    );
    expect(stored()).toBeUndefined();
  });

  it("refuses a malformed ID without a request", async () => {
    h.signIn(SCOPES);
    for (const id of ["has space", "tab\tid", "\u001b[2J", "x".repeat(2049)]) {
      const result = await h.invoke("tokens", "revoke", id, "--yes", "--json");
      expect(result.code, id).toBe(2);
      expect(json(result).error.code).toBe("invalid_input");
      expect(result.stdout).not.toContain("\u001b");
    }
    expect(server.requests).toEqual([]);
  });

  it("keeps the session and revokes nothing when the session predates token management", async () => {
    h.signIn([...OAuthScope.options, "offline_access"]);
    const result = await h.invoke("tokens", "revoke", MCP, "--yes", "--json");
    expect(result.code).toBe(5);
    expect(json(result).error.code).toBe("forbidden");
    expect(server.otherApps).toHaveLength(1);
    expect(stored()).toBeDefined();
  });
});

describe("parseTokenId", () => {
  it("accepts client IDs, including metadata document URLs, as they are", () => {
    expect(parseTokenId("portifact-cli")).toBe("portifact-cli");
    expect(parseTokenId(MCP)).toBe(MCP);
    expect(parseTokenId("x".repeat(2048))).toHaveLength(2048);
    expect(() => parseTokenId("")).toThrow();
    expect(() => parseTokenId("a‮b")).toThrow();
  });
});
