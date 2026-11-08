import { describe, expect, it } from "vitest";
import {
  authorizeWithPkce,
  callMcp,
  consentQuery,
  exchangeCode,
  registerMcpClient,
  startAuthorization,
  type TokenResponse,
} from "./flows.ts";
import { API_RESOURCE, createHarness, ISSUER, json, MCP_RESOURCE, pkcePair } from "./harness.ts";

const CLAUDE_CODE_CIMD = "https://claude.ai/oauth/claude-code-client-metadata";

function claudeCodeMetadata() {
  // Shape of the document Claude Code publishes: a public native client with port-less
  // loopback redirects that it binds to a per-session port.
  return {
    client_id: CLAUDE_CODE_CIMD,
    client_name: "Claude Code",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

describe("dynamic client registration (RFC 7591)", () => {
  it("registers a public native MCP client linked only to the MCP resource", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/oauth2/register",
      json({
        client_name: "Example MCP client",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    );
    expect(response.status).toBe(201);
    const client = await response.json<Record<string, unknown>>();
    expect(client.client_id).toEqual(expect.any(String));
    expect(client).not.toHaveProperty("client_secret");
    expect(client.application_type).toBe("native");
    expect(client.resources).toEqual([MCP_RESOURCE]);
    expect(client).not.toHaveProperty("user_id");
  });

  it("does not tie a registration to the browser session that sent it", async () => {
    const h = createHarness();
    const cookie = await h.signIn("registrar@example.test");
    const response = await h.request(
      "/api/auth/oauth2/register",
      json(
        {
          client_name: "Client registered from a signed-in browser",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
        },
        { cookie },
      ),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("user_id");
  });

  it("refuses an http redirect URI that is not a loopback address", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/oauth2/register",
      json({
        client_name: "Phishing client",
        redirect_uris: ["http://evil.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });
});

describe("authorization code with PKCE", () => {
  it("issues an MCP token after login and consent, and returns iss in the callback", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("grace@example.test");
    const callback = await authorizeWithPkce(h, { clientId, cookie });
    expect(callback.state).toBe("state-123");
    expect(callback.iss).toBe(ISSUER);

    const response = await exchangeCode(h, { clientId, ...callback });
    expect(response.status).toBe(200);
    const tokens = await response.json<TokenResponse>();
    expect(tokens.scope).toBe("artifacts:read offline_access");

    // The token is accepted; the MCP tools themselves arrive in phase 5.
    expect((await callMcp(h, tokens.access_token)).status).toBe(501);
  });

  it("returns access_denied to the client when the user denies consent", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("denies@example.test");
    const { challenge } = await pkcePair();
    const authorize = await startAuthorization(h, { clientId, cookie, codeChallenge: challenge });
    const consent = await h.request(
      "/api/auth/oauth2/consent",
      json({ accept: false, oauth_query: consentQuery(authorize) }, { cookie }),
    );
    const callback = new URL((await consent.json<{ url: string }>()).url);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
  });

  it("refuses a consent whose query was tampered with", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("tamper@example.test");
    const { challenge } = await pkcePair();
    const authorize = await startAuthorization(h, { clientId, cookie, codeChallenge: challenge });
    const query = consentQuery(authorize).replace("artifacts%3Aread", "artifacts%3Adelete");
    const consent = await h.request(
      "/api/auth/oauth2/consent",
      json({ accept: true, oauth_query: query }, { cookie }),
    );
    expect(consent.status).toBe(400);
  });

  it("refuses a consent sent from another origin", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("consent-csrf@example.test");
    const { challenge } = await pkcePair();
    const authorize = await startAuthorization(h, { clientId, cookie, codeChallenge: challenge });
    const consent = await h.request(
      "/api/auth/oauth2/consent",
      json(
        { accept: true, oauth_query: consentQuery(authorize) },
        { cookie, origin: "https://k7d2qm4xab.portifact.dev" },
      ),
    );
    expect(consent.status).toBe(403);
  });

  it("sends an anonymous browser to the login page first", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const response = await startAuthorization(h, {
      clientId,
      cookie: "",
      codeChallenge: "x".repeat(43),
    });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "", ISSUER).pathname).toBe("/login");
  });

  it("continues to consent after an email code sign-in on the login page", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const { challenge } = await pkcePair();
    const authorize = await startAuthorization(h, {
      clientId,
      cookie: "",
      codeChallenge: challenge,
    });
    const loginUrl = new URL(authorize.headers.get("location") ?? "", ISSUER);
    // The login page sends back the signed part of its own query as oauth_query.
    const oauthQuery = loginUrl.search.slice(1);
    const email = "continue@example.test";
    await h.request("/api/auth/email-otp/send-verification-otp", json({ email, type: "sign-in" }));
    const otp = h.outbox.findLast((message) => message.to === email)?.text.match(/(\d{6})/)?.[1];
    const signedIn = await h.request(
      "/api/auth/sign-in/email-otp",
      json({ email, otp, oauth_query: oauthQuery }),
    );
    expect(signedIn.status).toBe(200);
    const body = await signedIn.json<{ url?: string }>();
    expect(new URL(body.url ?? "", ISSUER).pathname).toBe("/consent");
  });

  it("rejects an authorization request without a code challenge", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("nopkce@example.test");
    const response = await startAuthorization(h, { clientId, cookie, codeChallenge: null });
    const location = new URL(response.headers.get("location") ?? "", ISSUER);
    expect(location.pathname).not.toBe("/consent");
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a code exchanged with the wrong verifier", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("wrongverifier@example.test");
    const callback = await authorizeWithPkce(h, { clientId, cookie });
    const other = await pkcePair();
    const response = await exchangeCode(h, {
      clientId,
      code: callback.code,
      verifier: other.verifier,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("does not accept the same code twice", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("replay@example.test");
    const callback = await authorizeWithPkce(h, { clientId, cookie });
    expect((await exchangeCode(h, { clientId, ...callback })).status).toBe(200);
    const replay = await exchangeCode(h, { clientId, ...callback });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a redirect URI that was never registered", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("redirect@example.test");
    const { challenge } = await pkcePair();
    const response = await startAuthorization(h, {
      clientId,
      cookie,
      codeChallenge: challenge,
      redirectUri: "https://evil.example/callback",
    });
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("https://evil.example")).toBe(false);
    expect(new URL(location, ISSUER).searchParams.get("error")).toBe("invalid_redirect");
  });

  it("refuses a resource the client is not linked to", async () => {
    const h = createHarness();
    const clientId = await registerMcpClient(h);
    const cookie = await h.signIn("target@example.test");
    const { challenge } = await pkcePair();
    const response = await startAuthorization(h, {
      clientId,
      cookie,
      codeChallenge: challenge,
      resource: API_RESOURCE,
    });
    const location = new URL(response.headers.get("location") ?? "", ISSUER);
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });
});

describe("Client ID Metadata Documents", () => {
  it("accepts Claude Code's document and its loopback redirect on any port", async () => {
    const h = createHarness();
    h.clientMetadata.set(CLAUDE_CODE_CIMD, claudeCodeMetadata());
    const cookie = await h.signIn("cimd@example.test");
    for (const redirectUri of [
      "http://localhost:3118/callback",
      "http://127.0.0.1:49152/callback",
    ]) {
      const { challenge } = await pkcePair();
      const response = await startAuthorization(h, {
        clientId: CLAUDE_CODE_CIMD,
        cookie,
        codeChallenge: challenge,
        redirectUri,
      });
      const location = new URL(response.headers.get("location") ?? "", ISSUER);
      expect(location.pathname).toBe("/consent");
      expect(location.searchParams.get("redirect_uri")).toBe(redirectUri);
    }
    expect(h.fetchedMetadata).toContain(CLAUDE_CODE_CIMD);
  });

  it("shows the document's client name to the consent page", async () => {
    const h = createHarness();
    h.clientMetadata.set(CLAUDE_CODE_CIMD, claudeCodeMetadata());
    const cookie = await h.signIn("cimd-name@example.test");
    const { challenge } = await pkcePair();
    await startAuthorization(h, {
      clientId: CLAUDE_CODE_CIMD,
      cookie,
      codeChallenge: challenge,
      redirectUri: "http://localhost:3118/callback",
    });
    const response = await h.request(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(CLAUDE_CODE_CIMD)}`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      client_id: CLAUDE_CODE_CIMD,
      client_name: "Claude Code",
    });
  });

  it("rejects a redirect URI the document does not declare", async () => {
    const h = createHarness();
    h.clientMetadata.set(CLAUDE_CODE_CIMD, claudeCodeMetadata());
    const cookie = await h.signIn("cimd-redirect@example.test");
    const { challenge } = await pkcePair();
    const response = await startAuthorization(h, {
      clientId: CLAUDE_CODE_CIMD,
      cookie,
      codeChallenge: challenge,
      redirectUri: "https://claude.ai.evil.example/callback",
    });
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("https://claude.ai.evil.example")).toBe(false);
    expect(new URL(location, ISSUER).pathname).not.toBe("/consent");
  });

  it("rejects a document whose client_id does not match its URL", async () => {
    const h = createHarness();
    h.clientMetadata.set(CLAUDE_CODE_CIMD, {
      ...claudeCodeMetadata(),
      client_id: "https://evil.example/client.json",
    });
    const cookie = await h.signIn("cimd-mismatch@example.test");
    const { challenge } = await pkcePair();
    const response = await startAuthorization(h, {
      clientId: CLAUDE_CODE_CIMD,
      cookie,
      codeChallenge: challenge,
    });
    expect(new URL(response.headers.get("location") ?? "", ISSUER).pathname).not.toBe("/consent");
  });
});
