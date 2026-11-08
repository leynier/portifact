import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpClient, startAuthorization } from "./flows.ts";
import {
  cookieHeader,
  createHarness,
  type Harness,
  ISSUER,
  json,
  ORIGIN,
  pkcePair,
  SESSION_COOKIE,
} from "./harness.ts";

// Google and GitHub are external identity providers: the only part of these flows that is
// faked. Better Auth calls them with the global fetch, so the test replaces it.
interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

interface GitHubProfile {
  id: number;
  login: string;
  email: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
}

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fakeProviders(google?: GoogleProfile, github?: GitHubProfile) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token") && google) {
      const idToken = `${base64Url({ alg: "RS256", typ: "JWT" })}.${base64Url({
        iss: "https://accounts.google.com",
        aud: env.GOOGLE_CLIENT_ID,
        ...google,
      })}.signature`;
      return Response.json({
        access_token: "google-access-token",
        id_token: idToken,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email profile",
      });
    }
    if (url.startsWith("https://github.com/login/oauth/access_token") && github) {
      return Response.json({
        access_token: "github-access-token",
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url === "https://api.github.com/user" && github) {
      return Response.json({
        id: github.id,
        login: github.login,
        name: null,
        email: github.email,
        avatar_url: "https://avatars.example/u.png",
      });
    }
    if (url === "https://api.github.com/user/emails" && github) {
      return Response.json(github.emails);
    }
    return new Response("unexpected request", { status: 500 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Starts a social sign-in from the login page and returns the provider URL and cookies. */
async function startSocial(h: Harness, provider: "google" | "github", body: object = {}) {
  const response = await h.request(
    "/api/auth/sign-in/social",
    json({ provider, callbackURL: "/login", errorCallbackURL: "/login", ...body }),
  );
  expect(response.status).toBe(200);
  const { url } = await response.json<{ url: string }>();
  return { providerUrl: new URL(url), cookie: cookieHeader(response) };
}

/** The provider sends the browser back to the callback with a code and the state. */
async function finishSocial(h: Harness, provider: "google" | "github", body: object = {}) {
  const { providerUrl, cookie } = await startSocial(h, provider, body);
  const state = providerUrl.searchParams.get("state") ?? "";
  // The browser follows the provider's redirect as a top-level navigation.
  return h.request(`/api/auth/callback/${provider}?code=provider-code&state=${state}`, {
    headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    redirect: "manual",
  });
}

async function usersWithEmail(email: string) {
  const rows = await env.DB.prepare("select id from users where email = ?").bind(email).all();
  return rows.results;
}

describe("sign-in with Google", () => {
  it("sends the browser to Google with this app's client and callback", async () => {
    const h = createHarness();
    const { providerUrl } = await startSocial(h, "google");
    expect(providerUrl.origin).toBe("https://accounts.google.com");
    expect(providerUrl.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(`${ISSUER}/callback/google`);
    expect(providerUrl.searchParams.get("state")).toEqual(expect.any(String));
    expect(providerUrl.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("creates an account and a session, and keeps no Google tokens", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-1001", email: "gina@example.test", email_verified: true });
    const callback = await finishSocial(h, "google");
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location") ?? "", ORIGIN).pathname).toBe("/login");
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      true,
    );

    const account = await env.DB.prepare(
      "select account_id, provider_id, access_token, refresh_token, id_token from accounts where provider_id = 'google' and account_id = 'google-1001'",
    ).first();
    expect(account).toEqual({
      account_id: "google-1001",
      provider_id: "google",
      access_token: null,
      refresh_token: null,
      id_token: null,
    });
  });

  it("finds a returning user by Google's stable ID even if the email changed", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-2002", email: "before@example.test", email_verified: true });
    const first = await finishSocial(h, "google");
    const firstSession = await h.request("/api/auth/get-session", {
      headers: { cookie: cookieHeader(first) },
    });
    const { user } = await firstSession.json<{ user: { id: string } }>();

    fakeProviders({ sub: "google-2002", email: "after@example.test", email_verified: true });
    const second = await finishSocial(h, "google");
    const secondSession = await h.request("/api/auth/get-session", {
      headers: { cookie: cookieHeader(second) },
    });
    expect((await secondSession.json<{ user: { id: string } }>()).user.id).toBe(user.id);
    expect(await usersWithEmail("after@example.test")).toEqual([]);
  });

  it("does not merge into an existing account just because the email matches", async () => {
    const h = createHarness();
    await h.signIn("shared@example.test");
    fakeProviders({ sub: "google-3003", email: "shared@example.test", email_verified: true });
    const callback = await finishSocial(h, "google");
    const location = new URL(callback.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("account_not_linked");
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    const linked = await env.DB.prepare(
      "select id from accounts where provider_id = 'google' and account_id = 'google-3003'",
    ).all();
    expect(linked.results).toEqual([]);
  });

  it("refuses an account whose email Google does not vouch for", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-4004", email: "unverified@example.test", email_verified: false });
    const callback = await finishSocial(h, "google");
    const location = new URL(callback.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("email_not_verified");
    expect(await usersWithEmail("unverified@example.test")).toEqual([]);
  });

  it("rejects a callback whose state does not match the browser's", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-5005", email: "state@example.test", email_verified: true });
    const { cookie } = await startSocial(h, "google");
    const callback = await h.request("/api/auth/callback/google?code=x&state=forged", {
      headers: { cookie },
      redirect: "manual",
    });
    expect(new URL(callback.headers.get("location") ?? "", ORIGIN).searchParams.get("error")).toBe(
      "state_mismatch",
    );
    expect(await usersWithEmail("state@example.test")).toEqual([]);
  });

  it("does not follow a callback URL on another site", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/sign-in/social",
      json({ provider: "google", callbackURL: "https://evil.example/steal" }),
    );
    expect(response.status).toBe(403);
  });

  it("continues an MCP client's authorization after the provider callback", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-6006", email: "mcp-google@example.test", email_verified: true });
    const clientId = await registerMcpClient(h);
    const { challenge } = await pkcePair();
    const authorize = await startAuthorization(h, {
      clientId,
      cookie: "",
      codeChallenge: challenge,
    });
    const login = new URL(authorize.headers.get("location") ?? "", ORIGIN);
    const callback = await finishSocial(h, "google", { oauth_query: login.search.slice(1) });
    expect(new URL(callback.headers.get("location") ?? "", ORIGIN).pathname).toBe("/consent");
  });
});

describe("sign-in with GitHub", () => {
  it("works with a private email, using the primary verified address", async () => {
    const h = createHarness();
    fakeProviders(undefined, {
      id: 7007,
      login: "octo",
      email: null,
      emails: [
        { email: "octo-old@example.test", primary: false, verified: true },
        { email: "octo@example.test", primary: true, verified: true },
      ],
    });
    const callback = await finishSocial(h, "github");
    expect(callback.status).toBe(302);
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      true,
    );
    const account = await env.DB.prepare(
      "select a.account_id, u.email, u.email_verified from accounts a join users u on u.id = a.user_id where a.provider_id = 'github'and a.account_id = '7007'",
    ).first();
    expect(account).toEqual({ account_id: "7007", email: "octo@example.test", email_verified: 1 });
  });

  it("refuses an account whose primary email is not verified on GitHub", async () => {
    const h = createHarness();
    fakeProviders(undefined, {
      id: 8008,
      login: "unverified",
      email: null,
      emails: [{ email: "gh-unverified@example.test", primary: true, verified: false }],
    });
    const callback = await finishSocial(h, "github");
    expect(new URL(callback.headers.get("location") ?? "", ORIGIN).searchParams.get("error")).toBe(
      "email_not_verified",
    );
    expect(await usersWithEmail("gh-unverified@example.test")).toEqual([]);
  });

  it("keeps Google and GitHub accounts with the same email apart", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-9009", email: "both@example.test", email_verified: true });
    await finishSocial(h, "google");
    fakeProviders(undefined, {
      id: 9009,
      login: "both",
      email: "both@example.test",
      emails: [{ email: "both@example.test", primary: true, verified: true }],
    });
    const callback = await finishSocial(h, "github");
    expect(new URL(callback.headers.get("location") ?? "", ORIGIN).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    const accounts = await env.DB.prepare(
      "select provider_id from accounts a join users u on u.id = a.user_id where u.email = 'both@example.test'",
    ).all();
    expect(accounts.results).toEqual([{ provider_id: "google" }]);
  });
});

/** A signed-in user starts linking a provider; returns the provider URL and the state cookie. */
async function startLink(h: Harness, cookie: string, provider: "google" | "github") {
  const response = await h.request(
    "/api/auth/link-social",
    json(
      { provider, callbackURL: `/login?linked=${provider}`, errorCallbackURL: "/login" },
      { cookie },
    ),
  );
  expect(response.status).toBe(200);
  const { url } = await response.json<{ url: string }>();
  return { providerUrl: new URL(url), stateCookie: cookieHeader(response) };
}

/** Runs the whole link: start it, then come back from the provider with the session. */
async function finishLink(h: Harness, cookie: string, provider: "google" | "github") {
  const { providerUrl, stateCookie } = await startLink(h, cookie, provider);
  const state = providerUrl.searchParams.get("state") ?? "";
  return h.request(`/api/auth/callback/${provider}?code=provider-code&state=${state}`, {
    headers: {
      cookie: [cookie, stateCookie].filter(Boolean).join("; "),
      accept: "text/html",
      "sec-fetch-mode": "navigate",
    },
    redirect: "manual",
  });
}

async function providersOf(email: string) {
  const rows = await env.DB.prepare(
    "select a.provider_id from accounts a join users u on u.id = a.user_id where u.email = ? and a.provider_id in ('google', 'github') order by a.provider_id",
  )
    .bind(email)
    .all<{ provider_id: string }>();
  return rows.results.map((row) => row.provider_id);
}

async function userIdOf(h: Harness, cookie: string): Promise<string> {
  const response = await h.request("/api/auth/get-session", { headers: { cookie } });
  return (await response.json<{ user: { id: string } }>()).user.id;
}

const errorOf = (response: Response) =>
  new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("error");

describe("linking a provider to a signed-in account", () => {
  it("connects GitHub to an account that signed in with Google, and both then sign in", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-1101", email: "link@example.test", email_verified: true });
    const googleCookie = cookieHeader(await finishSocial(h, "google"));
    const userId = await userIdOf(h, googleCookie);

    fakeProviders(undefined, {
      id: 1101,
      login: "linker",
      email: "link@example.test",
      emails: [{ email: "link@example.test", primary: true, verified: true }],
    });
    const linked = await finishLink(h, googleCookie, "github");
    expect(linked.status).toBe(302);
    const location = new URL(linked.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname + location.search).toBe("/login?linked=github");
    expect(await providersOf("link@example.test")).toEqual(["github", "google"]);
    const tokens = await env.DB.prepare(
      "select access_token, refresh_token, id_token from accounts where provider_id = 'github' and account_id = '1101'",
    ).first();
    expect(tokens).toEqual({ access_token: null, refresh_token: null, id_token: null });

    const githubCookie = cookieHeader(await finishSocial(h, "github"));
    expect(await userIdOf(h, githubCookie)).toBe(userId);
  });

  it("connects Google to an account created with an email code", async () => {
    const h = createHarness();
    const cookie = await h.signIn("otp-link@example.test");
    fakeProviders({ sub: "google-1102", email: "otp-link@example.test", email_verified: true });
    const linked = await finishLink(h, cookie, "google");
    expect(errorOf(linked)).toBeNull();
    expect(await providersOf("otp-link@example.test")).toEqual(["google"]);
  });

  it("lists the providers connected to the signed-in account", async () => {
    const h = createHarness();
    const cookie = await h.signIn("list@example.test");
    fakeProviders({ sub: "google-1103", email: "list@example.test", email_verified: true });
    await finishLink(h, cookie, "google");
    const response = await h.request("/api/auth/list-accounts", { headers: { cookie } });
    expect(response.status).toBe(200);
    const accounts = await response.json<{ providerId: string }[]>();
    expect(accounts.map((account) => account.providerId)).toContain("google");
    expect(JSON.stringify(accounts)).not.toMatch(/accessToken|refreshToken|idToken/);
  });

  it("requires a session to list or link providers", async () => {
    const h = createHarness();
    expect((await h.request("/api/auth/list-accounts")).status).toBe(401);
    const link = await h.request(
      "/api/auth/link-social",
      json({ provider: "github", callbackURL: "/login" }),
    );
    expect(link.status).toBe(401);
  });

  it("refuses a link started from another site", async () => {
    const h = createHarness();
    const cookie = await h.signIn("csrf-link@example.test");
    const response = await h.request(
      "/api/auth/link-social",
      json(
        { provider: "github", callbackURL: "/login" },
        { cookie, origin: "https://evil.example" },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a provider account with a different email", async () => {
    const h = createHarness();
    const cookie = await h.signIn("owner@example.test");
    fakeProviders(undefined, {
      id: 1104,
      login: "someone-else",
      email: "attacker@example.test",
      emails: [{ email: "attacker@example.test", primary: true, verified: true }],
    });
    expect(errorOf(await finishLink(h, cookie, "github"))).toBe("email_does_not_match");
    expect(await providersOf("owner@example.test")).toEqual([]);
  });

  it("refuses a provider account whose email the provider does not vouch for", async () => {
    const h = createHarness();
    const cookie = await h.signIn("unvouched@example.test");
    fakeProviders({ sub: "google-1105", email: "unvouched@example.test", email_verified: false });
    expect(errorOf(await finishLink(h, cookie, "google"))).toBe("email_not_verified");
    expect(await providersOf("unvouched@example.test")).toEqual([]);
  });

  it("refuses a provider account that already belongs to another Portifact account", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-1106", email: "first@example.test", email_verified: true });
    await finishSocial(h, "google");
    const cookie = await h.signIn("second@example.test");
    fakeProviders({ sub: "google-1106", email: "second@example.test", email_verified: true });
    expect(errorOf(await finishLink(h, cookie, "google"))).toBe(
      "account_already_linked_to_different_user",
    );
    expect(await providersOf("second@example.test")).toEqual([]);
    expect(await providersOf("first@example.test")).toEqual(["google"]);
  });

  it("does not link when the session ended before the provider sent the browser back", async () => {
    const h = createHarness();
    const cookie = await h.signIn("ended@example.test");
    fakeProviders({ sub: "google-1107", email: "ended@example.test", email_verified: true });
    const { providerUrl, stateCookie } = await startLink(h, cookie, "google");
    await h.request("/api/auth/sign-out", json({}, { cookie }));
    const state = providerUrl.searchParams.get("state") ?? "";
    const callback = await h.request(`/api/auth/callback/google?code=c&state=${state}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
      redirect: "manual",
    });
    expect(errorOf(callback)).toBe("unable_to_link_account");
    expect(await providersOf("ended@example.test")).toEqual([]);
  });
});
