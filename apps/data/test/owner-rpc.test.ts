// The owner side's RPC methods of the documents object (decision 0026, delivery 5): `ownerCommand`
// parses every argument at the boundary and runs the store's command as the owner side, and the
// audit relay's `auditSettle` and `auditAcknowledge` settle an owner operation's obligation. An
// invalid argument is answered as a value and never touches storage.
import { PLANS } from "@portifact/contracts";
import type { DataObjectRpc } from "@portifact/services";
import { lifecycleId } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { artifactId, DATA_NOW, inside, quiet, stubOf } from "./lifecycle.ts";

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;
const LIMITS = PLANS.free.data.perArtifact;

function envelope(id: string, opId?: string) {
  return {
    artifactId: id,
    region: "default",
    ownerId: "u_owner",
    generation: 0,
    epoch: 0,
    ...(opId === undefined ? {} : { opId }),
  };
}

type Answer = { ok: boolean; code?: string; value?: unknown };

describe("ownerCommand", () => {
  it("refuses invalid arguments as a value, before any storage", async () => {
    const id = artifactId();
    await quiet(id);
    const object = rpc(id);
    const describe = { kind: "describe" } as const;
    const invalid = (await Promise.all([
      object.ownerCommand(
        { ...envelope(id), requiredErase: "purge" } as never,
        "u_owner",
        describe,
        LIMITS,
        DATA_NOW,
      ),
      object.ownerCommand(envelope(id), "not an actor", describe, LIMITS, DATA_NOW),
      object.ownerCommand(envelope(id), "u_owner", { kind: "drop" } as never, LIMITS, DATA_NOW),
      object.ownerCommand(
        envelope(id),
        "u_owner",
        describe,
        { ...LIMITS, documentBytes: 0 },
        DATA_NOW,
      ),
      object.ownerCommand(envelope(id), "u_owner", describe, LIMITS, -1),
    ])) as Answer[];
    expect(invalid.map((answer) => answer.ok || answer.code)).toEqual(
      Array(invalid.length).fill("invalid_input"),
    );
    expect(await inside(id, (o) => o.store.inspect("pf_meta"))).toEqual([]);
  });

  it("declares, creates and reads as the owner side, then settles and acknowledges the audit", async () => {
    const id = artifactId();
    await quiet(id);
    const object = rpc(id);
    const declareId = lifecycleId(DATA_NOW);
    const declared = (await object.ownerCommand(
      envelope(id, declareId),
      "u_owner",
      { kind: "declare", declaration: { name: "notes", mode: "own" } },
      LIMITS,
      DATA_NOW,
    )) as Answer;
    expect(declared.ok).toBe(true);
    const created = (await object.ownerCommand(
      envelope(id, lifecycleId(DATA_NOW)),
      "u_owner",
      { kind: "create", collection: "notes", body: { text: "hi" } },
      LIMITS,
      DATA_NOW,
    )) as Answer;
    expect(created).toMatchObject({ ok: true, value: { text: "hi", _by: "owner" } });
    const page = (await object.ownerCommand(
      envelope(id),
      "u_owner",
      { kind: "query", query: { collection: "notes" } },
      LIMITS,
      DATA_NOW,
    )) as Answer;
    expect((page.value as { documents: unknown[] }).documents).toHaveLength(1);

    const settled = await object.auditSettle(envelope(id), "u_owner", declareId, DATA_NOW);
    expect(settled).toMatchObject({
      state: "committed",
      kind: "data.collection_set",
      delivered: false,
    });
    expect(await object.auditAcknowledge(envelope(id), "u_owner", declareId, DATA_NOW)).toBe(true);
    expect(await object.auditAcknowledge(envelope(id), "u_owner", declareId, DATA_NOW)).toBe(false);
    expect(await object.auditSettle(envelope(id), "u_owner", declareId, DATA_NOW)).toMatchObject({
      delivered: true,
    });
    // Another actor's key holds nothing: the operation is recorded aborted for them.
    expect(await object.auditSettle(envelope(id), "u_other", declareId, DATA_NOW)).toEqual({
      state: "aborted",
    });
  });

  it("answers the relay's invalid arguments without throwing", async () => {
    const id = artifactId();
    await quiet(id);
    const object = rpc(id);
    expect(
      await object.auditSettle(envelope(id), "bad actor", lifecycleId(DATA_NOW), DATA_NOW),
    ).toEqual({
      state: "refused",
      code: "invalid_input",
    });
    expect(await object.auditAcknowledge(envelope(id), "u_owner", "nope", DATA_NOW)).toBe(false);
    expect(await inside(id, (o) => o.store.inspect("pf_meta"))).toEqual([]);
  });

  it("lists pending obligations for the sweep, and erases as the owner's optional intent", async () => {
    const id = artifactId();
    await quiet(id);
    const object = rpc(id);
    const declareId = lifecycleId(DATA_NOW);
    await object.ownerCommand(
      envelope(id, declareId),
      "u_owner",
      { kind: "declare", declaration: { name: "notes", mode: "shared" } },
      LIMITS,
      DATA_NOW,
    );
    const createId = lifecycleId(DATA_NOW + 1);
    await object.ownerCommand(
      envelope(id, createId),
      "u_owner",
      { kind: "create", collection: "notes", body: { text: "hi" } },
      LIMITS,
      DATA_NOW + 1,
    );
    const pending = await object.auditPending(envelope(id), DATA_NOW + 10, DATA_NOW + 10);
    expect(pending).toEqual([
      { actor: "u_owner", generation: 0, opId: declareId, owner: "u_owner" },
      { actor: "u_owner", generation: 0, opId: createId, owner: "u_owner" },
    ]);
    expect(await object.auditPending(envelope(id), DATA_NOW, DATA_NOW + 10)).toEqual([]);
    expect(await object.auditPending({ nope: 1 } as never, DATA_NOW, DATA_NOW)).toEqual([]);

    const eraseId = lifecycleId(DATA_NOW + 2);
    const step = (name: "prepare" | "commit") =>
      object.ownerCommand(
        envelope(id),
        "u_owner",
        { kind: "erase", step: name, eraseId },
        LIMITS,
        DATA_NOW + 2,
      ) as Promise<Answer & { storage?: { generation: number } }>;
    expect(await step("prepare")).toMatchObject({ ok: true, value: { outcome: "prepared" } });
    const committed = await step("commit");
    expect(committed).toMatchObject({ ok: true, storage: { generation: 1 } });
    expect(await inside(id, (o) => o.store.inspect("pf_documents"))).toEqual([]);
  });
});
