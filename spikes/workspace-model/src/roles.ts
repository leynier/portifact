// Portifact's workspace roles (plan-premium F3) expressed in the organization plugin's access
// control. The plugin's own statements (organization, member, invitation, team, ac) stay so its
// endpoints keep working; `artifact` is Portifact's.
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export const statements = {
  ...defaultStatements,
  artifact: ["read", "comment", "publish", "share", "lifecycle", "moderate"],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  // Members, plan, policies and deleting the workspace, plus everything an editor does.
  admin: ac.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
    artifact: ["read", "comment", "publish", "share", "lifecycle", "moderate"],
  }),
  // Publish, access, lifecycle and moderating comments.
  editor: ac.newRole({
    artifact: ["read", "comment", "publish", "share", "lifecycle", "moderate"],
  }),
  // Read and comment on what is shared with the workspace.
  member: ac.newRole({ artifact: ["read", "comment"] }),
};

export type WorkspaceRole = keyof typeof roles;
