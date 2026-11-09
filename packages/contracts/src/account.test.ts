import { describe, expect, it } from "vitest";
import {
  AccountSettings,
  AccountSettingsUpdate,
  BrowserSession,
  ConnectedApp,
  CREDENTIALS_SCOPE,
  DisconnectResult,
  OAuthScope,
  TokenGrantList,
  TokenRevokeResult,
} from "./index.ts";

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

  it("lists the CLI's tokens as connected apps marked current, without secrets", () => {
    const grant = {
      clientId: "portifact-cli",
      name: "Portifact CLI",
      firstParty: true,
      current: true,
      resources: ["api"],
      scopes: ["artifacts:read", CREDENTIALS_SCOPE],
      approvedAt: AT,
      lastIssuedAt: AT,
      expiresAt: AT,
    };
    expect(TokenGrantList.parse({ items: [{ ...grant, refreshToken: "x" }] })).toEqual({
      items: [grant],
    });
    expect(TokenGrantList.safeParse({ items: [{ ...grant, current: undefined }] }).success).toBe(
      false,
    );
    expect(
      TokenRevokeResult.safeParse({ clientId: "c", revoked: false, current: false }).success,
    ).toBe(false);
  });

  it("keeps the credentials scope apart from the product scopes", () => {
    expect(CREDENTIALS_SCOPE).toBe("credentials:manage");
    expect(OAuthScope.safeParse(CREDENTIALS_SCOPE).success).toBe(false);
  });

  it("confirms a disconnection only as done", () => {
    expect(DisconnectResult.safeParse({ clientId: "c", disconnected: false }).success).toBe(false);
  });

  it("describes the defaults for new artifacts and refuses unknown or empty changes", () => {
    const settings = {
      defaultAccessMode: "restricted",
      defaultAnnotations: "off",
      defaultCommentVisibility: "owner",
      defaultBar: true,
      expiryNotices: true,
    };
    expect(AccountSettings.parse(settings)).toEqual(settings);
    expect(AccountSettings.safeParse({ ...settings, expiryNotices: undefined }).success).toBe(
      false,
    );
    expect(AccountSettingsUpdate.parse({ expiryNotices: false })).toEqual({
      expiryNotices: false,
    });
    expect(AccountSettings.safeParse({ ...settings, defaultAnnotations: "locked" }).success).toBe(
      false,
    );
    expect(AccountSettingsUpdate.parse({ defaultBar: false })).toEqual({ defaultBar: false });
    expect(AccountSettingsUpdate.safeParse({}).success).toBe(false);
    expect(AccountSettingsUpdate.safeParse({ defaultAccessMode: "everyone" }).success).toBe(false);
    expect(AccountSettingsUpdate.safeParse({ defaultBar: true, ownerId: "u_1" }).success).toBe(
      false,
    );
  });
});
