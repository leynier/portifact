import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { operationKey } from "../src/documents.ts";
import { admit, applyFence, type Control, newControl, reconcile } from "../src/envelope.ts";
import { claimVisitorId } from "../src/journal.ts";
import { artifact, context, NOW, OWNER, ok, op, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("fencing: one validator, the owner, the generation and the epoch", () => {
  it("refuses a request that began before a transfer, and names the new owner after it", async () => {
    const { envelope, docs } = artifact("owner_a");
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const transfer = { ...envelope, epoch: 1 };
    const move = { state: "open", toOwner: "owner_b", transition: "t_move" } as const;
    expect(ok(await docs.fence(transfer, move))).toEqual({
      epoch: 1,
      held: false,
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
    // A late, older fence never moves the object back; the same transition again is acknowledged.
    expect(await docs.fence(envelope, { state: "open", transition: "t_old" })).toMatchObject({
      ok: false,
      error: "stale",
    });
    ok(await docs.fence(transfer, move));
    expect((await docs.controlRecord())?.last).toMatchObject({
      id: "t_move",
      kind: "transfer",
      fromOwner: "owner_a",
      toOwner: "owner_b",
    });
  });

  it("makes a hold an acknowledged barrier that cancels a prepared erase", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const kept = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    expect(ok(await docs.prepareErase(envelope))).toEqual({ prepared: true });
    const held = { ...envelope, epoch: 1 };
    expect(ok(await docs.fence(held, { state: "held", transition: "t_hold" }))).toMatchObject({
      epoch: 1,
      held: true,
    });
    expect(await docs.commitErase(envelope)).toMatchObject({ ok: false, error: "stale" });
    expect(await docs.commitErase(held)).toMatchObject({ ok: false, error: "held" });
    expect(await docs.get(held, owner, "items", kept._id)).toMatchObject({
      ok: false,
      error: "held",
    });
    const released = { ...envelope, epoch: 2 };
    ok(await docs.fence(released, { state: "open", transition: "t_release" }));
    expect(ok(await docs.get(released, owner, "items", kept._id)).n).toBe(1);
  });

  it("erases a generation in one transaction, and a retried job finds it done", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    ok(await docs.prepareErase(envelope));
    expect(ok(await docs.commitErase(envelope))).toEqual({ erased: true });
    expect(ok(await docs.prepareErase(envelope))).toEqual({ prepared: false });
    expect(ok(await docs.commitErase(envelope))).toEqual({ erased: false });
    const next = { ...envelope, generation: 1 };
    expect((await docs.controlRecord())?.generation).toBe(1);
    expect(await docs.query(next, owner, { collection: "items" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    // A request of the erased generation is refused, not answered from the new one.
    expect(await docs.create(op(envelope), owner, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "stale",
    });
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
    const base = { artifactId: "a", region: "eu", ownerId: "o", generation: 2, epoch: 5 };
    const stored: Control = newControl(base, NOW);
    const request = { kind: "request", create: false } as const;
    expect(admit(null, base, request)).toEqual({ ok: true, adopt: true, empty: true });
    expect(admit(stored, { ...base, region: "default" }, request)).toMatchObject({
      error: "forbidden",
    });
    expect(admit(stored, { ...base, region: "default" }, { kind: "maintenance" })).toMatchObject({
      error: "forbidden",
    });
    expect(admit(stored, { ...base, ownerId: "x" }, { kind: "maintenance" })).toMatchObject({
      ok: true,
    });
    expect(admit(stored, { ...base, ownerId: "x" }, request)).toMatchObject({ error: "stale" });
    expect(admit(stored, { ...base, generation: 1 }, request)).toMatchObject({ error: "stale" });
    expect(admit(stored, { ...base, generation: 1 }, { kind: "erase" })).toEqual({
      ok: true,
      done: true,
    });
    expect(admit(stored, { ...base, epoch: 4 }, request)).toMatchObject({ error: "stale" });
    expect(admit(stored, { ...base, epoch: 6 }, request)).toEqual({
      ok: true,
      adopt: true,
      empty: false,
    });
    const held = { ...stored, hold: { transition: "t", epoch: 5 } };
    expect(admit(held, base, request)).toMatchObject({ error: "held" });
    expect(admit(held, base, { kind: "erase" })).toMatchObject({ error: "held" });
    expect(admit(held, base, { kind: "operator" })).toEqual({
      ok: true,
      adopt: false,
      empty: false,
    });
    const quarantined = { ...stored, quarantine: { reason: "owner" as const, at: NOW } };
    expect(admit(quarantined, base, request)).toMatchObject({ error: "quarantined" });
    expect(admit(quarantined, base, { kind: "operator" })).toMatchObject({ ok: true });
    expect(admit({ ...stored, erasing: { generation: 2, epoch: 5 } }, base, request)).toMatchObject(
      { error: "stale" },
    );
    expect(
      applyFence(
        stored,
        { ...base, epoch: 6 },
        { state: "open", toOwner: "p", transition: "t1" },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      control: { ownerId: "p", ownerEpoch: 6, last: { kind: "transfer", fromOwner: "o" } },
    });
    expect(
      applyFence(
        stored,
        { ...base, artifactId: "b", epoch: 6 },
        { state: "open", transition: "t2" },
        NOW,
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      applyFence(
        stored,
        { ...base, ownerId: "x", epoch: 6 },
        { state: "open", transition: "t3" },
        NOW,
      ),
    ).toMatchObject({ ok: false, error: "stale" });
    expect(
      applyFence(
        stored,
        { ...base, generation: 3, epoch: 6 },
        { state: "open", transition: "t4" },
        NOW,
      ),
    ).toMatchObject({ ok: false, error: "stale" });
    // On an empty object a fence creates the control record at its own epoch.
    expect(applyFence(null, base, { state: "held", transition: "t5" }, NOW)).toMatchObject({
      ok: true,
      control: { epoch: 5, hold: { transition: "t5" } },
    });
  });
});

describe("restore reconciliation", () => {
  it("raises D1 for the same owner, resumes an erase, and quarantines what the numbers cannot explain", () => {
    const object: Control = newControl(
      { artifactId: "a", region: "eu", ownerId: "new", generation: 1, epoch: 5 },
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
    expect(
      reconcile(
        { ownerId: "new", generation: 0, epoch: 2, held: false },
        { ...object, erasing: { generation: 1, epoch: 5 } },
      ),
    ).toEqual({ action: "resume_erase", generation: 1, epoch: 5 });
    expect(
      reconcile(
        { ownerId: "new", generation: 1, epoch: 5, held: false },
        { ...object, quarantine: { reason: "owner", at: NOW } },
      ),
    ).toEqual({ action: "operator", reason: "quarantined" });
    expect(reconcile({ ownerId: "new", generation: 1, epoch: 5, held: false }, null)).toEqual({
      action: "none",
    });
  });

  it("never lets a restored former owner read the new owner's data; the operator resolves a quarantine", async () => {
    const { envelope, docs } = artifact("owner_old");
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(
      await docs.fence(
        { ...envelope, epoch: 5 },
        { state: "open", toOwner: "owner_new", transition: "t_move" },
      ),
    );
    const current = { ...envelope, ownerId: "owner_new", epoch: 5 };
    ok(await docs.create(op(current), owner, "items", { secret: "new" }));
    // D1 restored to the old owner at epoch 0: even raised to the object's epoch, it is refused.
    expect(
      await docs.query({ ...envelope, epoch: 6 }, owner, { collection: "items" }),
    ).toMatchObject({ ok: false, error: "stale" });
    const object = await docs.controlRecord();
    expect(
      reconcile({ ownerId: "owner_old", generation: 0, epoch: 0, held: false }, object),
    ).toMatchObject({ action: "quarantine" });
    expect(await docs.quarantine(envelope, "owner")).toBe(true);
    expect(await docs.query(current, owner, { collection: "items" })).toMatchObject({
      ok: false,
      error: "quarantined",
    });
    // The operator can still export, and resolves by adopting the owner the object names.
    expect(ok(await docs.exportPage(current, owner, null, 10, true)).rows).toHaveLength(1);
    expect(await docs.resolveQuarantine(envelope, "adopt")).toMatchObject({ ok: false });
    expect(await docs.resolveQuarantine(current, "adopt")).toEqual({ ok: true });
    expect(ok(await docs.query(current, owner, { collection: "items" })).documents).toHaveLength(1);
  });

  it("resolves a quarantine by erasing, into the next generation", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    expect(await docs.quarantine(envelope, "hold")).toBe(true);
    expect(await docs.resolveQuarantine(envelope, "erase")).toEqual({ ok: true });
    expect(await docs.resolveQuarantine(envelope, "erase")).toMatchObject({ ok: false });
    const control = await docs.controlRecord();
    expect(control).toMatchObject({ generation: 1, quarantine: null });
  });
});

describe("replay records, obligations and author erasure", () => {
  it("keeps replay records a day and prunes them, and the rest of the control tables, after", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const once = op(envelope);
    ok(await docs.create(once, context(visitor("v_a")), "items", { n: 1 }));
    expect(await docs.pruneReplays(NOW)).toBe(0);
    // Two operation records, the author's rate row and the day's counters.
    expect(await docs.pruneReplays(NOW + 3 * 86_400_000)).toBe(4);
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

  it("settles an operation: committed obligations are returned, the rest are marked aborted for good", async () => {
    const { envelope, docs } = artifact();
    const declared = op(envelope);
    ok(await docs.declareCollection(declared, owner, { name: "items", mode: "read" }));
    expect(await docs.settle(envelope, "owner:owner", declared.opId as string)).toMatchObject({
      state: "committed",
      kind: "data.collection_set",
      delivered: false,
    });
    expect(await docs.acknowledge(envelope, "owner:owner", declared.opId as string)).toBe(true);
    expect(await docs.settle(envelope, "owner:owner", declared.opId as string)).toMatchObject({
      delivered: true,
    });
    expect(await docs.settle(envelope, "owner:owner", "op_never")).toEqual({ state: "aborted" });
    // The original call arriving after the relay gave up does not commit.
    expect(
      await docs.create({ ...envelope, opId: "op_never" }, owner, "items", { n: 1 }),
    ).toMatchObject({ ok: false, error: "conflict" });
    // Obligations survive a whole erase.
    ok(await docs.prepareErase(envelope));
    ok(await docs.commitErase(envelope));
    expect(
      await docs.auditFor(operationKey("owner:owner", 0, declared.opId as string)),
    ).not.toBeNull();
    expect(await docs.settle({ ...envelope, artifactId: "other" }, "owner:owner", "op_x")).toEqual({
      state: "refused",
    });
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

  it("gives two racing first grants one identity", async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        claimVisitorId(env.JOURNAL, "user_1", "a_race", `v_candidate_${index}`, NOW),
      ),
    );
    expect(new Set(claims).size).toBe(1);
    expect(await claimVisitorId(env.JOURNAL, "user_1", "a_race", "v_later", NOW)).toBe(claims[0]);
  });
});

describe("storage reports", () => {
  it("raise their sequence on every change and on refused work, and come with failures", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const first = await docs.create(op(envelope), owner, "items", { n: 1 });
    const refused = await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 });
    const second = await docs.create(op(envelope), owner, "items", { n: 2 });
    expect(refused.ok).toBe(false);
    expect(refused.storage.seq).toBeGreaterThan(first.storage.seq);
    expect(second.storage.seq).toBeGreaterThan(refused.storage.seq);
  });
});

describe("document export", () => {
  it("exports bodies exactly as stored, with their server fields, in a stable order", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "b", mode: "append" }));
    ok(await docs.declareCollection(op(envelope), owner, { name: "a", mode: "append" }));
    const body = { big: 9007199254740991, text: "é€😀", nested: { list: [1, "x", null, true] } };
    const created = ok(await docs.create(op(envelope), context(visitor("v_a")), "b", body));
    ok(await docs.create(op(envelope), context(visitor("v_b")), "a", { n: 0.1 }));
    const page = ok(await docs.exportPage(envelope, owner, null, 10));
    expect(page.rows.map((row) => row.collection)).toEqual(["a", "b"]);
    const row = page.rows[1];
    expect(row).toMatchObject({ id: created._id, by: "v_a", editedBy: null, created: NOW });
    expect(JSON.parse(row?.body ?? "null")).toEqual(body);
    expect(JSON.parse(page.rows[0]?.body ?? "null")).toEqual({ n: 0.1 });
    const again = ok(await docs.exportPage(envelope, owner, null, 10));
    expect(again).toEqual(page);
    ok(await docs.create(op(envelope), context(visitor("v_a")), "a", { n: 2 }));
    expect(ok(await docs.exportPage(envelope, owner, null, 10)).revision).toBeGreaterThan(
      page.revision,
    );
  });
});
