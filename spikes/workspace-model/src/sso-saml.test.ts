// Question 2 (SAML in workerd) and 5 (terms and human check on SAML sign-ins). samlify acts as
// the identity provider inside workerd and signs real responses with a key made for this run;
// the SSO plugin verifies them with samlify and xml-crypto on node:crypto (nodejs_compat).
import { env } from "cloudflare:test";
import { createDb } from "@portifact/db";
import * as samlify from "samlify";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGIN } from "./auth.ts";
import { resolveActor } from "./membership.ts";
import { createHarness, get, json, newAccountCookies, uniqueEmail } from "./test/harness.ts";

const DOMAIN = "saml.example";
const IDP_ENTITY = "https://idp.example.com/saml";
const ENTRY_POINT = "https://idp.example.com/saml/sso";
const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const h = createHarness();
let providerId: string;
let workspaceId: string;
let idp: ReturnType<typeof samlify.IdentityProvider>;
let sp: ReturnType<typeof samlify.ServiceProvider>;

beforeAll(async () => {
  const admin = await h.signIn(uniqueEmail("admin", DOMAIN));
  const created = await h.raw(
    "/organization/create",
    json({ name: "Saml", slug: `saml-${crypto.randomUUID().slice(0, 6)}` }, { cookie: admin }),
  );
  workspaceId = ((await created.json()) as { id: string }).id;
  providerId = `saml-${crypto.randomUUID().slice(0, 6)}`;
  await h.auth.api.registerSSOProvider({
    headers: new Headers({ cookie: admin }),
    body: {
      providerId,
      issuer: IDP_ENTITY,
      domain: DOMAIN,
      organizationId: workspaceId,
      samlConfig: {
        entryPoint: ENTRY_POINT,
        cert: env.IDP_CERT,
        callbackUrl: `${ORIGIN}/`,
        wantAssertionsSigned: true,
        idpMetadata: {
          entityID: IDP_ENTITY,
          cert: env.IDP_CERT,
          singleSignOnService: [{ Binding: REDIRECT, Location: ENTRY_POINT }],
        },
        spMetadata: {},
      },
    },
  });
  await env.DB.prepare("UPDATE sso_providers SET domain_verified = 1 WHERE provider_id = ?")
    .bind(providerId)
    .run();

  const metadata = await h.gated(
    `/sso/saml2/sp/metadata?providerId=${providerId}&format=xml`,
    get(),
  );
  expect(metadata.status).toBe(200);
  sp = samlify.ServiceProvider({ metadata: await metadata.text() });
  idp = samlify.IdentityProvider({
    entityID: IDP_ENTITY,
    signingCert: env.IDP_CERT,
    privateKey: env.IDP_KEY,
    nameIDFormat: ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
    singleSignOnService: [{ Binding: REDIRECT, Location: ENTRY_POINT }],
  });
});

interface Assertion {
  SAMLResponse: string;
  RelayState: string;
}

/** Starts sign-in at Portifact, then has the IdP answer the AuthnRequest for `email`. */
async function idpAnswers(email: string, startCookies: string): Promise<Assertion> {
  const started = await h.gated(
    "/sign-in/sso",
    json({ providerId, callbackURL: `${ORIGIN}/` }, { cookie: startCookies }),
  );
  expect(started.status).toBe(200);
  const url = new URL(((await started.json()) as { url: string }).url);
  expect(url.origin + url.pathname).toBe(ENTRY_POINT);
  const request = await idp.parseLoginRequest(sp, "redirect", {
    query: Object.fromEntries(url.searchParams),
  });
  // samlify's own FlowResult lacks the index signature its RequestInfo declares.
  const requestInfo = request as unknown as Parameters<typeof idp.createLoginResponse>[1];
  const response = (await idp.createLoginResponse(
    sp,
    requestInfo,
    "post",
    { email },
    { relayState: url.searchParams.get("RelayState") ?? "" },
  )) as {
    context: string;
    relayState?: string;
  };
  return { SAMLResponse: response.context, RelayState: response.relayState ?? "" };
}

/**
 * The IdP's auto-submitted form: a cross-site POST, so the browser sends no SameSite=Lax
 * cookies. `cookies` lets a test model a same-site POST for comparison.
 */
async function postToAcs(
  assertion: Assertion,
  cookies = "",
): Promise<{ location: string; session: string }> {
  const response = await h.gated(`/sso/saml2/sp/acs/${providerId}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://idp.example.com",
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: new URLSearchParams({ ...assertion }).toString(),
  });
  expect(response.status).toBe(302);
  const session =
    response.headers.getSetCookie().find((c) => /^__Host-pf\.session_token=[^;]/.test(c)) ?? "";
  return { location: response.headers.get("location") ?? "", session };
}

async function userId(email: string) {
  return (
    await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>()
  )?.id;
}

describe("SAML SSO in workerd", () => {
  it("verifies a signed response and signs in a user the terms already cover", async () => {
    // An account created earlier by email code, so it has accepted the current terms.
    const email = uniqueEmail("ada", DOMAIN);
    await h.signIn(email);
    const { location, session } = await postToAcs(await idpAnswers(email, ""));
    expect(location).toBe(`${ORIGIN}/`);
    expect(session).not.toBe("");
    expect(
      (await resolveActor(createDb(env.DB), (await userId(email)) ?? "", workspaceId))?.role,
    ).toBe("member");
  });

  it("rejects a response whose signature does not verify", async () => {
    const email = uniqueEmail("tamper", DOMAIN);
    await h.signIn(email);
    const assertion = await idpAnswers(email, "");
    const xml = atob(assertion.SAMLResponse).replace(email, uniqueEmail("mallory", DOMAIN));
    const { location, session } = await postToAcs({ ...assertion, SAMLResponse: btoa(xml) });
    expect(location).toContain("error=");
    expect(session).toBe("");
  });

  it("rejects a replayed response", async () => {
    const email = uniqueEmail("replay", DOMAIN);
    await h.signIn(email);
    const assertion = await idpAnswers(email, "");
    expect((await postToAcs(assertion)).session).not.toBe("");
    const replay = await postToAcs(assertion);
    expect(replay.session).toBe("");
  });

  it("cannot create a new account from the cross-site POST: the Lax terms cookie never arrives", async () => {
    const email = uniqueEmail("newcomer", DOMAIN);
    const cookies = await newAccountCookies();
    const { location, session } = await postToAcs(await idpAnswers(email, cookies));
    expect(location).toContain("error=terms_not_accepted");
    expect(session).toBe("");
    expect(await userId(email)).toBeUndefined();
  });

  it("creates the account when the same cookies reach the ACS, so the hooks themselves work", async () => {
    const email = uniqueEmail("sameSite", DOMAIN);
    const cookies = await newAccountCookies();
    const { session } = await postToAcs(await idpAnswers(email, cookies), cookies);
    expect(session).not.toBe("");
    const row = await env.DB.prepare("SELECT terms_version AS v FROM users WHERE email = ?")
      .bind(email)
      .first<{ v: string | null }>();
    expect(row?.v).not.toBeNull();
  });

  it("locks a returning user out after a terms change: the acceptance cannot reach the ACS", async () => {
    const email = uniqueEmail("stale", DOMAIN);
    await h.signIn(email);
    await env.DB.prepare("UPDATE users SET terms_version = 'old' WHERE email = ?")
      .bind(email)
      .run();
    // The login page records a fresh acceptance in the Lax cookie, but the POST drops it.
    const cookies = await newAccountCookies({ human: false });
    const { location, session } = await postToAcs(await idpAnswers(email, cookies));
    expect(location).toContain("error=terms_not_accepted");
    expect(session).toBe("");
  });

  it("refuses a new account without the human check even when the terms cookie arrives", async () => {
    const email = uniqueEmail("bot", DOMAIN);
    const cookies = await newAccountCookies({ human: false });
    const { location } = await postToAcs(await idpAnswers(email, cookies), cookies);
    expect(location).toContain("error=human_verification_required");
    expect(await userId(email)).toBeUndefined();
  });

  it("refuses to join an existing account outside the provider's domain", async () => {
    const email = uniqueEmail("victim", "other.example");
    await h.signIn(email);
    const { location, session } = await postToAcs(await idpAnswers(email, ""));
    expect(location).toContain("error=account_not_linked");
    expect(session).toBe("");
  });

  it("refuses to create an account outside the provider's domain", async () => {
    const email = uniqueEmail("squat", "other.example");
    const cookies = await newAccountCookies();
    const { location } = await postToAcs(await idpAnswers(email, cookies), cookies);
    expect(location).toContain("error=sso_email_outside_domain");
    expect(await userId(email)).toBeUndefined();
  });
});
