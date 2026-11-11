// The human check on account creation: the endpoint the login page posts the Turnstile token
// to, the refusal of sign-ups without a solved check, the single use of a check, and existing
// accounts signing in without one. Google and GitHub are covered in social.test.ts; comments
// in annotations.test.ts.
import { env } from "cloudflare:workers";
import { HUMAN_VERIFICATION_REQUIRED } from "@portifact/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HUMAN_COOKIE,
  HUMAN_COOKIE_TTL_SECONDS,
  openHumanCheck,
  sealHumanCheck,
} from "../src/auth/human.ts";
import { readCookie } from "../src/auth/terms.ts";
import { SITEVERIFY_URL, verifyTurnstile } from "../src/turnstile.ts";
import {
  codeFrom,
  cookieHeader,
  createHarness,
  FAILED_HUMAN_TOKEN,
  type Harness,
  HUMAN_TOKEN,
  json,
  OUTAGE_HUMAN_TOKEN,
  SESSION_COOKIE,
} from "./harness.ts";

const SECRET = env.BETTER_AUTH_SECRET;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
});

function verify(h: Harness, token: unknown, headers: Record<string, string> = {}) {
  return h.request("/api/auth/verify-human", json({ token }, headers));
}

async function signInWithCode(h: Harness, email: string, cookie: string) {
  await env.DB.exec("DELETE FROM rate_limits WHERE key NOT LIKE 'human:%'");
  const sent = await h.request(
    "/api/auth/email-otp/send-verification-otp",
    json({ email, type: "sign-in" }),
  );
  expect(sent.status).toBe(200);
  const otp = codeFrom(h.outbox.findLast((message) => message.to === email));
  return h.request("/api/auth/sign-in/email-otp", json({ email, otp }, { cookie }));
}

async function userCount(email: string) {
  const row = await env.DB.prepare("select count(*) as n from users where email = ?")
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /api/auth/verify-human", () => {
  it("verifies the token for the visitor's IP and answers a short, signed __Host- cookie", async () => {
    const h = createHarness();
    const token = `${HUMAN_TOKEN}-endpoint`;
    const response = await verify(h, token, { "cf-connecting-ip": "203.0.113.7" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.siteverifyCalls).toEqual([
      { secret: env.TURNSTILE_SECRET_KEY, token, remoteIp: "203.0.113.7" },
    ]);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(
      new RegExp(
        `^${HUMAN_COOKIE}=[^;]+; Max-Age=${HUMAN_COOKIE_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax$`,
      ),
    );
    const value = readCookie(cookieHeader(response), HUMAN_COOKIE) ?? "";
    expect(await openHumanCheck(SECRET, value, Date.now())).toEqual(expect.any(String));
  });

  it("refuses a failed or replayed token, a malformed body and a cross-origin request", async () => {
    const h = createHarness();
    const failed = await verify(h, FAILED_HUMAN_TOKEN);
    expect(failed.status).toBe(403);
    expect(await failed.json()).toMatchObject({ error: { code: HUMAN_VERIFICATION_REQUIRED } });
    expect(failed.headers.getSetCookie()).toEqual([]);

    const token = `${HUMAN_TOKEN}-replayed`;
    expect((await verify(h, token)).status).toBe(200);
    expect((await verify(h, token)).status).toBe(403);

    for (const body of [{}, { token: "" }, { token: "x".repeat(2_049) }, { token: "t", x: 1 }]) {
      const response = await h.request("/api/auth/verify-human", json(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const cross = await h.request(
      "/api/auth/verify-human",
      json({ token: `${HUMAN_TOKEN}-cross` }, { origin: "https://evil.example" }),
    );
    expect(cross.status).toBe(403);
    expect((await h.request("/api/auth/verify-human")).status).toBe(404);
  });

  it("fails closed with 503 when siteverify is down or the secret is missing", async () => {
    const h = createHarness();
    const down = await verify(h, OUTAGE_HUMAN_TOKEN);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: { code: "capacity_unavailable" } });
    expect(down.headers.getSetCookie()).toEqual([]);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unconfigured = createHarness({ env: { TURNSTILE_SECRET_KEY: undefined } });
    const response = await verify(unconfigured, `${HUMAN_TOKEN}-unconfigured`);
    expect(response.status).toBe(503);
    expect(unconfigured.siteverifyCalls).toEqual([]);
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: "turnstile_secret_missing" }));
    expect(JSON.stringify(error.mock.calls)).not.toContain(HUMAN_TOKEN);
    error.mockRestore();
  });

  it("is limited per IP", async () => {
    const h = createHarness();
    const ip = { "cf-connecting-ip": "198.51.100.30" };
    for (let i = 0; i < 30; i++) await verify(h, FAILED_HUMAN_TOKEN, ip);
    const limited = await verify(h, `${HUMAN_TOKEN}-limited`, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toEqual(expect.any(String));
  });
});

describe("account creation", () => {
  it("refuses a sign-up with the terms accepted but no solved check, and creates nothing", async () => {
    const h = createHarness();
    const email = "no-human@example.test";
    const response = await signInWithCode(h, email, await h.acceptTerms());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: HUMAN_VERIFICATION_REQUIRED });
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect(await userCount(email)).toBe(0);
  });

  it("refuses forged, expired and tampered checks", async () => {
    const h = createHarness();
    const nonce = "a".repeat(32);
    const now = Date.now();
    const expired = await sealHumanCheck(SECRET, nonce, now - HUMAN_COOKIE_TTL_SECONDS * 1000 - 1);
    const future = await sealHumanCheck(SECRET, nonce, now + 60_000);
    const otherKey = await sealHumanCheck("another-secret-0123456789abcdef0123", nonce, now);
    const valid = await sealHumanCheck(SECRET, nonce, now);
    const [n, issued, signature] = valid.split(".");
    for (const value of [
      expired,
      future,
      otherKey,
      `${"b".repeat(32)}.${issued}.${signature}`,
      `${n}.${issued}`,
      `${n}.${issued}.${signature}.x`,
      `short.${issued}.${signature}`,
      `${n}.soon.${signature}`,
      `${n}.${issued}.***`,
    ]) {
      const response = await signInWithCode(
        h,
        "forged-human@example.test",
        `${await h.acceptTerms()}; ${HUMAN_COOKIE}=${value}`,
      );
      expect(response.status, value).toBe(403);
    }
    expect(await userCount("forged-human@example.test")).toBe(0);
  });

  it("creates the account with a solved check, which then cannot create another", async () => {
    const h = createHarness();
    const human = await h.verifyHuman();
    const first = await signInWithCode(
      h,
      "human-1@example.test",
      `${await h.acceptTerms()}; ${human}`,
    );
    expect(first.status).toBe(200);
    expect(await userCount("human-1@example.test")).toBe(1);
    // The same browser (or a script) reusing the check for a second account is refused.
    const second = await signInWithCode(
      h,
      "human-2@example.test",
      `${await h.acceptTerms()}; ${human}`,
    );
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ code: HUMAN_VERIFICATION_REQUIRED });
    expect(await userCount("human-2@example.test")).toBe(0);
  });

  it("checks the terms first, so a refusal for them does not spend the check", async () => {
    const h = createHarness();
    const human = await h.verifyHuman();
    const refused = await signInWithCode(h, "terms-first@example.test", human);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "terms_not_accepted" });
    const accepted = await signInWithCode(
      h,
      "terms-first@example.test",
      `${await h.acceptTerms()}; ${human}`,
    );
    expect(accepted.status).toBe(200);
  });

  it("signs existing accounts in without a check", async () => {
    const h = createHarness();
    const email = "returning-human@example.test";
    await h.signIn(email);
    const response = await signInWithCode(h, email, "");
    expect(response.status).toBe(200);
    expect(await userCount(email)).toBe(1);
  });
});

describe("siteverify", () => {
  const base = { secret: "s", token: "t", remoteIp: undefined };

  it("passes only a successful answer and fails closed on everything unexpected", async () => {
    const answer =
      (body: unknown, status = 200) =>
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    expect(await verifyTurnstile({ ...base, fetch: answer({ success: true }) })).toBe("passed");
    expect(
      await verifyTurnstile({
        ...base,
        fetch: answer({ success: false, "error-codes": ["invalid-input-response"] }),
      }),
    ).toBe("failed");
    expect(await verifyTurnstile({ ...base, fetch: answer({ success: false }) })).toBe("failed");
    expect(
      await verifyTurnstile({
        ...base,
        fetch: answer({ success: false, "error-codes": ["internal-error"] }),
      }),
    ).toBe("unavailable");
    expect(await verifyTurnstile({ ...base, fetch: answer({ success: "true" }, 500) })).toBe(
      "unavailable",
    );
    expect(await verifyTurnstile({ ...base, fetch: answer("not json") })).toBe("unavailable");
    expect(await verifyTurnstile({ ...base, fetch: answer("null") })).toBe("unavailable");
    expect(
      await verifyTurnstile({
        ...base,
        fetch: async () => {
          throw new Error("network");
        },
      }),
    ).toBe("unavailable");
  });

  it("treats a rejected secret as an operator problem, never as a pass", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await verifyTurnstile({
      ...base,
      fetch: async () => Response.json({ success: false, "error-codes": ["invalid-input-secret"] }),
    });
    expect(result).toBe("unavailable");
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: "turnstile_secret_rejected" }));
    error.mockRestore();
  });

  it("posts the secret, the token and the IP to Cloudflare's endpoint", async () => {
    let seen: { url: string; form: FormData; signal: unknown } | undefined;
    await verifyTurnstile({
      secret: "secret-value",
      token: "token-value",
      remoteIp: "192.0.2.1",
      fetch: async (input, init) => {
        seen = { url: String(input), form: init?.body as FormData, signal: init?.signal };
        return Response.json({ success: true });
      },
    });
    expect(seen?.url).toBe(SITEVERIFY_URL);
    expect(seen?.form.get("secret")).toBe("secret-value");
    expect(seen?.form.get("response")).toBe("token-value");
    expect(seen?.form.get("remoteip")).toBe("192.0.2.1");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});
