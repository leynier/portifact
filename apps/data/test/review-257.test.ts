// The independent review of PR #257: its reproductions of B1 and B2 (appendix A) and the checks
// of S1 and S2 (appendix B), as written, and the rules decided on them.

import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { unpaidRows, unpaidWork } from "@portifact/domain/artifact-data";
import {
  context,
  envelope,
  NOW,
  OWNER,
  op,
  opId,
  ROOMY,
  value,
  visitor,
} from "@portifact/domain/testing/artifact-data";
import { describe, expect, it } from "vitest";
import { RealObject } from "./driver.ts";
import { pairObject } from "./pair.ts";

const base = envelope();
const ctx = context();

async function fixture(indexed = false) {
  const object = new RealObject();
  const declaration = {
    name: "items",
    mode: "append" as const,
    ...(indexed ? { indexed: ["tag"] } : {}),
  };
  value(await object.declare(op(base), OWNER, declaration, ctx));
  return object;
}

async function assertAccounted(object: RealObject) {
  const view = await object.view();
  expect(view.accounted()).toBe(view.accesses + 4 * view.counterWrites);
}

describe("review 257 invariant reproductions", () => {
  it("B1: a failed recovery transaction cannot forget measured work", async () => {
    const object = await fixture();
    await object.run((store) => {
      let remaining = 2;
      store.faults = {
        statement: (sql) => sql.startsWith("INSERT INTO pf_days") && remaining-- > 0,
      };
    });
    await expect(object.create(op(base), visitor("a"), "items", { n: 1 }, ctx)).rejects.toThrow(
      /injected storage fault/,
    );
    await object.setFaults({});
    value(await object.create(op(base), visitor("a"), "items", { n: 2 }, ctx));
    await assertAccounted(object);
  });

  for (const command of ["get", "export", "fence", "connect", "alarm"] as const) {
    it(`B1: ${command} preserves work before a storage failure`, async () => {
      const object = await fixture();
      const doc = value<{ _id: string }>(
        await object.create(op(base), OWNER, "items", { n: 1 }, ctx),
      );
      await object.run((store) => {
        let armed = true;
        store.faults = {
          statement: (sql) => {
            const hit =
              command === "get"
                ? sql.includes("FROM pf_documents WHERE collection")
                : command === "alarm"
                  ? sql.includes("FROM pf_rights WHERE")
                  : sql.startsWith("INSERT INTO pf_days");
            if (armed && hit) {
              armed = false;
              return true;
            }
            return false;
          },
        };
      });
      const run = () =>
        command === "get"
          ? object.get(base, OWNER, "items", doc._id, ctx)
          : command === "export"
            ? object.exportPage(base, OWNER, null, 500, ctx)
            : command === "fence"
              ? object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "failure" }, NOW)
              : command === "connect"
                ? object.connect(base, null, "reader", NOW + 60_000, ctx)
                : object.alarm(NOW + 4 * 86_400_000);
      await expect(run()).rejects.toThrow(/injected storage fault/);
      await object.setFaults({});
      value(await object.get(base, OWNER, "items", doc._id, ctx));
      await assertAccounted(object);
    });
  }

  it("B1: unpaid work is written into its own class by the next counter write", async () => {
    const object = await fixture();
    await object.run((store) => {
      let remaining = 2;
      store.faults = {
        statement: (sql) => sql.startsWith("INSERT INTO pf_days") && remaining-- > 0,
      };
    });
    const growthBefore = [...(await object.view()).durable.days.values()][0]?.growth ?? 0;
    await expect(object.create(op(base), visitor("a"), "items", { n: 1 }, ctx)).rejects.toThrow(
      /injected storage fault/,
    );
    await object.setFaults({});
    const held = (await object.view()).pending;
    // An attempted debit, not a committed one: nothing reached the day row, the work is held.
    expect(held.unpaid).toEqual({
      growth: unpaidRows(held),
      cleanup: 0,
      export: 0,
      rights: 0,
      protected: 0,
    });
    expect(unpaidRows(held)).toBeGreaterThan(0);
    expect([...(await object.view()).durable.days.values()][0]?.growth ?? 0).toBe(growthBefore);
    const answer = await object.get(base, OWNER, "items", "missing", ctx);
    expect(answer).toMatchObject({ ok: false, code: "not_found" });
    // A read alone writes nothing; the next charge does, and folds the unpaid rows into growth.
    const done = await object.create(op(base), visitor("a"), "items", { n: 2 }, ctx);
    value(done);
    const after = await object.view();
    expect(unpaidRows(after.pending)).toBe(0);
    const day = [...after.durable.days.values()][0];
    expect(day?.growth).toBe(
      growthBefore + unpaidRows(held) + done.cost.rowsRead + done.cost.rowsWritten + 4,
    );
    await assertAccounted(object);
  });

  it("B1: past the flush bound ordinary work is refused until the usage is written; protected work is not", async () => {
    const object = await fixture();
    const doc = value<{ _id: string }>(await object.create(op(base), OWNER, "items", {}, ctx));
    let failing = true;
    await object.run((store) => {
      store.pending = unpaidWork(store.pending, "growth", ARTIFACT_DATA.readFlush.rows, NOW);
      store.faults = { statement: (sql) => failing && sql.startsWith("INSERT INTO pf_days") };
    });
    const refused = { ok: false, code: "unavailable", cost: { rowsRead: 0, rowsWritten: 0 } };
    const before = await object.view();
    expect(await object.get(base, OWNER, "items", doc._id, ctx)).toMatchObject(refused);
    expect(await object.create(op(base), OWNER, "items", {}, ctx)).toMatchObject(refused);
    expect(await object.exportPage(base, OWNER, null, 10, ctx)).toMatchObject(refused);
    expect(await object.connect(base, null, "reader", NOW + 60_000, ctx)).toMatchObject(refused);
    // Refused before any work: the only rows measured are each entry point's own re-arm, held
    // as deferred housekeeping, which is nobody's allowance.
    const still = await object.view();
    expect(still.accesses - before.accesses).toBe(still.pending.deferred - before.pending.deferred);
    expect(still.pending.rows).toBe(before.pending.rows);
    expect(unpaidRows(still.pending)).toBe(ARTIFACT_DATA.readFlush.rows);
    expect(still.durable.documents.size).toBe(1);
    // Protected work is not asked: it runs, and here fails on the same storage fault.
    await expect(
      object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t1" }, NOW),
    ).rejects.toThrow(/injected storage fault/);
    await expect(object.exportPage(base, OWNER, null, 10, ctx, true)).rejects.toThrow(
      /injected storage fault/,
    );
    failing = false;
    // Storage answers again: the next command writes the usage first and then runs.
    value(await object.get(base, OWNER, "items", doc._id, ctx));
    const after = await object.view();
    expect(unpaidRows(after.pending)).toBe(0);
    expect([...after.durable.days.values()][0]?.growth).toBeGreaterThanOrEqual(
      ARTIFACT_DATA.readFlush.rows,
    );
    value(await object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t1" }, NOW));
  });

  it("B1: an eviction loses unpaid work with the pending usage, never more than the flush bound", async () => {
    const object = await fixture();
    await object.run((store) => {
      let remaining = 2;
      store.faults = {
        statement: (sql) => sql.startsWith("INSERT INTO pf_days") && remaining-- > 0,
      };
    });
    await expect(object.create(op(base), visitor("a"), "items", { n: 1 }, ctx)).rejects.toThrow(
      /injected storage fault/,
    );
    await object.setFaults({});
    const held = unpaidRows((await object.view()).pending);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
    await object.evict();
    const view = await object.view();
    expect(unpaidRows(view.pending)).toBe(0);
    // The oracle counts what the eviction lost as retired, so conservation still holds.
    expect(view.accounted()).toBe(view.accesses + 4 * view.counterWrites);
  });

  it("B2: adding an index preserves the measured file cap", async () => {
    const object = await fixture();
    for (let batch = 0; batch < 6; batch++) {
      value(
        await object.bulkCreate(
          op(base),
          OWNER,
          {
            collection: "items",
            documents: Array.from({ length: 100 }, (_, n) => ({
              tag: `${batch}-${n}-${"x".repeat(230)}`,
            })),
          },
          ctx,
        ),
      );
    }
    const before = (await object.view()).fileBytes();
    const limits = { ...ROOMY, bytesPerArtifact: before - ARTIFACT_DATA.controlReserveBytes };
    const answer = await object.declare(
      op(base),
      OWNER,
      { name: "items", mode: "append", indexed: ["tag"] },
      context({ limits }),
    );
    expect(answer).toMatchObject({ ok: false, code: "quota_exceeded" });
    const after = await object.view();
    expect(after.fileBytes()).toBeLessThanOrEqual(
      limits.bytesPerArtifact + ARTIFACT_DATA.controlReserveBytes,
    );
    // Rolled back whole: no field, no index entry, no value count.
    expect(after.durable.fields).toEqual([]);
    expect(await object.run((store) => store.inspect("pf_values"))).toEqual([]);
    expect(after.durable.valueCounts.size).toBe(0);
    await assertAccounted(object);
  });

  it("B2: an index step is refused at the cap, and removing documents is not", async () => {
    const object = await fixture();
    for (let batch = 0; batch < 12; batch++) {
      value(
        await object.bulkCreate(
          op(base),
          OWNER,
          {
            collection: "items",
            documents: Array.from({ length: 100 }, (_, n) => ({
              tag: `${batch}-${n}-${"x".repeat(230)}`,
            })),
          },
          ctx,
        ),
      );
    }
    // Room for the declaration's first step of 500 documents, not for the second step.
    value(
      await object.declare(
        op(base),
        OWNER,
        { name: "items", mode: "append", indexed: ["tag"] },
        ctx,
      ),
    );
    const before = (await object.view()).fileBytes();
    const limits = { ...ROOMY, bytesPerArtifact: before - ARTIFACT_DATA.controlReserveBytes };
    const tight = context({ limits });
    expect(await object.indexStep(op(base), OWNER, tight)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    expect((await object.view()).fileBytes()).toBe(before);
    expect((await object.view()).durable.fields).toMatchObject([{ state: "building" }]);
    // Work that shrinks is never refused for size, at the cap or over it.
    const ids = [...(await object.view()).durable.documents.values()]
      .slice(0, 100)
      .map((d) => d.id);
    const over = context({ limits: { ...ROOMY, bytesPerArtifact: 1 } });
    value(await object.bulkRemove(op(base), OWNER, "items", ids, over));
    await assertAccounted(object);
  });

  it("S1 cursor: a dense query counts its index entries and the documents it fetched", async () => {
    const object = await fixture(true);
    value(
      await object.bulkCreate(
        op(base),
        OWNER,
        { collection: "items", documents: Array.from({ length: 100 }, () => ({ tag: 1 })) },
        ctx,
      ),
    );
    const answer = await object.query(
      base,
      OWNER,
      { collection: "items", equals: { field: "tag", value: 1 }, limit: 100 },
      ctx,
    );
    expect(value<{ documents: unknown[] }>(answer).documents).toHaveLength(100);
    // A lower bound no early sample of the cursor's counters can reach.
    expect(answer.cost.rowsRead).toBeGreaterThanOrEqual(200);
  });

  it("S1 erase: no physical indexed value survives a whole erase", async () => {
    const object = await fixture(true);
    value(await object.create(op(base), visitor("a"), "items", { tag: "secret" }, ctx));
    expect(await object.run((store) => store.inspect("pf_values"))).toHaveLength(1);
    const id = opId();
    value(await object.prepareErase(base, id, NOW));
    value(await object.commitErase(base, id, NOW));
    for (const table of ["pf_values", "pf_value_counts", "pf_documents", "pf_collections"]) {
      expect(await object.run((store) => store.inspect(table)), table).toEqual([]);
    }
  });

  it("S1 sequence: a flush that only a read triggered moves the storage sequence", async () => {
    const object = await fixture();
    const doc = value<{ _id: string }>(await object.create(op(base), OWNER, "items", {}, ctx));
    await object.get(base, OWNER, "items", doc._id, ctx);
    const seq = (await object.view()).durable.control?.storageSeq ?? 0;
    const days = (await object.view()).counterWrites;
    for (let i = 0; i < 4000; i++) await object.get(base, OWNER, "items", doc._id, ctx);
    const after = await object.view();
    expect(after.counterWrites).toBeGreaterThan(days);
    expect(after.durable.control?.storageSeq).toBeGreaterThan(seq);
  });

  it("S2: the pair accepts each object's own measured usage in describe", async () => {
    const object = pairObject();
    value(await object.declare(op(base), OWNER, { name: "items", mode: "append" }, ctx));
    const answer = await object.describe(base, OWNER, ctx);
    expect(answer.ok).toBe(true);
    expect(value<{ today: { day: number } }>(answer).today.day).toBe(Math.floor(NOW / 86_400_000));
  });
});
