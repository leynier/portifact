// The lifecycle interface of the documents object (decision 0026, delivery 4): the only RPC
// methods another Worker reaches. Every argument is parsed at the boundary: an envelope that
// carries an operation ID or an erase reason is refused there (each method sets its own), a
// required erase is required only through `lifecycleErase`'s reason, and reading the control
// record of an object nothing bound creates nothing.

import type { DataObjectRpc } from "@portifact/services";
import { lifecycleId } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { artifactId, DATA_NOW, inside, stubOf, withData } from "./lifecycle.ts";

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;

function envelope(id: string, ownerId: string) {
  return { artifactId: id, region: "default", ownerId, generation: 0, epoch: 0 };
}

describe("the lifecycle interface", () => {
  it("reads no control record and writes nothing on an object nothing bound", async () => {
    const id = artifactId();
    expect(await rpc(id).lifecycleControl()).toBeNull();
    expect(await inside(id, (object) => object.store.inspect("pf_meta"))).toEqual([]);
  });

  it("refuses an envelope carrying an erase reason or an operation ID, writing nothing", async () => {
    const { id, ownerId } = await withData();
    const base = envelope(id, ownerId);
    const before = await rpc(id).lifecycleControl();
    const fence = { kind: "hold", transition: "hold_rpc" } as const;
    const invalid = [
      await rpc(id).lifecycleFence({ ...base, requiredErase: "purge" } as never, fence, DATA_NOW),
      await rpc(id).lifecycleFence(
        { ...base, opId: lifecycleId(DATA_NOW) } as never,
        fence,
        DATA_NOW,
      ),
      await rpc(id).lifecycleFence(base, fence, -1),
      await rpc(id).lifecycleErase(
        "prepare",
        base,
        lifecycleId(DATA_NOW),
        "reset" as never,
        DATA_NOW,
      ),
      await rpc(id).lifecycleErase("drop" as never, base, lifecycleId(DATA_NOW), "purge", DATA_NOW),
      await rpc(id).lifecycleEraseAuthor(base, "owner", lifecycleId(DATA_NOW), DATA_NOW),
      await rpc(id).lifecycleQuarantine(base, "bored" as never, DATA_NOW),
      await rpc(id).lifecycleResolve(base, "keep" as never, DATA_NOW),
      await rpc(id).lifecycleExport(base, { collection: "notes" } as never, DATA_NOW),
    ];
    expect(invalid.map((answer) => answer.ok || answer.code)).toEqual(
      Array(invalid.length).fill("invalid_input"),
    );
    expect(await rpc(id).lifecycleControl()).toEqual(before);
  });

  it("prepares, cancels and commits a required erase under its ID", async () => {
    const { id, ownerId } = await withData();
    const base = envelope(id, ownerId);
    const first = lifecycleId(DATA_NOW);
    const prepared = await rpc(id).lifecycleErase("prepare", base, first, "purge", DATA_NOW);
    expect(prepared.ok && prepared.value.outcome).toBe("prepared");
    const cancelled = await rpc(id).lifecycleErase("cancel", base, first, "purge", DATA_NOW);
    expect(cancelled.ok && cancelled.value.outcome).toBe("cancelled");
    const second = lifecycleId(DATA_NOW);
    await rpc(id).lifecycleErase("prepare", base, second, "account_deletion", DATA_NOW);
    const committed = await rpc(id).lifecycleErase(
      "commit",
      base,
      second,
      "account_deletion",
      DATA_NOW,
    );
    expect(committed.ok && committed.value.outcome).toBe("committed");
    expect((await rpc(id).lifecycleControl())?.generation).toBe(1);
  });

  it("quarantines, exports under the quarantine and resolves", async () => {
    const { id, ownerId } = await withData({ documents: 2 });
    const base = envelope(id, ownerId);
    const quarantined = await rpc(id).lifecycleQuarantine(base, "orphan", DATA_NOW);
    expect(quarantined.ok && quarantined.value).toBe(true);
    const page = await rpc(id).lifecycleExport(base, null, DATA_NOW);
    expect(page.ok && page.value.rows.length).toBe(2);
    const resolved = await rpc(id).lifecycleResolve(base, "adopt", DATA_NOW);
    expect(resolved.ok).toBe(true);
    expect((await rpc(id).lifecycleControl())?.quarantine).toBeNull();
  });

  it("erases an author in chunks under the given operation ID only", async () => {
    const visitor = `v_${"a".repeat(24)}`;
    const { id, ownerId } = await withData({ visitors: [visitor] });
    const base = envelope(id, ownerId);
    const chunk = await rpc(id).lifecycleEraseAuthor(
      base,
      visitor,
      lifecycleId(DATA_NOW),
      DATA_NOW,
    );
    expect(chunk.ok && "value" in chunk && chunk.value).toEqual({
      documents: 1,
      edits: 0,
      more: false,
    });
  });
});
