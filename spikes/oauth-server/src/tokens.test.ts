import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_RESOURCE, ORIGIN } from "./config.ts";
import {
  approveDevice,
  authorizeWithPkce,
  callApi,
  callMcp,
  exchangeCode,
  pollDeviceToken,
  registerMcpClient,
  requestDeviceCode,
  seedCliClient,
  type TokenResponse,
} from "./test/flows.ts";
import { createHarness, form, type Harness, json } from "./test/harness.ts";

let now = Date.parse("2026-11-01T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

async function cliTokens(h: Harness, email: string, scope?: string) {
  const clientId = await seedCliClient(h);
  const device = await requestDeviceCode(h, clientId, scope);
  await approveDevice(h, await h.signIn(email), device.user_code);
  now += device.interval * 1000;
  vi.setSystemTime(now);
  const tokens = await (
    await pollDeviceToken(h, clientId, device.device_code)
  ).json<TokenResponse>();
  return { clientId, tokens };
}

// A null resource omits the parameter from both the authorization and the token request.
async function mcpTokens(h: Harness, email: string, resource: string | null = MCP_RESOURCE) {
  const clientId = await registerMcpClient(h);
  const cookie = await h.signIn(email);
  const callback = await authorizeWithPkce(h, { clientId, cookie, resource });
  const response = await exchangeCode(h, { clientId, ...callback, resource });
  return { clientId, cookie, tokens: await response.json<TokenResponse>() };
}

function refresh(h: Harness, clientId: string, refreshToken: string) {
  return h.request(
    "/api/auth/oauth2/token",
    form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  );
}

function revoke(h: Harness, clientId: string, token: string, hint: string) {
  return h.request(
    "/api/auth/oauth2/revoke",
    form({ token, token_type_hint: hint, client_id: clientId }),
  );
}

describe("audience validation (RFC 8707)", () => {
  it("rejects a CLI token, issued for the API, at the MCP endpoint", async () => {
    const h = createHarness();
    const { tokens } = await cliTokens(h, "aud-cli@example.test");
    expect((await callApi(h, tokens.access_token)).status).toBe(200);
    const mcp = await callMcp(h, tokens.access_token);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("rejects an MCP token at the API", async () => {
    const h = createHarness();
    const { tokens } = await mcpTokens(h, "aud-mcp@example.test");
    expect((await callMcp(h, tokens.access_token)).status).toBe(200);
    const api = await callApi(h, tokens.access_token);
    expect(api.status).toBe(401);
    expect(api.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1"`,
    );
  });

  it("rejects a token issued without any resource at every resource", async () => {
    const h = createHarness();
    const { tokens } = await mcpTokens(h, "aud-none@example.test", null);
    const payload = await h.auth.api.introspectBearer({
      headers: new Headers({ authorization: `Bearer ${tokens.access_token}` }),
    });
    // The authorization server still issues it; the resource servers must refuse it.
    expect(payload).toMatchObject({ active: true, aud: undefined });
    expect((await callMcp(h, tokens.access_token)).status).toBe(401);
    expect((await callApi(h, tokens.access_token)).status).toBe(401);
  });

  it("keeps the resource from the authorization request when the token request omits it", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("aud-kept@example.test");
    const callback = await authorizeWithPkce(h, { clientId, cookie });
    const response = await exchangeCode(h, { clientId, ...callback, resource: null });
    const tokens = await response.json<TokenResponse>();
    expect((await callMcp(h, tokens.access_token)).status).toBe(200);
    expect((await callApi(h, tokens.access_token)).status).toBe(401);
  });
});

describe("scopes", () => {
  it("answers 403 insufficient_scope naming every scope the operation needs", async () => {
    const h = createHarness();
    const { tokens } = await cliTokens(h, "scope@example.test");
    const response = await h.request("/api/v1/artifacts/abc", {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1", scope="artifacts:delete"`,
    );
  });

  it("allows the operation once the token carries the scope", async () => {
    const h = createHarness();
    const { tokens } = await cliTokens(
      h,
      "scope-ok@example.test",
      "artifacts:read artifacts:delete",
    );
    const response = await h.request("/api/v1/artifacts/abc", {
      method: "DELETE",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(response.status).toBe(204);
  });
});

describe("revocation (RFC 7009)", () => {
  it("stops an access token from working on the next request", async () => {
    const h = createHarness();
    const { clientId, tokens } = await cliTokens(h, "revoke-access@example.test");
    expect((await callApi(h, tokens.access_token)).status).toBe(200);
    const response = await revoke(h, clientId, tokens.access_token, "access_token");
    expect(response.status).toBe(200);
    expect((await callApi(h, tokens.access_token)).status).toBe(401);
  });

  it("stops a refresh token from minting new access tokens", async () => {
    const h = createHarness();
    const { clientId, tokens } = await cliTokens(h, "revoke-refresh@example.test");
    const refreshToken = tokens.refresh_token ?? "";
    expect((await revoke(h, clientId, refreshToken, "refresh_token")).status).toBe(200);
    const response = await refresh(h, clientId, refreshToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("does not let one client revoke another client's token", async () => {
    const h = createHarness();
    const { tokens } = await cliTokens(h, "revoke-owner@example.test");
    const otherClient = await seedCliClient(h);
    await revoke(h, otherClient, tokens.access_token, "access_token");
    expect((await callApi(h, tokens.access_token)).status).toBe(200);
  });
});

describe("refresh tokens", () => {
  it("rotates on use and refuses the previous refresh token afterwards", async () => {
    const h = createHarness();
    const { clientId, tokens } = await mcpTokens(h, "rotate@example.test");
    const first = await refresh(h, clientId, tokens.refresh_token ?? "");
    expect(first.status).toBe(200);
    const rotated = await first.json<TokenResponse>();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await callMcp(h, rotated.access_token)).status).toBe(200);
    const reused = await refresh(h, clientId, tokens.refresh_token ?? "");
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("expires access tokens after an hour", async () => {
    const h = createHarness();
    const { tokens } = await cliTokens(h, "expiry@example.test");
    now += 3601 * 1000;
    vi.setSystemTime(now);
    expect((await callApi(h, tokens.access_token)).status).toBe(401);
  });
});

describe("storage", () => {
  it("keeps only hashes of access and refresh tokens in D1", async () => {
    const h = createHarness();
    const { tokens } = await cliTokens(h, "storage@example.test");
    const access = await env.DB.prepare('select token from "oauthAccessToken"').all<{
      token: string;
    }>();
    const refreshRows = await env.DB.prepare('select token from "oauthRefreshToken"').all<{
      token: string;
    }>();
    const stored = [...access.results, ...refreshRows.results].map((row) => row.token);
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
  });
});

describe("relation to the dashboard session", () => {
  it("ends MCP access tokens with the browser session, while refresh keeps working", async () => {
    const h = createHarness();
    const { clientId, cookie, tokens } = await mcpTokens(h, "signout@example.test");
    await h.request("/api/auth/sign-out", json({}, { cookie }));
    expect((await callMcp(h, tokens.access_token)).status).toBe(401);
    const refreshed = await refresh(h, clientId, tokens.refresh_token ?? "");
    expect(refreshed.status).toBe(200);
    expect((await callMcp(h, (await refreshed.json<TokenResponse>()).access_token)).status).toBe(
      200,
    );
  });

  it("keeps CLI tokens from the device flow valid after the browser signs out", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    const cookie = await h.signIn("device-signout@example.test");
    await approveDevice(h, cookie, device.user_code);
    now += device.interval * 1000;
    vi.setSystemTime(now);
    const tokens = await (
      await pollDeviceToken(h, clientId, device.device_code)
    ).json<TokenResponse>();
    await h.request("/api/auth/sign-out", json({}, { cookie }));
    expect((await callApi(h, tokens.access_token)).status).toBe(200);
  });
});
