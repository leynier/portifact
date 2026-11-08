import type { OAuthScope } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { authorizeApiRequest, hasSessionCookie, SESSION_COOKIE } from "../src/api/access.ts";
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
});
