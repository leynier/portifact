// Question 3: every endpoint the three plugins register in Better Auth 1.7.18, and the proposed
// allowlist. A new endpoint after an upgrade fails here until someone classifies it.
import { describe, expect, it } from "vitest";
import { CLOSED, classified, OPEN, openEndpoint } from "./routes.ts";
import { createHarness, get, json } from "./test/harness.ts";

const h = createHarness({
  transactions: "sequential",
  scimConnections: [{ workspaceId: "ws_routes", token: "spike-routes-token" }],
});
const PLUGIN_PATH = /^\/(organization|sso|sign-in\/sso|scim)\b/;

interface Endpoint {
  path: string;
  options: { method: string | string[] };
}

function pluginEndpoints(): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  for (const value of Object.values(h.auth.api) as unknown[]) {
    const endpoint = value as Partial<Endpoint>;
    if (typeof endpoint.path !== "string" || !PLUGIN_PATH.test(endpoint.path)) continue;
    const methods = endpoint.options?.method ?? "GET";
    for (const method of Array.isArray(methods) ? methods : [methods])
      found.push({ method, path: endpoint.path });
  }
  return found;
}

describe("plugin endpoints", () => {
  const endpoints = pluginEndpoints();

  it("registers the expected number per plugin", () => {
    const count = (prefix: RegExp) => endpoints.filter((e) => prefix.test(e.path)).length;
    expect({
      organization: count(/^\/organization\//),
      sso: count(/^\/(sso|sign-in\/sso)/),
      scim: count(/^\/scim\//),
    }).toMatchInlineSnapshot(`
      {
        "organization": 22,
        "scim": 17,
        "sso": 16,
      }
    `);
  });

  it("classifies every endpoint as open or closed", () => {
    expect(endpoints.filter((e) => !classified(e.method, e.path))).toEqual([]);
  });

  it("opens only endpoints that exist", () => {
    for (const open of OPEN)
      expect(endpoints).toContainEqual({ method: open.method, path: open.path });
    for (const key of Object.keys(CLOSED).filter((k) => !k.endsWith("*"))) {
      const [method, path] = key.includes(" ") ? key.split(" ") : [undefined, key];
      expect(endpoints.some((e) => e.path === path && (!method || e.method === method))).toBe(true);
    }
  });

  it("leaves anything else unclassified", () => {
    expect(classified("GET", "/sso/new-endpoint")).toBeUndefined();
  });

  it("keeps every organization endpoint closed", () => {
    expect(
      endpoints.filter(
        (e) => e.path.startsWith("/organization/") && classified(e.method, e.path) === "open",
      ),
    ).toEqual([]);
  });
});

describe("the proposed gate", () => {
  it("answers 404 for closed endpoints", async () => {
    expect((await h.gated("/organization/create", json({ name: "x", slug: "x" }))).status).toBe(
      404,
    );
    expect((await h.gated("/sso/register", json({}))).status).toBe(404);
    expect((await h.gated("/sso/verify-domain", json({}))).status).toBe(404);
  });

  it("refuses a cross-origin SSO start", async () => {
    expect(
      (await h.gated("/sign-in/sso", json({ providerId: "x" }, { origin: "https://evil.example" })))
        .status,
    ).toBe(403);
  });

  it("matches path parameters but not extra segments", () => {
    expect(openEndpoint("GET", "/sso/callback/acme")?.kind).toBe("idp");
    expect(openEndpoint("GET", "/sso/callback/acme/extra")).toBeUndefined();
    expect(openEndpoint("GET", "/sso/callback/")).toBeUndefined();
    expect(openEndpoint("DELETE", "/scim/v2/Users/123")?.kind).toBe("scim");
  });

  it("lets the IdP-facing and public endpoints through without the app Origin", async () => {
    expect((await h.gated("/sso/saml2/sp/metadata?providerId=missing", get())).status).toBe(404);
    expect((await h.gated("/sso/callback/missing?code=x&state=y", get())).status).not.toBe(404);
  });
});
