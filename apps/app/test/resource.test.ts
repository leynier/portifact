import { TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  authorizeResourceRequest,
  type IntrospectionPayload,
  type ProtectedResource,
  protectedResourceMetadataUrl,
} from "../src/auth/resource.ts";
import { API_RESOURCE, ISSUER, MCP_RESOURCE } from "./harness.ts";

const MCP: ProtectedResource = {
  identifier: MCP_RESOURCE,
  name: "Portifact MCP",
  issuer: ISSUER,
  challengeScopes: ["artifacts:read"],
};

function request(token = "opaque-token") {
  return new Request(MCP_RESOURCE, { headers: { authorization: `Bearer ${token}` } });
}

// The guard against unusual introspection results that the real server does not produce
// for user tokens today, but must never accept if it ever does.
async function decide(payload: IntrospectionPayload, scopes: string[] = ["artifacts:read"]) {
  const seen: string[] = [];
  const decision = await authorizeResourceRequest(
    async (token) => {
      seen.push(token);
      return payload;
    },
    request(),
    MCP,
    scopes,
  );
  return { decision, seen };
}

const user = { active: true, sub: "user-1", client_id: "client-1", scope: "artifacts:read" };

describe("resource guard", () => {
  it("passes the bearer token to introspection and returns the principal", async () => {
    const { decision, seen } = await decide({ ...user, aud: [API_RESOURCE, MCP_RESOURCE] });
    expect(seen).toEqual(["opaque-token"]);
    expect(decision).toEqual({
      ok: true,
      principal: { userId: "user-1", clientId: "client-1", scopes: ["artifacts:read"] },
      termsAccepted: false,
    });
  });

  it("says whether the token's account accepted the current terms", async () => {
    const accepted = await decide({
      ...user,
      aud: MCP_RESOURCE,
      portifact_terms_version: TERMS_VERSION,
    });
    expect(accepted.decision).toMatchObject({ ok: true, termsAccepted: true });
    const older = await decide({
      ...user,
      aud: MCP_RESOURCE,
      portifact_terms_version: "2000-01-01",
    });
    expect(older.decision).toMatchObject({ ok: true, termsAccepted: false });
  });

  it("accepts an audience given as a single string", async () => {
    const { decision } = await decide({ ...user, aud: MCP_RESOURCE });
    expect(decision.ok).toBe(true);
  });

  it("rejects an inactive token", async () => {
    const { decision } = await decide({ ...user, active: false, aud: MCP_RESOURCE });
    expect(decision.ok).toBe(false);
  });

  it("rejects an active token without a subject", async () => {
    const { decision } = await decide({ ...user, sub: "", aud: MCP_RESOURCE });
    expect(decision.ok).toBe(false);
  });

  it("rejects an active token without a client", async () => {
    const { decision } = await decide({ ...user, client_id: "", aud: MCP_RESOURCE });
    expect(decision.ok).toBe(false);
  });

  it("rejects an active token without an audience", async () => {
    const { decision } = await decide({ ...user });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.response.status).toBe(401);
  });

  it("treats a token without scopes as having none", async () => {
    const { decision } = await decide({ ...user, scope: "", aud: MCP_RESOURCE });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.response.status).toBe(403);
  });

  it("does not call introspection when no bearer token is present", async () => {
    let called = false;
    const decision = await authorizeResourceRequest(
      async () => {
        called = true;
        return user;
      },
      new Request(MCP_RESOURCE),
      MCP,
      [],
    );
    expect(called).toBe(false);
    expect(decision.ok).toBe(false);
  });

  it("builds the RFC 9728 metadata URL by inserting the resource path", () => {
    expect(protectedResourceMetadataUrl(MCP)).toBe(
      "https://app.portifact.com/.well-known/oauth-protected-resource/mcp",
    );
  });
});
