import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../src/auth/config.ts";
import { API_RESOURCE, createHarness, ISSUER, json, MCP_RESOURCE, ORIGIN } from "./harness.ts";

describe("authorization server metadata (RFC 8414)", () => {
  it("is served at the path-inserted well-known URL of the issuer", async () => {
    const h = createHarness();
    const response = await h.request("/.well-known/oauth-authorization-server/api/auth");
    expect(response.status).toBe(200);
    const metadata = await response.json<Record<string, unknown>>();
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
    expect(metadata.device_authorization_endpoint).toBe(`${ISSUER}/device/code`);
    expect(metadata.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    expect(metadata.revocation_endpoint).toBe(`${ISSUER}/oauth2/revoke`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.grant_types_supported).toEqual(
      expect.arrayContaining([
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ]),
    );
    expect(metadata.grant_types_supported).not.toContain("client_credentials");
    expect(metadata.scopes_supported).toEqual([...ALL_SCOPES]);
  });

  it("answers compact JSON, which the release workflow's deploy check greps", async () => {
    const h = createHarness();
    const response = await h.request("/.well-known/oauth-authorization-server/api/auth");
    expect(await response.text()).toContain(`"issuer":"${ISSUER}"`);
  });

  it("advertises what Claude and Codex need to pick Client ID Metadata Documents", async () => {
    const h = createHarness();
    const response = await h.request("/.well-known/oauth-authorization-server/api/auth");
    const metadata = await response.json<Record<string, unknown>>();
    // Both clients choose CIMD only when both values are present, and fall back to DCR.
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
    // RFC 9207: clients validate iss in the authorization response.
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("does not answer other methods on the metadata URL", async () => {
    const h = createHarness();
    const response = await h.request("/.well-known/oauth-authorization-server/api/auth", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  it("is only served on the app host", async () => {
    const h = createHarness();
    const response = await h.request(
      "https://portifact.com/.well-known/oauth-authorization-server/api/auth",
    );
    expect(response.status).toBe(404);
  });
});

describe("protected resource metadata (RFC 9728)", () => {
  it("names the MCP endpoint as the resource and the issuer as its only server", async () => {
    const h = createHarness();
    const response = await h.request("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: MCP_RESOURCE,
      resource_name: "Portifact MCP",
      authorization_servers: [ISSUER],
      scopes_supported: ["artifacts:read"],
      bearer_methods_supported: ["header"],
    });
  });

  it("describes the API as a separate resource", async () => {
    const h = createHarness();
    const response = await h.request("/.well-known/oauth-protected-resource/api/v1");
    const metadata = await response.json<Record<string, unknown>>();
    expect(metadata.resource).toBe(API_RESOURCE);
    expect(metadata.resource_name).toBe("Portifact API");
    expect(metadata.authorization_servers).toEqual([ISSUER]);
  });

  it("is served by the deployed Worker entry point", async () => {
    const response = await exports.default.fetch(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ resource: string }>()).resource).toBe(MCP_RESOURCE);
  });
});

describe("discovery from an unauthenticated request", () => {
  it("answers 401 at the MCP endpoint with a pointer to the resource metadata", async () => {
    const h = createHarness();
    const response = await h.request("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="artifacts:read"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 401 at the API with the API's resource metadata", async () => {
    const h = createHarness();
    const response = await h.request("/api/v1/me");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1"`,
    );
  });

  it("treats a malformed authorization header like a missing one", async () => {
    const h = createHarness();
    const response = await h.request("/mcp", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).not.toContain("invalid_token");
  });

  it("rejects an unknown bearer token as invalid", async () => {
    const h = createHarness();
    const response = await h.request("/api/v1/me", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("in-process introspection", () => {
  it("is not reachable over HTTP", async () => {
    const h = createHarness();
    const response = await h.request(
      "/api/auth/portifact/introspect",
      json({}, { authorization: "Bearer anything" }),
    );
    expect(response.status).toBe(404);
  });

  it("rejects a server call without a bearer token", async () => {
    const h = createHarness();
    await expect(
      h.auth.api.introspectBearer({ headers: new Headers({ authorization: "Bearer" }) }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("reports an unknown token as inactive", async () => {
    const h = createHarness();
    const payload = await h.auth.api.introspectBearer({
      headers: new Headers({ authorization: "Bearer not-a-real-token" }),
    });
    expect(payload).toEqual({ active: false });
  });
});
