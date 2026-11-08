import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_RESOURCE, ORIGIN } from "./config.ts";
import {
  approveDevice,
  callApi,
  pollDeviceToken,
  requestDeviceCode,
  seedCliClient,
  type TokenResponse,
} from "./test/flows.ts";
import { createHarness, form, json } from "./test/harness.ts";

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

describe("device authorization grant (RFC 8628) for the CLI", () => {
  it("issues a scoped API token after the signed-in user approves the code", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    expect(device.verification_uri).toBe(`${ORIGIN}/device`);
    expect(device.verification_uri_complete).toBe(`${ORIGIN}/device?user_code=${device.user_code}`);
    expect(device.interval).toBe(5);
    expect(device.expires_in).toBe(600);

    const pending = await pollDeviceToken(h, clientId, device.device_code);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

    const cookie = await h.signIn("ada@example.test");
    const approval = await approveDevice(h, cookie, device.user_code);
    expect(approval.status).toBe(200);

    advance(device.interval);
    const issued = await pollDeviceToken(h, clientId, device.device_code);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toContain("no-store");
    const tokens = await issued.json<TokenResponse>();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("artifacts:read offline_access");
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const whoami = await callApi(h, tokens.access_token);
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({
      clientId,
      scopes: ["artifacts:read", "offline_access"],
    });
  });

  it("shows the client, scopes and resource only to the user who opened the code", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    const owner = await h.signIn("owner@example.test");
    const other = await h.signIn("other@example.test");
    const path = `/api/auth/device?user_code=${device.user_code}`;

    const ownerView = await (await h.request(path, { headers: { cookie: owner } })).json();
    expect(ownerView).toMatchObject({
      client_id: clientId,
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
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
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
    const poll = await pollDeviceToken(h, clientId, device.device_code);
    expect(await poll.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("requires a session to approve", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    const approval = await h.request(
      "/api/auth/device/approve",
      json({ userCode: device.user_code }),
    );
    expect(approval.status).toBe(401);
  });

  it("returns access_denied once the user denies, and forgets the code", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    const cookie = await h.signIn("denier@example.test");
    await h.request(`/api/auth/device?user_code=${device.user_code}`, { headers: { cookie } });
    const denial = await h.request(
      "/api/auth/device/deny",
      json({ userCode: device.user_code }, { cookie }),
    );
    expect(denial.status).toBe(200);
    const denied = await pollDeviceToken(h, clientId, device.device_code);
    expect(await denied.json()).toMatchObject({ error: "access_denied" });
    advance(device.interval);
    const again = await pollDeviceToken(h, clientId, device.device_code);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("asks a client that polls faster than the interval to slow down", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    await pollDeviceToken(h, clientId, device.device_code);
    advance(1);
    const tooSoon = await pollDeviceToken(h, clientId, device.device_code);
    expect(await tooSoon.json()).toMatchObject({ error: "slow_down" });
  });

  it("expires the code after ten minutes", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    advance(601);
    const expired = await pollDeviceToken(h, clientId, device.device_code);
    expect(await expired.json()).toMatchObject({ error: "expired_token" });
  });

  it("redeems an approved code exactly once, also under concurrent polls", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    const cookie = await h.signIn("racer@example.test");
    await approveDevice(h, cookie, device.user_code);
    advance(device.interval);
    const results = await Promise.all([
      pollDeviceToken(h, clientId, device.device_code),
      pollDeviceToken(h, clientId, device.device_code),
      pollDeviceToken(h, clientId, device.device_code),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400, 400]);
    advance(device.interval);
    const replay = await pollDeviceToken(h, clientId, device.device_code);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a device code presented by a different client", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const otherClientId = await seedCliClient(h);
    const device = await requestDeviceCode(h, clientId);
    const cookie = await h.signIn("victim@example.test");
    await approveDevice(h, cookie, device.user_code);
    advance(device.interval);
    const stolen = await pollDeviceToken(h, otherClientId, device.device_code);
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses scopes the CLI client is not registered for", async () => {
    const h = createHarness();
    const clientId = await seedCliClient(h);
    const response = await h.request(
      "/api/auth/device/code",
      form({ client_id: clientId, scope: "annotations:moderate", resource: API_RESOURCE }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });
});
