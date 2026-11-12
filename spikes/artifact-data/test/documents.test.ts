import { describe, expect, it } from "vitest";
import type { StoredDocument } from "../src/artifact-data.ts";
import type { Filter } from "../src/model.ts";
import { artifact, FREE, NOW, OWNER, ok, READER, visitor } from "./harness.ts";

const ALICE = visitor("v_alice");
const BOB = visitor("v_bob");

async function withCollection(mode: string, uniqueKey?: string) {
  const target = artifact();
  ok(
    await target.stub.declareCollection(
      target.ref,
      { name: "items", mode, ...(uniqueKey ? { uniqueKey } : {}) },
      FREE,
    ),
  );
  return target;
}

describe("own mode: a visitor reaches only their own documents", () => {
  it("never lets Bob read, list, change or delete Alice's document, by any ID or filter", async () => {
    const { ref, stub } = await withCollection("own");
    const mine = ok(await stub.create(ref, ALICE, "items", { secret: "alice" }, FREE, NOW));
    ok(await stub.create(ref, BOB, "items", { secret: "bob" }, FREE, NOW));

    expect(await stub.get(ref, BOB, "items", mine._id)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    const filters = [
      [],
      [{ field: "_by", op: "eq", value: "v_alice" }],
      [{ field: "_id", op: "eq", value: mine._id }],
      [{ field: "secret", op: "eq", value: "alice" }],
      [{ field: "_by", op: "in", value: ["v_alice", "v_bob"] }],
      [{ field: "_created", op: "gte", value: 0 }],
    ] satisfies Filter[][];
    for (const filter of filters) {
      const page = ok(await stub.query(ref, BOB, { collection: "items", filters: filter }));
      expect(page.documents.every((document) => document._by === "v_bob")).toBe(true);
      expect(page.documents.some((document) => document.secret === "alice")).toBe(false);
    }
    // A cursor that points past Alice's row does not reach it either.
    const cursor = btoa(JSON.stringify([NOW - 1, ""])).replaceAll("=", "");
    const after = ok(await stub.query(ref, BOB, { collection: "items", after: cursor }));
    expect(after.documents.map((document) => document.secret)).toEqual(["bob"]);

    expect(
      await stub.update(ref, BOB, "items", mine._id, { secret: "bob was here" }, FREE, NOW),
    ).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await stub.remove(ref, BOB, "items", mine._id, FREE, NOW)).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(ok(await stub.get(ref, ALICE, "items", mine._id)).secret).toBe("alice");
  });

  it("lets the owner side read everyone's documents and a reader none", async () => {
    const { ref, stub } = await withCollection("own");
    ok(await stub.create(ref, ALICE, "items", { n: 1 }, FREE, NOW));
    ok(await stub.create(ref, BOB, "items", { n: 2 }, FREE, NOW + 1));
    expect(ok(await stub.query(ref, OWNER, { collection: "items" })).documents).toHaveLength(2);
    expect(ok(await stub.query(ref, READER, { collection: "items" })).documents).toEqual([]);
  });

  it("sets the server fields and refuses input that tries to set them", async () => {
    const { ref, stub } = await withCollection("own");
    const created = ok(await stub.create(ref, ALICE, "items", { n: 1 }, FREE, NOW));
    expect(created).toMatchObject({ _by: "v_alice", _created: NOW, _updated: NOW, n: 1 });
    expect(created._id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await stub.create(ref, ALICE, "items", { _by: "v_bob" }, FREE, NOW)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });
});

describe("append, read and shared modes", () => {
  it("append: everyone reads, each changes only their own, one vote per person by unique key", async () => {
    const { ref, stub } = await withCollection("append", "poll");
    const vote = ok(await stub.create(ref, ALICE, "items", { poll: "p1", choice: "a" }, FREE, NOW));
    expect(
      await stub.create(ref, ALICE, "items", { poll: "p1", choice: "b" }, FREE, NOW),
    ).toMatchObject({
      ok: false,
      error: "conflict",
    });
    ok(await stub.create(ref, BOB, "items", { poll: "p1", choice: "b" }, FREE, NOW));
    expect(ok(await stub.query(ref, BOB, { collection: "items" })).documents).toHaveLength(2);
    expect(ok(await stub.query(ref, READER, { collection: "items" })).documents).toHaveLength(2);
    expect(
      await stub.update(ref, BOB, "items", vote._id, { poll: "p1", choice: "z" }, FREE, NOW),
    ).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await stub.create(ref, ALICE, "items", { choice: "a" }, FREE, NOW)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("read: only the owner side writes", async () => {
    const { ref, stub } = await withCollection("read");
    expect(await stub.create(ref, ALICE, "items", { n: 1 }, FREE, NOW)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    const posted = ok(await stub.create(ref, OWNER, "items", { n: 1 }, FREE, NOW));
    expect(posted._by).toBe("owner");
    expect(ok(await stub.get(ref, READER, "items", posted._id)).n).toBe(1);
  });

  it("shared: every writer edits everything; the author stays the creator", async () => {
    const { ref, stub } = await withCollection("shared");
    const card = ok(await stub.create(ref, ALICE, "items", { title: "a" }, FREE, NOW));
    const edited = ok(
      await stub.update(ref, BOB, "items", card._id, { title: "b" }, FREE, NOW + 5),
    );
    expect(edited).toMatchObject({ _by: "v_alice", title: "b", _updated: NOW + 5 });
    ok(await stub.remove(ref, BOB, "items", card._id, FREE, NOW + 6));
  });

  it("a visitor who may not write (a share link, writing closed) only reads", async () => {
    const { ref, stub } = await withCollection("append");
    expect(
      await stub.create(ref, visitor("v_carol", false), "items", { n: 1 }, FREE, NOW),
    ).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await stub.create(ref, READER, "items", { n: 1 }, FREE, NOW)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
  });
});

describe("queries", () => {
  it("pages with a capped size and a cursor, in either order", async () => {
    const { ref, stub } = await withCollection("append");
    for (let index = 0; index < 5; index++) {
      ok(await stub.create(ref, ALICE, "items", { index }, FREE, NOW + index));
    }
    const first = ok(await stub.query(ref, BOB, { collection: "items", limit: 2 }));
    expect(first.documents.map((document) => document.index)).toEqual([0, 1]);
    const second = ok(
      await stub.query(ref, BOB, { collection: "items", limit: 2, after: first.next as string }),
    );
    expect(second.documents.map((document) => document.index)).toEqual([2, 3]);
    const newest = ok(
      await stub.query(ref, BOB, { collection: "items", order: "-created", limit: 500 }),
    );
    expect(newest.documents.map((document) => document.index)).toEqual([4, 3, 2, 1, 0]);
    expect(newest.next).toBeNull();
    const filtered = ok(
      await stub.query(ref, BOB, {
        collection: "items",
        filters: [{ field: "index", op: "in", value: [1, 3] }],
      }),
    );
    expect(filtered.documents.map((document: StoredDocument) => document.index)).toEqual([1, 3]);
  });

  it("answers an unknown collection as missing", async () => {
    const { ref, stub } = await withCollection("append");
    expect(await stub.query(ref, ALICE, { collection: "nope" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await stub.create(ref, ALICE, "nope", {}, FREE, NOW)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});
