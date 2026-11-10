import { INVITATION_LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  checkInvitee,
  checkNewWorkspace,
  checkRemoval,
  checkRoleChange,
  checkSeat,
  checkTransfer,
  invitationExpiry,
  MISSING_INVITATION,
  RESERVED_SLUGS,
} from "./workspaces.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;

describe("seats", () => {
  it("allows a seat while one is free, and refuses at the cap", () => {
    expect(checkSeat(0, 1)).toEqual({ ok: true, value: true });
    expect(checkSeat(4, 5)).toEqual({ ok: true, value: true });
    expect(checkSeat(5, 5)).toEqual({
      ok: false,
      code: "seats_exhausted",
      message:
        "The workspace uses all of its 5 seats. Remove a member or revoke an invitation, or ask the operator for more seats.",
    });
    expect(checkSeat(6, 5).ok).toBe(false);
  });

  it("says seat for one", () => {
    expect(checkSeat(1, 1)).toMatchObject({
      message: expect.stringContaining("all of its 1 seat. "),
    });
  });
});

describe("the last admin", () => {
  it("cannot be demoted, while another admin or any other change can", () => {
    expect(checkRoleChange("admin", "editor", 1)).toEqual({
      ok: false,
      code: "sole_workspace_admin",
      message: "You cannot demote the workspace's only admin. Make another member an admin first.",
    });
    expect(checkRoleChange("admin", "member", 0).ok).toBe(false);
    expect(checkRoleChange("admin", "editor", 2)).toEqual({ ok: true, value: true });
    expect(checkRoleChange("admin", "admin", 1)).toEqual({ ok: true, value: true });
    expect(checkRoleChange("editor", "member", 1)).toEqual({ ok: true, value: true });
    expect(checkRoleChange("member", "admin", 1)).toEqual({ ok: true, value: true });
  });

  it("cannot be removed or leave", () => {
    expect(checkRemoval("admin", 1, false)).toEqual({
      ok: false,
      code: "sole_workspace_admin",
      message: "You cannot remove the workspace's only admin. Make another member an admin first.",
    });
    expect(checkRemoval("admin", 1, true)).toEqual({
      ok: false,
      code: "sole_workspace_admin",
      message:
        "You are the workspace's only admin. Make another member an admin before you leave, or ask Portifact at hello@portifact.com to delete the workspace.",
    });
    expect(checkRemoval("admin", 2, true)).toEqual({ ok: true, value: true });
    expect(checkRemoval("editor", 1, false)).toEqual({ ok: true, value: true });
    expect(checkRemoval("member", 0, true)).toEqual({ ok: true, value: true });
  });
});

describe("invitations", () => {
  it("expire a week after they are sent", () => {
    expect(INVITATION_LIMITS.ttlDays).toBe(7);
    expect(invitationExpiry(NOW)).toBe(NOW + 7 * DAY);
  });

  const invitation = { email: "grace@example.com", expiresAt: NOW + DAY };
  const missing = { ok: false, code: "not_found", message: MISSING_INVITATION };

  it("are for the verified email they were sent to, in any case", () => {
    expect(
      checkInvitee(invitation, { email: "Grace@Example.com", emailVerified: true }, NOW),
    ).toEqual({ ok: true, value: true });
  });

  it("answer anyone else, an unverified address or a late answer like a missing one", () => {
    expect(
      checkInvitee(invitation, { email: "ada@example.com", emailVerified: true }, NOW),
    ).toEqual(missing);
    expect(
      checkInvitee(invitation, { email: "grace@example.com", emailVerified: false }, NOW),
    ).toEqual(missing);
    expect(
      checkInvitee(invitation, { email: "grace@example.com", emailVerified: true }, NOW + DAY),
    ).toEqual(missing);
    expect(
      checkInvitee(invitation, { email: "grace@example.com", emailVerified: true }, NOW + DAY - 1),
    ).toEqual({ ok: true, value: true });
  });
});

describe("new workspaces", () => {
  it("take a valid slug and a one-line name, trimmed", () => {
    expect(checkNewWorkspace({ slug: "acme-docs", name: "  Acme Docs " })).toEqual({
      ok: true,
      value: { slug: "acme-docs", name: "Acme Docs" },
    });
  });

  it("refuse bad slugs, reserved slugs and bad names", () => {
    const badSlug = {
      ok: false,
      code: "invalid_input",
      message: "The slug must be 1 to 40 lowercase letters, digits or inner hyphens.",
    };
    expect(checkNewWorkspace({ slug: "Acme", name: "Acme" })).toEqual(badSlug);
    expect(checkNewWorkspace({ slug: "-acme", name: "Acme" })).toEqual(badSlug);
    expect(checkNewWorkspace({ slug: "a".repeat(41), name: "Acme" })).toEqual(badSlug);
    expect(RESERVED_SLUGS.has("personal")).toBe(true);
    expect(checkNewWorkspace({ slug: "personal", name: "Mine" })).toEqual({
      ok: false,
      code: "invalid_input",
      message: "The slug personal is reserved.",
    });
    const badName = {
      ok: false,
      code: "invalid_input",
      message: "The name must be 1 to 100 characters.",
    };
    expect(checkNewWorkspace({ slug: "acme", name: "   " })).toEqual(badName);
    expect(checkNewWorkspace({ slug: "acme", name: "x".repeat(101) })).toEqual(badName);
    expect(checkNewWorkspace({ slug: "acme", name: "Acme\nInc" })).toEqual(badName);
    expect(checkNewWorkspace({ slug: "acme", name: "x".repeat(100) }).ok).toBe(true);
  });
});

describe("transfers", () => {
  const source = { region: "default" as const };
  const target = { ownerId: "ws_target", region: "default" as const };

  it("move active and archived artifacts within a region", () => {
    for (const state of ["active", "archived"]) {
      expect(checkTransfer({ state, ownerId: "u_1" }, source, target)).toEqual({
        ok: true,
        value: true,
      });
    }
  });

  it("refuse the same space, another region and drafts, suspensions or purges", () => {
    expect(checkTransfer({ state: "active", ownerId: "ws_target" }, source, target)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "The artifact is already in that space.",
    });
    expect(
      checkTransfer({ state: "active", ownerId: "u_1" }, source, {
        ...target,
        region: "eu" as never,
      }),
    ).toEqual({
      ok: false,
      code: "invalid_input",
      message: "An artifact cannot move between regions.",
    });
    for (const state of ["draft", "suspended", "purging", "deleted"]) {
      expect(checkTransfer({ state, ownerId: "u_1" }, source, target)).toMatchObject({
        ok: false,
        code: "artifact_archived",
      });
    }
  });
});
