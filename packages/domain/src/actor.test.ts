import {
  ROLE_ACTIONS,
  type RoleAction,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  actsForOwner,
  authorize,
  can,
  personalActor,
  roleAllows,
  TOKEN_ACTIONS,
} from "./actor.ts";

const WORKSPACE = "ws_0123456789abcdef0123456789abcdef";
const actor = (role: WorkspaceRole): Actor => ({
  userId: "u_1",
  ownerId: WORKSPACE,
  role,
  region: "default",
});

/** The whole matrix, written out: a change to what a role may do must change this table. */
const MATRIX: Record<RoleAction, Record<WorkspaceRole, boolean>> = {
  read: { admin: true, editor: true, member: true },
  comment: { admin: true, editor: true, member: true },
  manage: { admin: true, editor: true, member: false },
  transfer: { admin: true, editor: true, member: false },
  transfer_out: { admin: true, editor: false, member: false },
  list: { admin: true, editor: true, member: false },
  publish: { admin: true, editor: true, member: false },
  update: { admin: true, editor: true, member: false },
  access: { admin: true, editor: true, member: false },
  lifecycle: { admin: true, editor: true, member: false },
  versions: { admin: true, editor: true, member: false },
  rollback: { admin: true, editor: true, member: false },
  moderate: { admin: true, editor: true, member: false },
  access_log: { admin: true, editor: true, member: false },
  usage: { admin: true, editor: true, member: false },
  domains: { admin: true, editor: true, member: false },
  members: { admin: true, editor: false, member: false },
  plan: { admin: true, editor: false, member: false },
  policies: { admin: true, editor: false, member: false },
  delete_workspace: { admin: true, editor: false, member: false },
  webhooks: { admin: true, editor: false, member: false },
  brand: { admin: true, editor: false, member: false },
  audit: { admin: true, editor: false, member: false },
  tokens: { admin: true, editor: false, member: false },
};

/** What a service token may do on top of its role (decision 0011): written out on purpose. */
const TOKEN_ALLOWED: readonly RoleAction[] = [
  "read",
  "manage",
  "list",
  "publish",
  "update",
  "access",
  "lifecycle",
  "versions",
  "rollback",
  "usage",
];

describe("role by action", () => {
  it("covers every action of the contracts", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ROLE_ACTIONS].sort());
  });

  const cases = ROLE_ACTIONS.flatMap((action) =>
    WORKSPACE_ROLES.map((role) => ({ action, role, allowed: MATRIX[action][role] })),
  );

  it.each(cases)("$role may $action: $allowed", ({ action, role, allowed }) => {
    expect(roleAllows(role, action)).toBe(allowed);
    expect(can(actor(role), action)).toBe(allowed);
    const result = authorize(actor(role), action);
    if (allowed) expect(result).toEqual({ ok: true, value: actor(role) });
    else
      expect(result).toEqual({
        ok: false,
        code: "forbidden",
        message: "Your role on this workspace does not allow this.",
      });
  });

  it("answers a user without a role like a missing artifact, for every action", () => {
    for (const action of ROLE_ACTIONS) {
      expect(authorize(null, action)).toEqual({
        ok: false,
        code: "not_found",
        message: "Artifact not found.",
      });
    }
  });
});

describe("service tokens", () => {
  const token = (role: WorkspaceRole): Actor => ({
    ...actor(role),
    userId: "st_0123456789abcdef0123456789abcdef",
    token: { restriction: { kind: "none" }, scopes: ["artifacts:read"], createdAt: 0, label: "CI" },
  });

  it("allows exactly the listed actions", () => {
    expect([...TOKEN_ACTIONS].sort()).toEqual([...TOKEN_ALLOWED].sort());
  });

  const cases = ROLE_ACTIONS.flatMap((action) =>
    (["editor", "member", "admin"] as const).map((role) => ({
      action,
      role,
      allowed: MATRIX[action][role] && TOKEN_ALLOWED.includes(action),
    })),
  );

  it.each(cases)("a $role token may $action: $allowed", ({ action, role, allowed }) => {
    expect(can(token(role), action)).toBe(allowed);
    expect(authorize(token(role), action).ok).toBe(allowed);
  });

  it("never manages tokens, members, webhooks, branding, domains or plans, even as admin", () => {
    for (const action of [
      "tokens",
      "members",
      "webhooks",
      "brand",
      "domains",
      "plan",
      "policies",
      "transfer",
      "transfer_out",
      "comment",
      "moderate",
      "access_log",
      "delete_workspace",
    ] as const) {
      expect(can(token("admin"), action)).toBe(false);
    }
  });

  it("acts for its owner when it may manage, as an editor does", () => {
    expect(actsForOwner(token("editor"), WORKSPACE)).toBe(true);
    expect(actsForOwner(token("member"), WORKSPACE)).toBe(false);
  });
});

describe("the personal space", () => {
  it("makes the user the admin of their own owner, in the default region", () => {
    expect(personalActor("u_9")).toEqual({
      userId: "u_9",
      ownerId: "u_9",
      role: "admin",
      region: "default",
    });
    for (const action of ROLE_ACTIONS) expect(can(personalActor("u_9"), action)).toBe(true);
  });
});

describe("acting for the owner", () => {
  it("is admins and editors of that owner only", () => {
    expect(actsForOwner(actor("admin"), WORKSPACE)).toBe(true);
    expect(actsForOwner(actor("editor"), WORKSPACE)).toBe(true);
    expect(actsForOwner(actor("member"), WORKSPACE)).toBe(false);
    expect(actsForOwner(actor("admin"), "u_other")).toBe(false);
    expect(actsForOwner(null, WORKSPACE)).toBe(false);
    expect(actsForOwner(personalActor("u_9"), "u_9")).toBe(true);
  });
});
