// The protocol's invariants after the simplification (decision 0026, decision 45): commands are
// synchronous, every limit is the artifact's own and charged by measured work in the transaction
// that did it, per-operation caps bound the overshoot, and random command sequences keep the
// counters, barriers and charges consistent.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CAPS, type Outcome, operationKey, READ_FLUSH } from "../src/documents.ts";
import { journalKey, pruneRetired, RETIRED_KEEP_MS, retireVisitorId } from "../src/journal.ts";
import { artifact, context, FREE, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("no command awaits anything (rule 1)", () => {
  it("returns every command's answer synchronously, so nothing can land between admission and work", async () => {
    const { envelope, docs } = artifact();
    const results = await runInDurableObject(docs, (instance) => {
      const answers: unknown[] = [];
      const call = <T>(value: T) => {
        answers.push(value);
        return value;
      };
      call(instance.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
      const created = call(
        instance.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }),
      );
      const id = created.ok && "value" in created ? created.value._id : "";
      call(instance.replace(op(envelope), context(visitor("v_a")), "items", id, { n: 2 }));
      call(instance.get(envelope, owner, "items", id));
      call(instance.query(envelope, owner, { collection: "items" }));
      call(instance.count(envelope, owner, "items", "v_a"));
      call(instance.exportPage(envelope, owner, null, 10));
      call(instance.exportMine(envelope, context(visitor("v_a")), null));
      call(instance.remove(op(envelope), context(visitor("v_a")), "items", id));
      call(instance.bulkRemove(op(envelope), owner, "items", ["x"]));
      call(instance.buildIndexStep(op(envelope), owner));
      call(instance.eraseAuthorChunk(op(envelope), "v_z", 10));
      call(instance.settle(envelope, "owner:owner", `${NOW}.s`));
      call(instance.acknowledge(envelope, "owner:owner", `${NOW}.s`));
      call(instance.prepareErase(envelope, "erase_sync"));
      call(instance.cancelErase(envelope, "erase_sync"));
      call(instance.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_sync" }));
      return answers.map((answer) => answer instanceof Promise);
    });
    expect(results).toHaveLength(17);
    expect(results.every((isPromise) => !isPromise)).toBe(true);
  });

  it("orders a hold and concurrent writes: each write lands wholly before the hold or is refused", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const writes = Array.from({ length: 20 }, (_, index) =>
      docs.create(op(envelope), context(visitor(`v_${index}`)), "items", { index }),
    );
    const hold = docs.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_hold" });
    const outcomes = await Promise.all([...writes, hold]);
    const accepted = outcomes.slice(0, 20).filter((outcome) => outcome.ok).length;
    const stored = ok(await docs.exportPage({ ...envelope, epoch: 1 }, owner, null, 100, true));
    expect(stored.rows).toHaveLength(accepted);
  });

  it("applies concurrent duplicates of one operation once", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const once = op(envelope);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        docs.create(once, context(visitor("v_a")), "items", { n: 1 }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.ok && "value" in outcome)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.ok && "replayed" in outcome)).toHaveLength(4);
  });
});

describe("measured charging (rule 2)", () => {
  it("adds what a mutation measured, its own counter row included, in the transaction that did it", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const before = await docs.budget(NOW);
    const created = await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 });
    const after = await docs.budget(NOW);
    expect((after.rows_written ?? 0) - (before.rows_written ?? 0)).toBeGreaterThanOrEqual(
      created.cost.rowsWritten,
    );
    expect((after.rows_read ?? 0) - (before.rows_read ?? 0)).toBeGreaterThanOrEqual(
      created.cost.rowsRead,
    );
  });

  it("charges a failure after the work began what it measured, with its rate attempt", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "votes",
        mode: "append",
        uniqueKey: "poll",
      }),
    );
    ok(await docs.create(op(envelope), context(visitor("v_a")), "votes", { poll: "p" }));
    const before = await docs.budget(NOW);
    const failed = await docs.create(op(envelope), context(visitor("v_a")), "votes", { poll: "p" });
    expect(failed).toMatchObject({ ok: false, error: "conflict" });
    const after = await docs.budget(NOW);
    expect((after.rows_written ?? 0) - (before.rows_written ?? 0)).toBeGreaterThan(0);
  });

  it("refuses work of a spent class without writing anything", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const spent = context(visitor("v_a"), { limits: { ...ROOMY, rowsWrittenPerDay: 1 } });
    const refused = await docs.create(op(envelope), spent, "items", { n: 1 });
    expect(refused).toMatchObject({ ok: false, error: "quota_exceeded" });
    expect(refused.cost.rowsWritten).toBe(0);
    expect((await docs.budget(NOW)).refused).toBeGreaterThan(0);
  });

  it("counts reads in memory and persists them at most every READ_FLUSH", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const created = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    const persisted = () =>
      runInDurableObject(
        docs,
        (_instance, state) =>
          state.storage.sql.exec<{ n: number }>("select read_used as n from pf_day").toArray()[0]
            ?.n ?? 0,
      );
    const start = await persisted();
    let read = 0;
    for (let index = 0; index < 30; index++)
      read += (await docs.get(envelope, owner, "items", created._id)).cost.rowsRead;
    expect(await persisted()).toBe(start);
    expect((await docs.budget(NOW)).rows_read).toBeGreaterThanOrEqual(start + read);
    expect(READ_FLUSH.rows).toBeGreaterThan(read);
  });

  it("bounds what one operation can overshoot by its caps", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "append",
        indexed: ["a"],
      }),
    );
    await docs.seedForMeasure(envelope, "items", 1_500, NOW);
    const ids = ok(
      await docs.query(envelope, owner, { collection: "items", limit: 100 }),
    ).documents.map((d) => d._id);
    const bulk = await docs.bulkRemove(op(envelope), owner, "items", ids);
    expect(ok(bulk).removed).toBe(CAPS.bulkDocuments);
    expect(bulk.cost.rowsRead + bulk.cost.rowsWritten).toBeLessThan(CAPS.bulkDocuments * 20);
    const page = await docs.query(envelope, owner, { collection: "items", limit: 1_000 });
    expect(ok(page).documents).toHaveLength(CAPS.pageDocuments);
    expect(page.cost.rowsRead).toBeLessThanOrEqual(CAPS.pageDocuments + 20);
  });
});

describe("indexes are built in bounded steps (finding 3)", () => {
  it("refuses queries on a field until its build finishes, then answers them from maintained values", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    await docs.seedForMeasure(envelope, "items", 1_200, NOW);
    const declared = ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "append",
        indexed: ["tag"],
      }),
    );
    expect(declared.building).toBe(1);
    expect(
      await docs.query(envelope, owner, {
        collection: "items",
        equals: { field: "tag", value: "t7" },
      }),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    // A write during the build is indexed too.
    ok(await docs.create(op(envelope), owner, "items", { tag: "t7", late: true }));
    let steps = 1;
    for (;;) {
      steps += 1;
      if (ok(await docs.buildIndexStep(op(envelope), owner)).building === 0) break;
    }
    expect(steps).toBe(Math.ceil(1_201 / CAPS.indexStepDocuments));
    const found = ok(
      await docs.query(envelope, owner, {
        collection: "items",
        equals: { field: "tag", value: "t7" },
        limit: 100,
      }),
    );
    expect(found.documents).toHaveLength(3);
  });
});

describe("the owner side's document API", () => {
  it("counts a collection and one author from maintained counters", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    for (let index = 0; index < 5; index++)
      ok(
        await docs.create(op(envelope), context(visitor(index < 3 ? "v_a" : "v_b")), "items", {
          index,
        }),
      );
    expect(ok(await docs.count(envelope, owner, "items"))).toEqual({ documents: 5 });
    expect(ok(await docs.count(envelope, owner, "items", "v_a"))).toEqual({ documents: 3 });
    expect(await docs.count(envelope, context(visitor("v_a")), "items")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(ok(await artifact().docs.count(envelope, owner, "items"))).toEqual({ documents: 0 });
  });

  it("deletes in bulk once, with one audit obligation, and refuses outside its cap", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const ids: string[] = [];
    for (let index = 0; index < 6; index++)
      ids.push(
        ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { index }))._id,
      );
    const once = { ...envelope, opId: `${NOW}.bulk` };
    const targets = [...ids.slice(0, 4), "missing"];
    expect(ok(await docs.bulkRemove(once, owner, "items", targets))).toEqual({ removed: 4 });
    expect(ok(await docs.bulkRemove(once, owner, "items", targets))).toEqual({ removed: 4 });
    expect(ok(await docs.count(envelope, owner, "items"))).toEqual({ documents: 2 });
    expect(await docs.auditFor(operationKey("owner:owner", 0, `${NOW}.bulk`))).toMatchObject({
      kind: "data.documents_deleted",
    });
    expect(await docs.bulkRemove(op(envelope), owner, "items", [])).toMatchObject({
      error: "invalid_input",
    });
    expect(
      await docs.bulkRemove(
        op(envelope),
        owner,
        "items",
        Array.from({ length: CAPS.bulkDocuments + 1 }, (_, i) => `x${i}`),
      ),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await docs.bulkRemove(op(envelope), context(visitor("v_a")), "items", [ids[4] as string]),
    ).toMatchObject({ error: "forbidden" });
    const tight = context(OWNER, { limits: { ...ROOMY, cleanupRowsPerDay: 1 } });
    expect(await docs.bulkRemove(op(envelope), tight, "items", [ids[4] as string])).toMatchObject({
      error: "rate_limited",
    });
  });
});

describe("plan B Free on one artifact", () => {
  it("stops growth at the artifact's day, keeps cleanup and rights apart, and never refuses erasure", async () => {
    const { envelope, docs } = artifact();
    const free = (caller: Parameters<typeof context>[0]) =>
      context(caller, {
        limits: { ...FREE, writesPerAuthorPerMinute: 10_000, deletesPerAuthorPerMinute: 10_000 },
      });
    ok(await docs.declareCollection(op(envelope), free(OWNER), { name: "items", mode: "append" }));
    const ids: string[] = [];
    let refused: Outcome<unknown> | null = null;
    let largest = 0;
    for (let index = 0; index < 1_000 && refused === null; index++) {
      const outcome = await docs.create(op(envelope), free(visitor("v_a")), "items", { index });
      if (outcome.ok && "value" in outcome) {
        ids.push(outcome.value._id);
        largest = Math.max(largest, outcome.cost.rowsWritten);
      } else refused = outcome;
    }
    expect(refused).toMatchObject({ ok: false, error: "quota_exceeded" });
    const written = (await docs.budget(NOW)).rows_written ?? 0;
    // The overshoot is at most one operation's work.
    expect(written).toBeGreaterThanOrEqual(FREE.rowsWrittenPerDay);
    expect(written - FREE.rowsWrittenPerDay).toBeLessThanOrEqual(largest + 10);
    // The owner spends cleanup; once it is spent, the visitor's own deletes still go, from rights.
    let ownerRefused = false;
    for (let index = 0; index < 2_000 && !ownerRefused; index++) {
      const outcome = await docs.remove(op(envelope), free(OWNER), "items", `missing_${index}`);
      if (!outcome.ok && outcome.error === "rate_limited") ownerRefused = true;
    }
    expect(ownerRefused).toBe(true);
    const last = ids.at(-1) as string;
    ok(await docs.remove(op(envelope), free(visitor("v_a")), "items", last));
    ok(await docs.exportMine(envelope, context(visitor("v_a", false), { limits: FREE }), null));
    // Erasure is counted, never refused.
    while (ok(await docs.eraseAuthorChunk(op(envelope), "v_a", 500, free(OWNER))).more) {
      // until done
    }
    expect(ok(await docs.count(envelope, free(OWNER), "items", "v_a"))).toEqual({ documents: 0 });
  });
});

describe("live messages are reserved in chunks against the artifact's day", () => {
  it("writes the counter once per chunk and closes the connection when the day is spent", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const limits = { ...ROOMY, liveMessagesPerDay: 200 };
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_a",
          principal: "grant:v_a",
          deadline: Date.now() + 60_000,
          limits,
          now: Date.now(),
        }),
      },
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    let received = 0;
    socket.addEventListener("message", () => {
      received += 1;
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.send(JSON.stringify({ subscribe: "items" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await docs.budget(Date.now())).live_messages).toBe(100);
    for (let index = 0; index < 220; index++)
      await docs.create(op(envelope), owner, "items", { index });
    expect(await closed).toBe(4029);
    expect(received).toBe(200);
    expect(((await docs.budget(Date.now())).live_messages ?? -1) % 100).toBe(0);
  });
});

describe("the author journal's one retention rule", () => {
  it("keeps a retired entry RETIRED_KEEP_MS and only then deletes it", async () => {
    await retireVisitorId(env.JOURNAL, "user_retire", "a_retire", NOW);
    expect(
      await pruneRetired(env.JOURNAL, "user_retire", "a_retire", NOW + RETIRED_KEEP_MS - 1),
    ).toBe(false);
    expect(await env.JOURNAL.head(journalKey("user_retire", "a_retire"))).not.toBeNull();
    expect(await pruneRetired(env.JOURNAL, "user_retire", "a_retire", NOW + RETIRED_KEEP_MS)).toBe(
      true,
    );
    expect(await pruneRetired(env.JOURNAL, "user_retire", "a_retire", NOW + RETIRED_KEEP_MS)).toBe(
      false,
    );
  });
});

/** A small deterministic generator, so a failing sequence can be replayed from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("properties over random command sequences", () => {
  for (const seed of [1, 7, 42]) {
    it(`keeps counters, barriers and charges consistent (seed ${seed})`, async () => {
      const next = random(seed);
      const { envelope, docs } = artifact();
      ok(
        await docs.declareCollection(op(envelope), owner, {
          name: "items",
          mode: "shared",
          indexed: ["step"],
        }),
      );
      const authors = ["v_a", "v_b", "v_c", "v_d"];
      const erased = new Set<string>();
      const live = new Map<string, string>();
      for (let step = 0; step < 120; step++) {
        const author = authors[Math.floor(next() * authors.length)] as string;
        const roll = next();
        const ids = [...live.keys()];
        const target = ids[Math.floor(next() * ids.length)];
        const before = await docs.budget(NOW);
        let outcome: Outcome<unknown>;
        let mutation = true;
        if (roll < 0.45 || target === undefined) {
          outcome = await docs.create(op(envelope), context(visitor(author)), "items", {
            step,
            text: "t".repeat(Math.floor(next() * 200)),
          });
          if (outcome.ok && "value" in outcome)
            live.set((outcome.value as { _id: string })._id, author);
        } else if (roll < 0.6) {
          outcome = await docs.replace(op(envelope), context(visitor(author)), "items", target, {
            step,
          });
        } else if (roll < 0.75) {
          outcome = await docs.remove(op(envelope), context(visitor(author)), "items", target);
          if (outcome.ok) live.delete(target);
        } else if (roll < 0.8) {
          outcome = await docs.bulkRemove(op(envelope), owner, "items", ids.slice(0, 3));
          if (outcome.ok) for (const id of ids.slice(0, 3)) live.delete(id);
        } else if (roll < 0.9) {
          mutation = false;
          outcome = await docs.query(envelope, context(visitor(author)), {
            collection: "items",
            limit: 20,
          });
        } else {
          outcome = await docs.eraseAuthorChunk(op(envelope), author, 2);
          erased.add(author);
          if (outcome.ok && "value" in outcome && !(outcome.value as { more: boolean }).more) {
            for (const [id, by] of live) if (by === author) live.delete(id);
          }
        }
        // Invariant 1: every successful operation is charged at least what it measured.
        if (outcome.ok) {
          const after = await docs.budget(NOW);
          const keys = mutation
            ? ["rows_read", "rows_written", "cleanup", "rights"]
            : ["rows_read"];
          const charged = keys.reduce(
            (sum, key) => sum + (after[key] ?? 0) - (before[key] ?? 0),
            0,
          );
          expect(charged).toBeGreaterThanOrEqual(outcome.cost.rowsRead + outcome.cost.rowsWritten);
        }
      }
      for (const author of erased) {
        while (ok(await docs.eraseAuthorChunk(op(envelope), author, 50)).more) {
          // finish every started erasure
        }
        for (const [id, by] of live) if (by === author) live.delete(id);
      }
      // Invariant 2: the counters equal the documents; invariant 3: no erased author has state.
      const page = ok(await docs.exportPage(envelope, owner, null, 500));
      expect(ok(await docs.count(envelope, owner, "items")).documents).toBe(page.rows.length);
      expect(page.rows.map((row) => row.id).sort()).toEqual([...live.keys()].sort());
      for (const author of erased) {
        expect(page.rows.some((row) => row.by === author || row.editedBy === author)).toBe(false);
        const traces = await runInDurableObject(docs, (_instance, state) =>
          [
            "select count(*) as n from pf_seq where scope = ?",
            "select count(*) as n from pf_rate where subject = ?",
            "select count(*) as n from pf_ops where actor = ?",
          ].reduce(
            (sum, sql) =>
              sum +
              (state.storage.sql
                .exec<{ n: number }>(sql, sql.includes("scope") ? `author:${author}` : author)
                .toArray()[0]?.n ?? 0),
            0,
          ),
        );
        expect(traces).toBe(0);
        expect(
          (await docs.create(op(envelope), context(visitor(author)), "items", { late: true })).ok,
        ).toBe(false);
      }
    });
  }
});
