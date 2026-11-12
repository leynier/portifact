import { describe, expect, it } from "vitest";
import { handoffGate } from "../src/gate.ts";
import { artifact, context, NOW, OWNER, ok, op, READER, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);
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
    expect(
      ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_hold" })),
    ).toEqual({
      epoch: 1,
      held: true,
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
    expect(await docs.acknowledge(held, "owner:owner", "op")).toBe(false);
    expect(await docs.exportPage(held, owner, null, 10)).toMatchObject({
      ok: false,
      error: "held",
    });
    const empty = artifact();
    expect(await empty.docs.budget(NOW)).toEqual({});
    expect(ok(await empty.docs.exportPage(empty.envelope, owner, null, 10))).toEqual({
      rows: [],
      next: null,
      revision: 0,
      bytes: 0,
    });
    // Preparing an erase on an empty object writes its control record: the erase is a barrier.
    expect(ok(await empty.docs.prepareErase(empty.envelope))).toEqual({ prepared: true });
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
    expect(second.rows[0]?.id).not.toBe(first.rows[0]?.id);
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
    const options = { owner: `owner_spent_${NOW}`, ownerWritten: 70 };
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
