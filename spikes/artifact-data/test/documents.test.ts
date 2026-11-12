import { describe, expect, it } from "vitest";
import { artifact, context, OWNER, ok, op, READER, visitor } from "./harness.ts";

const owner = context(OWNER);
const alice = context(visitor("v_alice"));
const bob = context(visitor("v_bob"));

async function withCollection(mode: string, uniqueKey?: string) {
  const target = artifact();
  ok(
    await target.docs.declareCollection(op(target.envelope), owner, {
      name: "items",
      mode,
      ...(uniqueKey ? { uniqueKey } : {}),
    }),
  );
  return target;
}

describe("own mode: a visitor reaches only their own documents", () => {
  it("never lets Bob read, list, change or delete Alice's document, by any ID, filter or cursor", async () => {
    const { envelope, docs } = await withCollection("own");
    const mine = ok(await docs.create(op(envelope), alice, "items", { secret: "alice" }));
    ok(await docs.create(op(envelope), bob, "items", { secret: "bob" }));
    expect(await docs.get(envelope, bob, "items", mine._id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    for (const spec of [
      { collection: "items" },
      { collection: "items", order: "-created" as const },
      { collection: "items", created: { op: "gte" as const, value: 0 } },
      { collection: "items", after: btoa(JSON.stringify([0, ""])).replaceAll("=", "") },
    ]) {
      const page = ok(await docs.query(envelope, bob, spec));
      expect(page.documents.map((document) => document.secret)).toEqual(["bob"]);
    }
    // Naming an author is not a query in own mode.
    expect(
      await docs.query(envelope, bob, {
        collection: "items",
        equals: { field: "_by", value: "v_alice" },
      }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await docs.replace(op(envelope), bob, "items", mine._id, { secret: "x" })).toMatchObject(
      {
        ok: false,
        error: "not_found",
      },
    );
    expect(await docs.remove(op(envelope), bob, "items", mine._id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(ok(await docs.get(envelope, alice, "items", mine._id)).secret).toBe("alice");
  });

  it("lets the owner side read everyone's documents and a reader none", async () => {
    const { envelope, docs } = await withCollection("own");
    ok(await docs.create(op(envelope), alice, "items", { n: 1 }));
    ok(await docs.create(op(envelope), bob, "items", { n: 2 }));
    expect(ok(await docs.query(envelope, owner, { collection: "items" })).documents).toHaveLength(
      2,
    );
    expect(
      ok(await docs.query(envelope, context(READER), { collection: "items" })).documents,
    ).toEqual([]);
  });

  it("sets the server fields and refuses input that tries to set them", async () => {
    const { envelope, docs } = await withCollection("own");
    const created = ok(await docs.create(op(envelope), alice, "items", { n: 1 }));
    expect(created).toMatchObject({ _by: "v_alice", _editedBy: null, n: 1 });
    expect(await docs.create(op(envelope), alice, "items", { _by: "v_bob" })).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });
});

describe("append, read and shared modes", () => {
  it("append: everyone reads, each changes only their own; the unique key holds on replace", async () => {
    const { envelope, docs } = await withCollection("append", "poll");
    const vote = ok(await docs.create(op(envelope), alice, "items", { poll: "p1" }));
    ok(await docs.create(op(envelope), bob, "items", { poll: "p1" }));
    expect(
      ok(await docs.query(envelope, context(READER), { collection: "items" })).documents,
    ).toHaveLength(2);
    expect(await docs.replace(op(envelope), bob, "items", vote._id, { poll: "p9" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(
      await docs.create(op(envelope), alice, "items", { poll: { nested: true } }),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("read: only the owner side writes", async () => {
    const { envelope, docs } = await withCollection("read");
    expect(await docs.create(op(envelope), alice, "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(ok(await docs.create(op(envelope), owner, "items", { n: 1 }))._by).toBe("owner");
  });

  it("shared: every writer edits everything, and the record says who edited last", async () => {
    const { envelope, docs } = await withCollection("shared");
    const card = ok(await docs.create(op(envelope), alice, "items", { title: "a" }));
    const edited = ok(await docs.replace(op(envelope), bob, "items", card._id, { title: "b" }));
    expect(edited).toMatchObject({ _by: "v_alice", _editedBy: "v_bob", title: "b" });
    ok(await docs.remove(op(envelope), bob, "items", card._id));
  });

  it("a visitor without a write grant and a reader only read", async () => {
    const { envelope, docs } = await withCollection("append");
    expect(
      await docs.create(op(envelope), context(visitor("v_c", false)), "items", { n: 1 }),
    ).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await docs.create(op(envelope), context(READER), "items", { n: 1 })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });

  it("replays a retried mutation with the same operation ID instead of applying it twice", async () => {
    const { envelope, docs } = await withCollection("append");
    const once = op(envelope);
    const first = ok(await docs.create(once, alice, "items", { n: 1 }));
    const again = ok(await docs.create(once, alice, "items", { n: 1 }));
    expect(again._id).toBe(first._id);
    expect(ok(await docs.query(envelope, owner, { collection: "items" })).documents).toHaveLength(
      1,
    );
  });
});
