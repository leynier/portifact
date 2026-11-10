// The SCIM token and settings contracts (decision 0017).
import { describe, expect, it } from "vitest";
import { AUDIT_DETAILS } from "./audit.ts";
import { TombstoneMarker } from "./jobs.ts";
import {
  isScimTokenId,
  isScimTokenSecret,
  SCIM,
  SCIM_BASE_PATH,
  ScimOverview,
  ScimSettingsUpdate,
  ScimTokenCreate,
  ScimTokenCreated,
  ScimTokenId,
  ScimUserId,
} from "./scim.ts";
import { isServiceTokenId, isServiceTokenSecret } from "./service-tokens.ts";

// Built at run time so nothing committed matches the secret scanner's rule.
const secret = `pfsc_${"b".repeat(43)}`;
const view = {
  id: `sc_${"a".repeat(32)}`,
  label: "Okta",
  createdAt: "2026-11-10T12:00:00.000Z",
  expiresAt: "2027-11-10T12:00:00.000Z",
  lastUsedAt: null,
  createdBy: { name: "Ada" },
  expired: false,
};

describe("SCIM tokens", () => {
  it("are never mistaken for service tokens, either way", () => {
    expect(isScimTokenSecret(secret)).toBe(true);
    expect(isServiceTokenSecret(secret)).toBe(false);
    expect(isScimTokenSecret(`pfst_${"b".repeat(43)}`)).toBe(false);
    expect(isScimTokenSecret(`${secret}x`)).toBe(false);
    expect(isScimTokenId(view.id)).toBe(true);
    expect(isServiceTokenId(view.id)).toBe(false);
    expect(isScimTokenId(`st_${"a".repeat(32)}`)).toBe(false);
    expect(ScimTokenId.safeParse(view.id).success).toBe(true);
    expect(ScimTokenId.safeParse(`st_${"a".repeat(32)}`).success).toBe(false);
    expect(ScimUserId.safeParse(`su_${"0".repeat(32)}`).success).toBe(true);
    expect(ScimUserId.safeParse("ada@acme.com").success).toBe(false);
  });

  it("bounds what an admin sends", () => {
    expect(ScimTokenCreate.parse({ label: " Okta ", expiresInDays: 365 })).toEqual({
      label: "Okta",
      expiresInDays: 365,
    });
    expect(ScimTokenCreate.safeParse({ label: "", expiresInDays: 1 }).success).toBe(false);
    expect(ScimTokenCreate.safeParse({ label: "a\u0007", expiresInDays: 1 }).success).toBe(false);
    expect(ScimTokenCreate.safeParse({ label: "a", expiresInDays: SCIM.maxDays + 1 }).success).toBe(
      false,
    );
    expect(ScimTokenCreate.safeParse({ label: "a", expiresInDays: 1, role: "admin" }).success).toBe(
      false,
    );
    expect(ScimSettingsUpdate.safeParse({ invitationEmails: true }).success).toBe(true);
    expect(ScimSettingsUpdate.safeParse({ invitationEmails: true, roles: {} }).success).toBe(false);
    expect(ScimSettingsUpdate.safeParse({}).success).toBe(false);
    const group = `wg_${"a".repeat(32)}`;
    expect(
      ScimSettingsUpdate.safeParse({ adminGroup: group, confirmAdminGroup: group }).success,
    ).toBe(true);
    expect(ScimSettingsUpdate.safeParse({ editorGroup: null }).success).toBe(true);
    expect(ScimSettingsUpdate.safeParse({ editorGroup: "Engineering" }).success).toBe(false);
  });

  it("shows the secret only in the create answer, and the base path to paste", () => {
    expect(ScimTokenCreated.safeParse({ token: view, secret }).success).toBe(true);
    expect(ScimTokenCreated.safeParse({ token: view, secret: "pfsc_short" }).success).toBe(false);
    expect(
      ScimOverview.safeParse({
        baseUrl: `https://app.portifact.com${SCIM_BASE_PATH}`,
        available: true,
        tokens: [view],
        limit: SCIM.tokensPerWorkspace,
        invitationEmails: false,
        lastSyncAt: null,
        pending: 0,
        groups: [],
        roleMapping: { editor: null, admin: null },
      }).success,
    ).toBe(true);
    expect(SCIM_BASE_PATH).toBe("/scim/v2");
  });

  it("records what a directory changes and tombstones what it withdrew", () => {
    expect(AUDIT_DETAILS["scim_token.created"].safeParse({ days: 365 }).success).toBe(true);
    expect(AUDIT_DETAILS["scim_token.created"].safeParse({ days: 400 }).success).toBe(false);
    expect(
      AUDIT_DETAILS["member.provisioned"].safeParse({ role: "member", emailDomain: "acme.com" })
        .success,
    ).toBe(true);
    expect(
      AUDIT_DETAILS["member.provisioned"].safeParse({ role: "member", email: "a@acme.com" })
        .success,
    ).toBe(false);
    expect(
      AUDIT_DETAILS["member.joined"].safeParse({ role: "member", via: "directory" }).success,
    ).toBe(true);
    for (const kind of ["scim_token", "scim_user", "workspace_invitation", "workspace_member"]) {
      expect(TombstoneMarker.safeParse({ kind, id: "x", deletedAt: 1 }).success).toBe(true);
    }
  });
});
