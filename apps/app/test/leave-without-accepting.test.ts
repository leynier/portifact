// Leaving without accepting new terms (docs/legal.md, "Leaving without accepting"): a session of
// an account on an older version still counts as none for the dashboard and the API, but it can
// download the account's data and delete the account with a code emailed to its address. The
// deletion code never signs anyone in, a sign-in code never deletes, and nothing records an
// acceptance.
import { env } from "cloudflare:workers";
import { OTP_LIMITS, TERMS_VERSION } from "@portifact/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_ROUTES } from "../src/app-host.ts";
import { RecipientSuppressedError } from "../src/auth/email.ts";
import { codeFrom, createHarness, type Harness, json, ORIGIN } from "./harness.ts";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limits");
});

/** What the login page's fetch sends: the session cookie and same-origin fetch metadata. */
function page(cookie: string, method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...(method === "GET" ? {} : { origin: ORIGIN }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Signs in, then puts the account back on an older version of the terms. */
async function leaving(h: Harness, email: string): Promise<string> {
  const cookie = await h.signIn(email);
  await env.DB.prepare(
    "update users set terms_version = '2000-01-01', terms_accepted_at = 0 where email = ?",
  )
    .bind(email)
    .run();
  await env.DB.prepare(
    "delete from terms_acceptances where user_id = (select id from users where email = ?)",
  )
    .bind(email)
    .run();
  return cookie;
}

async function acceptances(email: string): Promise<number> {
  const row = await env.DB.prepare(
    "select count(*) as n from terms_acceptances t join users u on u.id = t.user_id where u.email = ?",
  )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function termsVersion(email: string) {
  const row = await env.DB.prepare("select terms_version from users where email = ?")
    .bind(email)
    .first<{ terms_version: string | null }>();
  return row?.terms_version;
}

async function accountExists(email: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as one from users where email = ?")
    .bind(email)
    .first();
  return row !== null;
}

async function askForCode(h: Harness, cookie: string): Promise<Response> {
  return h.request("/api/v1/account/deletion-code", page(cookie, "POST", {}));
}

async function deletionCode(h: Harness, cookie: string, email: string): Promise<string> {
  await env.DB.exec("DELETE FROM rate_limits");
  const response = await askForCode(h, cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: true, expiresInMinutes: 5 });
  const message = h.outbox.findLast((m) => m.to === email);
  expect(message?.subject).toBe("Your code to delete your Portifact account");
  return codeFrom(message);
}

async function deleteWith(h: Harness, cookie: string, code: string): Promise<Response> {
  return h.request("/api/v1/account/delete-with-code", page(cookie, "POST", { code }));
}

describe("a session without the current terms", () => {
  it("still counts as none for every dashboard route and the API", async () => {
    const h = createHarness();
    const cookie = await leaving(h, "still-none@example.test");
    for (const route of DASHBOARD_ROUTES) {
      const path = route.replace(":artifactId", "k7d2qm4xab");
      const response = await h.request(path, { headers: { cookie }, redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toMatch(/^\/login\?next=/);
    }
    const api = await h.request("/api/v1/artifacts", page(cookie));
    expect(api.status).toBe(401);
    expect(await acceptances("still-none@example.test")).toBe(0);
  });

  it("downloads the account's data and records no acceptance", async () => {
    const h = createHarness();
    const email = "export-old@example.test";
    const cookie = await leaving(h, email);
    const response = await h.request("/api/v1/account/export", page(cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="portifact-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const body = await response.json<{ account: { email: string } }>();
    expect(body.account.email).toBe(email);
    expect(await acceptances(email)).toBe(0);
    expect(await termsVersion(email)).toBe("2000-01-01");
  });

  it("can turn email notices off, and nothing else, in the settings", async () => {
    const h = createHarness();
    const cookie = await leaving(h, "settings-old@example.test");
    const patch = (body: unknown) =>
      h.request("/api/v1/account/settings", page(cookie, "PATCH", body));
    for (const body of [
      { expiryNotices: false },
      { commentNotices: false, expiryNotices: false },
    ]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(200);
    }
    for (const body of [
      { expiryNotices: true },
      { commentNotices: true },
      { commentNotices: false, locale: "es" },
      { defaultAccessMode: "public" },
      { defaultBar: false },
    ]) {
      const refused = await patch(body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect((await refused.json<{ error: { code: string } }>()).error.code).toBe(
        "terms_not_accepted",
      );
    }
    const read = await h.request("/api/v1/account/settings", page(cookie));
    expect(await read.json()).toMatchObject({ expiryNotices: false, commentNotices: false });
  });

  it("can mute an artifact's comment notices, never unmute one", async () => {
    const h = createHarness();
    const cookie = await leaving(h, "mute-old@example.test");
    const put = (muted: boolean) =>
      h.request("/api/v1/account/comment-notices/k7d2qm4xab", page(cookie, "PUT", { muted }));
    // Muting passes the terms gate and reaches the service, which finds no such artifact.
    expect((await put(true)).status).toBe(404);
    const unmute = await put(false);
    expect(unmute.status).toBe(403);
    expect((await unmute.json<{ error: { code: string } }>()).error.code).toBe(
      "terms_not_accepted",
    );
  });

  it("cannot change the brand, and can still remove it", async () => {
    const h = createHarness();
    const cookie = await leaving(h, "brand-old@example.test");
    const brand = await h.request("/api/v1/account/branding", page(cookie, "PUT", { name: "X" }));
    expect(brand.status).toBe(403);
    const logo = await h.request("/api/v1/account/branding/logo", page(cookie, "PUT", {}));
    expect(logo.status).toBe(403);
    for (const path of ["/api/v1/account/branding", "/api/v1/account/branding/logo"]) {
      const removed = await h.request(path, page(cookie, "DELETE"));
      const body = await removed.json<{ error?: { code: string } }>();
      expect(body.error?.code, path).not.toBe("terms_not_accepted");
    }
  });

  it("reads every account page it reached before", async () => {
    const h = createHarness();
    const cookie = await leaving(h, "reads-old@example.test");
    for (const path of [
      "/api/v1/account/settings",
      "/api/v1/account/sessions",
      "/api/v1/account/apps",
      "/api/v1/account/suspension",
    ]) {
      expect((await h.request(path, page(cookie))).status, path).toBe(200);
    }
  });
});

describe("deleting the account with an emailed code", () => {
  it("deletes the account with a valid code, signs nobody in and records no acceptance", async () => {
    const h = createHarness();
    const email = "leave-ok@example.test";
    const cookie = await leaving(h, email);
    const code = await deletionCode(h, cookie, email);
    const response = await deleteWith(h, cookie, code);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-pf\.session_token=; Max-Age=0/);
    expect(await accountExists(email)).toBe(false);
    expect(await acceptances(email)).toBe(0);
    // The session went with the account.
    const session = await h.request("/api/auth/get-session", { headers: { cookie } });
    expect(await session.json()).toBe(null);
  });

  it("refuses a wrong code, an expired one and a reused one", async () => {
    const h = createHarness();
    const email = "leave-wrong@example.test";
    const cookie = await leaving(h, email);
    const code = await deletionCode(h, cookie, email);
    const wrong = code === "000000" ? "111111" : "000000";
    const refused = await deleteWith(h, cookie, wrong);
    expect(refused.status).toBe(400);
    expect(await accountExists(email)).toBe(true);
    await env.DB.prepare(
      "update account_deletion_codes set expires_at = 0 where user_id = (select id from users where email = ?)",
    )
      .bind(email)
      .run();
    expect((await deleteWith(h, cookie, code)).status).toBe(400);
    expect(await accountExists(email)).toBe(true);

    // A code works once: the second account deletes with its code, then cannot use it again.
    const other = "leave-reuse@example.test";
    const otherCookie = await leaving(h, other);
    const otherCode = await deletionCode(h, otherCookie, other);
    expect((await deleteWith(h, otherCookie, otherCode)).status).toBe(200);
    expect((await deleteWith(h, otherCookie, otherCode)).status).toBe(401);
    expect(await acceptances(email)).toBe(0);
  });

  it("refuses one account's code from another account", async () => {
    const h = createHarness();
    const a = "leave-a@example.test";
    const b = "leave-b@example.test";
    const cookieA = await leaving(h, a);
    const cookieB = await leaving(h, b);
    const codeA = await deletionCode(h, cookieA, a);
    expect((await deleteWith(h, cookieB, codeA)).status).toBe(400);
    expect(await accountExists(a)).toBe(true);
    expect(await accountExists(b)).toBe(true);
  });

  it("is not something a sign-in code can do", async () => {
    const h = createHarness();
    const email = "leave-signin-code@example.test";
    const cookie = await leaving(h, email);
    await env.DB.exec("DELETE FROM rate_limits");
    await h.request("/api/auth/email-otp/send-verification-otp", json({ email, type: "sign-in" }));
    const signInCode = codeFrom(h.outbox.findLast((m) => m.to === email));
    await askForCode(h, cookie);
    expect((await deleteWith(h, cookie, signInCode)).status).toBe(400);
    expect(await accountExists(email)).toBe(true);
  });

  it("never signs anyone in", async () => {
    const h = createHarness();
    const email = "leave-no-sign-in@example.test";
    const cookie = await leaving(h, email);
    const code = await deletionCode(h, cookie, email);
    const terms = await h.acceptTerms();
    const signIn = await h.request(
      "/api/auth/sign-in/email-otp",
      json({ email, otp: code }, { cookie: terms }),
    );
    expect(signIn.status).not.toBe(200);
    expect(signIn.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await termsVersion(email)).toBe("2000-01-01");
    expect(await acceptances(email)).toBe(0);
  });

  it("is refused to an account that accepted the current terms", async () => {
    const h = createHarness();
    const email = "leave-current@example.test";
    const cookie = await h.signIn(email);
    const response = await askForCode(h, cookie);
    expect(response.status).toBe(403);
    expect(h.outbox.filter((m) => m.subject.includes("delete"))).toEqual([]);
    expect(await termsVersion(email)).toBe(TERMS_VERSION);
  });

  it("needs a session from the app's own pages", async () => {
    const h = createHarness();
    const email = "leave-origin@example.test";
    const cookie = await leaving(h, email);
    const crossSite = await h.request("/api/v1/account/deletion-code", {
      method: "POST",
      headers: {
        cookie,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    const bearer = await h.request("/api/v1/account/deletion-code", {
      ...page(cookie, "POST", {}),
      headers: { ...page(cookie, "POST").headers, authorization: "Bearer x" },
    });
    expect(bearer.status).toBe(403);
    const none = await h.request("/api/v1/account/deletion-code", page("", "POST", {}));
    expect(none.status).toBe(401);
    expect(h.outbox.filter((m) => m.to === email && m.subject.includes("delete"))).toEqual([]);
  });

  it("is limited like the sign-in code", async () => {
    const h = createHarness();
    const email = "leave-limits@example.test";
    const cookie = await leaving(h, email);
    expect((await askForCode(h, cookie)).status).toBe(200);
    // One code a minute per account.
    const again = await askForCode(h, cookie);
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(OTP_LIMITS.perEmailCooldown.max).toBe(1);
    // Attempts are limited per IP.
    for (let i = 0; i < 30; i++) await deleteWith(h, cookie, "000000");
    expect((await deleteWith(h, cookie, "000000")).status).toBe(429);
    expect(await accountExists(email)).toBe(true);
  });

  it("refuses a suppressed address before sending anything", async () => {
    const h = createHarness();
    const email = "leave-suppressed@example.test";
    const cookie = await leaving(h, email);
    const { suppressEmail } = await import("@portifact/services");
    const { regionsFromEnv } = await import("@portifact/db");
    await suppressEmail(regionsFromEnv(env).global, {
      email,
      reason: "hard_bounce",
      now: Date.now(),
    });
    const response = await askForCode(h, cookie);
    expect(response.status).toBe(403);
    expect(
      (await response.json<{ error: { details?: { reason?: string } } }>()).error.details?.reason,
    ).toBe("email_suppressed");
    expect(h.outbox.filter((m) => m.to === email && m.subject.includes("delete"))).toEqual([]);
  });

  it("suppresses an address Email Service refuses and says so, counting nothing", async () => {
    const email = "leave-provider@example.test";
    const cookie = await leaving(createHarness(), email);
    const refusing = createHarness({
      email: {
        send: async () => {
          throw new RecipientSuppressedError();
        },
      },
    });
    const response = await refusing.request("/api/v1/account/deletion-code", {
      ...page(cookie, "POST", {}),
      headers: { ...page(cookie, "POST").headers, "cf-connecting-ip": "192.0.2.80" },
    });
    expect(response.status).toBe(403);
    expect(
      (await response.json<{ error: { details?: { reason?: string } } }>()).error.details?.reason,
    ).toBe("email_suppressed");
    const { isEmailSuppressed } = await import("@portifact/services");
    const { regionsFromEnv } = await import("@portifact/db");
    expect(await isEmailSuppressed(regionsFromEnv(env).global, email, Date.now())).toBe(true);
  });

  it("answers capacity_unavailable when the email could not be sent, without suppressing", async () => {
    const email = "leave-flaky@example.test";
    const cookie = await leaving(createHarness(), email);
    const failing = createHarness({
      email: {
        send: async () => {
          throw new Error("email delivery failed");
        },
      },
    });
    const response = await failing.request(
      "/api/v1/account/deletion-code",
      page(cookie, "POST", {}),
    );
    expect(response.status).toBe(503);
    const { isEmailSuppressed } = await import("@portifact/services");
    const { regionsFromEnv } = await import("@portifact/db");
    expect(await isEmailSuppressed(regionsFromEnv(env).global, email, Date.now())).toBe(false);
  });

  it("refuses a body that is not an empty object or a six-digit code", async () => {
    const h = createHarness();
    const cookie = await leaving(h, "leave-input@example.test");
    const extra = await h.request(
      "/api/v1/account/deletion-code",
      page(cookie, "POST", { email: "someone-else@example.test" }),
    );
    expect(extra.status).toBe(400);
    for (const code of ["12345", "abcdef", "1234567"]) {
      expect((await deleteWith(h, cookie, code)).status, code).toBe(400);
    }
    const withUser = await h.request(
      "/api/v1/account/delete-with-code",
      page(cookie, "POST", { code: "123456", userId: "u_other" }),
    );
    expect(withUser.status).toBe(400);
    expect(await accountExists("leave-input@example.test")).toBe(true);
  });

  it("tells the sole admin of a workspace what to do", async () => {
    const h = createHarness();
    const email = "leave-admin@example.test";
    const cookie = await leaving(h, email);
    const { createWorkspace } = await import("@portifact/services");
    const { regionsFromEnv } = await import("@portifact/db");
    const user = await env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .first<{ id: string }>();
    await createWorkspace(regionsFromEnv(env).global, {
      slug: "leave-admin-ws",
      name: "Team",
      adminUserId: user?.id ?? "",
      now: Date.now(),
    });
    const response = await askForCode(h, cookie);
    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("sole_workspace_admin");
    // Members cannot be changed without the current terms: say what the person can do.
    expect(body.error.message).toContain("accept the terms");
    expect(body.error.message).toContain("Settings");
    expect(body.error.message).toContain("privacy@portifact.com");
  });
});
