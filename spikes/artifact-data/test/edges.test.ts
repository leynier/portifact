import { describe, expect, it } from "vitest";
import { handoffGate } from "../src/gate.ts";
import { artifact, context, NOW, OWNER, ok, op, READER, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);
const copyJob = (copyId: string) => ({
  copyId,
  page: 0,
  table: "copy_items",
  collection: "items",
  sourceGeneration: 0,
  sourceRevision: 0,
});
const alice = context(visitor("v_alice"));

describe("refusals on an object without data", () => {
  it("answers every document command like a missing collection or document", async () => {
    const { envelope, docs } = artifact();
    expect(await docs.create(op(envelope), alice, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await docs.replace(op(envelope), alice, "items", "x", { n: 1 })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await docs.remove(op(envelope), alice, "items", "x")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await docs.get(envelope, alice, "items", "x")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_alice", 10))).toEqual({
      erased: 0,
      more: false,
    });
    // A fence on an empty object is persisted: a stale command after it is refused.
    expect(ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "held" }))).toEqual({
      epoch: 1,
      state: "held",
      ownerId: envelope.ownerId,
    });
    expect(
      await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }),
    ).toMatchObject({
      ok: false,
      error: "stale",
    });
    const held = { ...envelope, epoch: 1 };
    expect(await docs.prepareErase(held)).toMatchObject({ ok: false, error: "held" });
    expect(await docs.cancelErase(held)).toBe(false);
    expect(await docs.auditFor("op")).toBeNull();
    await docs.ackAudit("op");
    expect(await docs.exportPage(held, owner, null, 10)).toMatchObject({
      ok: false,
      error: "held",
    });
    const empty = artifact();
    expect(await empty.docs.budget(NOW)).toEqual({});
    expect(ok(await empty.docs.prepareErase(empty.envelope))).toEqual({ prepared: false });
    expect(ok(await empty.docs.exportPage(empty.envelope, owner, null, 10))).toEqual({
      rows: [],
      next: null,
      revision: 0,
    });
    expect((await docs.fetch("https://data.internal/other")).status).toBe(404);
  });
});

describe("owner-side and mode refusals", () => {
  it("keeps declarations and exports to the owner side, and caps indexed fields", async () => {
    const { envelope, docs } = artifact();
    expect(
      await docs.declareCollection(op(envelope), alice, { name: "items", mode: "own" }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "append",
        indexed: ["a"],
      }),
    );
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "shared",
        indexed: ["a"],
      }),
    );
    const tight = context(OWNER, { limits: { ...ROOMY, indexedFields: 1, collections: 1 } });
    expect(
      await docs.declareCollection(op(envelope), tight, {
        name: "items",
        mode: "append",
        indexed: ["b"],
      }),
    ).toMatchObject({ ok: false, error: "quota_exceeded" });
    expect(
      await docs.declareCollection(op(envelope), tight, { name: "more", mode: "append" }),
    ).toMatchObject({ ok: false, error: "quota_exceeded" });
    expect(
      await docs.declareCollection(op(envelope), owner, {
        name: "x",
        mode: "own",
        uniqueKey: "bad key",
      }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await docs.exportPage(envelope, alice, null, 10)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await docs.get(envelope, alice, "nope", "x")).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("refuses page writes to read collections and readers, and pages the export", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.declareCollection(op(envelope), owner, { name: "mine", mode: "own" }));
    const posted = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    ok(await docs.create(op(envelope), owner, "items", { n: 2 }));
    expect(await docs.replace(op(envelope), alice, "items", posted._id, { n: 3 })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    // A visitor deletes only what they created: someone else's document is not found.
    expect(await docs.remove(op(envelope), alice, "items", posted._id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await docs.get(envelope, context(READER), "mine", "x")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    const first = ok(await docs.exportPage(envelope, owner, null, 1));
    expect(first.rows).toHaveLength(1);
    const second = ok(await docs.exportPage(envelope, owner, first.next, 1));
    expect(second.rows[0]?.document._id).not.toBe(first.rows[0]?.document._id);
  });

  it("limits deletes per author and reads per caller", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const limits = { ...ROOMY, deletesPerAuthorPerMinute: 1, readsPerCallerPerMinute: 1 };
    const a = context(visitor("v_a"), { limits });
    expect(await docs.remove(op(envelope), a, "items", "x")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await docs.remove(op(envelope), a, "items", "y")).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
    ok(await docs.query(envelope, context(READER, { limits }), { collection: "items" }));
    expect(
      await docs.query(envelope, context(READER, { limits }), { collection: "items" }),
    ).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("refuses when the owner's day is spent", async () => {
    const { envelope, docs } = artifact();
    const options = { owner: `owner_spent_${NOW}`, ownerWritten: 20 };
    ok(
      await docs.declareCollection(op(envelope), context(OWNER, options), {
        name: "items",
        mode: "append",
      }),
    );
    expect(
      await docs.create(op(envelope), context(visitor("v_a"), options), "items", { n: 1 }),
    ).toMatchObject({ ok: false, error: "quota_exceeded" });
  });
});

describe("the sandbox's edges", () => {
  it("limits statements per minute and refuses bad copies", async () => {
    const { envelope, sandbox } = artifact();
    const now = NOW + 7 * 60_000;
    const results = [];
    for (let index = 0; index < 32; index++)
      results.push(await sandbox.query(envelope, context(OWNER, { now }), "select 1"));
    expect(
      results.filter((outcome) => !outcome.ok && outcome.error === "rate_limited"),
    ).toHaveLength(2);
    expect(
      await sandbox.importCopy(
        op(envelope),
        owner,
        copyJob("c_edge_1"),
        [
          { id: "a", by: "v", editedBy: null, created: 1, updated: 1, body: "x".repeat(50_000) },
        ].map((row) => row),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await sandbox.importCopy(
        op(envelope),
        context(OWNER, { limits: { ...ROOMY, sandboxBytes: 1 } }),
        { ...copyJob("c_edge_2"), table: "copy_more" },
        [{ id: "b", by: "v", editedBy: null, created: 1, updated: 1, body: "y".repeat(50_000) }],
      ),
    ).toMatchObject({ ok: false, error: "quota_exceeded" });
    ok(
      await sandbox.importCopy(op(envelope), owner, copyJob("c_edge_3"), [
        { id: "c", by: "v", editedBy: null, created: 1, updated: 1, body: "{}" },
      ]),
    );
    // Two jobs into one table: each record counts the table's rows now.
    const copies = await sandbox.copies();
    expect(copies.map((copy) => copy.documents)).toEqual([2, 2]);
    expect(await sandbox.readOnlyProbe("select 1")).toEqual({ refused: false, message: "" });
    expect(await sandbox.readOnlyProbe("select * from missing")).toMatchObject({ refused: true });
    expect(
      await sandbox.fence({ ...envelope, artifactId: "other", epoch: 1 }, { state: "open" }),
    ).toBe(false);
    expect(await artifact().sandbox.fence({ ...envelope, epoch: 1 }, { state: "open" })).toBe(true);
    expect(await sandbox.query({ ...envelope, epoch: 3 }, owner, "select 1")).toMatchObject({
      ok: true,
    });
  });
});

describe("the handoff gate", () => {
  it("refuses anything but the navigation it expects", () => {
    const request = (method: string, headers: Record<string, string>) =>
      new Request("https://abc.portifact.dev/__portifact/data/grant?code=x", { method, headers });
    const good = {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    };
    expect(handoffGate(request("POST", good), "popup")).toBe("refused");
    expect(handoffGate(request("GET", { ...good, "Sec-Fetch-Mode": "cors" }), "popup")).toBe(
      "refused",
    );
    expect(handoffGate(request("GET", good), "frame")).toBe("refused");
    expect(handoffGate(request("GET", { ...good, "Sec-Fetch-Dest": "iframe" }), "popup")).toBe(
      "refused",
    );
  });
});
