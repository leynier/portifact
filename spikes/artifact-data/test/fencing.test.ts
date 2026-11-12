import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { admit, applyFence, type Control, newControl, reconcile } from "../src/envelope.ts";
import { claimVisitorId } from "../src/journal.ts";
import { artifact, context, NOW, OWNER, ok, op, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("fencing: one validator, the owner, the generation and the epoch", () => {
  it("refuses a request that began before a transfer, and names the new owner after it", async () => {
    const { envelope, docs } = artifact("owner_a");
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const transfer = { ...envelope, epoch: 1 };
    expect(ok(await docs.fence(transfer, { state: "open", toOwner: "owner_b" }))).toEqual({
      epoch: 1,
      state: "open",
      ownerId: "owner_b",
    });
    expect(await docs.create(op(envelope), owner, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "stale",
    });
    expect(await docs.create(op(transfer), owner, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "stale",
    });
    const after = { ...envelope, ownerId: "owner_b", epoch: 1 };
    ok(await docs.create(op(after), owner, "items", { n: 1 }));
    // A late, older fence never moves the object back; repeating the same fence is acknowledged.
    expect(await docs.fence(envelope, { state: "open" })).toMatchObject({
      ok: false,
      error: "stale",
    });
    ok(await docs.fence(transfer, { state: "open", toOwner: "owner_b" }));
  });

  it("makes a hold an acknowledged barrier that cancels a prepared erase", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const kept = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    expect(ok(await docs.prepareErase(envelope))).toEqual({ prepared: true });
    const held = { ...envelope, epoch: 1 };
    expect(ok(await docs.fence(held, { state: "held" }))).toMatchObject({
      epoch: 1,
      state: "held",
    });
    expect(await docs.commitErase(envelope)).toMatchObject({ ok: false, error: "stale" });
    expect(await docs.commitErase(held)).toMatchObject({ ok: false, error: "held" });
    expect(await docs.get(held, owner, "items", kept._id)).toMatchObject({
      ok: false,
      error: "held",
    });
    const released = { ...envelope, epoch: 2 };
    ok(await docs.fence(released, { state: "open" }));
    expect(ok(await docs.get(released, owner, "items", kept._id)).n).toBe(1);
  });

  it("erases both objects of a generation atomically each, and finishes when only one had", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await sandbox.execute(op(envelope), owner, "create table t (x)"));
    // The job prepares both; the documents commit, then the job dies before the sandbox does.
    ok(await docs.prepareErase(envelope));
    expect(await sandbox.prepareErase(envelope)).toEqual({ ok: true, prepared: true });
    expect(ok(await docs.commitErase(envelope))).toEqual({ erased: true });
    // The retried job: the documents say done, the sandbox finishes.
    expect(ok(await docs.prepareErase(envelope))).toEqual({ prepared: false });
    expect(await sandbox.prepareErase(envelope)).toEqual({ ok: true, prepared: true });
    expect(await sandbox.commitErase(envelope)).toEqual({ ok: true, erased: true });
    const next = { ...envelope, generation: 1 };
    expect((await docs.controlRecord())?.generation).toBe(1);
    expect((await sandbox.controlRecord())?.generation).toBe(1);
    expect(
      ok(
        await sandbox.query(
          next,
          owner,
          "select count(*) from sqlite_schema where type = 'table' and name not like '\\_cf\\_%' escape '\\'",
        ),
      ).rows,
    ).toEqual([[0]]);
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

  it("decides every command with one pure rule", () => {
    const stored: Control = {
      ...newControl(
        { artifactId: "a", region: "eu", ownerId: "o", generation: 2, epoch: 5 },
        "open",
        NOW,
      ),
      storageSeq: 0,
    };
    const base = { artifactId: "a", region: "eu", ownerId: "o", generation: 2, epoch: 5 };
    expect(admit(null, base, { kind: "request", create: false })).toEqual({
      ok: true,
      adopt: true,
      empty: true,
    });
    expect(admit(null, base, { kind: "erase" })).toEqual({ ok: true, done: true });
    expect(
      admit(stored, { ...base, region: "default" }, { kind: "request", create: false }),
    ).toMatchObject({ error: "forbidden" });
    expect(
      admit(stored, { ...base, ownerId: "x" }, { kind: "request", create: false }),
    ).toMatchObject({ error: "stale" });
    expect(
      admit(stored, { ...base, generation: 1 }, { kind: "request", create: false }),
    ).toMatchObject({ error: "stale" });
    expect(admit(stored, { ...base, generation: 1 }, { kind: "erase" })).toEqual({
      ok: true,
      done: true,
    });
    expect(admit(stored, { ...base, epoch: 4 }, { kind: "request", create: false })).toMatchObject({
      error: "stale",
    });
    expect(admit(stored, { ...base, epoch: 6 }, { kind: "request", create: false })).toEqual({
      ok: true,
      adopt: true,
      empty: false,
    });
    expect(
      admit({ ...stored, state: "held" }, base, { kind: "request", create: false }),
    ).toMatchObject({ error: "held" });
    expect(admit({ ...stored, state: "held" }, base, { kind: "operator" })).toEqual({
      ok: true,
      adopt: false,
      empty: false,
    });
    expect(
      admit({ ...stored, state: "quarantined" }, base, { kind: "request", create: false }),
    ).toMatchObject({ error: "quarantined" });
    expect(
      admit({ ...stored, state: "erasing" }, base, { kind: "request", create: false }),
    ).toMatchObject({ error: "stale" });
    expect(
      applyFence(stored, { ...base, epoch: 6 }, { state: "open", toOwner: "p" }, NOW),
    ).toMatchObject({
      ok: true,
      control: { ownerId: "p", ownerEpoch: 6, last: { kind: "transfer", fromOwner: "o" } },
    });
    expect(
      applyFence(stored, { ...base, artifactId: "b", epoch: 6 }, { state: "open" }, NOW),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      applyFence(stored, { ...base, ownerId: "x", epoch: 6 }, { state: "open" }, NOW),
    ).toMatchObject({ ok: false, error: "stale" });
  });
});

describe("restore reconciliation (finding 4)", () => {
  it("raises D1 for the same owner, and quarantines what the numbers cannot explain", () => {
    const object: Control = newControl(
      { artifactId: "a", region: "eu", ownerId: "new", generation: 1, epoch: 5 },
      "open",
      NOW,
    );
    expect(reconcile({ ownerId: "old", generation: 1, epoch: 0, held: false }, object)).toEqual({
      action: "quarantine",
      reason: "owner",
    });
    expect(reconcile({ ownerId: "new", generation: 0, epoch: 3, held: false }, object)).toEqual({
      action: "raise",
      generation: 1,
      epoch: 6,
    });
    expect(reconcile({ ownerId: "new", generation: 1, epoch: 5, held: false }, object)).toEqual({
      action: "none",
    });
    expect(reconcile({ ownerId: "new", generation: 1, epoch: 5, held: true }, object)).toEqual({
      action: "quarantine",
      reason: "hold",
    });
    expect(reconcile({ ownerId: "new", generation: 1, epoch: 5, held: false }, null)).toEqual({
      action: "none",
    });
  });

  it("never lets a restored former owner read the new owner's data, and a quarantine stops everyone", async () => {
    const { envelope, docs, sandbox } = artifact("owner_old");
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.fence({ ...envelope, epoch: 5 }, { state: "open", toOwner: "owner_new" }));
    ok(
      await docs.create(op({ ...envelope, ownerId: "owner_new", epoch: 5 }), owner, "items", {
        secret: "new",
      }),
    );
    // D1 restored to the old owner at epoch 0: even raised to the object's epoch, it is refused.
    expect(
      await docs.query({ ...envelope, epoch: 6 }, owner, { collection: "items" }),
    ).toMatchObject({ ok: false, error: "stale" });
    const object = await docs.controlRecord();
    expect(
      reconcile({ ownerId: "owner_old", generation: 0, epoch: 0, held: false }, object),
    ).toMatchObject({ action: "quarantine" });
    expect(await docs.quarantine(envelope)).toBe(true);
    expect(
      await docs.query({ ...envelope, ownerId: "owner_new", epoch: 5 }, owner, {
        collection: "items",
      }),
    ).toMatchObject({
      ok: false,
      error: "quarantined",
    });
    ok(await sandbox.execute(op(envelope), owner, "create table t (x)"));
    expect(await sandbox.quarantine(envelope)).toBe(true);
    expect(await sandbox.query(envelope, owner, "select 1")).toMatchObject({
      ok: false,
      error: "quarantined",
    });
  });
});

describe("replay records, obligations and author erasure", () => {
  it("keeps replay records a day and prunes them after (finding 5)", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const once = op(envelope);
    ok(await docs.create(once, context(visitor("v_a")), "items", { n: 1 }));
    expect(await docs.pruneReplays(Date.now())).toBe(0);
    await docs.backdateReplays(Date.now() - 2 * 86_400_000);
    expect(await docs.pruneReplays(Date.now())).toBe(2);
  });

  it("refuses a reused operation ID for another request, and replays only after authorization", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const once = op(envelope);
    ok(await docs.create(once, context(visitor("v_a")), "items", { n: 1 }));
    expect(await docs.create(once, context(visitor("v_a")), "items", { n: 2 })).toMatchObject({
      ok: false,
      error: "conflict",
    });
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    expect(await docs.create(once, context(visitor("v_a")), "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("settles an operation: committed obligations are returned, the rest are marked aborted for good (finding 14)", async () => {
    const { envelope, docs, sandbox } = artifact();
    const declared = op(envelope);
    ok(await docs.declareCollection(declared, owner, { name: "items", mode: "read" }));
    expect(await docs.settle(envelope, "owner:owner", declared.opId as string)).toMatchObject({
      state: "committed",
      kind: "data.collection_set",
    });
    expect(await docs.settle(envelope, "owner:owner", "op_never")).toEqual({ state: "aborted" });
    // The original call arriving after the relay gave up does not commit.
    expect(
      await docs.create({ ...envelope, opId: "op_never" }, owner, "items", { n: 1 }),
    ).toMatchObject({ ok: false, error: "conflict" });
    // Obligations survive a whole erase.
    ok(await docs.prepareErase(envelope));
    ok(await docs.commitErase(envelope));
    expect(await docs.auditFor(declared.opId as string)).not.toBeNull();
    const sql = op(envelope);
    ok(await sandbox.execute(sql, owner, "create table t (x)"));
    expect(await sandbox.settle(envelope, "owner:owner", sql.opId as string)).toMatchObject({
      state: "committed",
    });
    expect(await sandbox.settle(envelope, "owner:owner", "op_lost")).toEqual({ state: "aborted" });
  });

  it("erases one author in bounded chunks and keeps everyone else", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    for (let index = 0; index < 7; index++)
      ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { index }));
    ok(await docs.create(op(envelope), context(visitor("v_b")), "items", { n: 1 }));
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_a", 3))).toEqual({ erased: 3, more: true });
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_a", 3))).toEqual({ erased: 3, more: true });
    const last = ok(await docs.eraseAuthorChunk(envelope, "v_a", 3));
    expect(last.erased).toBe(1);
    while (ok(await docs.eraseAuthorChunk(envelope, "v_a", 3)).more) {
      // The replay and rate rows of the author go too, a bounded number per call.
    }
    const left = ok(await docs.query(envelope, owner, { collection: "items" }));
    expect(left.documents.map((document) => document._by)).toEqual(["v_b"]);
  });

  it("gives two racing first grants one identity (finding 6)", async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        claimVisitorId(env.JOURNAL, "user_1", "a_race", `v_candidate_${index}`, NOW),
      ),
    );
    expect(new Set(claims).size).toBe(1);
    expect(await claimVisitorId(env.JOURNAL, "user_1", "a_race", "v_later", NOW)).toBe(claims[0]);
  });
});

describe("storage reports (finding 13)", () => {
  it("raise their sequence on every change and on refused work, and come with failures", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const first = await docs.create(op(envelope), owner, "items", { n: 1 });
    const refused = await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 });
    const second = await docs.create(op(envelope), owner, "items", { n: 2 });
    expect(refused.ok).toBe(false);
    expect(refused.storage.seq).toBeGreaterThan(first.storage.seq);
    expect(second.storage.seq).toBeGreaterThan(refused.storage.seq);
    const sql = await sandbox.execute(op(envelope), owner, "create table t (x)");
    expect(sql.storage.seq).toBeGreaterThan(0);
  });
});

describe("lossless export (finding 9)", () => {
  it("exports every SQLite type exactly, large integers and large blobs included", async () => {
    const { envelope, sandbox } = artifact();
    ok(await sandbox.execute(op(envelope), owner, "create table t (a, b, c, d)"));
    await sandbox.unsafeExec(
      "insert into t values (9223372036854775807, randomblob(70000), 0.1, null)",
    );
    const page = await sandbox.exportTable(envelope, owner, "t", 0, 10);
    if (!page.ok || !("value" in page)) throw new Error("export failed");
    const row = page.value.rows[0];
    if (row === undefined) throw new Error("no row");
    expect(page.value.columns).toEqual(["a", "b", "c", "d"]);
    expect(row?.values[0]).toEqual({ t: "integer", v: "9223372036854775807" });
    expect(row?.values[1]).toMatchObject({ t: "blob" });
    expect((row.values[1] as { v: string }).v).toHaveLength(140_000);
    // The shortest text that reads back as the same double.
    expect(row?.values[2]).toMatchObject({ t: "real" });
    expect(Number((row.values[2] as { v: string }).v)).toBe(0.1);
    expect(row?.values[3]).toEqual({ t: "null" });
    expect(await sandbox.exportTable(envelope, owner, "missing", 0, 10)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await sandbox.exportTable(envelope, owner, "bad name", 0, 10)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });
});
