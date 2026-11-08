import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import {
  approveDevice,
  callApi,
  callMcp,
  insertDeviceClient,
  pollDeviceToken,
  requestDeviceCode,
  type TokenResponse,
} from "./flows.ts";
import { API_RESOURCE, createHarness, form, json, MCP_RESOURCE, ORIGIN } from "./harness.ts";

// Polling rules depend on time; the clock is controlled instead of waiting.
let now = Date.parse("2026-11-01T12:00:00Z");
const advance = (seconds: number) => {
  now += seconds * 1000;
  vi.setSystemTime(now);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("device authorization grant (RFC 8628) for the seeded CLI client", () => {
  it("issues a scoped API token after the signed-in user approves the code", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    expect(device.verification_uri).toBe(`${ORIGIN}/device`);
    expect(device.verification_uri_complete).toBe(`${ORIGIN}/device?user_code=${device.user_code}`);
    expect(device.interval).toBe(5);
    expect(device.expires_in).toBe(600);

    const pending = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

    const cookie = await h.signIn("ada@example.test");
    const approval = await approveDevice(h, cookie, device.user_code);
    expect(approval.status).toBe(200);

    advance(device.interval);
    const issued = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const tokens = await issued.json<TokenResponse>();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("artifacts:read offline_access");
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const me = await callApi(h, tokens.access_token);
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toEqual({
      userId: expect.any(String),
      clientId: CLI_CLIENT_ID,
      scopes: ["artifacts:read", "offline_access"],
    });
  });

  it("accepts the user code typed in lowercase with a separator", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const cookie = await h.signIn("typist@example.test");
    const typed = `${device.user_code.slice(0, 4)}-${device.user_code.slice(4)}`.toLowerCase();
    const approval = await approveDevice(h, cookie, typed);
    expect(approval.status).toBe(200);
  });

  it("cannot obtain a token for the MCP resource", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/device/code",
      form({ client_id: CLI_CLIENT_ID, scope: "artifacts:read", resource: MCP_RESOURCE }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  it("issues CLI tokens that the MCP endpoint refuses", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    await approveDevice(h, await h.signIn("cli-at-mcp@example.test"), device.user_code);
    advance(device.interval);
    const tokens = await (
      await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code)
    ).json<TokenResponse>();
    expect((await callMcp(h, tokens.access_token)).status).toBe(401);
  });

  it("shows the client, scopes and resource only to the user who opened the code", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const owner = await h.signIn("owner@example.test");
    const other = await h.signIn("other@example.test");
    const path = `/api/auth/device?user_code=${device.user_code}`;

    const ownerView = await (await h.request(path, { headers: { cookie: owner } })).json();
    expect(ownerView).toMatchObject({
      client_id: CLI_CLIENT_ID,
      scope: "artifacts:read offline_access",
      resource: API_RESOURCE,
      status: "pending",
    });
    const otherView = await (await h.request(path, { headers: { cookie: other } })).json();
    expect(otherView).not.toHaveProperty("client_id");
    expect(otherView).not.toHaveProperty("scope");
  });

  it("does not let another user approve a code someone else opened", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const owner = await h.signIn("first@example.test");
    await h.request(`/api/auth/device?user_code=${device.user_code}`, {
      headers: { cookie: owner },
    });
    const intruder = await h.signIn("intruder@example.test");
    const approval = await h.request(
      "/api/auth/device/approve",
      json({ userCode: device.user_code }, { cookie: intruder }),
    );
    expect(approval.status).toBe(403);
    advance(device.interval);
    const poll = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await poll.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("requires a session to approve", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const approval = await h.request(
      "/api/auth/device/approve",
      json({ userCode: device.user_code }),
    );
    expect(approval.status).toBe(401);
  });

  it("refuses an approval sent from another origin", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const cookie = await h.signIn("csrf@example.test");
    await h.request(`/api/auth/device?user_code=${device.user_code}`, { headers: { cookie } });
    const forged = await h.request(
      "/api/auth/device/approve",
      json({ userCode: device.user_code }, { cookie, origin: "https://k7d2qm4xab.portifact.dev" }),
    );
    expect(forged.status).toBe(403);
    advance(device.interval);
    const poll = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await poll.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("does not let the device request choose the user who approves it", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/device/code",
      form({ client_id: CLI_CLIENT_ID, scope: "artifacts:read", user_id: "victim" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("returns access_denied once the user denies, and forgets the code", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const cookie = await h.signIn("denier@example.test");
    await h.request(`/api/auth/device?user_code=${device.user_code}`, { headers: { cookie } });
    const denial = await h.request(
      "/api/auth/device/deny",
      json({ userCode: device.user_code }, { cookie }),
    );
    expect(denial.status).toBe(200);
    const denied = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await denied.json()).toMatchObject({ error: "access_denied" });
    advance(device.interval);
    const again = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("asks a client that polls faster than the interval to slow down", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    advance(1);
    const tooSoon = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await tooSoon.json()).toMatchObject({ error: "slow_down" });
  });

  it("expires the code after ten minutes", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    advance(601);
    const expired = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await expired.json()).toMatchObject({ error: "expired_token" });
  });

  it("redeems an approved code exactly once, also under concurrent polls", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const cookie = await h.signIn("racer@example.test");
    await approveDevice(h, cookie, device.user_code);
    advance(device.interval);
    const results = await Promise.all([
      pollDeviceToken(h, CLI_CLIENT_ID, device.device_code),
      pollDeviceToken(h, CLI_CLIENT_ID, device.device_code),
      pollDeviceToken(h, CLI_CLIENT_ID, device.device_code),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400, 400]);
    advance(device.interval);
    const replay = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a device code presented by a different client", async () => {
    const h = createHarness();
    const otherClientId = await insertDeviceClient();
    const device = await requestDeviceCode(h);
    const cookie = await h.signIn("victim@example.test");
    await approveDevice(h, cookie, device.user_code);
    advance(device.interval);
    const stolen = await pollDeviceToken(h, otherClientId, device.device_code);
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses scopes that do not exist", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/device/code",
      form({ client_id: CLI_CLIENT_ID, scope: "admin", resource: API_RESOURCE }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("refuses scopes the client is not registered for", async () => {
    const h = createHarness();
    const otherClientId = await insertDeviceClient();
    const response = await h.request(
      "/api/auth/device/code",
      form({ client_id: otherClientId, scope: "annotations:moderate", resource: API_RESOURCE }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("never issues first-party session tokens through /device/token", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h);
    const response = await h.request(
      "/api/auth/device/token",
      form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    );
    expect(response.status).toBe(404);
  });
});
