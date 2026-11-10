// Groups (decision 0014): who reads through a listed group, in every mode and for every kind of
// viewer, and which comment scope a person gets from reader rows and groups together.
import { AccessMode, type CommentScope } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { type AccessPolicy, canRead, type GroupMatch, type Viewer } from "./access.ts";
import type { Actor } from "./actor.ts";
import { commentScope } from "./annotations.ts";
import { feedbackReach } from "./feedback.ts";
import { checkArtifactGroups, normalizeGroupName } from "./groups.ts";
import { checkCommentVisibilityChange } from "./service-tokens.ts";

const WS = `ws_${"a".repeat(32)}`;
const OTHER_WS = `ws_${"b".repeat(32)}`;
const G1 = `wg_${"1".repeat(32)}`;
const G2 = `wg_${"2".repeat(32)}`;
const viewer: Viewer = { userId: "u_ana", verifiedEmails: ["ana@example.com"] };
const actor = (role: Actor["role"], ownerId = WS): Actor => ({
  userId: viewer.userId,
  ownerId,
  role,
  region: "default",
});
const matched = (featureAvailable: boolean, ids: string[] = [G1]): GroupMatch => ({
  featureAvailable,
  matched: ids.map((id) => ({ id, commentVisibility: null })),
});

type Case = {
  name: string;
  mode: AccessMode;
  ownerId?: string;
  actor: Actor | null;
  viewer?: Viewer | null;
  groups?: GroupMatch;
  readers?: string[];
  reads: boolean;
};

const cases: Case[] = [
  // A member in a listed group reads a restricted artifact, as a listed reader does.
  {
    name: "member in a group",
    mode: "restricted",
    actor: actor("member"),
    groups: matched(true),
    reads: true,
  },
  {
    name: "member in no listed group",
    mode: "restricted",
    actor: actor("member"),
    groups: matched(true, []),
    reads: false,
  },
  {
    name: "member without the group read",
    mode: "restricted",
    actor: actor("member"),
    reads: false,
  },
  // A lapsed plan makes groups grant nothing, never wider.
  {
    name: "plan lapsed",
    mode: "restricted",
    actor: actor("member"),
    groups: matched(false),
    reads: false,
  },
  // Groups never reach past the owning workspace's members.
  { name: "not a member", mode: "restricted", actor: null, groups: matched(true), reads: false },
  {
    name: "member of another workspace",
    mode: "restricted",
    actor: actor("member", OTHER_WS),
    groups: matched(true),
    reads: false,
  },
  {
    name: "personal artifact",
    mode: "restricted",
    ownerId: "u_owner",
    actor: actor("member"),
    groups: matched(true),
    reads: false,
  },
  {
    name: "anonymous",
    mode: "restricted",
    actor: null,
    viewer: null,
    groups: matched(true),
    reads: false,
  },
  // Groups grant only in restricted: other modes decide as before.
  {
    name: "authenticated mode",
    mode: "authenticated",
    actor: null,
    groups: matched(true),
    reads: true,
  },
  { name: "public mode", mode: "public", actor: null, viewer: null, reads: true },
  {
    name: "workspace mode, member",
    mode: "workspace",
    actor: actor("member"),
    groups: matched(false),
    reads: true,
  },
  {
    name: "domain mode, member",
    mode: "domain",
    actor: actor("member"),
    groups: matched(false),
    reads: true,
  },
  {
    name: "workspace mode, non-member",
    mode: "workspace",
    actor: null,
    groups: matched(true),
    reads: false,
  },
  // The owner side reads without a group; a listed reader too.
  { name: "editor", mode: "restricted", actor: actor("editor"), reads: true },
  {
    name: "listed reader",
    mode: "restricted",
    actor: null,
    readers: ["ana@example.com"],
    reads: true,
  },
];

describe("canRead with groups", () => {
  it.each(cases)("$name", (c) => {
    const policy: AccessPolicy = {
      mode: c.mode,
      ownerId: c.ownerId ?? WS,
      readers: c.readers ?? [],
      groups: c.groups,
    };
    const decision = canRead(policy, c.viewer === undefined ? viewer : c.viewer, c.actor);
    expect(decision.ok).toBe(c.reads);
  });

  it("refuses with the same answer as any other refusal", () => {
    expect(
      canRead({ mode: "restricted", ownerId: WS, readers: [] }, viewer, actor("member")),
    ).toEqual({
      ok: false,
      code: "forbidden",
      message: "Your account does not have access to this artifact.",
    });
  });

  it("admits through a group only the member the role came from", () => {
    const someoneElse: Actor = { ...actor("member"), userId: "u_other" };
    expect(
      canRead(
        { mode: "restricted", ownerId: WS, readers: [], groups: matched(true) },
        viewer,
        someoneElse,
      ).ok,
    ).toBe(false);
  });
});

describe("commentScope with groups", () => {
  const scope = (
    visibility: "owner" | "everyone",
    reader: CommentScope | null,
    groups: (CommentScope | null)[],
  ) => commentScope("participant", visibility, reader, groups);

  // Precedence: the reader row's exception, then the widest of the groups' scopes (each group's
  // exception, else the setting), then the setting.
  it.each([
    ["owner", null, [], "own"],
    ["everyone", null, [], "all"],
    ["owner", null, [null], "own"],
    ["everyone", null, [null], "all"],
    ["owner", null, ["all"], "all"],
    ["everyone", null, ["own"], "own"],
    ["owner", null, ["own", "all"], "all"],
    ["everyone", null, ["own", null], "all"],
    ["owner", null, ["own", null], "own"],
    ["owner", "own", ["all"], "own"],
    ["everyone", "own", [null], "own"],
    ["owner", "all", ["own"], "all"],
  ] as const)("%s, reader %s, groups %j gives %s", (visibility, reader, groups, expected) => {
    expect(scope(visibility, reader, [...groups])).toBe(expected);
  });

  it("gives the owner every thread whatever the groups say", () => {
    expect(commentScope("owner", "owner", "own", ["own"])).toBe("all");
  });
});

describe("feedbackReach with groups", () => {
  it("lists through groups only for a member while the plan allows them", () => {
    const member = actor("member");
    expect(
      feedbackReach(member, viewer, undefined, { featureAvailable: true, ids: [G1, G2] }),
    ).toMatchObject({ groupList: true, groups: [G1, G2] });
    expect(
      feedbackReach(member, viewer, undefined, { featureAvailable: false, ids: [G1] }),
    ).toMatchObject({ groupList: false, groups: [] });
    expect(feedbackReach(member, viewer, undefined)).toMatchObject({
      groupList: false,
      groups: [],
    });
    const personal = actor("admin", viewer.userId);
    expect(
      feedbackReach(personal, viewer, undefined, { featureAvailable: true, ids: [G1] }),
    ).toMatchObject({ groupList: false, groups: [] });
  });

  it("agrees with canRead for every mode", () => {
    const member = actor("member");
    const reach = feedbackReach(member, viewer, undefined, { featureAvailable: true, ids: [G1] });
    for (const mode of AccessMode.options) {
      const listed = canRead(
        { mode, ownerId: WS, readers: [], groups: matched(true) },
        viewer,
        member,
      ).ok;
      const open = reach.openModes === null || reach.openModes.includes(mode);
      expect(open || (mode === "restricted" && reach.groupList)).toBe(listed);
    }
  });
});

describe("checkArtifactGroups", () => {
  it("lists groups only on workspace artifacts, within the cap", () => {
    expect(checkArtifactGroups({ ownerId: WS, adding: true, after: 20 }).ok).toBe(true);
    expect(checkArtifactGroups({ ownerId: WS, adding: true, after: 21 })).toMatchObject({
      ok: false,
      code: "quota_exceeded",
      message: "An artifact can list at most 20 groups.",
    });
    expect(checkArtifactGroups({ ownerId: "u_owner", adding: true, after: 1 })).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "Only workspace artifacts can list groups.",
    });
    // Removing (or setting exceptions) never needs a workspace or the plan.
    expect(checkArtifactGroups({ ownerId: "u_owner", adding: false, after: 0 }).ok).toBe(true);
  });
});

describe("tokens and group exceptions", () => {
  it("never lets a token change who sees comments through a group", () => {
    const token = { id: "st_1", scopes: ["artifacts:share"], restriction: "none" } as never;
    expect(
      checkCommentVisibilityChange(token, {
        groupCommentVisibility: [{ group: G1, commentVisibility: "all" }],
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(checkCommentVisibilityChange(token, {}).ok).toBe(true);
    expect(
      checkCommentVisibilityChange(undefined, {
        groupCommentVisibility: [{ group: G1, commentVisibility: "all" }],
      }).ok,
    ).toBe(true);
  });
});

describe("normalizeGroupName", () => {
  it("trims and normalizes a one-line name, refusing anything else", () => {
    expect(normalizeGroupName("  Design ")).toEqual({ ok: true, value: "Design" });
    for (const wrong of ["", " ", "a\nb", "a\u202eb", "x".repeat(81)]) {
      expect(normalizeGroupName(wrong)).toEqual({
        ok: false,
        code: "invalid_input",
        message: "A group name is one line of 1 to 80 characters.",
      });
    }
  });
});
