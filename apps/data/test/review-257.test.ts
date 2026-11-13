// The independent review of PR #257: its reproductions of B1 and B2 (appendix A) and the checks
// of S1 and S2 (appendix B), as written, and the rules decided on them.

import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
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

  const lostRows = (object: RealObject) => object.run((store) => store.meters.lost);
  const growthOf = async (object: RealObject) =>
    [...(await object.view()).durable.days.values()].reduce((sum, day) => sum + day.growth, 0);
  const faulty = (object: RealObject, statement: ((sql: string) => boolean) | null) =>
    object.run((store) => {
      store.faults = statement === null ? {} : { statement };
    });
  const failDays = (times: number) => {
    let remaining = times;
    return (sql: string) => sql.startsWith("INSERT INTO pf_days") && remaining-- > 0;
  };

  it("B1: a failed read loses exactly the rows it measured, counted, and debits nothing", async () => {
    const object = await fixture();
    const doc = value<{ _id: string }>(await object.create(op(base), OWNER, "items", {}, ctx));
    const before = await object.view();
    const lostBefore = await lostRows(object);
    await faulty(object, (sql) => sql.includes("FROM pf_documents WHERE collection"));
    await expect(object.get(base, OWNER, "items", doc._id, ctx)).rejects.toThrow(
      /injected storage fault/,
    );
    await object.setFaults({});
    const after = await object.view();
    const measured = after.accesses - before.accesses;
    expect(measured).toBeGreaterThan(0);
    expect((await lostRows(object)) - lostBefore).toBe(measured);
    // No counter holds them and no allowance paid for them.
    expect(after.pending).toEqual(before.pending);
    expect([...after.durable.days.values()]).toEqual([...before.durable.days.values()]);
    expect(after.counterWrites).toBe(before.counterWrites);
    await assertAccounted(object);
  });

  it("B1: a mutation whose transaction fails is charged by the second one, and loses its rows only when that fails too", async () => {
    const object = await fixture();
    const growth = await growthOf(object);
    // One fault: the first transaction's charge fails, the second charges the failed work.
    await faulty(object, failDays(1));
    await expect(object.create(op(base), visitor("a"), "items", { n: 1 }, ctx)).rejects.toThrow(
      /injected storage fault/,
    );
    await object.setFaults({});
    const charged = await growthOf(object);
    expect(charged).toBeGreaterThan(growth);
    expect(await lostRows(object)).toBe(0);
    expect((await object.view()).durable.documents.size).toBe(0);
    // Two faults: the compensating charge fails as well. Nothing is debited, the rows are lost.
    const before = await object.view();
    await faulty(object, failDays(2));
    await expect(object.create(op(base), visitor("a"), "items", { n: 2 }, ctx)).rejects.toThrow(
      /injected storage fault/,
    );
    await object.setFaults({});
    const after = await object.view();
    expect(await growthOf(object)).toBe(charged);
    expect(await lostRows(object)).toBe(after.accesses - before.accesses);
    expect(after.pending).toEqual(before.pending);
    expect(after.durable.documents.size).toBe(0);
    await assertAccounted(object);
  });

  it("B1: every failure loses only its own rows, nothing accumulates, and the object keeps answering", async () => {
    const object = await fixture();
    const doc = value<{ _id: string }>(await object.create(op(base), OWNER, "items", {}, ctx));
    const pending = (await object.view()).pending;
    const losses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await lostRows(object);
      await faulty(object, failDays(1));
      await expect(
        object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t1" }, NOW),
      ).rejects.toThrow(/injected storage fault/);
      await object.setFaults({});
      losses.push((await lostRows(object)) - before);
      // Nothing is held in memory for a failed attempt, so nothing grows with the failures.
      expect((await object.view()).pending).toEqual(pending);
    }
    // Each attempt loses what it measured itself (the first read the control record from the
    // object's cache, the later ones from storage): a handful of rows, never a growing sum.
    for (const loss of losses) {
      expect(loss).toBeGreaterThan(0);
      expect(loss).toBeLessThan(20);
    }
    expect(new Set(losses.slice(1)).size).toBe(1);
    // No refusal follows a fault: ordinary and protected work both run as soon as storage does.
    value(await object.get(base, OWNER, "items", doc._id, ctx));
    value(await object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t1" }, NOW));
    expect((await object.view()).durable.control?.epoch).toBe(1);
    await assertAccounted(object);
  });

  it("B1: a fault while computing the next alarm does not fail the command that committed", async () => {
    const object = await fixture();
    const growth = await growthOf(object);
    let armed = true;
    await faulty(object, (sql) => {
      if (armed && sql.startsWith("SELECT at AS age FROM pf_ended")) {
        armed = false;
        return true;
      }
      return false;
    });
    const sets = object.recorder.sets.length;
    const answer = await object.create(op(base), OWNER, "items", { n: 1 }, ctx);
    await object.setFaults({});
    // The create committed and was charged to growth; only the scheduler's own rows are lost.
    const doc = value<{ _id: string }>(answer);
    expect((await object.view()).durable.documents.size).toBe(1);
    const charged = await growthOf(object);
    expect(charged - growth).toBe(answer.cost.rowsRead + answer.cost.rowsWritten + 4);
    const lost = await lostRows(object);
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(10);
    expect(object.recorder.sets.length).toBe(sets);
    // Nothing was set by the faulted pass, so the next entry point computes and sets it.
    value(await object.get(base, OWNER, "items", doc._id, ctx));
    expect(object.recorder.sets.length).toBeGreaterThan(sets);
    expect(await growthOf(object)).toBe(charged);
    await assertAccounted(object);
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
    await assertAccounted(object);
  });

  it("B2: the check reads the file after the charge's own writes", async () => {
    const object = await fixture();
    // The file as the store measures it, fixed until the charge's day row is written and one
    // page larger after: the measurement under test is the one that includes the charge's own
    // writes, whatever the real file's pages do. The documents are far below their allowance, so
    // nothing but that page can refuse the create.
    const size = ARTIFACT_DATA.controlReserveBytes + 10_000_000;
    const limits = { ...ROOMY, bytesPerArtifact: 10_000_000 };
    const mock = (on: boolean) =>
      object.run((store) => {
        let charged = false;
        store.faults = {
          statement: (sql) => {
            if (sql.startsWith("INSERT INTO pf_days")) charged = true;
            return false;
          },
        };
        store.fileBytes = () => size + (on && charged ? 4096 : 0);
      });
    await mock(false);
    // With the file not growing, the same create fits.
    value(await object.create(op(base), OWNER, "items", {}, context({ limits })));
    await mock(true);
    const refused = await object.create(op(base), OWNER, "items", {}, context({ limits }));
    expect(refused).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect((await object.view()).durable.documents.size).toBe(1);
  });

  it("B2: a connect is growth and is refused when it would grow the file past the cap", async () => {
    const object = new RealObject();
    const fields = ["a", "b", "c"];
    value(
      await object.declare(
        op(base),
        OWNER,
        { name: "items", mode: "append", indexed: fields },
        ctx,
      ),
    );
    value(
      await object.bulkCreate(
        op(base),
        OWNER,
        {
          collection: "items",
          documents: Array.from({ length: 100 }, (_, i) =>
            Object.fromEntries(fields.map((field) => [field, `${i}-${"x".repeat(230)}`])),
          ),
        },
        ctx,
      ),
    );
    const before = await object.view();
    const cap = before.fileBytes();
    const bytesPerArtifact = cap - ARTIFACT_DATA.controlReserveBytes;
    // The documents fit their allowance: only the file's size can refuse.
    expect(before.durable.collections.get("items")?.bytes).toBeLessThan(bytesPerArtifact);
    const growth = async () =>
      [...(await object.view()).durable.days.values()].reduce((sum, day) => sum + day.growth, 0);
    let refusedAt = -1;
    // One reader reconnecting each minute: every connect adds a rate row, until one needs a page.
    for (let minute = 0; minute < 600 && refusedAt < 0; minute++) {
      const now = NOW + minute * 60_000;
      const used = await growth();
      const answer = await object.connect(
        base,
        null,
        "reader",
        now + 60_000,
        context({ now, limits: { ...ROOMY, bytesPerArtifact } }),
      );
      if (answer.ok) {
        const socketId = value<string>(answer);
        await object.run((store) => store.closed(socketId, 1000));
        expect((await object.view()).fileBytes(), `minute ${minute}`).toBeLessThanOrEqual(cap);
        continue;
      }
      refusedAt = minute;
      expect(answer.code).toBe("quota_exceeded");
      const after = await object.view();
      // Rolled back whole (no socket was accepted), and its work charged to growth.
      expect([...after.sockets.values()].filter((socket) => socket.closed === null)).toEqual([]);
      expect(await growth()).toBeGreaterThan(used);
    }
    expect(refusedAt).toBeGreaterThan(0);
    await assertAccounted(object);
  });

  it("B2: work that does not grow its documents is never refused for size", async () => {
    const object = await fixture();
    const doc = value<{ _id: string }>(
      await object.create(op(base), OWNER, "items", { text: "x".repeat(1000) }, ctx),
    );
    const many = value<{ ids: string[] }>(
      await object.bulkCreate(
        op(base),
        OWNER,
        {
          collection: "items",
          documents: Array.from({ length: 100 }, () => ({ text: "x".repeat(12_000) })),
        },
        ctx,
      ),
    );
    const atCap = async () => {
      const file = (await object.view()).fileBytes();
      return context({
        limits: { ...ROOMY, bytesPerArtifact: file - ARTIFACT_DATA.controlReserveBytes },
      });
    };
    // Shrinking one byte at a time with the cap at the file's size: operation and audit
    // records still need a page now and then, and the replacement must finish every time.
    for (let size = 999; size >= 940; size--) {
      const answer = await object.replace(
        op(base),
        OWNER,
        "items",
        doc._id,
        { text: "x".repeat(size) },
        await atCap(),
      );
      expect(answer.ok, `shrinking to ${size}`).toBe(true);
    }
    // The same size again, a bulk replacement that shrinks, and removals, at the cap and far over it.
    value(
      await object.replace(
        op(base),
        OWNER,
        "items",
        doc._id,
        { text: "y".repeat(940) },
        await atCap(),
      ),
    );
    value(
      await object.bulkReplace(
        op(base),
        OWNER,
        {
          collection: "items",
          documents: many.ids.map((id) => ({ id, body: { text: "x".repeat(11_000) } })),
        },
        await atCap(),
      ),
    );
    const over = context({ limits: { ...ROOMY, bytesPerArtifact: 1 } });
    value(await object.remove(op(base), OWNER, "items", doc._id, over));
    value(await object.bulkRemove(op(base), OWNER, "items", many.ids.slice(0, 50), over));
    // A replacement that grows its document is growth, and is judged.
    const grown = await object.replace(
      op(base),
      OWNER,
      "items",
      many.ids[60] as string,
      { text: "x".repeat(200_000) },
      await atCap(),
    );
    expect(grown).toMatchObject({ ok: false, code: "quota_exceeded" });
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
    await object.getMany(base, OWNER, "items", doc._id, ctx, 4000);
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

  it("S2: a document's own field named today is compared whole by the pair", async () => {
    const object = pairObject();
    value(await object.declare(op(base), OWNER, { name: "items", mode: "append" }, ctx));
    const created = await object.create(op(base), OWNER, "items", { today: null }, ctx);
    expect(value<{ today: unknown }>(created).today).toBeNull();
    const other = await object.create(op(base), OWNER, "items", { today: { day: 1, n: 2 } }, ctx);
    expect(value<{ today: unknown }>(other).today).toEqual({ day: 1, n: 2 });
  });

  it("the driver's cached view follows every command that completed, concurrent ones included", async () => {
    const object = await fixture();
    await object.view();
    await Promise.all([
      object.create(op(base), OWNER, "items", { n: 1 }, ctx),
      object.create(op(base), OWNER, "items", { n: 2 }, ctx),
    ]);
    // The cached view is read first: any other call into the object would replace it.
    const cached = (await object.view()).durable.documents.size;
    const stored = await object.run((store) => store.inspect("pf_documents").length);
    expect(stored).toBe(2);
    expect(cached).toBe(stored);
  });
});
