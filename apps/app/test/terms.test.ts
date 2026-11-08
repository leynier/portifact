// Acceptance of the terms and the 18+ confirmation: the endpoint, the refusal of sign-up and
// sign-in without it, what D1 records and how existing accounts are asked again. Google and
// GitHub are covered in social.test.ts.
import { env } from "cloudflare:workers";
import { TERMS_NOT_ACCEPTED, TERMS_VERSION } from "@portifact/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  openAcceptance,
  readCookie,
  sealAcceptance,
  TERMS_COOKIE,
  TERMS_COOKIE_TTL_SECONDS,
  termsHooks,
} from "../src/auth/terms.ts";
import {
  codeFrom,
  cookieHeader,
  createHarness,
  type Harness,
  json,
  ORIGIN,
  SESSION_COOKIE,
  TERMS_ACCEPTANCE,
} from "./harness.ts";

const SECRET = env.BETTER_AUTH_SECRET;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
});

async function sendCode(h: Harness, email: string) {
  // These tests are not about limits: each code starts with fresh counters.
  await env.DB.exec("DELETE FROM rate_limits");
  const response = await h.request(
    "/api/auth/email-otp/send-verification-otp",
    json({ email, type: "sign-in" }),
  );
  expect(response.status).toBe(200);
  return codeFrom(h.outbox.findLast((message) => message.to === email));
}

async function signInWithCode(h: Harness, email: string, cookie = "") {
  const otp = await sendCode(h, email);
  return h.request("/api/auth/sign-in/email-otp", json({ email, otp }, cookie ? { cookie } : {}));
}

async function termsOf(email: string) {
  return env.DB.prepare("select terms_version, terms_accepted_at from users where email = ?")
    .bind(email)
    .first<{ terms_version: string | null; terms_accepted_at: number | null }>();
}

async function forgetTerms(email: string) {
  await env.DB.prepare(
    "update users set terms_version = null, terms_accepted_at = null where email = ?",
  )
    .bind(email)
    .run();
}

describe("POST /api/auth/accept-terms", () => {
  it("gives a browser without a session a short, signed __Host- acceptance cookie", async () => {
    const h = createHarness();
    const before = Date.now();
    const response = await h.request("/api/auth/accept-terms", json(TERMS_ACCEPTANCE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: TERMS_VERSION, recorded: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(
      new RegExp(
        `^${TERMS_COOKIE}=[^;]+; Max-Age=${TERMS_COOKIE_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax$`,
      ),
    );
    const value = readCookie(cookieHeader(response), TERMS_COOKIE) ?? "";
    const opened = await openAcceptance(SECRET, value, Date.now());
    expect(opened?.version).toBe(TERMS_VERSION);
    expect(opened?.acceptedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("refuses an acceptance without both confirmations or for another version", async () => {
    const h = createHarness();
    for (const body of [
      { ...TERMS_ACCEPTANCE, confirmAdult: false },
      { ...TERMS_ACCEPTANCE, acceptTerms: false },
      { ...TERMS_ACCEPTANCE, version: "2000-01-01" },
      { ...TERMS_ACCEPTANCE, userId: "someone-else" },
      {},
    ]) {
      const response = await h.request("/api/auth/accept-terms", json(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    const notJson = await h.request("/api/auth/accept-terms", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "not json",
    });
    expect(notJson.status).toBe(400);
  });

  it("refuses another origin and other methods", async () => {
    const h = createHarness();
    const crossSite = await h.request(
      "/api/auth/accept-terms",
      json(TERMS_ACCEPTANCE, { origin: "https://evil.example" }),
    );
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.getSetCookie()).toEqual([]);
    expect((await h.request("/api/auth/accept-terms")).status).toBe(404);
  });

  it("is limited per IP", async () => {
    const h = createHarness();
    const accept = () =>
      h.request(
        "/api/auth/accept-terms",
        json(TERMS_ACCEPTANCE, { "cf-connecting-ip": "192.0.2.150" }),
      );
    for (let index = 0; index < 30; index += 1) expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(429);
  });

  it("records the acceptance of a signed-in account directly", async () => {
    const h = createHarness();
    const email = "accept-signed-in@example.test";
    const cookie = await h.signIn(email);
    await forgetTerms(email);
    const before = Date.now();
    const response = await h.request("/api/auth/accept-terms", json(TERMS_ACCEPTANCE, { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: TERMS_VERSION, recorded: true });
    expect(response.headers.getSetCookie()).toEqual([]);
    const recorded = await termsOf(email);
    expect(recorded?.terms_version).toBe(TERMS_VERSION);
    expect(recorded?.terms_accepted_at).toBeGreaterThanOrEqual(before);
  });

  it("keeps the time of an earlier acceptance of the same version", async () => {
    const h = createHarness();
    const email = "accept-twice@example.test";
    const cookie = await h.signIn(email);
    const first = await termsOf(email);
    await h.request("/api/auth/accept-terms", json(TERMS_ACCEPTANCE, { cookie }));
    expect(await termsOf(email)).toEqual(first);
  });
});

describe("sign-up with an email code", () => {
  it("is refused without the acceptance, and no account is created", async () => {
    const h = createHarness();
    const email = "no-terms@example.test";
    const response = await signInWithCode(h, email);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: TERMS_NOT_ACCEPTED });
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect(await termsOf(email)).toBeNull();
  });

  it("is refused with a forged, expired or outdated acceptance", async () => {
    const h = createHarness();
    const now = Date.now();
    const valid = await sealAcceptance(SECRET, TERMS_VERSION, now);
    const forged = [
      `${valid.slice(0, -2)}xx`,
      await sealAcceptance("another-secret-of-enough-length-0123456789", TERMS_VERSION, now),
      await sealAcceptance(SECRET, TERMS_VERSION, now - (TERMS_COOKIE_TTL_SECONDS + 1) * 1000),
      await sealAcceptance(SECRET, "2000-01-01", now),
    ];
    for (const [index, value] of forged.entries()) {
      const email = `forged-${index}@example.test`;
      const response = await signInWithCode(h, email, `${TERMS_COOKIE}=${value}`);
      expect(response.status, value).toBe(403);
      expect(await termsOf(email)).toBeNull();
    }
  });

  it("records the version and the time of acceptance on the new account", async () => {
    const h = createHarness();
    const email = "with-terms@example.test";
    const cookie = await h.acceptTerms();
    const acceptedAt = (
      await openAcceptance(SECRET, readCookie(cookie, TERMS_COOKIE) ?? "", Date.now())
    )?.acceptedAt.getTime();
    const response = await signInWithCode(h, email, cookie);
    expect(response.status).toBe(200);
    expect(await termsOf(email)).toEqual({
      terms_version: TERMS_VERSION,
      terms_accepted_at: acceptedAt,
    });
    // The session the login page reads says which version the account accepted.
    const session = await h.request("/api/auth/get-session", {
      headers: { cookie: cookieHeader(response) },
    });
    const body = await session.json<{ user: { termsVersion: string } }>();
    expect(body.user.termsVersion).toBe(TERMS_VERSION);
  });

  it("cannot set the recorded version through the sign-in body", async () => {
    const h = createHarness();
    const email = "sneaky@example.test";
    const otp = await sendCode(h, email);
    const response = await h.request(
      "/api/auth/sign-in/email-otp",
      json({ email, otp, termsVersion: TERMS_VERSION }),
    );
    expect(response.status).not.toBe(200);
    expect(await termsOf(email)).toBeNull();
  });
});

describe("existing accounts", () => {
  it("must accept the current terms at their next sign-in", async () => {
    const h = createHarness();
    const email = "returning@example.test";
    await h.signIn(email);
    await env.DB.prepare("update users set terms_version = '2000-01-01' where email = ?")
      .bind(email)
      .run();

    const refused = await signInWithCode(h, email);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: TERMS_NOT_ACCEPTED });
    expect((await termsOf(email))?.terms_version).toBe("2000-01-01");

    const accepted = await signInWithCode(h, email, await h.acceptTerms());
    expect(accepted.status).toBe(200);
    expect((await termsOf(email))?.terms_version).toBe(TERMS_VERSION);
  });

  it("sign in without asking again once they accepted the current version", async () => {
    const h = createHarness();
    const email = "accepted-before@example.test";
    await h.signIn(email);
    const response = await signInWithCode(h, email);
    expect(response.status).toBe(200);
  });

  it("with a session from before are sent to the login page until they accept", async () => {
    const h = createHarness();
    const email = "live-session@example.test";
    const cookie = await h.signIn(email);
    await forgetTerms(email);

    const page = await h.request("/", { headers: { cookie }, redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/login?${new URLSearchParams({ next: "/" })}`);

    const api = await h.request("/api/v1/artifacts", {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(api.status).toBe(401);

    const read = await h.request(`/read/k7d2qm4xab?state=${"n".repeat(43)}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(read.headers.get("location")).toMatch(/^\/login\?next=%2Fread%2Fk7d2qm4xab/);

    // The login page sees the session without the current version and asks for it.
    const session = await h.request("/api/auth/get-session", { headers: { cookie } });
    expect(
      (await session.json<{ user: { termsVersion: string | null } }>()).user.termsVersion,
    ).toBe(null);
    await h.request("/api/auth/accept-terms", json(TERMS_ACCEPTANCE, { cookie }));
    expect((await h.request("/", { headers: { cookie } })).status).toBe(200);
  });
});

describe("terms hooks", () => {
  const hooks = termsHooks(env.DB, SECRET);
  const withCookie = async () =>
    `${TERMS_COOKIE}=${await sealAcceptance(SECRET, TERMS_VERSION, Date.now())}`;

  it("refuses to create an account outside a request", async () => {
    await expect(hooks.user.create.before({ email: "x@example.test" }, null)).rejects.toMatchObject(
      { body: { code: TERMS_NOT_ACCEPTED } },
    );
  });

  it("reads the acceptance from the request when the context has no headers", async () => {
    const request = new Request(ORIGIN, { headers: { cookie: await withCookie() } });
    const result = await hooks.user.create.before({ email: "x@example.test" }, { request });
    expect(result.data.termsVersion).toBe(TERMS_VERSION);
  });

  it("does not clear anything when the browser sent no acceptance", async () => {
    const cleared: string[] = [];
    const setCookie = (name: string) => {
      cleared.push(name);
      return "";
    };
    await hooks.session.create.after(null, { headers: new Headers(), setCookie });
    await hooks.session.create.after(null, null);
    expect(cleared).toEqual([]);
  });
});

describe("acceptance cookie values", () => {
  it("are refused when malformed", async () => {
    const now = Date.now();
    const valid = await sealAcceptance(SECRET, TERMS_VERSION, now);
    const [version, issued, signature] = valid.split(".");
    for (const value of [
      "",
      `${version}.${issued}`,
      `${valid}.extra`,
      `${version}.not-a-time.${signature}`,
      `${version}.${now + 60_000}.${signature}`,
      `${version}.${issued}.%%%`,
    ]) {
      expect(await openAcceptance(SECRET, value, now), value).toBeUndefined();
    }
  });

  it("are read by exact name only", () => {
    expect(readCookie(`a=1; ${TERMS_COOKIE}=v; b=2`, TERMS_COOKIE)).toBe("v");
    expect(readCookie(`${TERMS_COOKIE.toLowerCase()}=v`, TERMS_COOKIE)).toBeUndefined();
    expect(readCookie("=v; novalue", TERMS_COOKIE)).toBeUndefined();
    expect(readCookie(null, TERMS_COOKIE)).toBeUndefined();
  });
});
