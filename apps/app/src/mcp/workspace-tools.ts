// MCP tools for workspaces (premium plan T1): list_workspaces, the same body as
// GET /api/v1/workspaces, and transfer_artifact, the same as POST /api/v1/artifacts/:id/transfer.
// Managing members and invitations has no tool: it answers only the dashboard's session.
import {
  ArtifactSummary,
  ListWorkspacesInput,
  type OAuthScope,
  TransferArtifactInput,
  WorkspaceList,
} from "@portifact/contracts";
import { listUserWorkspaces, transferArtifact } from "@portifact/services";
import { workspaceListView } from "../api/workspaces.ts";
import { artifactDb, ownerOf, regionsOf } from "../regions.ts";
import { artifactSummary } from "./present.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const WORKSPACE_TOOL_SCOPES: [string, OAuthScope][] = [
  ["list_workspaces", "artifacts:read"],
  ["transfer_artifact", "artifacts:write"],
];

export function registerWorkspaceTools(register: RegisterTool, context: ToolContext): void {
  register(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List the workspaces the user belongs to, with their slug, name and the user's role (admin, editor or member). Admins and editors publish and manage a workspace's artifacts; members only read and comment on what is shared with them. Pass a slug as workspace to list_artifacts, get_usage, publish_document or prepare_upload to act in that workspace. When the user has any workspace and did not say where to publish, ask them which space to use first.",
      inputSchema: ListWorkspacesInput,
      outputSchema: WorkspaceList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const body = workspaceListView(
        await listUserWorkspaces(regionsOf(context.env).global, context.userId),
      );
      const lines = body.items.map((item) => `- ${item.slug} "${item.name}": ${item.role}`);
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
    "transfer_artifact",
    {
      title: "Move an artifact to another space",
      description:
        "Move an artifact between the user's personal space and a workspace, or between two workspaces (workspace: a slug from list_workspaces, or null for the personal space). Moving it into a space takes an admin or editor there; moving it out of a workspace takes an admin of that workspace. The artifact keeps its ID, URL, versions, readers and comments; its active slot, storage and comment usage move to the target, whose plan must have room for it (including the per-artifact size). Its access history moves too: the people who manage the target will see who opened it before the move. Open read, review and share link sessions end, and an artifact shared with its workspace or an email domain (access workspace or domain) becomes restricted. It changes who can manage the artifact, so ask the user before moving it and tell them all of this.",
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
        await artifactDb(context.env, args.artifactId),
        context.env.ARTIFACTS,
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
