// The device flow's sign-in time (decision 0021, review fix): the edges of recording the
// approving session's sign-in and copying it onto the issued tokens, each failing closed.
import { env } from "cloudflare:workers";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CLI_CLIENT_ID } from "../src/auth/config.ts";
import { DEVICE_GRANT, exchangeDeviceCode, recordDeviceApproval } from "../src/auth/device.ts";
import type { Env } from "../src/env.ts";
import { approveDevice, pollDeviceToken, requestDeviceCode } from "./flows.ts";
import { createHarness, json } from "./harness.ts";

const SCOPES = "artifacts:read offline_access";
const global = () => regionsFromEnv(env).global;

async function codeRow(deviceCode: string) {
  const [row] = await global()
    .select({ at: schema.deviceCodes.approverSignedInAt, status: schema.deviceCodes.status })
    .from(schema.deviceCodes)
    .where(eq(schema.deviceCodes.deviceCode, deviceCode));
  return row;
}

describe("recording the approving session's sign-in", () => {
  it("records nothing for a code that is not the caller's, malformed, or without a session", async () => {
    const h = createHarness();
    const owner = await h.signIn("dvo@example.test");
    const stranger = await h.signIn("dvs@example.test");
    const device = await requestDeviceCode(h, CLI_CLIENT_ID, SCOPES);
    // The owner claims it by opening the verification page; another account cannot approve it.
    await h.request(`/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`, {
      headers: { cookie: owner },
    });
    const refused = await h.request(
      "/api/auth/device/approve",
      json({ userCode: device.user_code }, { cookie: stranger }),
    );
    expect(refused.status).toBe(403);
    expect(await codeRow(device.device_code)).toMatchObject({ at: null, status: "pending" });
    // Without a session, or with a user code that is no string or too long: nothing written.
    for (const body of [
      { userCode: device.user_code },
      { userCode: 42 },
      { userCode: "X".repeat(65) },
      {},
    ]) {
      await recordDeviceApproval(h.auth, env as Env, new Headers(), body);
    }
    await recordDeviceApproval(h.auth, env as Env, new Headers({ cookie: owner }), {
      userCode: "",
    });
    expect(await codeRow(device.device_code)).toMatchObject({ at: null });
    // The owner's approval records their session's sign-in, also when typed with a dash and in
    // lower case (the provider normalizes the code the same way).
    const typed = `${device.user_code.slice(0, 4).toLowerCase()}-${device.user_code.slice(4)}`;
    expect((await approveDevice(h, owner, typed)).status).toBe(200);
    expect((await codeRow(device.device_code))?.at).toBeInstanceOf(Date);
  });
});

describe("copying it at the exchange", () => {
  it("leaves the provider's answer alone while the code is pending, and for other grants", async () => {
    const h = createHarness();
    const device = await requestDeviceCode(h, CLI_CLIENT_ID, SCOPES);
    const pending = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" });
    let issued = 0;
    const answer = await exchangeDeviceCode(
      h.auth,
      env as Env,
      { grant_type: "refresh_token" },
      async () => {
        issued++;
        return new Response("{}", { status: 200 });
      },
    );
    expect([answer.status, issued]).toEqual([200, 1]);
  });

  it("fails closed when the provider's answer has no token it can find", async () => {
    const h = createHarness();
    const cookie = await h.signIn("dvx@example.test");
    const device = await requestDeviceCode(h, CLI_CLIENT_ID, SCOPES);
    await approveDevice(h, cookie, device.user_code);
    const body = { grant_type: DEVICE_GRANT, device_code: device.device_code };
    for (const reply of [
      "not json",
      JSON.stringify({ token_type: "Bearer" }),
      JSON.stringify({ access_token: "unknown" }),
    ]) {
      const answer = await exchangeDeviceCode(
        h.auth,
        env as Env,
        body,
        async () => new Response(reply),
      );
      expect(await answer.text()).toBe(reply);
    }
  });

  it("still hands the tokens over when writing the sign-in time fails", async () => {
    const h = createHarness();
    const cookie = await h.signIn("dvf@example.test");
    const device = await requestDeviceCode(h, CLI_CLIENT_ID, SCOPES);
    await approveDevice(h, cookie, device.user_code);
    // The provider answered with the only copy of the tokens; the lookup of their rows then fails.
    const failing = {
      ...h.auth,
      api: {
        ...h.auth.api,
        tokenRecordOf: async () => {
          throw new Error("lookup failed");
        },
      },
    } as unknown as typeof h.auth;
    const logged: string[] = [];
    const error = console.error;
    console.error = (line: string) => logged.push(line);
    let answer: Response;
    try {
      answer = await exchangeDeviceCode(
        failing,
        env as Env,
        { grant_type: DEVICE_GRANT, device_code: device.device_code },
        async () => Response.json({ access_token: "issued", token_type: "Bearer" }),
      );
    } finally {
      console.error = error;
    }
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ access_token: "issued", token_type: "Bearer" });
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { event: "device_sign_in_time_failed", error: "Error" },
    ]);
  });

  it("gives a grant without a refresh token the approver's sign-in on its access token", async () => {
    const h = createHarness();
    const cookie = await h.signIn("dvn@example.test");
    const device = await requestDeviceCode(h, CLI_CLIENT_ID, "artifacts:read");
    await approveDevice(h, cookie, device.user_code);
    const approved = (await codeRow(device.device_code))?.at?.getTime();
    const issued = await pollDeviceToken(h, CLI_CLIENT_ID, device.device_code);
    expect(issued.status).toBe(200);
    const token = await issued.json<{ access_token: string; refresh_token?: string }>();
    expect(token.refresh_token).toBeUndefined();
    const record = (await h.auth.api.tokenRecordOf({
      headers: new Headers({ authorization: `Bearer ${token.access_token}` }),
    })) as { accessId: string; refreshId: string | null };
    expect(record.refreshId).toBeNull();
    const [row] = await global()
      .select({ at: schema.oauthAccessTokens.authTime })
      .from(schema.oauthAccessTokens)
      .where(eq(schema.oauthAccessTokens.id, record.accessId));
    expect(row?.at?.getTime()).toBe(approved);
  });

  it("answers no token record for a missing, malformed or inactive token", async () => {
    const h = createHarness();
    const ask = (authorization?: string) =>
      h.auth.api.tokenRecordOf({
        headers: new Headers(authorization ? { authorization } : {}),
      });
    expect(await ask()).toBeNull();
    expect(await ask("Basic abc")).toBeNull();
    expect(await ask("Bearer not-a-token")).toBeNull();
  });
});
