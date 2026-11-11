// MCP tools for workspaces (premium plan T1): list_workspaces, the same body as
// GET /api/v1/workspaces, and transfer_artifact, the same as POST /api/v1/artifacts/:id/transfer.
// Managing members and invitations has no tool: it answers only the dashboard's session.
import {
  ArtifactSummary,
  ListGroupsInput,
  ListWorkspacesInput,
  type OAuthScope,
  TransferArtifactInput,
  WorkspaceGroupList,
  WorkspaceList,
} from "@portifact/contracts";
import { describePolicy } from "@portifact/domain";
import { listUserWorkspaces, listWorkspaceGroups, transferArtifact } from "@portifact/services";
import { groupListView, workspaceListView } from "../api/workspaces.ts";
import { artifactStorage, ownerOf, regionsOf } from "../regions.ts";
import { artifactSummary } from "./present.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const WORKSPACE_TOOL_SCOPES: [string, OAuthScope][] = [
  ["list_workspaces", "artifacts:read"],
  ["list_groups", "artifacts:read"],
  ["transfer_artifact", "artifacts:write"],
];

export function registerWorkspaceTools(register: RegisterTool, context: ToolContext): void {
  register(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List the workspaces the user belongs to, with their slug, name and the user's role (admin, editor or member). Admins and editors publish and manage a workspace's artifacts; members only read and comment on what is shared with them. Pass a slug as workspace to list_artifacts, get_usage, publish_document or prepare_upload to act in that workspace. policy is the workspace's policies, set by its admins in the dashboard and binding everyone, admins included: publicAccess forbidden refuses making an artifact public, defaultAccess is the access a new artifact starts with, readerDomains (when set) are the only email domains readers may have, shareLinks allowed, password_required or disabled and shareLinkMaxDays limit share links, and ipAllowlist and tokenIpAllowlist (the ranges shown to admins only, \"hidden\" to everyone else) limit the networks people and service tokens may act from, sessionMaxHours (when set) is how long a person's sign-in may act on the workspace, and allowedClients (when set) lists the kinds of client besides the dashboard that may act on it with a person's authorization (cli is the Portifact CLI, oauth_apps every other app, MCP clients like this one included). ssoRequired true means people act on it only through a sign-in with the workspace's single sign-on. blocked true means a request policy refuses this request, and blockedBy says which: network (the user must connect from an approved network), session_age (the user must reconnect this app to Portifact, which signs them in again) client (this app may not act on the workspace; the user can use the dashboard or ask a workspace admin) or sso (the user must sign in to Portifact through the workspace's single sign-on, then reconnect this app). Every call on a blocked workspace answers policy_refused until then, and only the user can fix it. Explain them to the user before trying something they refuse (policy_refused). When the user has any workspace and did not say where to publish, ask them which space to use first.",
      inputSchema: ListWorkspacesInput,
      outputSchema: WorkspaceList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const body = workspaceListView(
        await listUserWorkspaces(regionsOf(context.env).global, context.userId),
      );
      const lines = body.items.map((item) => {
        const policy = describePolicy(item.policy);
        return `- ${item.slug} "${item.name}": ${item.role}${policy.length > 0 ? `; policies: ${policy.join("; ")}` : ""}`;
      });
      return success(
        [
          body.items.length === 0
            ? "The user belongs to no workspace; everything goes to their personal space."
            : `${body.items.length} workspace(s), besides the user's personal space.`,
          ...lines,
        ].join("\n"),
        body,
      );
    },
  );

  register(
    "list_groups",
    {
      title: "List a workspace's groups",
      description:
        "List the groups of a workspace (its slug from list_workspaces): their ID, name and member count, never who the members are. Admins and editors see them, to use with add_group on the workspace's restricted artifacts; members get forbidden. Groups are created and filled by the workspace's admins in the Portifact dashboard, never here. available is false while the workspace's plan does not include workspace sharing: groups then let nobody read.",
      inputSchema: ListGroupsInput,
      outputSchema: WorkspaceGroupList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: ListGroupsInput) => {
      const result = await listWorkspaceGroups(regionsOf(context.env).global, {
        userId: context.userId,
        slug: args.workspace,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = groupListView(result.value);
      const lines = body.items.map(
        (item) => `- ${item.id} "${item.name}": ${item.members} member(s)`,
      );
      return success(
        [
          body.items.length === 0
            ? `${args.workspace} has no groups; its admins create them in the dashboard.`
            : `${body.items.length} group(s) in ${args.workspace}.`,
          ...lines,
          ...(body.available
            ? []
            : [
                "The workspace's plan does not include workspace sharing now: groups let nobody read.",
              ]),
        ].join("\n"),
        body,
      );
    },
  );

  register(
    "transfer_artifact",
    {
      title: "Move an artifact to another space",
      description:
        "Move an artifact between the user's personal space and a workspace, or between two workspaces (workspace: a slug from list_workspaces, or null for the personal space). Moving it into a space takes an admin or editor there; moving it out of a workspace takes an admin of that workspace. The artifact keeps its ID, URL, versions, readers and comments; its active slot, storage and comment usage move to the target, whose plan must have room for it (including the per-artifact size). Its access history moves too: the people who manage the target will see who opened it before the move. Open read, review and share link sessions end, an artifact shared with its workspace or an email domain (access workspace or domain) becomes restricted, and the groups of the old workspace it listed are dropped. A target workspace's policy refuses an artifact that breaks it (public where public access is forbidden, readers outside its reader domains, active share links where links are disabled; policy_refused): narrow it first. It changes who can manage the artifact, so ask the user before moving it and tell them all of this.",
      inputSchema: TransferArtifactInput,
      outputSchema: ArtifactSummary,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: TransferArtifactInput) => {
      const result = await transferArtifact(
        ...(await artifactStorage(context.env, args.artifactId)),
        {
          userId: context.userId,
          artifactId: args.artifactId,
          workspace: args.workspace,
          now: context.now(),
        },
      );
      if (!result.ok) return failure(result.code, result.message);
      const body = artifactSummary(
        context.env,
        result.value,
        await ownerOf(context.env, result.value.ownerId),
      );
      const where =
        body.owner.kind === "workspace"
          ? `the workspace ${body.owner.slug} "${body.owner.name}"`
          : "the user's personal space";
      return success(
        `${body.id} "${body.name}" is in ${where}. URL: ${body.url}. The people who manage it there now also see who opened it before the move.`,
        body,
      );
    },
  );
}
