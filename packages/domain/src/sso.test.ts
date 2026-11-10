import { describe, expect, it } from "vitest";
import {
  checkDiscovery,
  checkSsoDomains,
  checkSsoIssuer,
  discoveryUrl,
  liveSsoDomains,
  SHARED_SSO_ISSUERS,
  ssoAccountDecision,
  ssoClaimsVerdict,
  ssoIssuerKind,
  ssoServesEmail,
} from "./sso.ts";
import { checkPublicHttpsUrl, checkWebhookUrl } from "./webhooks.ts";

const ISSUER = "https://login.acme.com";
const doc = (overrides: Record<string, unknown> = {}) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/keys`,
  response_types_supported: ["code", "id_token"],
  code_challenge_methods_supported: ["S256"],
  id_token_signing_alg_values_supported: ["RS256"],
  ...overrides,
});

describe("checkSsoIssuer", () => {
  it("keeps a public https issuer exactly as typed, with its host", () => {
    expect(checkSsoIssuer(" https://login.acme.com/tenant/v2.0 ")).toEqual({
      ok: true,
      value: { issuer: "https://login.acme.com/tenant/v2.0", host: "login.acme.com" },
    });
  });

  it.each([
    ["http://login.acme.com", "https://"],
    ["https://10.0.0.1", "IP address"],
    ["https://169.254.169.254", "IP address"],
    ["https://[::1]", "IP address"],
    ["https://localhost", "public DNS name"],
    ["https://idp.internal", "local or reserved"],
    ["https://app.portifact.com", "Portifact or Cloudflare"],
    ["https://workers.dev", "Portifact or Cloudflare"],
    ["https://login.acme.com:8443", "port"],
    ["https://user:pw@login.acme.com", "user name"],
    ["https://login.acme.com/#x", "fragment"],
    ["https://login.acme.com/?tenant=1", "query"],
    ["not a url", "not valid"],
    [`https://${"a".repeat(300)}.com`, "at most"],
  ])("refuses %s", (raw, message) => {
    const result = checkSsoIssuer(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });
});

describe("discoveryUrl", () => {
  it("appends the well-known path once", () => {
    expect(discoveryUrl("https://a.example.com/")).toBe(
      "https://a.example.com/.well-known/openid-configuration",
    );
    expect(discoveryUrl("https://a.example.com/t/v2.0")).toBe(
      "https://a.example.com/t/v2.0/.well-known/openid-configuration",
    );
  });
});

describe("checkDiscovery", () => {
  it("accepts a complete document and keeps only accepted algorithms", () => {
    const result = checkDiscovery(
      doc({ id_token_signing_alg_values_supported: ["HS256", "none", "RS256", "ES256"] }),
      ISSUER,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        authorization: `${ISSUER}/authorize`,
        token: `${ISSUER}/token`,
        jwks: `${ISSUER}/keys`,
        algorithms: ["RS256", "ES256"],
      },
    });
  });

  it("accepts a document that does not list PKCE methods", () => {
    expect(checkDiscovery(doc({ code_challenge_methods_supported: undefined }), ISSUER).ok).toBe(
      true,
    );
  });

  it.each([
    [null, "not_json"],
    [[], "not_json"],
    ["text", "not_json"],
    [doc({ issuer: "https://login.acme.com/" }), "issuer_mismatch"],
    [doc({ issuer: "https://evil.example.org" }), "issuer_mismatch"],
    [doc({ token_endpoint: undefined }), "missing_endpoint"],
    [doc({ jwks_uri: 3 }), "missing_endpoint"],
    [doc({ token_endpoint: "https://10.0.0.5/token" }), "invalid_endpoint"],
    [doc({ jwks_uri: "http://login.acme.com/keys" }), "invalid_endpoint"],
    [doc({ authorization_endpoint: "https://metadata.internal/a" }), "invalid_endpoint"],
    [doc({ response_types_supported: ["id_token"] }), "no_code_flow"],
    [doc({ response_types_supported: "code" }), "no_code_flow"],
    [doc({ code_challenge_methods_supported: ["plain"] }), "no_pkce"],
    [doc({ code_challenge_methods_supported: "S256" }), "no_pkce"],
    [doc({ id_token_signing_alg_values_supported: ["none"] }), "no_signing_algorithm"],
    [doc({ id_token_signing_alg_values_supported: ["HS256"] }), "no_signing_algorithm"],
    [doc({ id_token_signing_alg_values_supported: undefined }), "no_signing_algorithm"],
  ])("refuses %j as %s", (input, problem) => {
    expect(checkDiscovery(input, ISSUER)).toEqual({ ok: false, problem });
  });
});

describe("domains", () => {
  it("serves only domains still verified", () => {
    expect(liveSsoDomains(["a.com", "b.com"], ["b.com", "c.com"])).toEqual(["b.com"]);
    expect(liveSsoDomains(["a.com"], [])).toEqual([]);
  });

  it("matches an address's exact domain, never a subdomain or a look-alike", () => {
    expect(ssoServesEmail("Ada@Acme.com", ["acme.com"])).toBe(true);
    expect(ssoServesEmail("ada@eng.acme.com", ["acme.com"])).toBe(false);
    expect(ssoServesEmail("ada@acme.com.evil.org", ["acme.com"])).toBe(false);
    expect(ssoServesEmail("ada@evilacme.com", ["acme.com"])).toBe(false);
    expect(ssoServesEmail("not-an-address", ["acme.com"])).toBe(false);
    expect(ssoServesEmail("ada@acme.com", [])).toBe(false);
  });

  it("accepts only verified domains, normalized and deduplicated", () => {
    expect(checkSsoDomains([" B.com", "a.com", "b.com"], ["a.com", "b.com"])).toEqual({
      ok: true,
      value: ["a.com", "b.com"],
    });
    expect(checkSsoDomains(["a.com", "x.com"], ["a.com"]).ok).toBe(false);
  });
});

describe("checkPublicHttpsUrl", () => {
  it("is the rule webhook URLs use, with the webhook's own wording for Portifact hosts", () => {
    expect(checkPublicHttpsUrl("https://hooks.example.org/x", 100).ok).toBe(true);
    const own = checkWebhookUrl("https://portifact.com/x", "generic");
    expect(own.ok).toBe(false);
    if (!own.ok)
      expect(own.message).toBe("Webhooks cannot point at Portifact or Cloudflare service hosts.");
    const sso = checkPublicHttpsUrl("https://portifact.com/x", 100);
    if (!sso.ok) expect(sso.message).toContain("cannot point at Portifact");
  });
});

describe("shared issuers (review finding 1)", () => {
  it.each([
    "https://login.microsoftonline.com/common/v2.0",
    "https://login.microsoftonline.com/organizations/v2.0",
    "https://login.microsoftonline.com/consumers/v2.0",
    "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
    "https://login.microsoftonline.com/contoso.com/v2.0",
    "https://login.live.com",
    "https://appleid.apple.com",
    "https://gitlab.com",
  ])("refuses %s", (issuer) => {
    expect(checkSsoIssuer(issuer).ok).toBe(false);
  });

  it("accepts a tenant-specific Entra issuer and Google, and names their kind", () => {
    const tenant = "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0";
    expect(checkSsoIssuer(tenant).ok).toBe(true);
    expect(ssoIssuerKind(tenant)).toBe("entra");
    expect(checkSsoIssuer("https://accounts.google.com").ok).toBe(true);
    expect(ssoIssuerKind("https://accounts.google.com")).toBe("google");
    expect(ssoIssuerKind("https://login.acme.com")).toBe("generic");
    expect(SHARED_SSO_ISSUERS.map((entry) => entry.host)).toContain("accounts.google.com");
  });
});

describe("ssoClaimsVerdict", () => {
  const live = ["acme.com"];
  const email = "ada@acme.com";
  it("refuses email_verified false always, and keeps true or absent", () => {
    expect(ssoClaimsVerdict("generic", { email_verified: false }, email, live)).toEqual({
      ok: false,
      code: "sso_email_unverified",
    });
    expect(ssoClaimsVerdict("generic", { email_verified: true }, email, live)).toEqual({
      ok: true,
      emailVerified: true,
    });
    expect(ssoClaimsVerdict("generic", {}, email, live)).toEqual({
      ok: true,
      emailVerified: undefined,
    });
    expect(ssoClaimsVerdict("generic", { email_verified: "true" }, email, live)).toEqual({
      ok: true,
      emailVerified: undefined,
    });
  });

  it("checks Google's hd against the address's verified domain on every sign-in", () => {
    const ok = { email_verified: true, hd: "acme.com" };
    expect(ssoClaimsVerdict("google", ok, email, live)).toEqual({ ok: true, emailVerified: true });
    for (const claims of [{ email_verified: true }, { email_verified: true, hd: "other.com" }]) {
      expect(ssoClaimsVerdict("google", claims, email, live)).toEqual({
        ok: false,
        code: "sso_email_outside_domain",
      });
    }
    expect(
      ssoClaimsVerdict("google", { hd: "acme.com", email_verified: false }, email, live),
    ).toEqual({ ok: false, code: "sso_email_unverified" });
  });

  it("takes Entra's address only when xms_edov says the domain owner verified it", () => {
    expect(ssoClaimsVerdict("entra", { xms_edov: true }, email, live)).toEqual({
      ok: true,
      emailVerified: true,
    });
    for (const claims of [{}, { xms_edov: false }, { email_verified: true }]) {
      expect(ssoClaimsVerdict("entra", claims, email, live)).toEqual({
        ok: false,
        code: "sso_email_unverified",
      });
    }
  });
});

describe("ssoAccountDecision", () => {
  it("signs in through an identity already linked, consuming invitations only on a verified claim", () => {
    expect(
      ssoAccountDecision({
        linkedUserId: "u1",
        existingUserId: "u1",
        emailVerified: undefined,
        sessionUserId: null,
      }),
    ).toEqual({ ok: true, value: { mode: "existing", userId: "u1", consumeInvitation: false } });
    expect(
      ssoAccountDecision({
        linkedUserId: "u1",
        existingUserId: null,
        emailVerified: true,
        sessionUserId: null,
      }),
    ).toEqual({ ok: true, value: { mode: "existing", userId: "u1", consumeInvitation: true } });
  });

  it("creates a new account without the claim", () => {
    expect(
      ssoAccountDecision({
        linkedUserId: null,
        existingUserId: null,
        emailVerified: undefined,
        sessionUserId: null,
      }),
    ).toEqual({ ok: true, value: { mode: "create", userId: null, consumeInvitation: true } });
  });

  it("links an existing account only on a verified claim or from that account's own session", () => {
    expect(
      ssoAccountDecision({
        linkedUserId: null,
        existingUserId: "u1",
        emailVerified: true,
        sessionUserId: null,
      }),
    ).toEqual({ ok: true, value: { mode: "link", userId: "u1", consumeInvitation: true } });
    expect(
      ssoAccountDecision({
        linkedUserId: null,
        existingUserId: "u1",
        emailVerified: undefined,
        sessionUserId: null,
      }),
    ).toEqual({ ok: false, code: "forbidden", message: "sso_link_required" });
    expect(
      ssoAccountDecision({
        linkedUserId: null,
        existingUserId: "u1",
        emailVerified: undefined,
        sessionUserId: "u2",
      }),
    ).toEqual({ ok: false, code: "forbidden", message: "sso_link_required" });
    expect(
      ssoAccountDecision({
        linkedUserId: null,
        existingUserId: "u1",
        emailVerified: undefined,
        sessionUserId: "u1",
      }),
    ).toEqual({ ok: true, value: { mode: "session", userId: "u1", consumeInvitation: false } });
  });

  it("refuses a session-started flow that asserts another address", () => {
    expect(
      ssoAccountDecision({
        linkedUserId: null,
        existingUserId: null,
        emailVerified: true,
        sessionUserId: "u1",
      }),
    ).toEqual({ ok: false, code: "forbidden", message: "sso_link_required" });
  });

  it("never links an identity of another account to the session's", () => {
    expect(
      ssoAccountDecision({
        linkedUserId: "u9",
        existingUserId: "u1",
        emailVerified: true,
        sessionUserId: "u1",
      }),
    ).toEqual({ ok: false, code: "forbidden", message: "sso_link_required" });
  });
});
