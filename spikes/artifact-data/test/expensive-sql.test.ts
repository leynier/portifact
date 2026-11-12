import { describe, expect, it } from "vitest";
import { artifact, FREE, NOW, ok, visitor } from "./harness.ts";

/**
 * Decision 0026, "One bad query": a Durable Object runs one request at a time and SQLite has no
 * statement timeout, so an expensive owner statement holds every visitor request of the same
 * artifact until it ends. This measures by how much. Times are wall time seen by the caller.
 */
const ROWS = 8_000;

describe("an expensive owner statement and concurrent visitors", () => {
  it("holds a visitor's read for as long as the statement runs, and other objects of the isolate too", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "append" }, FREE));
    ok(await stub.create(ref, visitor("v_a"), "items", { n: 1 }, FREE, NOW));
    ok(await stub.sql(ref, "create table n (x integer)", [], true, FREE));
    ok(
      await stub.sql(
        ref,
        "insert into n select value from json_each(?)",
        [JSON.stringify(Array.from({ length: ROWS }, (_, index) => index))],
        true,
        FREE,
      ),
    );

    let started = Date.now();
    ok(await stub.query(ref, visitor("v_b"), { collection: "items" }));
    const idleRead = Date.now() - started;

    // ROWS × ROWS joined rows from a table of a few kilobytes: within every size cap, quadratic in time.
    started = Date.now();
    const heavy = stub.sql(
      ref,
      "select count(*) from n a, n b where a.x + b.x > 0",
      [],
      false,
      FREE,
    );
    const blocked = stub.query(ref, visitor("v_b"), { collection: "items" });
    const blockedDone = blocked.then(() => Date.now() - started);
    const heavyDone = heavy.then(() => Date.now() - started);
    const [heavyMs, blockedMs] = await Promise.all([heavyDone, blockedDone]);
    const result = ok(await heavy);
    expect(result.rows).toEqual([[ROWS * ROWS - 1]]);
    console.log(
      JSON.stringify({
        measure: "expensive_sql",
        idleReadMs: idleRead,
        heavyMs,
        visitorReadMs: blockedMs,
      }),
    );
    // The visitor waited for the statement: its read finished after it, not before.
    expect(blockedMs).toBeGreaterThanOrEqual(heavyMs);
    expect(heavyMs).toBeGreaterThan(idleRead);
    // Another artifact's object: in workerd every object of the class runs on one thread, so it
    // waits too. Production may also place several objects in one isolate (decision 0026, "One
    // bad query"): the CPU limit of the data Worker is what bounds this, not the object boundary.
    const other = artifact();
    started = Date.now();
    const meanwhile = other.stub.query(other.ref, visitor("v_b"), { collection: "items" });
    const slow = stub.sql(
      ref,
      "select count(*) from n a, n b where a.x + b.x > 0",
      [],
      false,
      FREE,
    );
    await meanwhile;
    const otherMs = Date.now() - started;
    const slowResult = await slow;
    expect(slowResult.ok).toBe(true);
    console.log(
      JSON.stringify({ measure: "expensive_sql_other_artifact", otherArtifactReadMs: otherMs }),
    );
    expect(otherMs).toBeGreaterThanOrEqual(heavyMs / 2);
  });
});
