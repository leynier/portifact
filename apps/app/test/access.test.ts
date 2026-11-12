import { type OAuthScope, TERMS_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  authorizeAccountRequest,
  authorizeApiRequest,
  hasSessionCookie,
  SESSION_COOKIE,
} from "../src/api/access.ts";
import type { ProtectedResource } from "../src/auth/resource.ts";
import { API_RESOURCE, ORIGIN } from "./harness.ts";

const resource: ProtectedResource = {
  identifier: API_RESOURCE,
  name: "Portifact API",
  issuer: `${ORIGIN}/api/auth`,
  challengeScopes: ["artifacts:read"],
};

const caller = (userId: string | undefined) => ({
  introspect: async () => ({ active: false }),
  resource,
  session: async () => userId,
});

const sessionRequest = (method = "GET") =>
  new Request(`${ORIGIN}/api/v1/artifacts`, {
    method,
    headers: {
      cookie: `other=1; ${SESSION_COOKIE}=abc`,
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
    },
  });

describe("API access decision", () => {
  it("accepts a same-origin session for every product scope", async () => {
    const decision = await authorizeApiRequest(
      caller("u1"),
      sessionRequest("POST"),
      "artifacts:delete",
    );
    expect(decision).toEqual({ ok: true, userId: "u1" });
  });

  it("refuses a scope outside the session's capabilities", async () => {
    const decision = await authorizeApiRequest(
      caller("u1"),
      sessionRequest(),
      "account:delete" as OAuthScope,
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.response.status).toBe(403);
  });

  it("falls back to the bearer challenge without a valid session", async () => {
    const decision = await authorizeApiRequest(
      caller(undefined),
      sessionRequest(),
      "artifacts:read",
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.response.status).toBe(401);
  });

  it("finds the session cookie only by its exact name", () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie(`${SESSION_COOKIE}=x`)).toBe(true);
    expect(hasSessionCookie(`a=b;${SESSION_COOKIE}=x`)).toBe(true);
    expect(hasSessionCookie(`${SESSION_COOKIE.toLowerCase()}=x`)).toBe(false);
    expect(hasSessionCookie(`x${SESSION_COOKIE}=x`)).toBe(false);
    expect(hasSessionCookie(`${SESSION_COOKIE}_data=x`)).toBe(false);
  });

  describe("a person's token without the current terms", () => {
    const bearer = (version: string | undefined, scope: string) => ({
      introspect: async () => ({
        active: true,
        sub: "u1",
        client_id: "c1",
        scope,
        aud: API_RESOURCE,
        ...(version === undefined ? {} : { portifact_terms_version: version }),
      }),
      resource,
      session: async () => undefined,
      serviceToken: async () => ({
        ok: true as const,
        tokenId: "st_1",
        workspaceId: "ws_1",
        scopes: ["artifacts:write" as const],
      }),
    });
    const withBearer = (secret = "opaque") =>
      new Request(`${ORIGIN}/api/v1/artifacts`, { headers: { authorization: `Bearer ${secret}` } });

    it("keeps the read scopes", async () => {
      for (const scope of ["artifacts:read", "annotations:read"] as const) {
        const decision = await authorizeApiRequest(
          bearer("2000-01-01", scope),
          withBearer(),
          scope,
        );
        expect(decision, scope).toEqual({ ok: true, userId: "u1" });
      }
    });

    it("refuses every other scope with terms_not_accepted, never accepted or older", async () => {
      for (const version of [undefined, "2000-01-01"]) {
        const decision = await authorizeApiRequest(
          bearer(version, "artifacts:write"),
          withBearer(),
          "artifacts:write",
        );
        expect(decision.ok).toBe(false);
        if (!decision.ok) {
          expect(decision.response.status).toBe(403);
          expect(await decision.response.json()).toMatchObject({
            error: { code: "terms_not_accepted" },
          });
        }
      }
    });

    it("lets the same token act once the account accepted", async () => {
      const decision = await authorizeApiRequest(
        bearer(TERMS_VERSION, "artifacts:write"),
        withBearer(),
        "artifacts:write",
      );
      expect(decision).toEqual({ ok: true, userId: "u1" });
    });

    it("never asks a service token", async () => {
      const decision = await authorizeApiRequest(
        bearer(undefined, "artifacts:write"),
        withBearer(`pfst_${"a".repeat(43)}`),
        "artifacts:write",
      );
      expect(decision).toEqual({ ok: true, userId: "st_1" });
    });

    it("refuses opening a channel out of the account, and the session is unchanged", async () => {
      const refused = await authorizeAccountRequest(
        bearer("2000-01-01", "credentials:manage"),
        withBearer(),
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.response.status).toBe(403);
      const accepted = await authorizeAccountRequest(
        bearer(TERMS_VERSION, "credentials:manage"),
        withBearer(),
      );
      expect(accepted).toMatchObject({ ok: true, userId: "u1", via: "c1" });
    });
  });
});
