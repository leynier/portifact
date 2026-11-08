import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LOGIN_CSP, PAGE_CSP, withHumanCheck } from "../src/app-host.ts";
import { createHarness, json, ORIGIN, SESSION_COOKIE } from "./harness.ts";

const ARTIFACT_ORIGIN = "https://k7d2qm4xab.portifact.dev";

function get(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });
}

describe("auth pages on app.portifact.com", () => {
  for (const [path, heading] of [
    ["/login", "Sign in to Portifact"],
    ["/device", "Connect a device"],
    ["/consent", "Allow access"],
  ] as const) {
    it(`serves ${path} with a strict CSP, no caching and no referrer`, async () => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toBe(
        path === "/login" ? LOGIN_CSP : PAGE_CSP,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
      const html = await response.text();
      expect(html).toContain(heading);
      expect(html).toContain('alt="portifact"');
    });
  }

  it("keeps the CSP strict: no inline code, no framing, no other origins", () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("script-src 'self'");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(PAGE_CSP).not.toContain("unsafe");
    expect(PAGE_CSP).not.toMatch(/https?:/);
  });

  it("lets only the login page load Turnstile, and nothing else from another origin", () => {
    const challenges = "https://challenges.cloudflare.com";
    expect(LOGIN_CSP).toBe(
      `${PAGE_CSP.replace("script-src 'self'", `script-src 'self' ${challenges}`)}; frame-src ${challenges}`,
    );
    expect(LOGIN_CSP).not.toContain("unsafe");
    expect(LOGIN_CSP.match(/https?:\/\/[^\s;]+/g)).toEqual([challenges, challenges]);
    // A policy that already frames something keeps it and adds the challenge frame.
    expect(withHumanCheck("script-src 'self'; frame-src https://a.test; img-src 'self'")).toBe(
      `script-src 'self' ${challenges}; frame-src https://a.test ${challenges}; img-src 'self'`,
    );
  });

  it("gives the login page the public Turnstile site key, escaped, and no other page", async () => {
    const html = await (await get("/login")).text();
    expect(html).toContain(
      '<meta name="portifact-turnstile-site-key" content="1x00000000000000000000AA">',
    );
    for (const path of ["/device", "/consent", "/report"]) {
      expect(await (await get(path)).text(), path).not.toContain("portifact-turnstile-site-key");
    }
    const { withSiteKey } = await import("../src/app-host.ts");
    const page = () =>
      new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } });
    expect(await withSiteKey(page(), 'k"><script>').text()).toContain(
      'content="k&quot;&gt;&lt;script&gt;"',
    );
    expect(await withSiteKey(page(), "").text()).not.toContain("<meta");
  });

  it("serves the bundles and favicon the pages load", async () => {
    const html = await (await get("/login")).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) expect((await get(asset ?? "")).status, asset).toBe(200);
    expect((await get("/favicon.svg")).status).toBe(200);
  });

  it("sends the root, where the landing's Sign in link points, to the login page", async () => {
    const response = await get("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2F");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for unknown paths", async () => {
    for (const path of ["/dashboard", "/api/v1/unknown", "/login/extra", "/.well-known/x"]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});

describe("auth API surface", () => {
  it("answers only the endpoints Portifact uses", async () => {
    const h = createHarness();
    for (const [method, path] of [
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/admin/oauth2/create-client"],
      ["POST", "/api/auth/oauth2/create-client"],
      ["GET", "/api/auth/oauth2/get-clients"],
      ["POST", "/api/auth/oauth2/introspect"],
      ["GET", "/api/auth/oauth2/userinfo"],
      ["POST", "/api/auth/device/token"],
      ["POST", "/api/auth/link-social"],
      ["POST", "/api/auth/unlink-account"],
      ["GET", "/api/auth/list-sessions"],
      ["GET", "/api/auth/error"],
      ["GET", "/api/auth/sign-out"],
      ["GET", "/api/auth/oauth2/token"],
    ] as const) {
      const response = await h.request(path, method === "POST" ? json({}) : { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("marks every auth response as not cacheable and without referrer", async () => {
    const h = createHarness();
    for (const response of [
      await h.request("/api/auth/get-session"),
      await h.request("/api/auth/does-not-exist"),
      await h.request("/api/auth/callback/github?code=x&state=y", { redirect: "manual" }),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("refuses browser mutations without the exact app origin", async () => {
    const h = createHarness();
    const body = { email: "csrf@example.test", type: "sign-in" };
    const path = "/api/auth/email-otp/send-verification-otp";
    for (const origin of [
      ARTIFACT_ORIGIN,
      "https://portifact.com",
      "null",
      `${ORIGIN}.evil.example`,
    ]) {
      const response = await h.request(path, json(body, { origin }));
      expect(response.status, origin).toBe(403);
    }
    const missing = await h.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(403);
    expect(h.outbox).toHaveLength(0);
  });

  it("never answers with credentialed CORS for artifact origins", async () => {
    const h = createHarness();
    const cookie = await h.signIn("cors@example.test");
    for (const init of [
      { headers: { origin: ARTIFACT_ORIGIN, cookie } },
      {
        method: "OPTIONS",
        headers: {
          origin: ARTIFACT_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      },
    ]) {
      const response = await h.request("/api/auth/get-session", init);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("session cookie", () => {
  it("is __Host- prefixed, Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain", async () => {
    const h = createHarness();
    const email = "cookie@example.test";
    await h.request("/api/auth/email-otp/send-verification-otp", json({ email, type: "sign-in" }));
    const code = h.outbox.at(-1)?.text.match(/(\d{6})/)?.[1];
    const response = await h.request(
      "/api/auth/sign-in/email-otp",
      json({ email, otp: code }, { cookie: await h.beforeSignIn() }),
    );
    const cookies = response.headers.getSetCookie();
    // The session cookie, and the used terms acceptance being cleared.
    expect(cookies.some((cookie) => cookie.startsWith("__Host-pf_terms=;"))).toBe(true);
    expect(cookies.length).toBeGreaterThan(1);
    for (const cookie of cookies) {
      const [nameValue, ...attributes] = cookie.split(/;\s*/);
      expect(nameValue?.startsWith("__Host-")).toBe(true);
      const lower = attributes.map((attribute) => attribute.toLowerCase());
      expect(lower).toContain("secure");
      expect(lower).toContain("httponly");
      expect(lower).toContain("path=/");
      expect(lower).toContain("samesite=lax");
      expect(lower.some((attribute) => attribute.startsWith("domain"))).toBe(false);
    }
    expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });

  it("identifies the user on the app host and ends on sign-out", async () => {
    const h = createHarness();
    const cookie = await h.signIn("session@example.test");
    const session = await h.request("/api/auth/get-session", { headers: { cookie } });
    expect(await session.json()).toMatchObject({ user: { email: "session@example.test" } });

    const signOut = await h.request("/api/auth/sign-out", json({}, { cookie }));
    expect(signOut.status).toBe(200);
    expect(signOut.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
    const after = await h.request("/api/auth/get-session", { headers: { cookie } });
    expect(await after.json()).toBeNull();
  });

  it("ignores a lowercase __host- cookie that a sibling could inject", async () => {
    const h = createHarness();
    const cookie = await h.signIn("case@example.test");
    const forged = cookie.replace("__Host-", "__host-");
    const session = await h.request("/api/auth/get-session", { headers: { cookie: forged } });
    expect(await session.json()).toBeNull();
  });
});
