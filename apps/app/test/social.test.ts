import { env } from "cloudflare:workers";
import {
  HUMAN_VERIFICATION_REQUIRED,
  TERMS_NOT_ACCEPTED,
  TERMS_VERSION,
} from "@portifact/contracts";
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

/**
 * The provider sends the browser back to the callback with a code and the state. Like the login
 * page, it accepts the terms and solves the human check first, unless `before` says it only
 * accepts the terms (`"terms"`) or does neither (`false`).
 */
async function finishSocial(
  h: Harness,
  provider: "google" | "github",
  body: object = {},
  before: boolean | "terms" = true,
) {
  const terms = before === "terms" ? await h.acceptTerms() : before ? await h.beforeSignIn() : "";
  const { providerUrl, cookie } = await startSocial(h, provider, body);
  const state = providerUrl.searchParams.get("state") ?? "";
  // The browser follows the provider's redirect as a top-level navigation.
  return h.request(`/api/auth/callback/${provider}?code=provider-code&state=${state}`, {
    headers: {
      cookie: [cookie, terms].filter(Boolean).join("; "),
      accept: "text/html",
      "sec-fetch-mode": "navigate",
    },
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
    // The session records how it signed in, in the statement that created it (decision 0021).
    const session = await env.DB.prepare(
      "select s.sign_in_method as method from sessions s join users u on u.id = s.user_id where u.email = 'gina@example.test'",
    ).first<{ method: string | null }>();
    expect(session?.method).toBe("google");
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

  it("joins the existing account with the same verified email", async () => {
    const h = createHarness();
    const otpCookie = await h.signIn("shared@example.test");
    fakeProviders({ sub: "google-3003", email: "shared@example.test", email_verified: true });
    const callback = await finishSocial(h, "google");
    expect(errorOf(callback)).toBeNull();
    expect(await userIdOf(h, cookieHeader(callback))).toBe(await userIdOf(h, otpCookie));
    expect(await providersOf("shared@example.test")).toEqual(["google"]);
    expect(await usersWithEmail("shared@example.test")).toHaveLength(1);
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
    const session = await env.DB.prepare(
      "select s.sign_in_method as method from sessions s join users u on u.id = s.user_id where u.email = 'octo@example.test'",
    ).first<{ method: string | null }>();
    expect(session?.method).toBe("github");
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

  it("signs in to the Google account when GitHub has the same verified email", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-9009", email: "both@example.test", email_verified: true });
    const google = await finishSocial(h, "google");
    fakeProviders(undefined, {
      id: 9009,
      login: "both",
      email: "both@example.test",
      emails: [{ email: "both@example.test", primary: true, verified: true }],
    });
    const github = await finishSocial(h, "github");
    expect(errorOf(github)).toBeNull();
    expect(await userIdOf(h, cookieHeader(github))).toBe(await userIdOf(h, cookieHeader(google)));
    expect(await providersOf("both@example.test")).toEqual(["github", "google"]);
    const tokens = await env.DB.prepare(
      "select access_token, refresh_token, id_token from accounts where provider_id = 'github' and account_id = '9009'",
    ).first();
    expect(tokens).toEqual({ access_token: null, refresh_token: null, id_token: null });
  });

  it("does not join an existing account when GitHub has not verified the email", async () => {
    const h = createHarness();
    await h.signIn("claimed@example.test");
    fakeProviders(undefined, {
      id: 9010,
      login: "claimer",
      email: null,
      emails: [{ email: "claimed@example.test", primary: true, verified: false }],
    });
    const callback = await finishSocial(h, "github");
    expect(errorOf(callback)).toBe("account_not_linked");
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect(await providersOf("claimed@example.test")).toEqual([]);
  });

  it("does not join an account whose own email was never verified", async () => {
    const h = createHarness();
    await env.DB.prepare(
      "insert into users (id, name, email, email_verified, created_at, updated_at) values ('legacy-user', '', 'legacy@example.test', 0, 0, 0)",
    ).run();
    fakeProviders(undefined, {
      id: 9011,
      login: "legacy",
      email: "legacy@example.test",
      emails: [{ email: "legacy@example.test", primary: true, verified: true }],
    });
    expect(errorOf(await finishSocial(h, "github"))).toBe("account_not_linked");
    expect(await providersOf("legacy@example.test")).toEqual([]);
  });
});

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

function errorOf(response: Response) {
  return new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("error");
}

describe("sign-in methods of the signed-in account", () => {
  it("lists the connected providers without their tokens", async () => {
    const h = createHarness();
    const cookie = await h.signIn("list@example.test");
    fakeProviders({ sub: "google-1103", email: "list@example.test", email_verified: true });
    await finishSocial(h, "google");
    const response = await h.request("/api/auth/list-accounts", { headers: { cookie } });
    expect(response.status).toBe(200);
    const accounts = await response.json<{ providerId: string }[]>();
    expect(accounts.map((account) => account.providerId)).toContain("google");
    expect(JSON.stringify(accounts)).not.toMatch(/accessToken|refreshToken|idToken/);
  });

  it("requires a session to list providers", async () => {
    const h = createHarness();
    expect((await h.request("/api/auth/list-accounts")).status).toBe(401);
  });
});

describe("human check with a provider", () => {
  it("refuses a Google or GitHub sign-up without a solved check, and creates no account", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-human-1", email: "g-human@example.test", email_verified: true });
    const google = await finishSocial(h, "google", {}, "terms");
    expect(errorOf(google)).toBe(HUMAN_VERIFICATION_REQUIRED);
    expect(new URL(google.headers.get("location") ?? "", ORIGIN).pathname).toBe("/login");
    expect(google.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect(await usersWithEmail("g-human@example.test")).toEqual([]);

    fakeProviders(undefined, {
      id: 9201,
      login: "user-9201",
      email: "gh-human@example.test",
      emails: [{ email: "gh-human@example.test", primary: true, verified: true }],
    });
    expect(errorOf(await finishSocial(h, "github", {}, "terms"))).toBe(HUMAN_VERIFICATION_REQUIRED);
    expect(await usersWithEmail("gh-human@example.test")).toEqual([]);
  });

  it("signs an existing provider account in without a check, and clears a spent one", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-human-2", email: "g-back@example.test", email_verified: true });
    const created = await finishSocial(h, "google");
    expect(errorOf(created)).toBeNull();
    // The check was used to create the account: the browser is told to drop it.
    expect(created.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^__Host-pf_human=;.*Max-Age=0/i),
    );
    const again = await finishSocial(h, "google", {}, "terms");
    expect(errorOf(again)).toBeNull();
    expect(again.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });
});

describe("terms acceptance with a provider", () => {
  const github = (id: number, email: string): GitHubProfile => ({
    id,
    login: `user-${id}`,
    email,
    emails: [{ email, primary: true, verified: true }],
  });

  it("refuses a Google sign-up without the acceptance, and creates no account", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-terms-1", email: "g-terms@example.test", email_verified: true });
    const callback = await finishSocial(h, "google", {}, false);
    expect(errorOf(callback)).toBe(TERMS_NOT_ACCEPTED);
    expect(new URL(callback.headers.get("location") ?? "", ORIGIN).pathname).toBe("/login");
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect(await usersWithEmail("g-terms@example.test")).toEqual([]);
  });

  it("refuses a GitHub sign-up without the acceptance, and creates no account", async () => {
    const h = createHarness();
    fakeProviders(undefined, github(9101, "gh-terms@example.test"));
    const callback = await finishSocial(h, "github", {}, false);
    expect(errorOf(callback)).toBe(TERMS_NOT_ACCEPTED);
    expect(await usersWithEmail("gh-terms@example.test")).toEqual([]);
  });

  it("records the acceptance on accounts created with Google and GitHub", async () => {
    const h = createHarness();
    fakeProviders({ sub: "google-terms-2", email: "g-ok@example.test", email_verified: true });
    await finishSocial(h, "google");
    fakeProviders(undefined, github(9102, "gh-ok@example.test"));
    await finishSocial(h, "github");
    for (const email of ["g-ok@example.test", "gh-ok@example.test"]) {
      const row = await env.DB.prepare(
        "select terms_version, terms_accepted_at from users where email = ?",
      )
        .bind(email)
        .first<{ terms_version: string; terms_accepted_at: number }>();
      expect(row?.terms_version, email).toBe(TERMS_VERSION);
      expect(row?.terms_accepted_at, email).toEqual(expect.any(Number));
    }
  });

  it("asks an existing account again at its next provider sign-in", async () => {
    const h = createHarness();
    fakeProviders(undefined, github(9103, "gh-returning@example.test"));
    await finishSocial(h, "github");
    await env.DB.prepare("update users set terms_version = null where email = ?")
      .bind("gh-returning@example.test")
      .run();
    expect(errorOf(await finishSocial(h, "github", {}, false))).toBe(TERMS_NOT_ACCEPTED);
    const accepted = await finishSocial(h, "github");
    expect(errorOf(accepted)).toBeNull();
    expect(accepted.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      true,
    );
  });
});
