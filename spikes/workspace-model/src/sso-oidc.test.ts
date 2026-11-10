// Question 5: an SSO sign-in through OIDC passes the real terms and human-check hooks, and what
// happens to an existing account with the same email.
import { env } from "cloudflare:test";
import { createDb } from "@portifact/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN } from "./auth.ts";
import { resolveActor } from "./membership.ts";
import { createHarness, get, json, newAccountCookies, uniqueEmail } from "./test/harness.ts";
import { type FakeIdp, ISSUER, startFakeIdp } from "./test/oidc-idp.ts";

const CLIENT_ID = "portifact-spike";
const DOMAIN = "acme.example";
const h = createHarness();
// Same database and provider, without Portifact's domain rule.
const unguarded = createHarness({ ssoDomainRule: false });
let idp: FakeIdp;
let workspaceId: string;
let providerId: string;
let adminCookie: string;

beforeAll(async () => {
  idp = await startFakeIdp(CLIENT_ID);
  const admin = await h.signIn(uniqueEmail("admin", DOMAIN));
  const created = await h.raw(
    "/organization/create",
    json({ name: "Acme", slug: `acme-${crypto.randomUUID().slice(0, 6)}` }, { cookie: admin }),
  );
  workspaceId = ((await created.json()) as { id: string }).id;
  providerId = `acme-oidc-${crypto.randomUUID().slice(0, 6)}`;
  adminCookie = admin;
  // Registered as a workspace admin through the plugin's API. Discovery only works for origins
  // in Better Auth's global trustedOrigins (see below), so the endpoints are given explicitly.
  await h.auth.api.registerSSOProvider({
    headers: new Headers({ cookie: admin }),
    body: {
      providerId,
      issuer: ISSUER,
      domain: DOMAIN,
      organizationId: workspaceId,
      oidcConfig: {
        clientId: CLIENT_ID,
        clientSecret: "spike-client-secret",
        skipDiscovery: true,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        jwksEndpoint: `${ISSUER}/jwks`,
      },
    },
  });
  // What Portifact's own DNS check (plan T2) would do once the TXT record is found.
  await setDomainVerified(true);
});

async function setDomainVerified(verified: boolean) {
  await env.DB.prepare("UPDATE sso_providers SET domain_verified = ? WHERE provider_id = ?")
    .bind(verified ? 1 : 0, providerId)
    .run();
}

afterAll(() => idp.restore());

/** Runs the whole browser flow: start, IdP redirect back with a code, callback. */
async function ssoSignIn(
  email: string,
  cookies: string,
  via = h,
): Promise<{ location: string; session: string }> {
  const started = await via.gated(
    "/sign-in/sso",
    json({ providerId, callbackURL: `${ORIGIN}/` }, { cookie: cookies }),
  );
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const stateCookies = started.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const code = crypto.randomUUID();
  idp.codes.set(code, { sub: `sub-${email}`, email, email_verified: true, name: "Ada" });
  idp.bindNonce(code, authorize.searchParams.get("nonce"));
  const state = authorize.searchParams.get("state") ?? "";
  const callback = await via.gated(
    `/sso/callback/${providerId}?code=${code}&state=${encodeURIComponent(state)}`,
    get({ cookie: [cookies, stateCookies].filter(Boolean).join("; ") }),
  );
  expect(callback.status).toBe(302);
  const session =
    callback.headers
      .getSetCookie()
      .find(
        (c) =>
          c.startsWith("__Host-pf.session_token=") && !c.startsWith("__Host-pf.session_token=;"),
      ) ?? "";
  return { location: callback.headers.get("location") ?? "", session };
}

async function userByEmail(email: string) {
  return env.DB.prepare("SELECT id, terms_version AS termsVersion FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; termsVersion: string | null }>();
}

describe("OIDC provider registration", () => {
  it("refuses discovery for an IdP origin missing from the global trustedOrigins", async () => {
    await expect(
      h.auth.api.registerSSOProvider({
        headers: new Headers({ cookie: adminCookie }),
        body: {
          providerId: `discovered-${crypto.randomUUID().slice(0, 6)}`,
          issuer: ISSUER,
          domain: DOMAIN,
          organizationId: workspaceId,
          oidcConfig: {
            clientId: CLIENT_ID,
            clientSecret: "s",
            discoveryEndpoint: `${ISSUER}/.well-known/openid-configuration`,
          },
        },
      }),
    ).rejects.toThrow(/not trusted by your trusted origins/);
  });

  it("refuses a provider for a workspace the caller does not administer", async () => {
    const outsider = await h.signIn(uniqueEmail("outsider"));
    const response = await h.raw(
      "/sso/register",
      json(
        {
          providerId: `foreign-${crypto.randomUUID().slice(0, 6)}`,
          issuer: ISSUER,
          domain: DOMAIN,
          organizationId: workspaceId,
          oidcConfig: {
            clientId: CLIENT_ID,
            skipDiscovery: true,
            authorizationEndpoint: `${ISSUER}/authorize`,
            tokenEndpoint: `${ISSUER}/token`,
            jwksEndpoint: `${ISSUER}/jwks`,
          },
        },
        { cookie: outsider },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not a member of the organization");
  });
});

describe("OIDC SSO", () => {
  it("creates the account with the terms recorded and adds it to the workspace as member", async () => {
    const email = uniqueEmail("new", DOMAIN);
    const { location, session } = await ssoSignIn(email, await newAccountCookies());
    expect(location).toBe(`${ORIGIN}/`);
    expect(session).not.toBe("");
    const user = await userByEmail(email);
    expect(user?.termsVersion).not.toBeNull();
    expect((await resolveActor(createDb(env.DB), user?.id ?? "", workspaceId))?.role).toBe(
      "member",
    );
    expect(idp.fetched).toContain("/jwks");
  });

  it("refuses to create an account without the terms accepted", async () => {
    const email = uniqueEmail("noterms", DOMAIN);
    const { location, session } = await ssoSignIn(email, await newAccountCookies({ terms: false }));
    expect(location).toContain("error=terms_not_accepted");
    expect(session).toBe("");
    expect(await userByEmail(email)).toBeNull();
  });

  it("refuses to create an account without the human check", async () => {
    const email = uniqueEmail("nohuman", DOMAIN);
    const { location, session } = await ssoSignIn(email, await newAccountCookies({ human: false }));
    expect(location).toContain("error=human_verification_required");
    expect(session).toBe("");
    expect(await userByEmail(email)).toBeNull();
  });

  it("refuses an existing account that has not accepted the current terms", async () => {
    const email = uniqueEmail("stale", DOMAIN);
    await ssoSignIn(email, await newAccountCookies());
    await env.DB.prepare("UPDATE users SET terms_version = 'old' WHERE email = ?")
      .bind(email)
      .run();
    const { location, session } = await ssoSignIn(email, "");
    expect(location).toContain("error=terms_not_accepted");
    expect(session).toBe("");
  });

  it("signs a returning SSO user in without any cookie", async () => {
    const email = uniqueEmail("again", DOMAIN);
    await ssoSignIn(email, await newAccountCookies());
    const { session } = await ssoSignIn(email, "");
    expect(session).not.toBe("");
  });

  it("refuses to start while the provider's domain is unverified", async () => {
    await setDomainVerified(false);
    try {
      const started = await h.gated(
        "/sign-in/sso",
        json({ providerId, callbackURL: `${ORIGIN}/` }, { cookie: await newAccountCookies() }),
      );
      expect(started.status).toBe(401);
    } finally {
      await setDomainVerified(true);
    }
  });

  it("refuses an address outside the provider's domain, even when the IdP vouches for it", async () => {
    const email = uniqueEmail("victim", "gmail.example");
    const { location, session } = await ssoSignIn(email, await newAccountCookies());
    expect(location).toContain("error=sso_email_outside_domain");
    expect(session).toBe("");
    expect(await userByEmail(email)).toBeNull();
  });

  describe("existing account with the same email", () => {
    it("is joined, not duplicated, when the email is in the provider's verified domain", async () => {
      const email = uniqueEmail("linked", DOMAIN);
      await h.signIn(email);
      const before = await userByEmail(email);
      const { session } = await ssoSignIn(email, "");
      expect(session).not.toBe("");
      const users = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?")
        .bind(email)
        .first<{ n: number }>();
      expect(users?.n).toBe(1);
      const accounts = await env.DB.prepare(
        "SELECT count(*) AS n FROM accounts WHERE user_id = ? AND provider_id = ?",
      )
        .bind(before?.id, providerId)
        .first<{ n: number }>();
      expect(accounts?.n).toBe(1);
      expect((await resolveActor(createDb(env.DB), before?.id ?? "", workspaceId))?.role).toBe(
        "member",
      );
    });

    it("is never joined through another domain's provider", async () => {
      const email = uniqueEmail("outsider", "other.example");
      await h.signIn(email);
      const before = await userByEmail(email);
      const { location, session } = await ssoSignIn(email, "");
      // Better Auth itself refuses: the provider is not trusted for that domain and the IdP's
      // email_verified claim is ignored. (OIDC sends this one to Better Auth's error page.)
      expect(new URL(location).searchParams.get("error")).toBe("account not linked");
      expect(session).toBe("");
      const accounts = await env.DB.prepare(
        "SELECT count(*) AS n FROM accounts WHERE user_id = ? AND provider_id = ?",
      )
        .bind(before?.id, providerId)
        .first<{ n: number }>();
      expect(accounts?.n).toBe(0);
    });

    it("without Portifact's domain rule, lets a workspace IdP create an account for anyone's address", async () => {
      const email = uniqueEmail("squatted", "gmail.example");
      const { session } = await ssoSignIn(email, await newAccountCookies(), unguarded);
      // Better Auth alone accepts it: the account exists, unverified, before its owner signs up.
      expect(session).not.toBe("");
      expect(await userByEmail(email)).not.toBeNull();
    });
  });
});
