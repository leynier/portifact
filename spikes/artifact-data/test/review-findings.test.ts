// The adversarial review's counterexamples (pull request #249). Each failed against the first
// spike (commit af82ab12); here they run against the redesign, with the same scenario where the
// design kept the operation and against its replacement where the design changed it.
import { describe, expect, it } from "vitest";
import { handoffGate } from "../src/gate.ts";
import { artifact, context, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("review findings", () => {
  it("1: a read-only SQL call never writes, through a virtual table either", async () => {
    const { envelope, sandbox } = artifact();
    expect(
      await sandbox.execute(op(envelope), owner, "create virtual table search using fts5(text)"),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    // Even a statement the classification missed cannot write in the read call.
    ok(await sandbox.execute(op(envelope), owner, "create table t (x)"));
    expect(await sandbox.readOnlyProbe("insert into t values (1)")).toEqual({
      refused: true,
      message: "this call only reads",
    });
    expect(ok(await sandbox.query(envelope, owner, "select count(*) from t")).rows).toEqual([[0]]);
  });

  it("2: no owner DDL can block a visitor's deletion or an account's erasure", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const mine = ok(
      await docs.create(op(envelope), context(visitor("v_alice")), "items", { n: 1 }),
    );
    // The documents are not in the sandbox: a reference to them cannot even be written.
    expect(
      await sandbox.execute(
        op(envelope),
        owner,
        "create table locked (collection text, id text, foreign key (collection, id) references pf_documents (collection, id) on delete restrict)",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await sandbox.execute(op(envelope), owner, "insert into locked values ('items', ?)", [
        mine._id,
      ]),
    ).toMatchObject({ ok: false });
    expect(ok(await docs.eraseAuthorChunk(envelope, "v_alice", 100))).toEqual({
      erased: 1,
      more: false,
    });
  });

  it("4: retrying an earlier erase never deletes data created after it", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.prepareErase(envelope));
    expect(ok(await docs.commitErase(envelope))).toEqual({ erased: true });
    const next = { ...envelope, generation: 1 };
    ok(await docs.declareCollection(op(next), owner, { name: "items", mode: "read" }));
    const kept = ok(await docs.create(op(next), owner, "items", { n: 1 }));
    // The first erase's retry carries generation 0.
    expect(ok(await docs.prepareErase(envelope))).toEqual({ prepared: false });
    expect(ok(await docs.commitErase(envelope))).toEqual({ erased: false });
    expect((await docs.get(next, owner, "items", kept._id)).ok).toBe(true);
  });

  it("6: a self-referencing common table expression is refused without the keyword", async () => {
    const { envelope, sandbox } = artifact();
    expect(
      await sandbox.query(
        envelope,
        owner,
        "with c(x) as (select 1 union all select x + 1 from c where x < 10000) select max(x) from c",
      ),
    ).toMatchObject({ ok: false, error: "invalid_input", message: "WITH is not allowed" });
  });

  it("7: a result's binary bytes count against the result cap", async () => {
    const { envelope, sandbox } = artifact();
    const result = ok(await sandbox.query(envelope, owner, "select zeroblob(2000000)"));
    expect(result.rows).toEqual([[{ $omitted: 2_000_000 }]]);
    expect(result.truncated).toBe(true);
  });

  it("10: refused attempts are counted against the writer's budget", async () => {
    const { envelope, docs } = artifact();
    const limits = { ...ROOMY, writesPerAuthorPerMinute: 30 };
    const alice = context(visitor("v_a"), { limits });
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "votes",
        mode: "append",
        uniqueKey: "poll",
      }),
    );
    ok(await docs.create(op(envelope), alice, "votes", { poll: "p" }));
    for (let index = 0; index < 40; index++)
      await docs.create(op(envelope), alice, "votes", { poll: "p" });
    expect(await docs.create(op(envelope), alice, "votes", { poll: "q" })).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("11: a visitor query that finds nothing reads a bounded number of rows", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    await docs.seedForMeasure(envelope, "items", 20_000, NOW);
    const empty = await docs.query(envelope, context(visitor("v_x")), {
      collection: "items",
      limit: 1,
      equals: { field: "_by", value: "absent" },
    });
    expect(ok(empty).documents).toEqual([]);
    expect(empty.cost.rowsRead).toBeLessThan(20);
    // The review's other shape, a range on `_updated`, is no longer a query.
    expect(
      await docs.query(envelope, context(visitor("v_x")), {
        collection: "items",
        equals: { field: "_updated", value: 1 },
      }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("12: deleting while over quota works, in SQL and in documents", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const document = ok(
      await docs.create(op(envelope), owner, "items", { text: "x".repeat(4000) }),
    );
    ok(await sandbox.execute(op(envelope), owner, "create table n (x)"));
    ok(await sandbox.execute(op(envelope), owner, "insert into n values (1)"));
    const lowered = context(OWNER, { limits: { ...ROOMY, bytesPerArtifact: 1_000 } });
    ok(await sandbox.execute(op(envelope), lowered, "delete from n"));
    ok(await docs.replace(op(envelope), lowered, "items", document._id, {}));
    ok(await docs.remove(op(envelope), lowered, "items", document._id));
  });

  it("13: replacing a document keeps one value of the unique key per author", async () => {
    const { envelope, docs } = artifact();
    const alice = context(visitor("v_a"));
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "votes",
        mode: "append",
        uniqueKey: "poll",
      }),
    );
    const first = ok(await docs.create(op(envelope), alice, "votes", { poll: "p1" }));
    ok(await docs.replace(op(envelope), alice, "votes", first._id, { poll: "p2" }));
    expect(await docs.create(op(envelope), alice, "votes", { poll: "p2" })).toMatchObject({
      ok: false,
      error: "conflict",
    });
    expect(await docs.replace(op(envelope), alice, "votes", first._id, { other: 1 })).toMatchObject(
      {
        ok: false,
        error: "invalid_input",
      },
    );
  });

  it("15: a visitor's sequence numbers do not reveal other authors' private writes", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const bob = context(visitor("v_bob"));
    const first = ok(await docs.create(op(envelope), bob, "items", { n: 1 }));
    ok(await docs.create(op(envelope), context(visitor("v_alice")), "items", { n: 1 }));
    const second = ok(await docs.create(op(envelope), bob, "items", { n: 2 }));
    expect(second._seq - first._seq).toBe(1);
  });

  it("16: the navigation handoff on the artifact origin has a gate it can pass", () => {
    const callback = (dest: string, site: string) =>
      new Request("https://abc.portifact.dev/__portifact/data/grant?code=x", {
        headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest },
      });
    expect(handoffGate(callback("document", "cross-site"), "popup")).toBe("allowed");
    expect(handoffGate(callback("iframe", "cross-site"), "frame")).toBe("allowed");
    expect(handoffGate(callback("document", "same-site"), "popup")).toBe("refused");
  });

  it("27: every call, SQL reads included, checks the artifact it names", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await sandbox.execute(op(envelope), owner, "create table t (x)"));
    const wrong = { ...envelope, artifactId: "different" };
    expect(await sandbox.query(wrong, owner, "select 1")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await docs.query(wrong, owner, { collection: "items" })).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await docs.eraseAuthorChunk(wrong, "v_a", 10)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await docs.renew(wrong, "socket", NOW)).toBe(false);
    expect(await docs.prepareErase(wrong)).toMatchObject({ ok: false, error: "forbidden" });
  });
});
