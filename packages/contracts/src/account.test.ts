import { describe, expect, it } from "vitest";
import {
  AccountSettings,
  AccountSettingsUpdate,
  BrowserSession,
  CommentNoticeMute,
  CommentNoticeMuteUpdate,
  ConnectedApp,
  CREDENTIALS_SCOPE,
  DisconnectResult,
  OAuthScope,
  TokenGrantList,
  TokenRevokeResult,
  UnsubscribeInput,
  UnsubscribeResult,
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
      commentNotices: true,
      locale: null,
    };
    expect(AccountSettings.parse(settings)).toEqual(settings);
    expect(AccountSettings.safeParse({ ...settings, expiryNotices: undefined }).success).toBe(
      false,
    );
    expect(AccountSettingsUpdate.parse({ expiryNotices: false })).toEqual({
      expiryNotices: false,
    });
    expect(AccountSettings.safeParse({ ...settings, commentNotices: undefined }).success).toBe(
      false,
    );
    expect(AccountSettingsUpdate.parse({ commentNotices: false })).toEqual({
      commentNotices: false,
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

  it("takes a supported language or null as the account's language, and nothing else", () => {
    const settings = {
      defaultAccessMode: "restricted",
      defaultAnnotations: "off",
      defaultCommentVisibility: "owner",
      defaultBar: true,
      expiryNotices: true,
      commentNotices: true,
      locale: "es",
    };
    expect(AccountSettings.parse(settings)).toEqual(settings);
    expect(AccountSettings.safeParse({ ...settings, locale: undefined }).success).toBe(false);
    expect(AccountSettings.safeParse({ ...settings, locale: "es-MX" }).success).toBe(false);
    expect(AccountSettingsUpdate.parse({ locale: "es" })).toEqual({ locale: "es" });
    expect(AccountSettingsUpdate.parse({ locale: null })).toEqual({ locale: null });
    expect(AccountSettingsUpdate.safeParse({ locale: "xx" }).success).toBe(false);
    expect(AccountSettingsUpdate.safeParse({ locale: "ES" }).success).toBe(false);
  });
});

describe("comment notice contracts", () => {
  it("describes the per-artifact mute and its change", () => {
    expect(CommentNoticeMute.parse({ available: true, muted: false })).toEqual({
      available: true,
      muted: false,
    });
    expect(CommentNoticeMute.safeParse({ available: true }).success).toBe(false);
    expect(CommentNoticeMuteUpdate.parse({ muted: true })).toEqual({ muted: true });
    expect(CommentNoticeMuteUpdate.safeParse({ muted: "yes" }).success).toBe(false);
    expect(CommentNoticeMuteUpdate.safeParse({ muted: true, userId: "u" }).success).toBe(false);
  });

  it("takes an unsubscribe token of URL-safe characters only", () => {
    expect(UnsubscribeInput.parse({ token: "cn1.dXNlcg.1.c2ln" })).toEqual({
      token: "cn1.dXNlcg.1.c2ln",
    });
    for (const token of ["short", "cn1.a b.1.sig", `cn1.${"a".repeat(400)}`, "cn1/../x.1.y"]) {
      expect(UnsubscribeInput.safeParse({ token }).success).toBe(false);
    }
    expect(UnsubscribeResult.parse({ unsubscribed: true })).toEqual({ unsubscribed: true });
    expect(UnsubscribeResult.safeParse({ unsubscribed: false }).success).toBe(false);
  });
});
