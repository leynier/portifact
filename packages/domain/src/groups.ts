// Groups of a workspace (premium plan T3, decision 0014): the rules for listing them on an
// artifact. Who reads through a group is `canRead`; who sees which comments is `commentScope`.
import { isWorkspaceId, WORKSPACE_GROUPS, WorkspaceGroupName } from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

/**
 * Whether an access change may leave the artifact with `after` groups. Groups exist only on
 * artifacts a workspace owns; at most `WORKSPACE_GROUPS.perArtifact` per artifact. Adding needs
 * the plan's `workspaces` (`requireFeature`, checked by the service); removing never does.
 */
export function checkArtifactGroups(input: {
  ownerId: string;
  adding: boolean;
  after: number;
}): Result<true> {
  if (input.adding && !isWorkspaceId(input.ownerId)) {
    return fail("invalid_input", "Only workspace artifacts can list groups.");
  }
  if (input.after > WORKSPACE_GROUPS.perArtifact) {
    return fail(
      "quota_exceeded",
      `An artifact can list at most ${WORKSPACE_GROUPS.perArtifact} groups.`,
    );
  }
  return ok(true);
}

/**
 * A group's name as stored: trimmed, NFC, one line of 1 to `WORKSPACE_GROUPS.nameMaxLength`
 * characters with no control characters or direction overrides. Unique per workspace without
 * regard to ASCII case (the database's index).
 */
export function normalizeGroupName(value: string): Result<string> {
  const parsed = WorkspaceGroupName.safeParse(value);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      `A group name is one line of 1 to ${WORKSPACE_GROUPS.nameMaxLength} characters.`,
    );
  }
  return ok(parsed.data);
}
