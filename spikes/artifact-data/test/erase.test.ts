import { describe, expect, it } from "vitest";
import { artifact, FREE, NOW, OWNER, ok, visitor } from "./harness.ts";

describe("erasing", () => {
  it("erases the whole object, is idempotent, and leaves an empty database behind", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    ok(await stub.create(ref, visitor("v_a"), "items", { n: 1 }, FREE, NOW));
    ok(await stub.sql(ref, "create table mine (x)", [], true, FREE));
    expect(await stub.size()).toBeGreaterThan(0);
    await stub.erase();
    await stub.erase();
    expect(ok(await stub.query(ref, OWNER, { collection: "items" }))).toEqual({
      documents: [],
      next: null,
    });
    const tables = ok(await stub.sql(ref, "select count(*) from sqlite_schema", [], false, FREE));
    expect(tables.rows).toEqual([[0]]);
    // The same name can be used again (a restore that brought the artifact back would find it empty).
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
  });

  it("erases one author's documents and keeps everyone else's and the counters right", async () => {
    const { ref, stub } = artifact();
    const limits = { ...FREE, documentsPerCollection: 3 };
    ok(await stub.declareCollection(ref, { name: "items", mode: "append" }, limits));
    ok(await stub.create(ref, visitor("v_a"), "items", { n: 1 }, limits, NOW));
    ok(await stub.create(ref, visitor("v_a"), "items", { n: 2 }, limits, NOW));
    ok(await stub.create(ref, visitor("v_b"), "items", { n: 3 }, limits, NOW));
    expect(ok(await stub.eraseAuthor("v_a"))).toBe(2);
    expect(ok(await stub.eraseAuthor("v_a"))).toBe(0);
    const left = ok(await stub.query(ref, OWNER, { collection: "items" }));
    expect(left.documents.map((document) => document._by)).toEqual(["v_b"]);
    // The count went down, so two more fit under the cap of three.
    ok(await stub.create(ref, visitor("v_c"), "items", { n: 4 }, limits, NOW));
    ok(await stub.create(ref, visitor("v_c"), "items", { n: 5 }, limits, NOW));
    expect(await stub.create(ref, visitor("v_c"), "items", { n: 6 }, limits, NOW)).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });

  it("erasing an author on an object without data does nothing", async () => {
    const { stub } = artifact();
    expect(ok(await stub.eraseAuthor("v_a"))).toBe(0);
  });
});
