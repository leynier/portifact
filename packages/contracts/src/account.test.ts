import { describe, expect, it } from "vitest";
import { BrowserSession, ConnectedApp, DisconnectResult } from "./index.ts";

const AT = "2026-11-08T12:00:00.000Z";

describe("account contracts", () => {
  it("drops anything a session row holds beyond what the dashboard shows", () => {
    const parsed = BrowserSession.parse({
      current: true,
      userAgent: null,
      createdAt: AT,
      lastActiveAt: AT,
      expiresAt: AT,
      token: "secret-session-token",
      ipAddress: "203.0.113.9",
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "createdAt",
      "current",
      "expiresAt",
      "lastActiveAt",
      "userAgent",
    ]);
  });

  it("describes a connected app by client, resources and scopes, without its tokens", () => {
    const app = {
      clientId: "portifact-cli",
      name: "Portifact CLI",
      firstParty: true,
      resources: ["api"],
      scopes: ["artifacts:read"],
      approvedAt: AT,
      lastIssuedAt: AT,
      expiresAt: null,
    };
    expect(ConnectedApp.parse({ ...app, accessToken: "x" })).toEqual(app);
    expect(ConnectedApp.safeParse({ ...app, resources: ["userinfo"] }).success).toBe(false);
  });

  it("confirms a disconnection only as done", () => {
    expect(DisconnectResult.safeParse({ clientId: "c", disconnected: false }).success).toBe(false);
  });
});
