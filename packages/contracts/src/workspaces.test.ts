import { describe, expect, it } from "vitest";
import { ArtifactId } from "./core.ts";
import { ERROR_STATUS } from "./publishing.ts";
import {
  DEFAULT_REGION,
  isWorkspaceId,
  REGIONS,
  ROLE_ACTIONS,
  WORKSPACE_ID_PREFIX,
  WORKSPACE_ROLES,
  WorkspaceId,
  WorkspaceRole,
  WorkspaceSlug,
} from "./workspaces.ts";

const ID = "ws_0123456789abcdef0123456789abcdef";

describe("workspace contracts", () => {
  it("has only the default region until the EU exists", () => {
    expect(REGIONS).toEqual(["default"]);
    expect(DEFAULT_REGION).toBe("default");
  });

  it("gives workspaces IDs no user or artifact ID can have", () => {
    expect(WORKSPACE_ID_PREFIX).toBe("ws_");
    expect(WorkspaceId.safeParse(ID).success).toBe(true);
    for (const bad of [
      "ws_ABC",
      "ws_0123",
      `${ID}0`,
      "0123456789abcdef0123456789abcdefab",
      "abcdefghij",
    ]) {
      expect(WorkspaceId.safeParse(bad).success, bad).toBe(false);
    }
    // Better Auth user IDs are alphanumeric and artifact IDs base32: neither has the prefix.
    expect(isWorkspaceId(ID)).toBe(true);
    expect(isWorkspaceId("Xk3f9QpL2mN8vB4cR7tY1uW6sA0eD5gH")).toBe(false);
    expect(isWorkspaceId("abcdefghij")).toBe(false);
    expect(ArtifactId.safeParse(ID).success).toBe(false);
  });

  it("accepts lowercase slugs with inner hyphens", () => {
    for (const good of ["a", "team", "acme-docs", "a1-b2"]) {
      expect(WorkspaceSlug.safeParse(good).success, good).toBe(true);
    }
    for (const bad of ["", "-team", "team-", "Team", "te am", "a".repeat(41)]) {
      expect(WorkspaceSlug.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("has three roles and names every action a role can be asked about", () => {
    expect(WORKSPACE_ROLES).toEqual(["admin", "editor", "member"]);
    expect(WorkspaceRole.safeParse("owner").success).toBe(false);
    expect(new Set(ROLE_ACTIONS).size).toBe(ROLE_ACTIONS.length);
    expect(ROLE_ACTIONS).toContain("delete_workspace");
  });

  it("answers the sole admin refusal with a conflict", () => {
    expect(ERROR_STATUS.sole_workspace_admin).toBe(409);
  });
});
