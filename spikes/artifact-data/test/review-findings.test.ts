// The adversarial review's counterexamples (pull request #249), written against the first spike
// before the redesign. Each test states the behavior the design must have; on the first spike
// they fail, which is the reproduction.
import { describe, expect, it } from "vitest";
import { dataGate } from "../src/gate.ts";
import { artifact, FREE, NOW, OWNER, ok, visitor } from "./harness.ts";

describe("review findings, reproduced", () => {
  it("1: a read-only SQL call never writes, through a virtual table either", async () => {
    const { ref, stub } = artifact();
    await stub.sql(ref, "create virtual table search using fts5(text)", [], true, FREE);
    await stub.sql(
      ref,
      "insert into search(text) values ('written with read scope')",
      [],
      false,
      FREE,
    );
    const count = await stub.sql(ref, "select count(*) from search", [], false, FREE);
    expect(count.ok && count.value.rows).not.toEqual([[1]]);
  });

  it("2: no owner DDL can block a visitor's deletion or an account's erasure", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    const mine = ok(await stub.create(ref, visitor("v_alice"), "items", { n: 1 }, FREE, NOW));
    await stub.sql(
      ref,
      "create table locked (collection text, id text, foreign key (collection, id) references pf_documents (collection, id) on delete restrict)",
      [],
      true,
      FREE,
    );
    await stub.sql(ref, "insert into locked values ('items', ?)", [mine._id], true, FREE);
    const erased = await stub.eraseAuthor("v_alice").catch(() => null);
    expect(erased?.ok && erased.value).toBe(1);
  });

  it("4: retrying an earlier erase never deletes data created after it", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "read" }, FREE));
    await stub.erase();
    ok(await stub.declareCollection(ref, { name: "items", mode: "read" }, FREE));
    const kept = ok(await stub.create(ref, OWNER, "items", { n: 1 }, FREE, NOW));
    await stub.erase(); // the first erase's retry
    expect((await stub.get(ref, OWNER, "items", kept._id)).ok).toBe(true);
  });

  it("6: a self-referencing common table expression is refused without the keyword", async () => {
    const { ref, stub } = artifact();
    const outcome = await stub.sql(
      ref,
      "with c(x) as (select 1 union all select x + 1 from c where x < 10000) select max(x) from c",
      [],
      false,
      FREE,
    );
    expect(outcome.ok).toBe(false);
  });

  it("7: a result's binary bytes count against the result cap", async () => {
    const { ref, stub } = artifact();
    const outcome = await stub.sql(ref, "select zeroblob(2000000)", [], false, FREE);
    expect(outcome.ok && !outcome.value.truncated).toBe(false);
  });

  it("10: refused attempts are counted against the writer's budget", async () => {
    const { ref, stub } = artifact();
    ok(
      await stub.declareCollection(ref, { name: "votes", mode: "append", uniqueKey: "poll" }, FREE),
    );
    ok(await stub.create(ref, visitor("v_a"), "votes", { poll: "p" }, FREE, NOW));
    for (let index = 0; index < 40; index++) {
      await stub.create(ref, visitor("v_a"), "votes", { poll: "p" }, FREE, NOW);
    }
    const after = await stub.create(ref, visitor("v_a"), "votes", { poll: "q" }, FREE, NOW);
    expect(after).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("11: a visitor query that finds nothing reads a bounded number of rows", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "append" }, FREE));
    await stub.seedForMeasure(ref, "items", 20_000, NOW);
    const outcome = await stub.query(ref, visitor("v_x"), {
      collection: "items",
      limit: 1,
      filters: [{ field: "_by", op: "in", value: ["absent", "missing"] }],
    });
    expect(outcome.cost.rowsRead).toBeLessThan(100);
  });

  it("12: deleting while over quota works, in SQL and in documents", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "read" }, FREE));
    const document = ok(
      await stub.create(ref, OWNER, "items", { text: "x".repeat(4000) }, FREE, NOW),
    );
    ok(await stub.sql(ref, "create table n (x)", [], true, FREE));
    const lowered = { ...FREE, bytesPerArtifact: 1_000 };
    expect((await stub.sql(ref, "delete from n", [], true, lowered)).ok).toBe(true);
    expect((await stub.update(ref, OWNER, "items", document._id, {}, lowered, NOW)).ok).toBe(true);
  });

  it("13: replacing a document keeps one value of the unique key per author", async () => {
    const { ref, stub } = artifact();
    ok(
      await stub.declareCollection(ref, { name: "votes", mode: "append", uniqueKey: "poll" }, FREE),
    );
    const first = ok(await stub.create(ref, visitor("v_a"), "votes", { poll: "p1" }, FREE, NOW));
    ok(await stub.update(ref, visitor("v_a"), "votes", first._id, { poll: "p2" }, FREE, NOW));
    const second = await stub.create(ref, visitor("v_a"), "votes", { poll: "p2" }, FREE, NOW);
    expect(second).toMatchObject({ ok: false, error: "conflict" });
  });

  it("15: a visitor's sequence numbers do not reveal other authors' private writes", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    const first = ok(await stub.create(ref, visitor("v_bob"), "items", { n: 1 }, FREE, NOW));
    ok(await stub.create(ref, visitor("v_alice"), "items", { n: 1 }, FREE, NOW));
    const second = ok(await stub.create(ref, visitor("v_bob"), "items", { n: 2 }, FREE, NOW));
    expect(second._seq - first._seq).toBe(1);
  });

  it("16: the navigation handoff on the artifact origin has a gate it can pass", () => {
    const callback = new Request("https://abc.portifact.dev/__portifact/data/grant?code=x", {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });
    expect(dataGate(callback, false)).toBe("allowed");
  });

  it("27: every call, SQL reads included, checks the artifact it names", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "read" }, FREE));
    const outcome = await stub.sql(
      { ...ref, artifactId: "different" },
      "select 1",
      [],
      false,
      FREE,
    );
    expect(outcome.ok).toBe(false);
  });
});
