import { env } from "cloudflare:workers";
import { OTP_LIMITS } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeFrom, createHarness, type Harness, json, SESSION_COOKIE } from "./harness.ts";

let now = Date.parse("2026-11-02T09:00:00Z");
const advance = (seconds: number) => {
  now += seconds * 1000;
  vi.setSystemTime(now);
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await env.DB.exec("DELETE FROM rate_limits");
});

afterEach(() => {
  vi.useRealTimers();
});

function sendCode(h: Harness, email: string, ip = "198.51.100.7", type = "sign-in") {
  return h.request(
    "/api/auth/email-otp/send-verification-otp",
    json({ email, type }, { "cf-connecting-ip": ip }),
  );
}

// The login page accepts the terms before sending the code, so a sign-in carries the cookie.
async function verify(h: Harness, email: string, otp: string) {
  const cookie = await h.acceptTerms();
  return h.request("/api/auth/sign-in/email-otp", json({ email, otp }, { cookie }));
}

describe("sign-in with an email code", () => {
  it("delivers a six-digit code through the email sender and signs in with it", async () => {
    const h = createHarness();
    const response = await sendCode(h, "new-user@example.test");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]?.to).toBe("new-user@example.test");
    expect(h.outbox[0]?.subject).toBe("Your Portifact sign-in code");

    const signedIn = await verify(h, "new-user@example.test", codeFrom(h.outbox[0]));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    const body = await signedIn.json<{ user: { email: string; emailVerified: boolean } }>();
    expect(body.user).toMatchObject({ email: "new-user@example.test", emailVerified: true });
  });

  it("answers the same whether or not an account exists", async () => {
    const h = createHarness();
    await h.signIn("existing@example.test");
    await env.DB.exec("DELETE FROM rate_limits");
    const existing = await sendCode(h, "existing@example.test");
    const unknown = await sendCode(h, "nobody@example.test");
    expect(existing.status).toBe(unknown.status);
    expect(await existing.json()).toEqual(await unknown.json());
  });

  it("normalizes the address, so case does not create a second account", async () => {
    const h = createHarness();
    await sendCode(h, "Mixed.Case@Example.TEST");
    const signedIn = await verify(h, "mixed.case@example.test", codeFrom(h.outbox.at(-1)));
    expect(signedIn.status).toBe(200);
    const rows = await env.DB.prepare(
      "select email from users where email like 'mixed.case%'",
    ).all();
    expect(rows.results).toEqual([{ email: "mixed.case@example.test" }]);
  });

  it("stores the code only as a hash", async () => {
    const h = createHarness();
    await sendCode(h, "hashed@example.test");
    const code = codeFrom(h.outbox.at(-1));
    const rows = await env.DB.prepare("select value from verifications").all<{ value: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) expect(row.value).not.toContain(code);
  });

  it("refuses a code after five minutes", async () => {
    const h = createHarness();
    await sendCode(h, "late@example.test");
    advance(OTP_LIMITS.codeTtlSeconds + 1);
    const response = await verify(h, "late@example.test", codeFrom(h.outbox.at(-1)));
    expect(response.status).toBe(400);
  });

  it("allows three attempts per code, then the code is gone", async () => {
    const h = createHarness();
    await sendCode(h, "guess@example.test");
    const code = codeFrom(h.outbox.at(-1));
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < OTP_LIMITS.allowedAttempts; attempt += 1) {
      expect((await verify(h, "guess@example.test", wrong)).status).toBe(400);
    }
    expect((await verify(h, "guess@example.test", code)).status).not.toBe(200);
  });

  it("works once", async () => {
    const h = createHarness();
    await sendCode(h, "once@example.test");
    const code = codeFrom(h.outbox.at(-1));
    expect((await verify(h, "once@example.test", code)).status).toBe(200);
    expect((await verify(h, "once@example.test", code)).status).toBe(400);
  });

  it("only sends sign-in codes", async () => {
    const h = createHarness();
    for (const type of ["email-verification", "forget-password", "change-email"]) {
      const response = await sendCode(h, "types@example.test", "198.51.100.7", type);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
    }
    const notAnObject = await h.request("/api/auth/email-otp/send-verification-otp", json(null));
    expect(notAnObject.status).toBe(400);
    expect(h.outbox).toHaveLength(0);
  });

  it("leaves malformed requests to Better Auth's validation without sending", async () => {
    const h = createHarness();
    const missing = await h.request(
      "/api/auth/email-otp/send-verification-otp",
      json({ type: "sign-in" }),
    );
    expect(missing.status).toBe(400);
    const notJson = await h.request("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.portifact.com" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(h.outbox).toHaveLength(0);
  });

  it("does not offer endpoints for other code types", async () => {
    const h = createHarness();
    for (const path of [
      "/api/auth/forget-password/email-otp",
      "/api/auth/email-otp/request-password-reset",
      "/api/auth/email-otp/verify-email",
      "/api/auth/email-otp/check-verification-otp",
    ]) {
      expect((await h.request(path, json({ email: "x@example.test" }))).status).toBe(404);
    }
  });
});

describe("limits on sending codes", () => {
  it("allows one code per address per minute", async () => {
    const h = createHarness();
    expect((await sendCode(h, "cooldown@example.test")).status).toBe(200);
    const second = await sendCode(h, "cooldown@example.test");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(await second.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(h.outbox).toHaveLength(1);
    advance(60);
    expect((await sendCode(h, "cooldown@example.test")).status).toBe(200);
  });

  it("allows five codes per address per hour, from any IP", async () => {
    const h = createHarness();
    for (let index = 0; index < OTP_LIMITS.perEmail.max; index += 1) {
      expect((await sendCode(h, "hourly@example.test", `203.0.113.${index}`)).status).toBe(200);
      advance(61);
    }
    expect((await sendCode(h, "hourly@example.test", "203.0.113.200")).status).toBe(429);
    expect(h.outbox).toHaveLength(OTP_LIMITS.perEmail.max);
  });

  it("allows twenty codes per IP per hour across addresses", async () => {
    const h = createHarness();
    for (let index = 0; index < OTP_LIMITS.perIp.max; index += 1) {
      expect((await sendCode(h, `ip-${index}@example.test`, "192.0.2.9")).status).toBe(200);
    }
    expect((await sendCode(h, "ip-last@example.test", "192.0.2.9")).status).toBe(429);
    expect((await sendCode(h, "ip-last@example.test", "192.0.2.10")).status).toBe(200);
  });

  it("stops every send once the global daily budget is spent", async () => {
    const h = createHarness();
    await env.DB.prepare("insert into rate_limits (key, window_start, count) values (?, ?, ?)")
      .bind("otp:global", now, OTP_LIMITS.global.max)
      .run();
    const response = await sendCode(h, "budget@example.test");
    expect(response.status).toBe(429);
    expect(h.outbox).toHaveLength(0);
    advance(OTP_LIMITS.global.windowSeconds);
    await env.DB.exec("DELETE FROM rate_limits WHERE key != 'otp:global'");
    expect((await sendCode(h, "budget@example.test")).status).toBe(200);
  });

  it("never stores the address in the counters", async () => {
    const h = createHarness();
    await sendCode(h, "private@example.test");
    const keys = await env.DB.prepare("select key from rate_limits").all<{ key: string }>();
    expect(keys.results.length).toBeGreaterThan(0);
    for (const { key } of keys.results) expect(key).not.toContain("private@example.test");
  });

  it("prunes counters older than two days", async () => {
    const h = createHarness();
    await env.DB.prepare("insert into rate_limits (key, window_start, count) values (?, ?, 1)")
      .bind("otp:ip:stale", now - 3 * 86_400_000)
      .run();
    await sendCode(h, "prune@example.test");
    const stale = await env.DB.prepare(
      "select key from rate_limits where key = 'otp:ip:stale'",
    ).all();
    expect(stale.results).toEqual([]);
  });

  it("limits code guesses per IP", async () => {
    const h = createHarness();
    const limit = 30;
    for (let index = 0; index < limit; index += 1) {
      const response = await h.request(
        "/api/auth/sign-in/email-otp",
        json(
          { email: `guess-${index}@example.test`, otp: "000000" },
          { "cf-connecting-ip": "192.0.2.77" },
        ),
      );
      expect(response.status).toBe(400);
    }
    const blocked = await h.request(
      "/api/auth/sign-in/email-otp",
      json({ email: "guess-x@example.test", otp: "000000" }, { "cf-connecting-ip": "192.0.2.77" }),
    );
    expect(blocked.status).toBe(429);
  });

  it("limits client registrations per IP", async () => {
    const h = createHarness();
    const register = () =>
      h.request(
        "/api/auth/oauth2/register",
        json(
          {
            client_name: "Spam",
            redirect_uris: ["http://127.0.0.1/callback"],
            token_endpoint_auth_method: "none",
          },
          { "cf-connecting-ip": "192.0.2.99" },
        ),
      );
    for (let index = 0; index < 20; index += 1) expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(429);
  });
});
