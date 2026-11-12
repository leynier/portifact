import { describe, expect, it } from "vitest";
import { checkProgram, classify } from "../src/sql-guard.ts";
import { artifact, context, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);

/** Statements the allowlist must keep working (the corpus its opcodes were measured on). */
const SUPPORTED = [
  "select * from t",
  "select a, count(*) from t group by a having count(*) > 1 order by a desc limit 5 offset 2",
  "select distinct b from t",
  "select * from t where a in (1, 2, 3)",
  "select * from t join u on u.t_id = t.a",
  "select * from t left join u on u.t_id = t.a",
  "select * from t where a in (select t_id from u)",
  "select (select max(a) from t)",
  "select b, sum(c) over (partition by b order by a) from t",
  "select json_extract(json_object('x', b), '$.x') from t",
  "select * from t union select a, b, c from t",
  "select * from t where exists (select 1 from u where u.t_id = t.a)",
];

async function withTables() {
  const target = artifact();
  const run = (statement: string, params: (string | number | null)[] = []) =>
    target.sandbox.execute(op(target.envelope), owner, statement, params);
  ok(await run("create table t (a integer primary key, b text, c real)"));
  ok(
    await run(
      "create table u (id integer primary key, t_id integer references t(a) on delete cascade, v text)",
    ),
  );
  ok(await run("insert into t (b, c) values ('x', 1), ('y', 2)"));
  ok(await run("insert into u (t_id, v) values (1, 'z')"));
  return { ...target, run };
}

describe("owner SQL in the sandbox", () => {
  it("runs every supported read and write shape", async () => {
    const { envelope, sandbox, run } = await withTables();
    for (const statement of SUPPORTED) {
      const outcome = await sandbox.query(envelope, owner, statement);
      expect({ statement, outcome }).toMatchObject({
        outcome: { ok: true },
      });
    }
    for (const statement of [
      "update t set b = 'w' where a = 2",
      "delete from t where a = 1",
      "create index t_b on t (b)",
      "create unique index t_c on t (c)",
      "create view tv as select a, b from t",
      "alter table t add column d text",
      "drop view tv",
      "drop index t_b",
      "insert into t (b) values ('a') on conflict do nothing",
    ]) {
      const outcome = await run(statement);
      expect({ statement, outcome }).toMatchObject({ outcome: { ok: true } });
    }
    // The foreign key cascaded within the owner's own tables, which is theirs to design.
    expect(ok(await sandbox.query(envelope, owner, "select count(*) from u")).rows).toEqual([[0]]);
  });

  it("refuses everything off the allowlist, before SQLite runs it", async () => {
    const { envelope, sandbox, run } = await withTables();
    const refusedWrites = [
      "create virtual table s using fts5(x)",
      "create trigger g after insert on t begin delete from u; end",
      "create temp table x (a)",
      "with c(x) as (select 1) select x from c",
      "attach database ':memory:' as other",
      "pragma writable_schema = 1",
      "vacuum",
      "begin",
      "replace into t (b) values ('r')",
      "select 1; delete from t",
      "analyze",
      "reindex",
    ];
    for (const statement of refusedWrites) {
      expect({ statement, outcome: await run(statement) }).toMatchObject({
        outcome: { ok: false },
      });
    }
    expect(await sandbox.query(envelope, owner, "delete from t")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await sandbox.execute(op(envelope), owner, "select 1")).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(await sandbox.query(envelope, context(visitor("v_a")), "select 1")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    // The key-value store that holds the sandbox's state is out of SQL's reach.
    expect(await sandbox.query(envelope, owner, "select * from __cf_kv")).toMatchObject({
      ok: false,
    });
    expect(await run("create table r (k text references __cf_kv (key))")).toMatchObject({
      ok: true,
    });
    expect(await run("insert into r values ('fence')")).toMatchObject({ ok: false });
  });

  it("decides fail closed over SQLite's program", () => {
    expect(checkProgram([{ opcode: "Init" }, { opcode: "OpenRead" }], "read")).toEqual({
      ok: true,
      shape: "read",
    });
    expect(checkProgram([{ opcode: "OpenWrite" }], "read")).toEqual({
      ok: false,
      reason: "this call only reads",
    });
    expect(checkProgram([{ opcode: "VUpdate" }], "write")).toMatchObject({ ok: false });
    expect(checkProgram([{ opcode: "SomethingNew" }], "write")).toEqual({
      ok: false,
      reason: "SomethingNew is not supported",
    });
    expect(classify("select 'with; drop' -- begin\n", [])).toEqual({ ok: true, shape: "read" });
    expect(classify("select ?", Array(101).fill(1))).toMatchObject({ ok: false });
    expect(classify("select ?", ["x".repeat(200_000)])).toMatchObject({
      ok: false,
      reason: "parameters too large",
    });
    expect(classify(`select '${"x".repeat(17_000)}'`, [])).toMatchObject({ ok: false });
    expect(classify("   ", [])).toMatchObject({ ok: false, reason: "empty statement" });
    expect(classify("select 'open", [])).toMatchObject({ ok: false });
    expect(classify("select /* open", [])).toMatchObject({ ok: false });
    expect(classify("explain select 1", [])).toMatchObject({ ok: false });
    expect(classify('select [a]]b], "q""q", `t` from x', [])).toMatchObject({ ok: true });
  });

  it("rolls back a read whatever it is, so the read call can never write", async () => {
    const { sandbox, envelope } = await withTables();
    expect(await sandbox.readOnlyProbe("delete from t")).toEqual({
      refused: true,
      message: "this call only reads",
    });
    expect(await sandbox.readOnlyProbe("create table sneaky (x)")).toMatchObject({ refused: true });
    expect(ok(await sandbox.query(envelope, owner, "select count(*) from t")).rows).toEqual([[2]]);
    expect(
      ok(
        await sandbox.query(
          envelope,
          owner,
          "select count(*) from sqlite_schema where name = 'sneaky'",
        ),
      ).rows,
    ).toEqual([[0]]);
  });

  it("types every value on the wire and caps bytes, not just rows", async () => {
    const { envelope, sandbox } = await withTables();
    const result = ok(
      await sandbox.query(
        envelope,
        owner,
        "select 1, 2.5, 'é', null, x'0102', zeroblob(100000), 9007199254740993",
      ),
    );
    expect(result.rows[0]?.slice(0, 6)).toEqual([
      1,
      2.5,
      "é",
      null,
      { $blob: "AQI=" },
      { $omitted: 100_000 },
    ]);
    expect(result.truncated).toBe(true);
    const many = ok(
      await sandbox.query(envelope, owner, "select randomblob(40000) from t a, t b, t c, t d, t e"),
    );
    expect(many.truncated).toBe(true);
    expect(many.rows.length).toBeLessThan(25);
  });

  it("charges every statement's actual rows to the day's budget, so mass updates run out", async () => {
    const { envelope, sandbox, run } = await withTables();
    ok(await run("create table n (x integer)"));
    // Table-valued functions such as json_each are virtual tables, refused in this release.
    expect(await run("insert into n select value from json_each('[1]')")).toMatchObject({
      ok: false,
    });
    await sandbox.unsafeExec(
      `insert into n (x) values ${Array.from({ length: 10_000 }, (_, i) => `(${i})`).join(", ")}`,
    );
    // Charged before (an estimate) and after (the actual rows): a statement can overshoot the day
    // by its own size once, and the next one is refused.
    const limits = { ...ROOMY, rowsWrittenPerDay: 15_000 };
    const capped = context(OWNER, { limits });
    ok(await sandbox.execute(op(envelope), capped, "update n set x = x + 1"));
    ok(await sandbox.execute(op(envelope), capped, "update n set x = x + 1"));
    expect(await sandbox.execute(op(envelope), capped, "update n set x = x + 1")).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    expect((await sandbox.budget(capped.now)).rowsWritten).toBeGreaterThan(20_000);
  });

  it("refuses growth past the artifact's size and lets deletes through", async () => {
    const { envelope, sandbox, run } = await withTables();
    const full = context(OWNER, { limits: { ...ROOMY, bytesPerArtifact: 1_000 } });
    expect(
      await sandbox.execute(op(envelope), full, "insert into t (b) values (?)", [
        "x".repeat(20_000),
      ]),
    ).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    ok(await sandbox.execute(op(envelope), full, "delete from u"));
    ok(await run("select 1").then(() => ({ ok: true, value: null })));
  });

  it("holds a copy of a collection only when the owner side asks, and keeps it after the author is erased", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    ok(
      await docs.create(op(envelope), context(visitor("v_alice")), "items", {
        text: "alice wrote",
      }),
    );
    const page = ok(await docs.exportPage(envelope, owner, null, 100));
    ok(
      await sandbox.importCopy(
        op(envelope),
        owner,
        "copy_items",
        "items",
        page.rows.map(({ document }) => ({
          id: document._id,
          by: document._by,
          editedBy: document._editedBy,
          created: document._created,
          updated: document._updated,
          body: JSON.stringify(document),
        })),
      ),
    );
    expect(await sandbox.copies()).toMatchObject([
      { table: "copy_items", collection: "items", documents: 1 },
    ]);
    ok(await docs.eraseAuthorChunk(envelope, "v_alice", 100));
    // The documented boundary (decision 0026): account erasure covers the documents, not copies.
    expect(ok(await sandbox.query(envelope, owner, "select _by from copy_items")).rows).toEqual([
      ["v_alice"],
    ]);
    // The owner side can erase an author from its copies itself.
    ok(
      await sandbox.execute(op(envelope), owner, "delete from copy_items where _by = ?", [
        "v_alice",
      ]),
    );
    expect(await sandbox.importCopy(op(envelope), owner, "items", "items", [])).toMatchObject({
      ok: false,
    });
  });

  it("checks the envelope, fences and erases by generation", async () => {
    const { envelope, sandbox, run } = await withTables();
    expect(await sandbox.fence({ ...envelope, epoch: 1 }, "held")).toBe(true);
    expect(await sandbox.query({ ...envelope, epoch: 1 }, owner, "select 1")).toMatchObject({
      ok: false,
      error: "held",
    });
    expect(await sandbox.fence(envelope, "open")).toBe(false);
    expect(await sandbox.fence({ ...envelope, epoch: 2 }, "open")).toBe(true);
    expect(await sandbox.erase({ ...envelope, epoch: 2 })).toBe(true);
    const next = { ...envelope, generation: 1, epoch: 2 };
    ok(await sandbox.execute(op(next), owner, "create table kept (x)"));
    expect(await sandbox.erase({ ...envelope, epoch: 2 })).toBe(false);
    expect(
      ok(await sandbox.query(next, owner, "select count(*) from sqlite_schema where name = 'kept'"))
        .rows,
    ).toEqual([[1]]);
    void run;
  });
});
