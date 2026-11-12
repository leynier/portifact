import { describe, expect, it } from "vitest";
import { artifact, FREE, NOW, OWNER, ok, visitor } from "./harness.ts";

async function seeded() {
  const target = artifact();
  ok(await target.stub.declareCollection(target.ref, { name: "items", mode: "own" }, FREE));
  ok(await target.stub.create(target.ref, visitor("v_a"), "items", { n: 1 }, FREE, NOW));
  return target;
}

describe("owner SQL", () => {
  it("creates, writes and reads the owner's own tables, and reads the reserved ones", async () => {
    const { ref, stub } = await seeded();
    ok(await stub.sql(ref, "create table scores (name text, points integer)", [], true, FREE));
    ok(
      await stub.sql(ref, "insert into scores values (?, ?), (?, ?)", ["a", 3, "b", 5], true, FREE),
    );
    const read = ok(
      await stub.sql(ref, "select name, points from scores order by points desc", [], false, FREE),
    );
    expect(read).toEqual({
      columns: ["name", "points"],
      rows: [
        ["b", 5],
        ["a", 3],
      ],
      truncated: false,
    });
    const documents = ok(
      await stub.sql(
        ref,
        "select author, json_extract(body, '$.n') from pf_documents",
        [],
        false,
        FREE,
      ),
    );
    expect(documents.rows).toEqual([["v_a", 1]]);
    // A view and an index on the owner's own table are fine.
    ok(await stub.sql(ref, "create index scores_points on scores (points)", [], true, FREE));
    ok(
      await stub.sql(
        ref,
        "create view top as select * from scores where points > 4",
        [],
        true,
        FREE,
      ),
    );
  });

  it("refuses every write to the reserved tables, data or schema, and leaves them as they were", async () => {
    const { ref, stub } = await seeded();
    const attempts = [
      "update pf_documents set author = 'v_b'",
      "delete from pf_documents",
      "insert into pf_collections (name, mode) values ('x', 'shared')",
      "update pf_rate set count = 0",
      "drop index pf_documents_author",
      "drop table pf_documents",
      "alter table pf_documents add column extra text",
      "create index sneaky on pf_documents (body)",
      "update pf_meta set value = 'other' where key = 'artifact'",
    ];
    for (const statement of attempts) {
      const outcome = await stub.sql(ref, statement, [], true, FREE);
      expect({ statement, outcome }).toMatchObject({ outcome: { ok: false, error: "forbidden" } });
    }
    ok(await stub.sql(ref, "create table mine (x)", [], true, FREE));
    expect(
      await stub.sql(
        ref,
        "create trigger t after insert on mine begin delete from pf_documents; end",
        [],
        true,
        FREE,
      ),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    const still = ok(await stub.query(ref, OWNER, { collection: "items" }));
    expect(still.documents.map((document) => document._by)).toEqual(["v_a"]);
  });

  it("refuses a write through the read-only call", async () => {
    const { ref, stub } = await seeded();
    expect(await stub.sql(ref, "create table t (x)", [], false, FREE)).toMatchObject({
      ok: false,
      error: "forbidden",
      message: "this call only reads",
    });
  });

  it("refuses what the lexer catches: several statements, recursion, transactions", async () => {
    const { ref, stub } = await seeded();
    const refused = [
      "select 1; delete from pf_documents",
      "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c",
      "begin",
      "attach database 'x' as other",
      "pragma writable_schema = 1",
      "vacuum",
    ];
    for (const statement of refused) {
      expect(await stub.sql(ref, statement, [], true, FREE)).toMatchObject({
        ok: false,
        error: "invalid_input",
      });
    }
    // A string or comment that looks like a second statement is one statement.
    ok(await stub.sql(ref, "select 'a; drop table x' -- ; begin\n", [], false, FREE));
  });

  it("shows what workerd itself refuses when nothing in front stops it", async () => {
    const { stub, ref } = await seeded();
    // The object's own storage API, without the guard: these are the platform's refusals.
    const platform = await stub.platformRefusals(ref);
    expect(platform).toEqual({
      begin: "refused",
      savepoint: "refused",
      attach: "refused",
      pragmaWritableSchema: "refused",
      cfTable: "refused",
      loadExtension: "refused",
      vacuum: "refused",
      explain: "allowed",
      sqliteSchemaRead: "allowed",
      pragmaTableInfo: "allowed",
    });
  });

  it("returns at most 1,000 rows and says it truncated", async () => {
    const { ref, stub } = await seeded();
    ok(await stub.sql(ref, "create table n (x integer)", [], true, FREE));
    ok(
      await stub.sql(
        ref,
        "insert into n select value from json_each(?)",
        [JSON.stringify(Array.from({ length: 1500 }, (_, index) => index))],
        true,
        FREE,
      ),
    );
    const result = ok(await stub.sql(ref, "select x from n", [], false, FREE));
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it("rolls back an owner write that takes the database past the artifact's size", async () => {
    const { ref, stub } = await seeded();
    const limits = { ...FREE, bytesPerArtifact: 200_000 };
    ok(await stub.sql(ref, "create table blobs (b blob)", [], true, limits));
    expect(
      await stub.sql(ref, "insert into blobs values (zeroblob(500000))", [], true, limits),
    ).toMatchObject({ ok: false, error: "quota_exceeded" });
    const count = ok(await stub.sql(ref, "select count(*) from blobs", [], false, limits));
    expect(count.rows).toEqual([[0]]);
  });
});
