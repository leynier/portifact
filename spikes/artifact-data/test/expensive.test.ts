import { describe, expect, it } from "vitest";
import { artifact, context, NOW, OWNER, ok, op, visitor } from "./harness.ts";

const ROWS = 8_000;
const owner = context(OWNER);

/**
 * Decision 0026, "One bad statement": SQLite has no statement timeout and an object runs one
 * request at a time. Owner SQL runs in the sandbox, so the documents object is never the one
 * held; in workerd every object shares one thread, so a documents read still waits here. In
 * production the sandbox is another Worker's object (other isolates); only staging can show it.
 */
describe("an expensive owner statement", () => {
  it("holds its sandbox for as long as it runs; the documents object is a separate object", async () => {
    const { envelope, docs, sandbox } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    ok(await sandbox.execute(op(envelope), owner, "create table n (x integer)"));
    await sandbox.unsafeExec(
      `insert into n (x) values ${Array.from({ length: ROWS }, (_, index) => `(${index})`).join(", ")}`,
    );
    let started = Date.now();
    const heavy = sandbox.query(
      envelope,
      owner,
      "select count(*) from n a, n b where a.x + b.x > 0",
    );
    const sameSandbox = sandbox.query(envelope, owner, "select 1");
    const documentsRead = docs.query(envelope, context(visitor("v_b")), { collection: "items" });
    const [heavyMs, sandboxMs, documentsMs] = await Promise.all([
      heavy.then(() => Date.now() - started),
      sameSandbox.then(() => Date.now() - started),
      documentsRead.then(() => Date.now() - started),
    ]);
    expect(ok(await heavy).rows).toEqual([[ROWS * ROWS - 1]]);
    console.log(
      JSON.stringify({
        measure: "expensive_sql",
        heavyMs,
        sameSandboxMs: sandboxMs,
        documentsReadMs: documentsMs,
      }),
    );
    expect(sandboxMs).toBeGreaterThanOrEqual(heavyMs);
    started = Date.now();
    ok(await docs.query(envelope, context(visitor("v_b"), { now: NOW }), { collection: "items" }));
    expect(Date.now() - started).toBeLessThan(heavyMs);
  });
});
