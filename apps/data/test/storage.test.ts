// Delivery 4's obligations on real storage (decision 0026, "Delivery 4's obligations"): what the
// shared suites cannot show through the driver. Synchronous commands and their interleavings,
// storage failures at the real boundary, query plans, measured costs against the row bounds, the
// cold start, the alarm scheduler, hibernation and a lost close, the payload-only erase, platform
// limits and the file-size headroom. Times come from the commands' `now` (an injected clock);
// nothing here depends on wall-clock speed.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type DataEnvelope,
  MAX_DOCUMENT_BYTES,
  MAX_INDEXED_FIELDS,
} from "@portifact/contracts/artifact-data";
import {
  dayOf,
  emptyDay,
  encodeCursor,
  OPERATION_ROW_BOUNDS,
  type OperationKind,
} from "@portifact/domain/artifact-data";
import {
  context,
  envelope,
  NOW,
  OWNER,
  op,
  opId,
  ROOMY,
  type SeedRows,
  value,
  visitor,
  visitorId,
} from "@portifact/domain/testing/artifact-data";
import { describe, expect, it } from "vitest";
import { SCHEMA_PROBE } from "../src/schema.ts";
import { ATTACHMENT_BYTES, type DocumentsStore } from "../src/store.ts";
import { RealObject } from "./driver.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ctx = context();

async function withCollection(
  options: {
    mode?: "own" | "append" | "shared";
    indexed?: string[];
    limits?: ArtifactDataLimits;
  } = {},
) {
  const object = new RealObject();
  const base = envelope();
  value(
    await object.declare(
      op(base),
      OWNER,
      { name: "items", mode: options.mode ?? "append", indexed: options.indexed ?? [] },
      context({ limits: options.limits ?? ROOMY }),
    ),
  );
  return { object, base };
}

/** Records every statement the store runs (its text), failing none. */
async function recordStatements(object: RealObject): Promise<Set<string>> {
  const seen = new Set<string>();
  await object.run((store) => {
    store.faults = {
      statement(query) {
        seen.add(query);
        return false;
      },
    };
  });
  return seen;
}

async function bulkFill(
  object: RealObject,
  base: DataEnvelope,
  total: number,
  body: (index: number) => Record<string, unknown>,
  caller = OWNER,
) {
  for (let start = 0; start < total; start += 100) {
    const documents = Array.from({ length: Math.min(100, total - start) }, (_v, i) =>
      body(start + i),
    );
    if (caller.kind === "owner") {
      value(await object.bulkCreate(op(base), OWNER, { collection: "items", documents }, ctx));
    } else {
      for (const document of documents) {
        value(await object.create(op(base), caller, "items", document, ctx));
      }
    }
  }
}

describe("one synchronous transaction per command", () => {
  it("answers every command synchronously inside the object", async () => {
    const { object, base } = await withCollection();
    await object.run((store) => {
      const answers: unknown[] = [
        store.create(op(base), OWNER, "items", { n: 1 }, ctx),
        store.query(base, OWNER, { collection: "items" }, ctx),
        store.count(base, OWNER, { collection: "items" }, ctx),
        store.describe(base, OWNER, ctx),
        store.exportPage(base, OWNER, null, 10, ctx),
        store.indexStep(op(base), OWNER, ctx),
        store.settle(base, "owner:owner", opId(), NOW),
        store.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "e1" }, NOW),
        store.alarm(NOW),
      ];
      for (const answer of answers) {
        expect(typeof (answer as { then?: unknown } | null)?.then).not.toBe("function");
      }
    });
  });

  it("orders a hold racing twenty writes wholly before or after each, and applies five copies of one operation once", async () => {
    const { object, base } = await withCollection();
    const held = { ...base, epoch: 1 };
    const calls = Array.from({ length: 21 }, (_v, index) =>
      index === 10
        ? object.fence(held, { kind: "hold", transition: "race" }, NOW)
        : object.create(op(base), visitor("a"), "items", { index }, ctx),
    );
    const answers = await Promise.all(calls);
    const fence = answers[10] as { ok: boolean; storage: { seq: number } };
    expect(fence.ok).toBe(true);
    const writes = answers.filter((_a, index) => index !== 10) as {
      ok: boolean;
      code?: string;
      storage: { seq: number };
    }[];
    for (const write of writes) {
      // A write after the hold carries the epoch before it: stale, then held.
      if (write.ok) expect(write.storage.seq).toBeLessThan(fence.storage.seq);
      else expect(["stale", "held"]).toContain(write.code);
    }
    const landed = writes.filter((write) => write.ok).length;
    expect((await object.view()).durable.documents.size).toBe(landed);
    // Five concurrent copies of one operation: one applies, the others replay.
    const { object: other, base: otherBase } = await withCollection();
    const sent = op(otherBase);
    const copies = await Promise.all(
      Array.from({ length: 5 }, () => other.create(sent, visitor("a"), "items", { n: 1 }, ctx)),
    );
    expect(copies.filter((copy) => copy.ok && "value" in copy)).toHaveLength(1);
    expect(copies.filter((copy) => copy.ok && "replayed" in copy)).toHaveLength(4);
    expect((await other.view()).durable.documents.size).toBe(1);
  });
});

describe("storage failures at the real boundary", () => {
  /** Fails the first statement matching `pattern`, once. */
  async function failOnce(object: RealObject, pattern: RegExp) {
    await object.run((store) => {
      let armed = true;
      store.faults = {
        statement(query) {
          if (!armed || !pattern.test(query)) return false;
          armed = false;
          return true;
        },
      };
    });
  }

  for (const [name, pattern] of [
    ["the document insert", /^INSERT INTO pf_documents/],
    ["the operation record", /^INSERT INTO pf_ops/],
    ["the control record", /^INSERT INTO pf_meta \(key, value\) VALUES \('control'/],
    ["the day counter of the charge", /^INSERT INTO pf_days/],
  ] as const) {
    it(`rolls a write back when ${name} fails, and charges the failed work in its own transaction`, async () => {
      const { object, base } = await withCollection();
      const before = await object.view();
      const growth = before.durable.days.get(dayOf(NOW))?.growth ?? 0;
      await failOnce(object, pattern);
      await expect(object.create(op(base), visitor("a"), "items", { n: 1 }, ctx)).rejects.toThrow(
        /injected storage fault/,
      );
      const after = await object.view();
      expect(after.durable.documents.size).toBe(0);
      expect(after.durable.ops.size).toBe(before.durable.ops.size);
      // The attempt was charged, failed, with its rate row, in the second transaction.
      const failed = after.charges.at(-1);
      expect(failed).toMatchObject({ kind: "create", charge: "growth", failed: true });
      expect(after.durable.days.get(dayOf(NOW))?.growth ?? 0).toBeGreaterThan(growth);
      expect([...after.durable.rates.keys()].some((key) => key.startsWith(visitorId("a")))).toBe(
        true,
      );
      // Every row the cursors measured is accounted for.
      expect(after.accounted()).toBe(after.accesses + 4 * after.counterWrites);
      // The object keeps working.
      value(await object.create(op(base), visitor("a"), "items", { n: 2 }, ctx));
    });
  }

  it("sends nothing when the durable reservation of a live message fails", async () => {
    const { object, base } = await withCollection();
    const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
    await failOnce(object, /^INSERT INTO pf_days/);
    await expect(
      object.message(socket, JSON.stringify({ subscribe: "items" }), NOW),
    ).rejects.toThrow(/injected storage fault/);
    const view = await object.view();
    expect(view.sockets.get(socket)?.received).toEqual([]);
    expect(view.durable.days.get(dayOf(NOW))?.live ?? 0).toBe(0);
  });

  it("sets the alarm again after a failed set that followed a committed write", async () => {
    const object = new RealObject();
    const base = envelope();
    // The binding declaration commits, then its re-arm fails.
    object.recorder.failNextSet = true;
    value(await object.declare(op(base), OWNER, { name: "items", mode: "append" }, ctx));
    expect((await object.view()).durable.collections.size).toBe(1);
    expect(object.recorder.sets).toEqual([]);
    await object.run((store) => expect(store.alarmAt).toBeUndefined());
    // The next command, a read that writes nothing, sets it.
    await object.query(base, OWNER, { collection: "items" }, ctx);
    expect(object.recorder.sets).toHaveLength(1);
    await object.run((store) => expect(store.alarmAt).toBe(object.recorder.alarm));
    expect(object.recorder.alarm).not.toBeNull();
  });
});

describe("query plans", () => {
  /** Statements that may scan: each is bounded by an absolute cap, never by the data. */
  const BOUNDED_SCANS: [RegExp, string][] = [
    [/^SELECT count\(\*\) AS n FROM pf_collections/, "at most MAX_COLLECTIONS rows"],
    [/^SELECT coalesce\(max\(position\), -1\) \+ 1 AS p FROM pf_collections/, "MAX_COLLECTIONS"],
    [
      /^SELECT coalesce\(max\(position\), -1\) \+ 1 AS p FROM pf_fields/,
      "MAX_COLLECTIONS x MAX_INDEXED_FIELDS",
    ],
    [/^SELECT coalesce\(sum\(bytes\), 0\) AS bytes FROM pf_collections/, "MAX_COLLECTIONS"],
    [/^SELECT collection, field, state, cursor, position FROM pf_fields$/, "describe: every field"],
    [/^SELECT name, mode, unique_key, documents, bytes, position FROM pf_collections$/, "describe"],
    [/^DELETE FROM pf_[a-z_]+$/, "a whole erase: protected work measured row by row"],
    [
      /^SELECT (at|window|day) AS age FROM pf_[a-z]+ (WHERE state = 'delivered' )?ORDER BY \1 LIMIT 1$/,
      "the oldest row: the first entry of its age index",
    ],
  ];

  it("runs no statement that scans a table, except the ones an absolute cap bounds", async () => {
    const { object, base } = await withCollection({ mode: "shared", indexed: ["tag"] });
    const seen = await recordStatements(object);
    // Every command kind, every query shape, and the housekeeping paths.
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      ids.push(
        value<{ _id: string }>(
          await object.create(op(base), visitor("a"), "items", { tag: `t${index}` }, ctx),
        )._id,
      );
    }
    value(
      await object.replace(op(base), visitor("b"), "items", ids[0] as string, { tag: "x" }, ctx),
    );
    value(await object.remove(op(base), visitor("a"), "items", ids[1] as string, ctx));
    value(await object.get(base, OWNER, "items", ids[2] as string, ctx));
    for (const query of [
      { collection: "items" },
      { collection: "items", order: "-created" as const, after: encodeCursor(NOW, "zz") },
      { collection: "items", equals: { field: "_by", value: visitorId("a") } },
      { collection: "items", equals: { field: "tag", value: "t2" } },
      { collection: "items", created: { op: "gte" as const, value: NOW } },
    ]) {
      value(await object.query(base, OWNER, query, ctx));
    }
    value(await object.count(base, OWNER, { collection: "items" }, ctx));
    value(await object.count(base, OWNER, { collection: "items", by: visitorId("a") }, ctx));
    value(
      await object.count(
        base,
        OWNER,
        { collection: "items", equals: { field: "tag", value: "t2" } },
        ctx,
      ),
    );
    value(await object.describe(base, OWNER, ctx));
    value(
      await object.bulkCreate(
        op(base),
        OWNER,
        { collection: "items", documents: [{ tag: "b" }] },
        ctx,
      ),
    );
    value(
      await object.bulkReplace(
        op(base),
        OWNER,
        { collection: "items", documents: [{ id: ids[3] as string, body: { tag: "y" } }] },
        ctx,
      ),
    );
    value(await object.bulkRemove(op(base), OWNER, "items", [ids[4] as string], ctx));
    value(
      await object.declare(
        op(base),
        OWNER,
        { name: "items", mode: "shared", indexed: ["tag", "n"] },
        ctx,
      ),
    );
    value(await object.indexStep(op(base), OWNER, ctx));
    value(await object.exportPage(base, OWNER, null, 10, ctx));
    value(await object.exportMine(base, visitor("a"), null, ctx));
    const socket = value(await object.connect(base, visitorId("a"), "grant:a", NOW + 60_000, ctx));
    await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
    await object.renew(base, socket, "grant:a", NOW + 50_000, ctx);
    value(await object.eraseAuthorChunk(op(base), visitorId("a"), 500, ctx));
    const owned = op(base);
    value(await object.create(owned, OWNER, "items", { tag: "o" }, ctx));
    await object.settle(base, "owner:owner", owned.opId as string, NOW);
    await object.acknowledge(base, "owner:owner", owned.opId as string, NOW);
    await object.settle(base, "owner:owner", opId(), NOW);
    await object.alarm(NOW + 10 * DAY);
    const erase = opId(NOW + 10 * DAY);
    value(await object.prepareErase(base, erase, NOW + 10 * DAY));
    value(await object.commitErase(base, erase, NOW + 10 * DAY));
    const plans = await object.run((_store, _instance, state) => {
      const found: { query: string; detail: string }[] = [];
      for (const query of seen) {
        if (!/^(SELECT|INSERT|UPDATE|DELETE)/.test(query)) continue;
        const binds = (query.match(/\?/g) ?? []).map(() => null);
        for (const row of state.storage.sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...binds)) {
          found.push({ query: query.replace(/\s+/g, " "), detail: String(row.detail) });
        }
      }
      return found;
    });
    expect(seen.size).toBeGreaterThan(60);
    const scans = plans.filter(
      (plan) => /\bSCAN\b/.test(plan.detail) && !/SCAN CONSTANT ROW/.test(plan.detail),
    );
    for (const scan of scans) {
      // The oldest row is the first entry of an index leading with its age: `pf_days`'s primary key
      // is its day, so its in-order scan stops at the first row.
      if (/^SELECT (at|window|day) AS age/.test(scan.query)) {
        expect(scan.detail).toMatch(
          /USING (COVERING )?INDEX pf_[a-z]+_(at|window|day|state)|^SCAN pf_days$/,
        );
      }
      expect(
        BOUNDED_SCANS.some(([pattern]) => pattern.test(scan.query)),
        `${scan.query} -> ${scan.detail}`,
      ).toBe(true);
    }
    // The pruning seeks lead with the age index; the erasure seeks lead with the author.
    const detail = (prefix: string) =>
      plans.filter((plan) => plan.query.startsWith(prefix)).map((plan) => plan.detail);
    expect(detail("SELECT key FROM pf_ops WHERE at <").join()).toMatch(/pf_ops_at/);
    expect(detail("SELECT key FROM pf_ops WHERE actor").join()).toMatch(/pf_ops_actor/);
    expect(
      detail("SELECT window FROM pf_rates WHERE window").join() +
        detail("SELECT subject, kind, window FROM pf_rates WHERE window").join(),
    ).toMatch(/pf_rates_window/);
    expect(detail("SELECT author, day FROM pf_rights WHERE day").join()).toMatch(/pf_rights_day/);
    // No statement binds more than the platform's 100 parameters or passes 100 KB.
    for (const query of seen) {
      expect((query.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(query).length).toBeLessThan(100 * 1024);
    }
  });
});

describe("measured costs on real SQLite", () => {
  /** Every operation's measured rows, with its bound, for the record. */
  const MEASURED: Record<string, { rows: number; bound: number }> = {};
  const keep = (
    name: string,
    kind: OperationKind,
    cost: { rowsRead: number; rowsWritten: number },
  ) => {
    const rows = cost.rowsRead + cost.rowsWritten;
    MEASURED[name] = { rows, bound: OPERATION_ROW_BOUNDS[kind] };
    expect(rows, name).toBeLessThanOrEqual(OPERATION_ROW_BOUNDS[kind]);
    return rows;
  };

  it("keeps every query shape at the page plus fixed rows, dense, sparse or empty, whatever the collection holds", async () => {
    const costs: Record<string, number[]> = {};
    for (const size of [500, 4_000]) {
      const { object, base } = await withCollection({ indexed: ["tag"] });
      await bulkFill(object, base, size, (index) => ({
        tag: index < 2 ? "rare" : "common",
        by: index,
      }));
      value(await object.create(op(base), visitor("a"), "items", { tag: "mine" }, ctx));
      const shapes = {
        "created, dense": { collection: "items" },
        "created, descending": { collection: "items", order: "-created" as const },
        "author, sparse": { collection: "items", equals: { field: "_by", value: visitorId("a") } },
        "author, empty": { collection: "items", equals: { field: "_by", value: visitorId("z") } },
        "value, dense": { collection: "items", equals: { field: "tag", value: "common" } },
        "value, sparse": { collection: "items", equals: { field: "tag", value: "rare" } },
        "value, empty": { collection: "items", equals: { field: "tag", value: "none" } },
        "value and range, empty": {
          collection: "items",
          equals: { field: "tag", value: "common" },
          created: { op: "gt" as const, value: NOW },
        },
      };
      for (const [name, shape] of Object.entries(shapes)) {
        const answer = await object.query(base, OWNER, { ...shape, limit: 100 }, ctx);
        const rows = keep(`query ${name} (${size})`, "query", answer.cost);
        const list = costs[name] ?? [];
        list.push(rows);
        costs[name] = list;
      }
    }
    // The same shape costs the same at 500 and 4,000 documents: the seek, not the data, bounds it.
    for (const [name, [small, large]] of Object.entries(costs)) expect(large, name).toBe(small);
  });

  it("measures every operation kind at its largest legal shape within its bound", async () => {
    const limits = { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS };
    const fields = Array.from({ length: MAX_INDEXED_FIELDS }, (_v, index) => `f${index}`);
    const full = (n: number) => Object.fromEntries(fields.map((field) => [field, `${field}-${n}`]));
    const c = context({ limits });
    const { object, base } = await withCollection({ mode: "shared", indexed: fields, limits });
    // Writes with every indexed field, one at a time and in bulk.
    const one = value<{ _id: string }>(await object.create(op(base), OWNER, "items", full(1), c));
    keep("create, 8 indexed fields", "create", (await object.view()).checked.at(-1)?.cost as never);
    value(await object.replace(op(base), OWNER, "items", one._id, full(2), c));
    keep(
      "replace, 8 indexed fields",
      "replace",
      (await object.view()).checked.at(-1)?.cost as never,
    );
    const created = value<{ ids: string[] }>(
      await object.bulkCreate(
        op(base),
        OWNER,
        { collection: "items", documents: Array.from({ length: 100 }, (_v, n) => full(n + 10)) },
        c,
      ),
    );
    keep("bulk create 100", "bulk_create", (await object.view()).checked.at(-1)?.cost as never);
    value(
      await object.bulkReplace(
        op(base),
        OWNER,
        {
          collection: "items",
          documents: created.ids.map((id, n) => ({ id, body: full(n + 500) })),
        },
        c,
      ),
    );
    keep("bulk replace 100", "bulk_replace", (await object.view()).checked.at(-1)?.cost as never);
    value(await object.get(base, OWNER, "items", one._id, c));
    keep("get", "get", (await object.view()).checked.at(-1)?.cost as never);
    value(
      await object.count(
        base,
        OWNER,
        { collection: "items", equals: { field: "f0", value: "f0-2" } },
        c,
      ),
    );
    keep("count by value", "count", (await object.view()).checked.at(-1)?.cost as never);
    value(await object.bulkRemove(op(base), OWNER, "items", created.ids, c));
    keep("bulk remove 100", "bulk_remove", (await object.view()).checked.at(-1)?.cost as never);
    value(await object.remove(op(base), OWNER, "items", one._id, c));
    keep("remove, 8 indexed fields", "remove", (await object.view()).checked.at(-1)?.cost as never);
    // Describe at 32 collections of 8 fields.
    for (let index = 0; index < 31; index++) {
      value(
        await object.declare(
          op(base),
          OWNER,
          { name: `c${index}`, mode: "append", indexed: fields },
          context({ limits: { ...limits, collections: 32 } }),
        ),
      );
    }
    value(await object.describe(base, OWNER, c));
    keep(
      "describe, 32 collections of 8 fields",
      "describe",
      (await object.view()).checked.at(-1)?.cost as never,
    );
    // An index step over 500 documents, and the declaration that starts it.
    const { object: big, base: bigBase } = await withCollection({ limits });
    await bulkFill(big, bigBase, 1_000, (n) => ({ late: `v${n}` }));
    value(
      await big.declare(
        op(bigBase),
        OWNER,
        { name: "items", mode: "append", indexed: ["late"] },
        c,
      ),
    );
    keep(
      "declare with a 500-document step",
      "declare",
      (await big.view()).checked.at(-1)?.cost as never,
    );
    value(await big.indexStep(op(bigBase), OWNER, c));
    keep(
      "index step, 500 documents",
      "index_step",
      (await big.view()).checked.at(-1)?.cost as never,
    );
    // An export page of 500 rows, and of 1 MiB.
    value(await big.exportPage(bigBase, OWNER, null, 500, c));
    keep("export page, 500 rows", "export_page", (await big.view()).checked.at(-1)?.cost as never);
    // An author erasure chunk of 500 documents and their rows.
    const { object: erased, base: erasedBase } = await withCollection({ indexed: ["k"] });
    await bulkFill(erased, erasedBase, 520, (n) => ({ k: `k${n}` }), visitor("gone"));
    value(await erased.eraseAuthorChunk(op(erasedBase), visitorId("gone"), 500, ctx));
    keep(
      "erase author chunk, 500 documents",
      "erase_author_chunk",
      (await erased.view()).checked.at(-1)?.cost as never,
    );
    // A pruning pass over six full retained classes.
    const { object: pruned } = await withCollection();
    const d = dayOf(NOW);
    const seed: SeedRows = { ops: [], ended: [], audit: [], rates: [], days: [], rights: [] };
    for (let i = 0; i < ARTIFACT_DATA.caps.pruneRows; i++) {
      seed.ops?.push([
        `op${i}`,
        {
          actor: "owner:owner",
          requestHash: "h",
          state: "committed",
          kind: "x",
          target: "",
          result: null,
          at: NOW,
        },
      ]);
      seed.ended?.push([`end${i}`, { outcome: "cancelled", at: NOW }]);
      seed.audit?.push([
        `audit${i}`,
        { kind: "x", detail: {}, owner: "owner_a", state: "delivered", at: NOW },
      ]);
      seed.rates?.push([`a${i}\u0000writes\u0000${Math.floor(NOW / 60_000)}`, 1]);
      seed.days?.push(emptyDay(d - 10 - i));
      seed.rights?.push([`a${i}\u0000${d}`, 1]);
    }
    await pruned.seed(seed);
    expect((await pruned.alarm(NOW + 10 * DAY)).pruned).toBe(6 * ARTIFACT_DATA.caps.pruneRows);
    const pass = (await pruned.view()).checked.filter((item) => item.kind === "prune").at(-1);
    keep("prune, six full classes", "prune", pass?.cost as never);
    // The figures for the record (decision 0026, "Implementation notes", delivery 4).
    console.log(JSON.stringify({ measure: "rows_vs_bounds", measured: MEASURED }));
  });

  it("charges a counter write's own statements at most the stated overhead", async () => {
    const { object, base } = await withCollection();
    for (let index = 0; index < 30; index++) {
      value(await object.create(op(base), visitor(`v${index % 3}`), "items", { index }, ctx));
      await object.query(base, visitor("v1"), { collection: "items" }, ctx);
    }
    const doc = value<{ _id: string }>(
      await object.create(op(base), visitor("v1"), "items", {}, ctx),
    );
    value(await object.remove(op(base), visitor("v1"), "items", doc._id, ctx));
    await object.flushReads(NOW + DAY);
    const meters = object.recorder.instrument;
    expect(meters.counterWrites).toBeGreaterThan(30);
    expect(meters.bookkeeping).toBeLessThanOrEqual(4 * meters.counterWrites);
  });
});

describe("cold start", () => {
  it("reads one metadata row on a wake, never a scan of sqlite_schema", async () => {
    const { object, base } = await withCollection();
    value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
    await object.hibernate();
    expect(object.recorder.instrument.coldStarts.at(-1)).toBe(1);
    const plan = await object.run((_store, _instance, state) =>
      [...state.storage.sql.exec(`EXPLAIN QUERY PLAN ${SCHEMA_PROBE}`)].map((row) =>
        String(row.detail),
      ),
    );
    expect(plan.join()).toMatch(/SEARCH pf_meta/);
    // The wake's row is accounted for, as deferred protected work.
    const view = await object.view();
    expect(view.accounted()).toBe(view.accesses + 4 * view.counterWrites);
  });

  it("creates nothing on an object no write bound: a read leaves it empty", async () => {
    const object = new RealObject();
    expect(
      await object.query(envelope(), visitor("a"), { collection: "items" }, ctx),
    ).toMatchObject({
      ok: true,
      value: { documents: [] },
    });
    expect(await object.exportPage(envelope(), OWNER, null, 10, ctx)).toMatchObject({ ok: true });
    const tables = await object.run((store, _instance, state) => {
      expect(store.meters.coldStarts[0]).toBe(0);
      return [...state.storage.sql.exec("SELECT name FROM sqlite_schema WHERE name LIKE 'pf_%'")];
    });
    expect(tables).toEqual([]);
  });
});

describe("the alarm scheduler", () => {
  async function follow(object: RealObject, until: number) {
    let wakes = 0;
    for (let at = (await object.view()).durable.alarm; at !== null && at < until; ) {
      await object.alarm(at);
      wakes += 1;
      at = (await object.view()).durable.alarm;
    }
    return wakes;
  }

  it("wakes twice for 120 writes spread over an hour (delivery 2 measured 241 wakes)", async () => {
    const { object, base } = await withCollection();
    for (let index = 0; index < 120; index++) {
      const at = NOW + index * 30_000;
      value(
        await object.create(
          op(base, at),
          visitor(`v${index % 7}`),
          "items",
          { index },
          context({ now: at }),
        ),
      );
    }
    // Retention wakes once the next day and once when the day counters expire.
    expect(await follow(object, NOW + 10 * DAY)).toBe(2);
    const view = await object.view();
    expect(view.durable.ops.size + view.durable.rates.size + view.durable.days.size).toBe(0);
    expect(view.durable.alarm).toBeNull();
  });

  it("prunes everything due when an alarm runs late, does nothing more when it runs twice, and nothing under a hold that came after it was set", async () => {
    const { object, base } = await withCollection();
    value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
    await object.flushReads(NOW + 31_000);
    const due = (await object.view()).durable.alarm as number;
    expect(due).toBeGreaterThan(NOW + DAY);
    // Late by five hours: one pass prunes all that is due.
    const late = await object.alarm(due + 5 * HOUR);
    expect(late.pruned).toBeGreaterThan(0);
    // The same alarm again: idempotent.
    expect((await object.alarm(due + 5 * HOUR)).pruned).toBe(0);
    // A hold after the alarm was set: the handler re-admits and prunes nothing.
    const { object: held, base: heldBase } = await withCollection();
    value(await held.create(op(heldBase), visitor("a"), "items", { n: 1 }, ctx));
    await held.flushReads(NOW + 31_000);
    const scheduled = (await held.view()).durable.alarm as number;
    value(
      await held.fence({ ...heldBase, epoch: 1 }, { kind: "hold", transition: "h" }, NOW + 40_000),
    );
    const rows = (await held.view()).durable.ops.size;
    expect((await held.alarm(scheduled)).pruned).toBe(0);
    expect((await held.view()).durable.ops.size).toBe(rows);
    expect((await held.view()).durable.alarm).toBeNull();
  });

  it("sets the platform's alarm through the object's own scheduler, and the handler runs it", async () => {
    const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName("platform-alarm"));
    const now = Date.now();
    await runInDurableObject(stub, async (instance, state) => {
      const base = envelope();
      value(
        instance.store.declare(
          op(base, now),
          OWNER,
          { name: "items", mode: "append" },
          context({ now }),
        ),
      );
      value(instance.store.create(op(base, now), visitor("a"), "items", {}, context({ now })));
      const at = await state.storage.getAlarm();
      expect(at).toBe(instance.store.alarmAt);
      expect(at).toBeGreaterThan(now);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});

describe("hibernation", () => {
  it("serializes every changed attachment within its size and rebuilds connections on a wake", async () => {
    const limits = { ...ROOMY, collections: 32 };
    const { object, base } = await withCollection({ limits });
    const names = Array.from({ length: ARTIFACT_DATA.live.subscriptions }, (_v, index) =>
      `c${index}_${"x".repeat(26)}`.slice(0, 32),
    );
    for (const name of names) {
      value(await object.declare(op(base), OWNER, { name, mode: "append" }, context({ limits })));
    }
    const socket = value(
      await object.connect(
        base,
        visitorId("a".repeat(16)),
        "grant:".padEnd(200, "p"),
        NOW + 60_000,
        ctx,
      ),
    );
    // The largest attachment: every subscription, four a minute, renewed each minute.
    for (const [index, name] of names.entries()) {
      const at = NOW + Math.floor(index / 4) * 60_000;
      if (index % 4 === 0 && index > 0) {
        expect(
          await object.renew(
            base,
            socket,
            "grant:".padEnd(200, "p"),
            at + 60_000,
            context({ now: at }),
          ),
        ).toBe(true);
      }
      await object.message(socket, JSON.stringify({ subscribe: name }), at);
    }
    const stored = await object.run((_store, _instance, state) =>
      state.getWebSockets().map((ws) => ws.deserializeAttachment() as { subscriptions: string[] }),
    );
    expect(stored[0]?.subscriptions).toEqual(names);
    expect(new TextEncoder().encode(JSON.stringify(stored[0])).length).toBeLessThan(
      ATTACHMENT_BYTES,
    );
    await object.hibernate();
    const view = await object.view();
    expect(view.sockets.get(socket)?.attachment.subscriptions).toEqual(names);
    expect(view.sockets.get(socket)?.closed).toBeNull();
    // After the wake the connection still hears changes, and its deadline still closes it.
    const last = NOW + 4 * 60_000;
    const heard = view.sockets.get(socket)?.received.length ?? 0;
    value(
      await object.create(
        op(base, last),
        OWNER,
        names[0] as string,
        { n: 1 },
        context({ limits, now: last }),
      ),
    );
    expect((await object.view()).sockets.get(socket)?.received.length).toBe(heard + 1);
    await object.message(socket, JSON.stringify({ subscribe: "items" }), last + 60_000);
    expect((await object.view()).sockets.get(socket)?.closed).toBe(4001);
  });

  for (const [name, change] of [
    [
      "a transfer",
      (o: RealObject, b: DataEnvelope) =>
        o.fence({ ...b, epoch: 1 }, { kind: "transfer", toOwner: "owner_b", transition: "m" }, NOW),
    ],
    [
      "an epoch fence",
      (o: RealObject, b: DataEnvelope) =>
        o.fence({ ...b, epoch: 1 }, { kind: "epoch", transition: "e" }, NOW),
    ],
    [
      "a quarantine adopted",
      async (o: RealObject, b: DataEnvelope) => {
        await o.quarantine(b, "owner", NOW);
        return o.resolveQuarantine(b, "adopt", NOW);
      },
    ],
  ] as const) {
    it(`refuses a connection whose close was lost at ${name}, after a wake`, async () => {
      const { object, base } = await withCollection();
      const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
      object.recorder.dropCloses = true;
      expect((await change(object, base)).ok).toBe(true);
      object.recorder.dropCloses = false;
      // The close never reached the socket: after a wake the runtime hands it back, open.
      await object.hibernate();
      const woken = (await object.view()).sockets.get(socket);
      expect(woken?.closed).toBeNull();
      const heard = woken?.received.length;
      // Its next message re-admits against the persisted live epoch and closes it.
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW + 1_000);
      const after = (await object.view()).sockets.get(socket);
      expect(after?.closed).toBe(4003);
      expect(after?.received.length).toBe(heard);
    });
  }
});

describe("payload-only erase", () => {
  it("deletes the payload and keeps every control record, the schema and the alarm, atomically with the next generation", async () => {
    const { object, base } = await withCollection({ indexed: ["k"] });
    await bulkFill(object, base, 3_000, (n) => ({ k: `k${n % 50}`, text: "x".repeat(200) }));
    value(await object.create(op(base), visitor("a"), "items", { k: "a" }, ctx));
    value(await object.eraseAuthorChunk(op(base), visitorId("gone"), 10, ctx));
    const owned = op(base);
    value(await object.create(owned, OWNER, "items", { k: "o" }, ctx));
    const cancelled = opId();
    value(await object.prepareErase(base, cancelled, NOW));
    value(await object.cancelErase(base, cancelled, NOW));
    const before = await object.view();
    const alarm = before.durable.alarm;
    const id = opId();
    value(await object.prepareErase(base, id, NOW));
    const committed = await object.commitErase(base, id, NOW);
    expect(committed).toMatchObject({ ok: true, value: { outcome: "committed" } });
    // Measured row by row: at least one row of work for each payload row.
    expect(committed.cost.rowsRead + committed.cost.rowsWritten).toBeGreaterThanOrEqual(3_002);
    const after = await object.view();
    for (const table of [
      "documents",
      "collections",
      "authorCounts",
      "valueCounts",
      "seq",
      "ops",
    ] as const) {
      expect(after.durable[table].size, table).toBe(0);
    }
    expect(after.durable.fields).toEqual([]);
    expect(after.durable.control?.generation).toBe(1);
    expect([...after.durable.barriers.keys()]).toEqual([visitorId("gone")]);
    expect(after.durable.audit.size).toBe(before.durable.audit.size);
    expect([...after.durable.ended.keys()].sort()).toEqual([cancelled, id].sort());
    expect(after.durable.days.size).toBeGreaterThan(0);
    expect(after.durable.rights.size).toBe(before.durable.rights.size);
    expect(after.durable.rates.size).toBe(before.durable.rates.size);
    expect(after.durable.alarm).not.toBeNull();
    expect(alarm).not.toBeNull();
    const schema = await object.run((store) => store.inspect("pf_meta").map((row) => row.key));
    expect(schema.sort()).toEqual(["control", "schema"]);
    // The next generation works, and a late write of the old one is stale.
    expect(await object.create(op(base), visitor("a"), "items", {}, ctx)).toMatchObject({
      code: "stale",
    });
  });
});

describe("platform limits", () => {
  it("refuses limits the platform cannot hold, whatever plan sends them", async () => {
    const { object, base } = await withCollection();
    const impossible = context({ limits: { ...ROOMY, documentBytes: MAX_DOCUMENT_BYTES + 1 } });
    expect(await object.create(op(base), OWNER, "items", { n: 1 }, impossible)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(await object.query(base, OWNER, { collection: "items" }, impossible)).toMatchObject({
      code: "invalid_input",
    });
    expect(await object.exportPage(base, OWNER, null, 1, impossible)).toMatchObject({
      code: "invalid_input",
    });
    expect(await object.connect(base, null, "reader", NOW + 1_000, impossible)).toMatchObject({
      code: "invalid_input",
    });
  });

  it("stores the largest legal document with every indexed field, and exports it in a page of one", async () => {
    const limits = {
      ...ROOMY,
      documentBytes: MAX_DOCUMENT_BYTES,
      indexedFields: MAX_INDEXED_FIELDS,
    };
    const fields = Array.from({ length: MAX_INDEXED_FIELDS }, (_v, index) => `f${index}`);
    const { object, base } = await withCollection({ indexed: fields, limits });
    const body: Record<string, unknown> = Object.fromEntries(
      fields.map((field) => [field, "v".repeat(250)]),
    );
    const overhead = new TextEncoder().encode(JSON.stringify({ ...body, pad: "" })).length;
    body.pad = "p".repeat(MAX_DOCUMENT_BYTES - overhead);
    const c = context({ limits });
    const doc = value<{ _id: string }>(await object.create(op(base), OWNER, "items", body, c));
    value(await object.create(op(base), OWNER, "items", { f0: "small" }, c));
    const page = value<{ rows: unknown[]; next: unknown }>(
      await object.exportPage(base, OWNER, null, 500, c),
    );
    expect(page.rows).toHaveLength(1);
    expect(page.next).not.toBeNull();
    expect(value<{ _id: string }>(await object.get(base, OWNER, "items", doc._id, c))._id).toBe(
      doc._id,
    );
    // One byte more is refused before any write.
    expect(
      await object.create(op(base), OWNER, "items", { ...body, pad: `${body.pad as string}p` }, c),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
  });
});

describe("file size and headroom", () => {
  it("refuses growth by the measured file after the whole transaction, and keeps protected writes possible at the cap", async () => {
    const limits = { ...ROOMY, bytesPerArtifact: 300_000 };
    const c = context({ limits });
    const { object, base } = await withCollection({ indexed: ["k"], limits });
    let refused: { ok: boolean; code?: string } | null = null;
    for (let index = 0; index < 2_000; index++) {
      const answer = await object.create(
        op(base),
        visitor(`v${index % 40}`),
        "items",
        { k: `k${index}`, text: "t".repeat(400) },
        c,
      );
      if (!answer.ok) {
        refused = answer;
        break;
      }
    }
    expect(refused).toMatchObject({ ok: false, code: "quota_exceeded" });
    const at = await object.view();
    expect(at.fileBytes()).toBeLessThanOrEqual(
      limits.bytesPerArtifact + ARTIFACT_DATA.controlReserveBytes,
    );
    // Protected and shrinking work goes through on a full artifact: a barrier, an erase intent,
    // a fence, a delete.
    value(await object.eraseAuthorChunk(op(base), visitorId("v1"), 500, c));
    const id = opId();
    value(await object.prepareErase(base, id, NOW));
    value(await object.cancelErase(base, id, NOW));
    value(await object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "e" }, NOW));
    expect((await object.view()).fileBytes()).toBeLessThanOrEqual(
      limits.bytesPerArtifact + ARTIFACT_DATA.controlReserveBytes,
    );
  });
});

export type { DocumentsStore };
