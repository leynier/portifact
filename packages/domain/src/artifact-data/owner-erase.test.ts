// The owner side's erase dispatch and the audit sweep's reading of pending obligations (decision
// 0026, the follow-up of delivery 5).
import { ERASURE_ACTOR, PLANS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { MemoryObject } from "../testing/artifact-data-object.ts";
import { mutationActorName } from "./mutation.ts";
import { operationKey, pendingObligation } from "./operations.ts";
import { runOwnerCommand } from "./owner-commands.ts";

const NOW = 1_800_000_000_000;
const OP = `${NOW}.abcdefgh`;

describe("pendingObligation", () => {
  it("reads an owner's and the erasure's obligation keys", () => {
    expect(pendingObligation(operationKey("owner:u1", 3, OP), "o1")).toEqual({
      actor: "u1",
      generation: 3,
      opId: OP,
      owner: "o1",
    });
    expect(pendingObligation(operationKey(ERASURE_ACTOR, 0, OP), "o1")).toEqual({
      actor: ERASURE_ACTOR,
      generation: 0,
      opId: OP,
      owner: "o1",
    });
  });

  it("refuses a page's obligation and malformed keys", () => {
    expect(pendingObligation(operationKey("visitor:v_x", 0, OP), "o1")).toBeNull();
    expect(pendingObligation(operationKey("owner:", 0, OP), "o1")).toBeNull();
    expect(pendingObligation(operationKey("owner:u1", -1, OP), "o1")).toBeNull();
    expect(pendingObligation(operationKey("owner:u1", 1.5, OP), "o1")).toBeNull();
    expect(pendingObligation(operationKey("owner:u1", 0, "nope"), "o1")).toBeNull();
    expect(pendingObligation("owner:u1|0", "o1")).toBeNull();
  });
});

describe("the owner's erase and pending obligations on the reference object", () => {
  const envelope = { artifactId: "a1", region: "default", ownerId: "o1", generation: 0, epoch: 0 };
  const limits = PLANS.free.data.perArtifact;
  const context = { now: NOW, limits };

  function seeded() {
    const memory = new MemoryObject("a1");
    runOwnerCommand(
      memory,
      { ...envelope, opId: `${NOW}.declare1` },
      "u1",
      { kind: "declare", declaration: { name: "votes", mode: "shared", indexed: [] } },
      context,
    );
    runOwnerCommand(
      memory,
      { ...envelope, opId: `${NOW}.create01` },
      "u1",
      { kind: "create", collection: "votes", body: { n: 1 } },
      context,
    );
    return memory;
  }

  it("lists obligations pending before a time, oldest first, as the sweep reads them", () => {
    const memory = seeded();
    const pending = memory.pendingObligations(envelope, NOW + 1, 10, NOW + 1);
    expect(pending.map((one) => one.opId)).toEqual([`${NOW}.declare1`, `${NOW}.create01`]);
    expect(pending.every((one) => one.actor === "u1" && one.owner === "o1")).toBe(true);
    expect(memory.pendingObligations(envelope, NOW, 10, NOW + 1)).toEqual([]);
    expect(memory.pendingObligations(envelope, NOW + 1, 1, NOW + 1)).toHaveLength(1);
    memory.settle(
      envelope,
      mutationActorName({ kind: "owner", actor: "u1" }),
      `${NOW}.create01`,
      NOW,
    );
    memory.acknowledge(
      envelope,
      mutationActorName({ kind: "owner", actor: "u1" }),
      `${NOW}.create01`,
      NOW,
    );
    expect(memory.pendingObligations(envelope, NOW + 1, 10, NOW + 1)).toHaveLength(1);
  });

  it("prepares and commits an optional erase, dropping the operation ID and requiredErase", () => {
    const memory = seeded();
    const eraseId = `${NOW}.erase001`;
    const sent = { ...envelope, opId: `${NOW}.ignored1`, requiredErase: "purge" as const };
    const prepared = runOwnerCommand(
      memory,
      sent,
      "u1",
      { kind: "erase", step: "prepare", eraseId },
      context,
    );
    expect(prepared).toMatchObject({ ok: true, value: { outcome: "prepared" } });
    const committed = runOwnerCommand(
      memory,
      sent,
      "u1",
      { kind: "erase", step: "commit", eraseId },
      context,
    );
    expect(committed).toMatchObject({ ok: true });
    expect(memory.durable.documents.size).toBe(0);
    expect(memory.durable.control?.generation).toBe(1);
  });

  it("cancels a prepared erase, which keeps the data", () => {
    const memory = seeded();
    const eraseId = `${NOW}.erase002`;
    runOwnerCommand(memory, envelope, "u1", { kind: "erase", step: "prepare", eraseId }, context);
    const cancelled = runOwnerCommand(
      memory,
      envelope,
      "u1",
      { kind: "erase", step: "cancel", eraseId },
      context,
    );
    expect(cancelled).toMatchObject({ ok: true, value: { outcome: "cancelled" } });
    expect(memory.durable.documents.size).toBe(1);
  });
});
