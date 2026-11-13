// The owner side's RPC methods (`ownerCommand`, `auditSettle`, `auditAcknowledge`) over the
// in-memory reference object, as apps/data's `ArtifactDocuments` serves them over the store.
import { mutationActorName, runOwnerCommand } from "@portifact/domain/artifact-data";
import type { MemoryObject } from "@portifact/domain/testing/artifact-data";
import type { DataObjectRpc } from "../src/artifact-data.ts";

export function ownerRpc(
  memory: MemoryObject,
): Pick<DataObjectRpc, "ownerCommand" | "auditSettle" | "auditAcknowledge" | "lifecycleControl"> {
  const name = (actor: string) => mutationActorName({ kind: "owner", actor });
  return {
    lifecycleControl: async () => memory.durable.control,
    ownerCommand: async (envelope, actor, command, limits, now) =>
      runOwnerCommand(memory, envelope, actor, command, { now, limits }) as never,
    auditSettle: async (envelope, actor, opId, now) =>
      memory.settle(envelope, name(actor), opId, now) as never,
    auditAcknowledge: async (envelope, actor, opId, now) =>
      memory.acknowledge(envelope, name(actor), opId, now),
  };
}
