import { describe, expect, it } from "vitest";
import { ArtifactId } from "./core.ts";
import {
  GetUsageInput,
  INVITATION_LIMITS,
  IncomingInvitationList,
  IncomingInvitationView,
  InvitationCreate,
  InvitationId,
  InvitationList,
  InvitationToken,
  InvitationTokenInput,
  InvitationView,
  ListArtifactsInput,
  ListWorkspacesInput,
  MemberRoleUpdate,
  OwnerView,
  Region,
  SeatsView,
  TransferArtifactInput,
  TransferRequest,
  WorkspaceList,
  WorkspaceMemberList,
  WorkspaceMemberView,
  WorkspaceName,
  WorkspaceParam,
} from "./index.ts";
import { DEFAULT_POLICY } from "./policies.ts";
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
  it("knows the default and EU regions; a Worker serves only those it is bound to", () => {
    expect(REGIONS).toEqual(["default", "eu"]);
    expect(DEFAULT_REGION).toBe("default");
    expect(Region.safeParse("eu").success).toBe(true);
    expect(Region.safeParse("us").success).toBe(false);
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

  it("answers a full workspace with its own code", () => {
    expect(ERROR_STATUS.seats_exhausted).toBe(409);
  });

  it("shows where an artifact lives", () => {
    expect(OwnerView.parse({ kind: "personal" })).toEqual({ kind: "personal" });
    const workspace = { kind: "workspace", slug: "acme", name: "Acme" };
    expect(OwnerView.parse(workspace)).toEqual(workspace);
    expect(OwnerView.safeParse({ kind: "workspace", slug: "Acme", name: "x" }).success).toBe(false);
    expect(OwnerView.safeParse({ kind: "team" }).success).toBe(false);
  });

  it("names workspaces on one line", () => {
    expect(WorkspaceName.parse("  Acme  ")).toBe("Acme");
    for (const bad of ["", "   ", "a\nb", "a\u0007b", "x".repeat(101)]) {
      expect(WorkspaceName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("validates invitations: email, role, ID and token", () => {
    expect(InvitationCreate.parse({ email: "Grace@Example.com", role: "editor" })).toEqual({
      email: "grace@example.com",
      role: "editor",
    });
    expect(InvitationCreate.safeParse({ email: "grace", role: "editor" }).success).toBe(false);
    expect(InvitationCreate.safeParse({ email: "g@x.io", role: "owner" }).success).toBe(false);
    expect(InvitationCreate.safeParse({ email: "g@x.io", role: "member", x: 1 }).success).toBe(
      false,
    );
    expect(InvitationId.safeParse(`inv_${"a".repeat(32)}`).success).toBe(true);
    expect(InvitationId.safeParse(`inv_${"a".repeat(31)}`).success).toBe(false);
    expect(InvitationToken.safeParse("A".repeat(43)).success).toBe(true);
    expect(InvitationToken.safeParse("A".repeat(42)).success).toBe(false);
    expect(InvitationToken.safeParse(`${"A".repeat(42)}=`).success).toBe(false);
    expect(InvitationTokenInput.safeParse({ token: "A".repeat(43), extra: 1 }).success).toBe(false);
    expect(INVITATION_LIMITS).toEqual({
      ttlDays: 7,
      perWorkspacePerDay: { max: 50, windowSeconds: 86_400 },
      perAdminPerHour: { max: 20, windowSeconds: 3_600 },
      perRecipientPerDay: { max: 5, windowSeconds: 86_400 },
    });
  });

  it("moves an artifact to a workspace or to the personal space", () => {
    expect(TransferRequest.parse({ workspace: "acme" })).toEqual({ workspace: "acme" });
    expect(TransferRequest.parse({ workspace: null })).toEqual({ workspace: null });
    expect(TransferRequest.safeParse({}).success).toBe(false);
    expect(TransferRequest.safeParse({ workspace: "Acme" }).success).toBe(false);
  });

  it("takes an optional slug for owner-scoped routes and tools", () => {
    expect(WorkspaceParam.parse(undefined)).toBeUndefined();
    expect(WorkspaceParam.parse("acme")).toBe("acme");
    expect(WorkspaceParam.safeParse("ACME").success).toBe(false);
    expect(ListArtifactsInput.parse({ workspace: "acme" })).toMatchObject({ workspace: "acme" });
    expect(GetUsageInput.parse({})).toEqual({});
    expect(GetUsageInput.parse({ workspace: "acme" })).toEqual({ workspace: "acme" });
    expect(
      TransferArtifactInput.safeParse({ artifactId: "abcdefghij", workspace: null }).success,
    ).toBe(true);
    expect(ListWorkspacesInput.parse({})).toEqual({});
  });

  it("lists workspaces and members with seats", () => {
    const view = {
      slug: "acme",
      name: "Acme",
      role: "admin",
      region: "default",
      createdAt: "2026-11-10T12:00:00.000Z",
      policy: DEFAULT_POLICY,
    };
    // A list without `blocked` (an older server) reads as not blocked (decision 0020).
    expect(WorkspaceList.parse({ items: [view] })).toEqual({
      items: [{ ...view, blocked: false }],
    });
    expect(
      WorkspaceList.parse({
        items: [{ ...view, blocked: true, policy: { ...DEFAULT_POLICY, ipAllowlist: "hidden" } }],
      }).items[0],
    ).toMatchObject({ blocked: true, policy: { ipAllowlist: "hidden" } });
    expect(
      WorkspaceMemberList.parse({
        workspace: view,
        items: [
          {
            userId: "u_1",
            name: "Ada",
            email: "ada@example.com",
            role: "admin",
            joinedAt: "2026-11-10T12:00:00.000Z",
            you: true,
            directoryRole: false,
          },
        ],
        seats: { used: 2, limit: 5 },
      }).seats,
    ).toEqual({ used: 2, limit: 5 });
    expect(SeatsView.safeParse({ used: 1, limit: 0 }).success).toBe(false);
    expect(MemberRoleUpdate.safeParse({ role: "owner" }).success).toBe(false);
  });

  it("keeps every field of the views and refuses them without one", () => {
    const at = "2026-11-10T12:00:00.000Z";
    const views: [
      { safeParse(v: unknown): { success: boolean; data?: unknown } },
      Record<string, unknown>,
    ][] = [
      [SeatsView, { used: 1, limit: 2 }],
      [
        WorkspaceMemberView,
        {
          userId: "u_1",
          name: "Ada",
          email: "a@b.io",
          role: "editor",
          joinedAt: at,
          you: false,
          directoryRole: false,
        },
      ],
      [
        InvitationView,
        {
          id: `inv_${"a".repeat(32)}`,
          email: "a@b.io",
          role: "member",
          invitedBy: null,
          createdAt: at,
          expiresAt: at,
          source: "directory",
        },
      ],
      [
        IncomingInvitationView,
        {
          id: `inv_${"b".repeat(32)}`,
          workspace: { slug: "acme", name: "Acme" },
          role: "admin",
          invitedBy: "Ada",
          expiresAt: at,
        },
      ],
    ];
    for (const [schema, value] of views) {
      expect(schema.safeParse(value)).toEqual({ success: true, data: value });
      for (const key of Object.keys(value)) {
        const { [key]: _gone, ...rest } = value;
        expect(schema.safeParse(rest).success, key).toBe(false);
      }
    }
    const incoming = { items: [views[3]?.[1]] };
    expect(IncomingInvitationList.parse(incoming)).toEqual(incoming);
    expect(IncomingInvitationList.safeParse({}).success).toBe(false);
    const invitations = { items: [views[2]?.[1]], seats: { used: 1, limit: 2 } };
    expect(InvitationList.parse(invitations)).toEqual(invitations);
    expect(InvitationList.safeParse({ items: [] }).success).toBe(false);
    expect(WorkspaceMemberList.safeParse({ items: [], seats: { used: 0, limit: 1 } }).success).toBe(
      false,
    );
  });

  it("anchors IDs and tokens at both ends", () => {
    const id = `inv_${"a".repeat(32)}`;
    expect(InvitationId.safeParse(`x${id}`).success).toBe(false);
    expect(InvitationId.safeParse(`${id}x`).success).toBe(false);
    const token = "A".repeat(43);
    expect(InvitationToken.safeParse(`!${token}`).success).toBe(false);
    expect(InvitationToken.safeParse(`${token}!`).success).toBe(false);
    expect(WorkspaceId.safeParse(`x${"ws_"}${"a".repeat(32)}`).success).toBe(false);
  });
});
