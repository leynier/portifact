// Who may write to an artifact's data from its page (decision 0026, decisions 4, 13 and 21,
// delivery 9): signed-in visitors who can open the artifact by default; people without an account
// only where the owner opens it, the owner deciding alone (a personal space) or a workspace policy
// controlling it. Pure: the services read the owner's plan and policy and apply these.
import type { DataWriters, WorkspacePolicy } from "@portifact/contracts";
import { type Entitlements, requireFeature } from "./plans.ts";
import { fail, ok, type Result } from "./result.ts";

export const DATA_WRITER_MESSAGES = {
  policy:
    "The workspace's policy does not allow people without an account to save data. Ask a workspace admin to allow it on the Policies page.",
} as const;

/** What anonymous writing needs of the owner. */
export interface AnonymousOwner {
  /** Whether the owner is a workspace (a personal space decides alone). */
  workspace: boolean;
  /** The owner's entitlements now: a workspace needs `policies`. */
  entitlements: Entitlements;
  /** The workspace's policy; undefined for a personal space. */
  policy: WorkspacePolicy | undefined;
}

/**
 * Whether the owner allows people without an account to write: always in a personal space; in a
 * workspace only with `policies` in its plan (`plan_required` otherwise) and a policy that allows
 * it (`policy_refused` otherwise). A permission, so a lapsed plan stops it rather than keeps it.
 */
export function anonymousWriting(owner: AnonymousOwner): Result<true> {
  if (!owner.workspace) return ok(true);
  const plan = requireFeature(owner.entitlements, "policies");
  if (!plan.ok) return plan;
  if (owner.policy?.anonymousDataWriters !== "allowed") {
    return fail("policy_refused", DATA_WRITER_MESSAGES.policy);
  }
  return ok(true);
}

/**
 * The change of who writes from the page: `signed_in` always (it only narrows); `anyone` only
 * where the owner allows anonymous writing.
 */
export function checkDataWriters(writers: DataWriters, owner: AnonymousOwner): Result<true> {
  return writers === "signed_in" ? ok(true) : anonymousWriting(owner);
}

/** How the owner side reads anonymous writing on an artifact now. */
export function anonymousState(
  writers: DataWriters,
  owner: AnonymousOwner,
): "available" | "off" | "plan_required" | "policy_refused" {
  if (writers === "signed_in") return "off";
  const allowed = anonymousWriting(owner);
  if (allowed.ok) return "available";
  return allowed.code === "plan_required" ? "plan_required" : "policy_refused";
}

/** The artifact as anonymous grants read it. */
export interface AnonymousArtifact {
  state: string;
  accessMode: string;
  /** Null when the artifact holds no data (no `artifact_data` row). */
  writers: DataWriters | null;
}

/**
 * Whether an anonymous grant may be issued or renewed now: the switch is on, the artifact is
 * active and public (a person without an account reads nothing else), holds data, its writers are
 * `anyone`, and its owner allows anonymous writing. Every renewal asks again, so turning any of
 * these off ends anonymous writing within the claims' minute.
 */
export function anonymousGrantOpen(input: {
  enabled: boolean;
  artifact: AnonymousArtifact | null;
  owner: AnonymousOwner | null;
}): boolean {
  const { artifact, owner } = input;
  return (
    input.enabled &&
    artifact !== null &&
    owner !== null &&
    artifact.state === "active" &&
    artifact.accessMode === "public" &&
    artifact.writers === "anyone" &&
    anonymousWriting(owner).ok
  );
}
