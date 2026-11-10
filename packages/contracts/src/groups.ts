// Groups of a workspace (premium plan T3, decision 0014): named sets of the workspace's members
// that a `restricted` artifact of the same workspace lists besides email addresses. Admins manage
// them through the dashboard session only; the IDs, names and member counts are listed for the
// people who change artifacts' access (the API with `artifacts:read`, MCP and the CLI).
import { z } from "zod";
import { CommentScope } from "./core.ts";
import { WorkspaceRole } from "./workspaces.ts";

export const WORKSPACE_GROUPS = {
  /** Groups per workspace: a safety cap, not a plan value. */
  perWorkspace: 50,
  /** Members per group. */
  membersPerGroup: 500,
  /** Groups one artifact lists. */
  perArtifact: 20,
  /** Characters of a group's name. */
  nameMaxLength: 80,
  /** Artifact group rows the maintenance scan checks per run (decision 0014, "Regions"). */
  scanBatch: 500,
} as const;

/** A group ID: `wg_` and 32 hex characters. */
export const WorkspaceGroupId = z.string().regex(/^wg_[0-9a-f]{32}$/, "Invalid group id");
export type WorkspaceGroupId = z.infer<typeof WorkspaceGroupId>;

/** Whether a string is a group ID. */
export function isWorkspaceGroupId(value: string): boolean {
  return WorkspaceGroupId.safeParse(value).success;
}

/** A group's name: one line, unique in its workspace without regard to case. */
export const WorkspaceGroupName = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_GROUPS.nameMaxLength)
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    (value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value),
    "No control characters or direction overrides",
  )
  .transform((value) => value.normalize("NFC"));

export const WorkspaceGroupCreate = z.strictObject({ name: WorkspaceGroupName });
export type WorkspaceGroupCreate = z.infer<typeof WorkspaceGroupCreate>;

export const WorkspaceGroupRename = z.strictObject({ name: WorkspaceGroupName });
export type WorkspaceGroupRename = z.infer<typeof WorkspaceGroupRename>;

export const WorkspaceGroupMemberAdd = z.strictObject({ userId: z.string().min(1).max(200) });
export type WorkspaceGroupMemberAdd = z.infer<typeof WorkspaceGroupMemberAdd>;

/** A group as admins and editors see it: its name and how many members it has, never who. */
export const WorkspaceGroupView = z.object({
  id: WorkspaceGroupId,
  name: z.string(),
  members: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});
export type WorkspaceGroupView = z.infer<typeof WorkspaceGroupView>;

/** `GET /api/v1/workspaces/:slug/groups`, `list_groups`, `portifact workspaces groups`. */
export const WorkspaceGroupList = z.object({
  items: z.array(WorkspaceGroupView),
  /**
   * Whether the workspace's plan includes `workspaces`: without it no group can be created or
   * added to an artifact, and groups grant nothing.
   */
  available: z.boolean(),
  limit: z.number().int().positive(),
});
export type WorkspaceGroupList = z.infer<typeof WorkspaceGroupList>;

export const WorkspaceGroupMemberView = z.object({
  userId: z.string().min(1),
  name: z.string(),
  email: z.string(),
  role: WorkspaceRole,
  addedAt: z.iso.datetime(),
});
export type WorkspaceGroupMemberView = z.infer<typeof WorkspaceGroupMemberView>;

/** One group with its members, for admins through the dashboard session. */
export const WorkspaceGroupDetail = z.object({
  group: WorkspaceGroupView,
  items: z.array(WorkspaceGroupMemberView),
  limit: z.number().int().positive(),
});
export type WorkspaceGroupDetail = z.infer<typeof WorkspaceGroupDetail>;

/** A group an artifact lists, as the people managing its access see it. */
export const ArtifactGroupView = z.object({
  id: WorkspaceGroupId,
  name: z.string(),
  members: z.number().int().min(0),
  /** The group's exception to the artifact's comment visibility; null follows it. */
  commentVisibility: CommentScope.nullable(),
});
export type ArtifactGroupView = z.infer<typeof ArtifactGroupView>;
