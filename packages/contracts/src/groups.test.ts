import { describe, expect, it } from "vitest";
import {
  ArtifactGroupView,
  isWorkspaceGroupId,
  WORKSPACE_GROUPS,
  WorkspaceGroupCreate,
  WorkspaceGroupDetail,
  WorkspaceGroupId,
  WorkspaceGroupList,
  WorkspaceGroupMemberAdd,
  WorkspaceGroupName,
} from "./groups.ts";
import { TombstoneMarker } from "./jobs.ts";
import { AccessPolicyView, AccessUpdate } from "./publishing.ts";

const ID = `wg_${"0".repeat(32)}`;
const OTHER = `wg_${"1".repeat(32)}`;

describe("workspace groups", () => {
  it("keeps the caps the decision states", () => {
    expect(WORKSPACE_GROUPS).toEqual({
      perWorkspace: 50,
      membersPerGroup: 500,
      perArtifact: 20,
      nameMaxLength: 80,
      scanBatch: 500,
    });
  });

  it("accepts only group IDs", () => {
    expect(WorkspaceGroupId.safeParse(ID).success).toBe(true);
    expect(isWorkspaceGroupId(ID)).toBe(true);
    for (const wrong of [
      `wg_${"0".repeat(31)}`,
      `ws_${"0".repeat(32)}`,
      `wg_${"G".repeat(32)}`,
      "",
    ]) {
      expect(isWorkspaceGroupId(wrong)).toBe(false);
    }
  });

  it("takes a one-line name, trimmed and normalized", () => {
    expect(WorkspaceGroupName.parse("  Design  ")).toBe("Design");
    expect(WorkspaceGroupName.parse("Café")).toBe("Café");
    expect(WorkspaceGroupName.parse("x".repeat(80))).toHaveLength(80);
    for (const wrong of [
      "",
      "   ",
      "x".repeat(81),
      "a\nb",
      "a\tb",
      "a\u0000b",
      "a\u007fb",
      "a\u0085b",
      "a b",
      "a‮b",
      "a⁦b",
    ]) {
      expect(WorkspaceGroupName.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
    expect(WorkspaceGroupCreate.safeParse({ name: "Design", extra: 1 }).success).toBe(false);
    expect(WorkspaceGroupMemberAdd.safeParse({ userId: "" }).success).toBe(false);
    expect(WorkspaceGroupMemberAdd.safeParse({ userId: "u_1" }).success).toBe(true);
  });

  it("shows names and counts in lists, members only in a group's detail", () => {
    const group = { id: ID, name: "Design", members: 3, createdAt: "2026-11-10T00:00:00.000Z" };
    expect(WorkspaceGroupList.parse({ items: [group], available: true, limit: 50 })).toEqual({
      items: [group],
      available: true,
      limit: 50,
    });
    expect(
      WorkspaceGroupDetail.safeParse({
        group,
        items: [
          {
            userId: "u_1",
            name: "Ada",
            email: "ada@example.com",
            role: "member",
            addedAt: "2026-11-10T00:00:00.000Z",
          },
        ],
        limit: 500,
      }).success,
    ).toBe(true);
    expect(
      ArtifactGroupView.safeParse({ id: ID, name: "Design", members: 1, commentVisibility: "all" })
        .success,
    ).toBe(true);
    expect(
      ArtifactGroupView.safeParse({
        id: ID,
        name: "Design",
        members: 1,
        commentVisibility: "inherit",
      }).success,
    ).toBe(false);
  });

  it("adds groups to the access update, one exception per group", () => {
    expect(AccessUpdate.parse({ addGroups: [ID], removeGroups: [OTHER] })).toEqual({
      addGroups: [ID],
      removeGroups: [OTHER],
    });
    expect(AccessUpdate.safeParse({ addGroups: ["Design"] }).success).toBe(false);
    expect(
      AccessUpdate.safeParse({ addGroups: Array.from({ length: 21 }, () => ID) }).success,
    ).toBe(false);
    expect(
      AccessUpdate.parse({ groupCommentVisibility: [{ group: ID, commentVisibility: "inherit" }] }),
    ).toEqual({ groupCommentVisibility: [{ group: ID, commentVisibility: "inherit" }] });
    expect(
      AccessUpdate.safeParse({
        groupCommentVisibility: [
          { group: ID, commentVisibility: "all" },
          { group: ID, commentVisibility: "own" },
        ],
      }).error?.issues[0]?.message,
    ).toBe("Send one comment visibility per group.");
    expect(AccessPolicyView.shape.groups.safeParse([]).success).toBe(true);
  });

  it("tombstones deleted groups and removed memberships", () => {
    for (const kind of ["workspace_group", "workspace_group_member"]) {
      expect(TombstoneMarker.safeParse({ kind, id: ID, deletedAt: 1 }).success).toBe(true);
    }
  });
});

describe("group names that normalization lengthens", () => {
  it("checks the length after normalizing", () => {
    expect(WorkspaceGroupName.safeParse("क़".repeat(80)).success).toBe(false);
    expect(WorkspaceGroupName.parse(` ${"क़".repeat(40)} `)).toHaveLength(80);
  });
});
