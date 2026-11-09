// /api/v1/tokens: the CLI's view of the account's own tokens (decision 0003). Bearer tokens of
// the API resource with `credentials:manage` only; the dashboard keeps /api/v1/account/apps.
import { describe, expect, it } from "vitest";
import { tokenClient } from "./api-client.ts";
import {
  authorizeWithPkce,
  callMcp,
  exchangeCode,
  registerMcpClient,
  startAuthorization,
  type TokenResponse,
} from "./flows.ts";
import { createHarness, type Harness, json, ORIGIN } from "./harness.ts";

const CREDENTIALS = "artifacts:read credentials:manage offline_access";

interface Grant {
  clientId: string;
  name: string | null;
  firstParty: boolean;
  current: boolean;
  resources: string[];
  scopes: string[];
  approvedAt: string;
  lastIssuedAt: string;
  expiresAt: string | null;
}

function dashboard(cookie: string, method = "GET"): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
    },
  };
}

async function connectMcp(h: Harness, cookie: string) {
  const clientId = await registerMcpClient(h);
  const { code, verifier } = await authorizeWithPkce(h, { clientId, cookie });
  const tokens = await (await exchangeCode(h, { clientId, code, verifier })).json<TokenResponse>();
  return { clientId, token: tokens.access_token };
}

describe("listing the account's tokens", () => {
  it("lists the apps holding live tokens, marks the caller's own and shows no token", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "tokens-list@example.test", CREDENTIALS);
    const mcp = await connectMcp(h, cli.cookie);
    await tokenClient(h, "tokens-list-other@example.test", CREDENTIALS);

    const response = await cli.call("/api/v1/tokens");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain(mcp.token);
    const { items } = JSON.parse(text) as { items: Grant[] };
    expect(items.map((item) => item.clientId).sort()).toEqual(
      ["portifact-cli", mcp.clientId].sort(),
    );
    expect(items.find((item) => item.clientId === "portifact-cli")).toMatchObject({
      name: "Portifact CLI",
      firstParty: true,
      current: true,
      resources: ["api"],
      scopes: expect.arrayContaining(["credentials:manage", "offline_access"]),
    });
    expect(items.find((item) => item.clientId === mcp.clientId)).toMatchObject({
      name: "Example MCP client",
      firstParty: false,
      current: false,
      resources: ["mcp"],
    });
  });

  it("shows the same apps the dashboard shows (parity with /api/v1/account/apps)", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "tokens-parity@example.test", CREDENTIALS);
    await connectMcp(h, cli.cookie);
    const viaToken = (await (await cli.call("/api/v1/tokens")).json<{ items: Grant[] }>()).items;
    const viaSession = (
      await (
        await h.request("/api/v1/account/apps", dashboard(cli.cookie))
      ).json<{
        items: Omit<Grant, "current">[];
      }>()
    ).items;
    expect(viaToken.map(({ current: _, ...app }) => app)).toEqual(viaSession);
  });
});

describe("revoking tokens", () => {
  it("revokes another app's tokens for this account only, then answers a repeat as missing", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "tokens-revoke@example.test", CREDENTIALS);
    const mcp = await connectMcp(h, cli.cookie);
    const neighbour = await tokenClient(h, "tokens-revoke-other@example.test", CREDENTIALS);
    const neighbourMcp = await connectMcp(h, neighbour.cookie);

    const path = `/api/v1/tokens/${encodeURIComponent(mcp.clientId)}`;
    const revoked = await cli.call(path, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(await revoked.json()).toEqual({ clientId: mcp.clientId, revoked: true, current: false });
    expect((await callMcp(h, mcp.token)).status).toBe(401);
    expect((await cli.call("/api/v1/me")).status).toBe(200);
    expect((await callMcp(h, neighbourMcp.token)).status).toBe(200);
    // The dashboard sees the same result: the app is gone from the account.
    const apps = await (await h.request("/api/v1/account/apps", dashboard(cli.cookie))).json<{
      items: { clientId: string }[];
    }>();
    expect(apps.items.map((app) => app.clientId)).toEqual(["portifact-cli"]);

    const again = await cli.call(path, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect((await again.json<{ error: { code: string } }>()).error.code).toBe("not_found");
  });

  it("answers another user's app and an unknown client like a missing one, revoking nothing", async () => {
    const h = createHarness();
    const owner = await tokenClient(h, "tokens-foreign@example.test", CREDENTIALS);
    const ownerMcp = await connectMcp(h, owner.cookie);
    const intruder = await tokenClient(h, "tokens-foreign-intruder@example.test", CREDENTIALS);

    for (const clientId of [ownerMcp.clientId, "no-such-client"]) {
      const response = await intruder.call(`/api/v1/tokens/${encodeURIComponent(clientId)}`, {
        method: "DELETE",
      });
      expect(response.status, clientId).toBe(404);
      expect((await response.json<{ error: { code: string } }>()).error.code).toBe("not_found");
    }
    // The same client ID names only the caller's own grant: the owner's CLI keeps working.
    const own = await intruder.call("/api/v1/tokens/portifact-cli", { method: "DELETE" });
    expect(await own.json()).toMatchObject({ clientId: "portifact-cli", current: true });
    expect((await intruder.call("/api/v1/me")).status).toBe(401);
    expect((await callMcp(h, ownerMcp.token)).status).toBe(200);
    expect((await owner.call("/api/v1/me")).status).toBe(200);
  });

  it("revokes the calling app's own tokens and says so, like signing out", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "tokens-self@example.test", CREDENTIALS);
    const response = await cli.call("/api/v1/tokens/portifact-cli", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      clientId: "portifact-cli",
      revoked: true,
      current: true,
    });
    expect((await cli.call("/api/v1/me")).status).toBe(401);
    expect((await cli.call("/api/v1/tokens")).status).toBe(401);
  });
});

describe("who may manage tokens", () => {
  it("refuses a CLI token without credentials:manage, naming the scope, and revokes nothing", async () => {
    const h = createHarness();
    const cli = await tokenClient(
      h,
      "tokens-scope@example.test",
      "artifacts:read artifacts:write artifacts:share artifacts:delete annotations:read annotations:write annotations:moderate offline_access",
    );
    const mcp = await connectMcp(h, cli.cookie);
    for (const [method, path] of [
      ["GET", "/api/v1/tokens"],
      ["DELETE", `/api/v1/tokens/${encodeURIComponent(mcp.clientId)}`],
      ["DELETE", "/api/v1/tokens/portifact-cli"],
    ] as const) {
      const response = await cli.call(path, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(response.headers.get("www-authenticate")).toContain('scope="credentials:manage"');
    }
    expect((await callMcp(h, mcp.token)).status).toBe(200);
    expect((await cli.call("/api/v1/me")).status).toBe(200);
  });

  it("refuses MCP tokens, the dashboard session and requests without credentials", async () => {
    const h = createHarness();
    const cli = await tokenClient(h, "tokens-audience@example.test", CREDENTIALS);
    const mcp = await connectMcp(h, cli.cookie);
    for (const [method, path] of [
      ["GET", "/api/v1/tokens"],
      ["DELETE", "/api/v1/tokens/portifact-cli"],
    ] as const) {
      const withMcp = await h.request(path, {
        method,
        headers: { authorization: `Bearer ${mcp.token}` },
      });
      expect(withMcp.status, `${method} ${path} with an MCP token`).toBe(401);
      expect(withMcp.headers.get("www-authenticate")).toContain('error="invalid_token"');
      const withSession = await h.request(path, dashboard(cli.cookie, method));
      expect(withSession.status, `${method} ${path} with a session`).toBe(401);
      const anonymous = await h.request(path, { method });
      expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
    }
    expect((await cli.call("/api/v1/me")).status).toBe(200);
    expect((await callMcp(h, mcp.token)).status).toBe(200);
  });

  it("never lets a registered client register for or request credentials:manage", async () => {
    const h = createHarness();
    const register = await h.request(
      "/api/auth/oauth2/register",
      json({
        client_name: "Greedy MCP client",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "artifacts:read credentials:manage",
      }),
    );
    expect(register.status).toBe(400);
    expect(JSON.stringify(await register.json())).toContain("invalid_scope");

    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("tokens-greedy@example.test");
    const authorize = await startAuthorization(h, {
      clientId,
      cookie,
      scope: "artifacts:read credentials:manage",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
    const location = new URL(authorize.headers.get("location") ?? "", ORIGIN);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });
});
