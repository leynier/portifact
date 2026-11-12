import { describe, expect, it } from "vitest";
import { checkFence } from "../src/envelope.ts";
import { newerReport } from "../src/model.ts";
import { artifact, context, OWNER, ok, op, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("fencing: one envelope, a generation and an epoch (findings 4 and 27)", () => {
  it("refuses a request that began before a transfer once the object has the new epoch", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const transferred = { ...envelope, epoch: 1 };
    ok(await docs.fence(transferred, "open"));
    expect(await docs.create(op(envelope), owner, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "stale",
    });
    ok(await docs.create(op(transferred), owner, "items", { n: 1 }));
    // An older fence never moves the object back.
    expect(await docs.fence(envelope, "open")).toMatchObject({ ok: false, error: "stale" });
  });

  it("makes a hold an acknowledged barrier: everything stops, and a prepared erase is cancelled", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const kept = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    expect(ok(await docs.prepareErase(envelope))).toEqual({ prepared: true });
    const held = { ...envelope, epoch: 1 };
    expect(ok(await docs.fence(held, "held"))).toEqual({ epoch: 1, state: "held" });
    // The erase job committing after the hold finds nothing to do.
    expect(ok(await docs.commitErase(envelope))).toEqual({ erased: false });
    expect(await docs.get(held, owner, "items", kept._id)).toMatchObject({
      ok: false,
      error: "held",
    });
    expect(await docs.create(op(held), context(visitor("v_a")), "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "held",
    });
    // Release: a newer epoch, open again, the data intact.
    const released = { ...envelope, epoch: 2 };
    ok(await docs.fence(released, "open"));
    expect(ok(await docs.get(released, owner, "items", kept._id)).n).toBe(1);
  });

  it("refuses commands while an erase is prepared, and lets a cancel reopen", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.prepareErase(envelope));
    expect(await docs.create(op(envelope), owner, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "stale",
    });
    expect(await docs.cancelErase(envelope)).toBe(true);
    ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
  });

  it("decides the envelope in one pure rule", () => {
    const stored = {
      artifactId: "a",
      region: "eu",
      generation: 2,
      epoch: 5,
      state: "open" as const,
    };
    expect(checkFence(null, { artifactId: "a", region: "eu", generation: 0, epoch: 0 })).toEqual({
      ok: true,
      adopt: true,
    });
    expect(
      checkFence(stored, { artifactId: "a", region: "default", generation: 2, epoch: 5 }),
    ).toMatchObject({ error: "forbidden" });
    expect(
      checkFence(stored, { artifactId: "a", region: "eu", generation: 1, epoch: 5 }),
    ).toMatchObject({ error: "stale" });
    expect(
      checkFence(stored, { artifactId: "a", region: "eu", generation: 2, epoch: 4 }),
    ).toMatchObject({ error: "stale" });
    expect(checkFence(stored, { artifactId: "a", region: "eu", generation: 2, epoch: 6 })).toEqual({
      ok: true,
      adopt: true,
    });
    expect(
      checkFence(
        { ...stored, state: "held" },
        { artifactId: "a", region: "eu", generation: 2, epoch: 5 },
      ),
    ).toMatchObject({ error: "held" });
    expect(
      checkFence(
        { ...stored, state: "held" },
        { artifactId: "a", region: "eu", generation: 2, epoch: 5 },
        true,
      ),
    ).toEqual({ ok: true, adopt: false });
  });
});

describe("sizes, audit obligations and author erasure", () => {
  it("reports sizes with a revision so a late report never replaces a newer one (finding 17)", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const first = await docs.create(op(envelope), owner, "items", { n: 1 });
    const second = await docs.create(op(envelope), owner, "items", { n: 2 });
    if (!first.ok || !second.ok) throw new Error("expected writes");
    expect(second.revision).toBeGreaterThan(first.revision);
    const late = { generation: 0, revision: first.revision, bytes: first.size };
    const newer = { generation: 0, revision: second.revision, bytes: second.size };
    expect(newerReport(newer, late)).toBe(false);
    expect(newerReport(late, newer)).toBe(true);
    expect(newerReport(newer, { generation: 1, revision: 0, bytes: 0 })).toBe(true);
    expect(newerReport(null, late)).toBe(true);
  });

  it("journals an owner mutation's audit obligation in the mutation's own transaction (finding 21)", async () => {
    const { envelope, docs, sandbox } = artifact();
    const write = op(envelope);
    ok(await docs.declareCollection(write, owner, { name: "items", mode: "read" }));
    expect(await docs.auditFor(write.opId as string)).toMatchObject({
      kind: "data.collection_set",
    });
    await docs.ackAudit(write.opId as string);
    expect(await docs.auditFor(write.opId as string)).toBeNull();
    const sql = op(envelope);
    ok(await sandbox.execute(sql, owner, "create table t (x)"));
    expect(await sandbox.auditFor(sql.opId as string)).toMatchObject({ kind: "data.sql_executed" });
    // A visitor's write leaves none.
    const visit = op(envelope);
    ok(await docs.declareCollection(op(envelope), owner, { name: "open", mode: "append" }));
    ok(await docs.create(visit, context(visitor("v_a")), "open", { n: 1 }));
    expect(await docs.auditFor(visit.opId as string)).toBeNull();
  });

  it("erases one author in bounded chunks and keeps everyone else (finding 5)", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    for (let index = 0; index < 7; index++)
      ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { index }));
    ok(await docs.create(op(envelope), context(visitor("v_b")), "items", { n: 1 }));
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_a", 3))).toEqual({ erased: 3, more: true });
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_a", 3))).toEqual({ erased: 3, more: true });
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_a", 3))).toEqual({ erased: 1, more: false });
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_a", 3))).toEqual({ erased: 0, more: false });
    const left = ok(await docs.query(envelope, owner, { collection: "items" }));
    expect(left.documents.map((document) => document._by)).toEqual(["v_b"]);
  });
});
