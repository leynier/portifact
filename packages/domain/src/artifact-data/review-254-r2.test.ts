// The second code review of pull request #254 (B1 to B4, S1 to S4): its counterexamples F01 to F11 as written,
// except where a decision on the review changed the rule (F07, F11; see their comments).

import {
  ARTIFACT_DATA,
  MAX_COLLECTIONS,
  MAX_INDEXED_FIELDS,
  REQUIRED_ERASES,
} from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import {
  context,
  envelope,
  NOW,
  OWNER,
  op,
  opId,
  READER,
  ROOMY,
  value,
  visitor,
  visitorId,
} from "../testing/artifact-data-fixtures.ts";
import { authorTraces, MemoryObject, orphanValueCounts } from "../testing/artifact-data-object.ts";
import {
  COUNTER_WRITE_ROWS,
  dayOf,
  emptyDay,
  OPERATION_ROW_BOUNDS,
  RETAINED_CLASSES,
  withinBound,
} from "./index.ts";

const DAY = 86400000;
const ctx = context();
function fixture(mode: "own" | "append" | "shared" | "read" = "own", indexed: string[] = []) {
  const o = new MemoryObject();
  const e = envelope();
  value(o.declare(op(e), OWNER, { name: "items", mode, indexed }, ctx));
  return { o, e };
}
describe("independent round two counterexamples", () => {
  it("F01 bulk replacement must honor every creators terminal barrier", () => {
    const { o, e } = fixture("shared");
    value(o.create(op(e), visitor("a"), "items", { n: 1 }, ctx));
    const doc = value<{ _id: string }>(o.create(op(e), visitor("a"), "items", { n: 2 }, ctx));
    value(o.eraseAuthorChunk(op(e), visitorId("a"), 1, ctx));
    expect(o.replace(op(e), OWNER, "items", doc._id, { n: 3 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(
      o.bulkReplace(
        op(e),
        OWNER,
        { collection: "items", documents: [{ id: doc._id, body: { n: 3 } }] },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
  });
  it("F02 a declaration building an index over 500 existing documents stays within its cap", () => {
    const { o, e } = fixture("append");
    for (let batch = 0; batch < 5; batch++)
      value(
        o.bulkCreate(
          op(e),
          OWNER,
          { collection: "items", documents: Array.from({ length: 100 }, () => ({ f: 1 })) },
          ctx,
        ),
      );
    const answer = o.declare(op(e), OWNER, { name: "items", mode: "append", indexed: ["f"] }, ctx);
    expect(answer.ok).toBe(true);
    expect(withinBound("declare", answer.cost), JSON.stringify(answer.cost)).toBe(true);
  });
  it("F03 erased documents leave no indexed body values in zero-count rows", () => {
    const { o, e } = fixture("own", ["secret"]);
    value(o.create(op(e), visitor("a"), "items", { secret: "private-value" }, ctx));
    const erased = value<{ more: boolean }>(o.eraseAuthorChunk(op(e), visitorId("a"), 500, ctx));
    expect(erased.more).toBe(false);
    expect(o.durable.documents.size).toBe(0);
    expect([...o.durable.valueCounts.keys()].filter((k) => k.includes("private-value"))).toEqual(
      [],
    );
  });
  it("F04 a midnight alarm must not lose its deferred pruning usage", () => {
    const { o, e } = fixture();
    const at = (dayOf(NOW) + 4) * DAY - 10000;
    o.alarm(at);
    const deferred = o.pending.deferred;
    expect(deferred).toBeGreaterThan(0);
    value(o.query(e, visitor("a"), { collection: "items" }, context({ now: at })));
    o.alarm(at + ARTIFACT_DATA.readFlush.ms);
    const recorded =
      [...o.durable.days.values()].reduce((s, d) => s + d.protected, 0) + o.pending.deferred;
    expect(recorded).toBeGreaterThanOrEqual(deferred);
  });
  it("F05 pre-work refusals must consume the callers minute allowance", () => {
    const { o, e } = fixture();
    const c = context({
      limits: { ...ROOMY, readsPerCallerPerMinute: 2, writesPerAuthorPerMinute: 2 },
    });
    for (let i = 0; i < 2; i++)
      expect(o.create(op(e), visitor("a", false), "items", {}, c)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    // The allowance is the caller's minute (`readsPerCallerPerMinute`), shared with reads: the
    // refusals spent it, so the next attempt of any kind is refused, with no durable row per refusal.
    expect(o.create(op(e), visitor("a", false), "items", {}, c)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(o.query(e, visitor("a"), { collection: "items" }, c)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });
  it("F06 completed author erasure removes the new author-associated rights rows", () => {
    const { o, e } = fixture();
    value(o.exportMine(e, visitor("a", false), null, ctx));
    value(o.eraseAuthorChunk(op(e), visitorId("a"), 500, ctx));
    expect(o.durable.barriers.get(visitorId("a"))?.complete).toBe(true);
    expect([...o.durable.rights.keys()].filter((k) => k.startsWith(visitorId("a") + "\0"))).toEqual(
      [],
    );
  });
  // F07 as decided: a required erase (purge, account or workspace deletion) says so in its trusted
  // envelope and is never rate limited; an optional owner reset still is.
  it("F07 exhausting voluntary erase intents must not block a required lifecycle erasure", () => {
    const { o, e } = fixture();
    for (let i = 0; i < 20; i++) {
      const id = opId();
      value(o.prepareErase(e, id, NOW));
      value(o.cancelErase(e, id, NOW));
    }
    expect(o.prepareErase(e, opId(), NOW)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(o.prepareErase({ ...e, requiredErase: "purge" }, opId(), NOW)).toMatchObject({
      ok: true,
      value: { outcome: "prepared" },
    });
  });
  it("F08 one pruning pass across six full retained classes stays within its cap", () => {
    const { o } = fixture();
    const d = dayOf(NOW);
    // Model a long-held object released after old records accumulated. Every row is legal.
    o.durable.ops.clear();
    o.durable.audit.clear();
    o.durable.days.clear();
    for (let i = 0; i < 500; i++) {
      o.durable.ops.set("op" + i, {
        actor: "owner:owner",
        requestHash: "h",
        state: "committed",
        kind: "x",
        target: "",
        result: null,
        at: NOW,
      });
      o.durable.ended.set("end" + i, { outcome: "cancelled", at: NOW - i * DAY });
      o.durable.audit.set("audit" + i, {
        kind: "x",
        detail: {},
        owner: "owner_a",
        state: "delivered",
        at: NOW,
      });
      o.durable.rates.set(`a${i}\0writes\0${Math.floor(NOW / 60000)}`, 1);
      o.durable.days.set(d - i, {
        day: d - i,
        growth: 0,
        read: 0,
        cleanup: 0,
        export: 0,
        rights: 0,
        protected: 0,
        live: 0,
        refused: 0,
        intents: 0,
      });
      o.durable.rights.set(`a${i}\0${d}`, 1);
    }
    expect(o.alarm(NOW + 10 * DAY).pruned).toBe(3000);
    expect(o.checked.length).toBeGreaterThan(0);
    expect(o.checked.every((item) => withinBound(item.kind, item.cost))).toBe(true);
  });
});

it("F09 erasure-job replays use protected accounting, not the public read allowance", () => {
  const o = new MemoryObject(),
    e = envelope(),
    ctx = context();
  value(o.declare(op(e), OWNER, { name: "items", mode: "own" }, ctx));
  const sent = op(e);
  value(o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx));
  const readBefore = o.durable.days.get(dayOf(NOW))!.read + o.pending.rows;
  const answer = o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx);
  expect(answer).toMatchObject({ ok: true, replayed: {} });
  expect(o.durable.days.get(dayOf(NOW))!.read + o.pending.rows).toBe(readBefore);
});
it("F10 an alarm flush accounts for its own counter and control-row writes", () => {
  const o = new MemoryObject(),
    e = envelope(),
    ctx = context();
  value(o.declare(op(e), OWNER, { name: "items", mode: "own" }, ctx));
  value(o.query(e, OWNER, { collection: "items" }, ctx));
  const beforeAccounted = o.accounted(),
    beforeAccesses = o.accesses;
  o.alarm(NOW + 30000);
  expect(o.pending.rows).toBe(0);
  // A day counter was updated and the control storage sequence was written.
  expect(o.accounted() - beforeAccounted).toBeGreaterThanOrEqual(2);
  expect(o.accesses - beforeAccesses).toBeGreaterThanOrEqual(2);
});

// F11 as decided: the declaration's bound is corrected (B3), so the failure is within it; what
// the test keeps is that a failure after work is checked against its operation's bound.
it("F11 failures after work still check the operation row bound", () => {
  const { o, e } = fixture("append");
  for (let b = 0; b < 5; b++)
    value(
      o.bulkCreate(
        op(e),
        OWNER,
        { collection: "items", documents: Array.from({ length: 100 }, () => ({ f: 1 })) },
        ctx,
      ),
    );
  o.faults.afterWork = (k) => k === "declare";
  const answer = o.declare(op(e), OWNER, { name: "items", mode: "append", indexed: ["f"] }, ctx);
  expect(answer).toMatchObject({ ok: false, code: "conflict" });
  expect(withinBound("declare", answer.cost)).toBe(true);
  expect(o.checked.some((item) => item.kind === "declare" && item.failed)).toBe(true);
});

// The decisions on the second review, each beyond its counterexample.
describe("decisions on the second review of PR 254", () => {
  const FIELDS = Array.from({ length: MAX_INDEXED_FIELDS }, (_, i) => `f${i}`);
  const DENSE = context({
    limits: { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS, collections: MAX_COLLECTIONS },
  });
  const full = (n: number) => Object.fromEntries(FIELDS.map((f) => [f, `${f}-${n}`]));
  const exact = (o: MemoryObject) =>
    expect(o.accounted()).toBe(o.accesses + COUNTER_WRITE_ROWS * o.counterWrites);

  it("B1: bulk commands authorize every target as the single command does, all or nothing", () => {
    const { o, e } = fixture("shared");
    const kept = value<{ _id: string }>(o.create(op(e), visitor("b"), "items", { n: 1 }, ctx));
    value(o.create(op(e), visitor("a"), "items", { n: 2 }, ctx));
    value(o.create(op(e), visitor("a"), "items", { n: 3 }, ctx));
    // One chunk of one: the creator is barred and one of their documents is left.
    value(o.eraseAuthorChunk(op(e), visitorId("a"), 1, ctx));
    const gone = {
      _id: [...o.durable.documents.values()].find((doc) => doc.author === visitorId("a"))!.id,
    };
    const before = structuredClone([...o.durable.documents.entries()]);
    // One barred target, wherever it stands, refuses the whole replacement.
    for (const ids of [[gone._id], [kept._id, gone._id], [gone._id, kept._id]]) {
      expect(
        o.bulkReplace(
          op(e),
          OWNER,
          { collection: "items", documents: ids.map((id) => ({ id, body: { n: 9 } })) },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "conflict" });
    }
    // A missing target refuses the whole removal: before, it was skipped.
    expect(o.bulkRemove(op(e), OWNER, "items", [kept._id, "missing"], ctx)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect([...o.durable.documents.entries()]).toEqual(before);
    // The owner may remove a barred creator's document, singly or in bulk, as the single rule says.
    expect(value(o.bulkRemove(op(e), OWNER, "items", [kept._id, gone._id], ctx))).toEqual({
      removed: 2,
    });
    exact(o);
  });

  it("B2: a value-count row goes when its count reaches zero, and no indexed value outlives its document", () => {
    const { o, e } = fixture("shared", ["tag"]);
    const counts = () => Object.fromEntries(o.durable.valueCounts);
    const one = value<{ _id: string }>(o.create(op(e), OWNER, "items", { tag: "x" }, ctx));
    const two = value<{ _id: string }>(o.create(op(e), OWNER, "items", { tag: "x" }, ctx));
    expect(Object.values(counts())).toEqual([2]);
    value(o.remove(op(e), OWNER, "items", one._id, ctx)); // one of several
    expect(Object.values(counts())).toEqual([1]);
    value(o.replace(op(e), OWNER, "items", two._id, { tag: "y" }, ctx)); // replacement
    expect(Object.keys(counts()).join()).not.toContain("x");
    value(o.remove(op(e), OWNER, "items", two._id, ctx)); // the last reference
    expect(o.durable.valueCounts.size).toBe(0);
    // An index built over existing documents, then a bulk removal.
    value(o.declare(op(e), OWNER, { name: "late", mode: "append" }, ctx));
    const ids = value<{ ids: string[] }>(
      o.bulkCreate(op(e), OWNER, { collection: "late", documents: [{ k: 1 }, { k: 1 }] }, ctx),
    ).ids;
    value(o.declare(op(e), OWNER, { name: "late", mode: "append", indexed: ["k"] }, ctx));
    expect(o.durable.valueCounts.size).toBe(1);
    expect(orphanValueCounts(o)).toBe(0);
    value(o.bulkRemove(op(e), OWNER, "late", ids, ctx));
    expect(o.durable.valueCounts.size).toBe(0);
    // Author erasure.
    value(o.create(op(e), visitor("a"), "items", { tag: "secret" }, ctx));
    const size = o.fileBytes();
    value(o.eraseAuthorChunk(op(e), visitorId("a"), 500, ctx));
    expect(o.durable.valueCounts.size).toBe(0);
    expect(authorTraces(o, visitorId("a")).orphanValues).toBe(0);
    // The modelled file shrinks by the value-count row with the document.
    expect(o.fileBytes()).toBeLessThan(size);
    exact(o);
  });

  it("B3: every operation kind at its densest legal shape stays within its bound", () => {
    const seen = new Set<string>();
    const o = new MemoryObject();
    const e = envelope();
    value(o.declare(op(e), OWNER, { name: "big", mode: "shared" }, DENSE));
    for (let batch = 0; batch < 6; batch++)
      value(
        o.bulkCreate(
          op(e),
          OWNER,
          {
            collection: "big",
            documents: Array.from({ length: 100 }, (_, i) => full(batch * 100 + i)),
          },
          DENSE,
        ),
      );
    // A declaration that builds eight indexes over its first step, then the rest of the build.
    value(o.declare(op(e), OWNER, { name: "big", mode: "shared", indexed: FIELDS }, DENSE));
    while (value(o.indexStep(op(e), OWNER, DENSE)).building > 0) {
      // until built
    }
    const ids = value<{ ids: string[] }>(
      o.bulkCreate(
        op(e),
        OWNER,
        { collection: "big", documents: Array.from({ length: 100 }, (_, i) => full(1_000 + i)) },
        DENSE,
      ),
    ).ids;
    value(
      o.bulkReplace(
        op(e),
        OWNER,
        {
          collection: "big",
          documents: ids.map((id, i) => ({ id, body: full(2_000 + i) })),
        },
        DENSE,
      ),
    );
    const one = value<{ _id: string }>(o.create(op(e), OWNER, "big", full(3_000), DENSE));
    value(o.replace(op(e), OWNER, "big", one._id, full(3_001), DENSE));
    value(o.get(e, OWNER, "big", one._id, DENSE));
    value(o.query(e, OWNER, { collection: "big", limit: 100 }, DENSE));
    value(
      o.query(
        e,
        OWNER,
        { collection: "big", equals: { field: "f0", value: "f0-1" }, limit: 100 },
        DENSE,
      ),
    );
    value(o.count(e, OWNER, { collection: "big", equals: { field: "f1", value: "f1-1" } }, DENSE));
    value(o.remove(op(e), OWNER, "big", one._id, DENSE));
    value(o.bulkRemove(op(e), OWNER, "big", ids, DENSE));
    value(o.exportPage(e, OWNER, null, ARTIFACT_DATA.caps.exportRows, DENSE));
    for (let c = 1; c < MAX_COLLECTIONS; c++)
      value(o.declare(op(e), OWNER, { name: `c${c}`, mode: "shared", indexed: FIELDS }, DENSE));
    value(o.describe(e, OWNER, DENSE));
    // An author with a full chunk: documents with eight values, edits, rights rows, rates.
    const author = visitor("dense");
    for (let i = 0; i < ARTIFACT_DATA.caps.eraseChunkDocuments; i++)
      value(o.create(op(e), author, "c1", full(i), DENSE));
    value(
      o.replace(
        op(e),
        author,
        "big",
        value<{ documents: { _id: string }[] }>(
          o.query(e, OWNER, { collection: "big", limit: 1 }, DENSE),
        ).documents[0]!._id,
        full(9),
        DENSE,
      ),
    );
    value(o.exportMine(e, author, null, DENSE));
    value(o.eraseAuthorChunk(op(e), visitorId("dense"), 500, DENSE));
    for (const item of o.checked) seen.add(item.kind);
    // Pruning: six full retained classes (F08's shape).
    const pruned = fixture().o;
    const d = dayOf(NOW);
    for (let i = 0; i < ARTIFACT_DATA.caps.pruneRows; i++) {
      pruned.durable.ops.set(`op${i}`, {
        actor: "owner:owner",
        requestHash: "h",
        state: "committed",
        kind: "x",
        target: "",
        result: null,
        at: NOW,
      });
      pruned.durable.ended.set(`end${i}`, { outcome: "cancelled", at: NOW });
      pruned.durable.audit.set(`audit${i}`, {
        kind: "x",
        detail: {},
        owner: "owner_a",
        state: "delivered",
        at: NOW,
      });
      pruned.durable.rates.set(`a${i}\0writes\0${Math.floor(NOW / 60000)}`, 1);
      pruned.durable.days.set(d - 10 - i, { ...emptyDay(d - 10 - i) });
      pruned.durable.rights.set(`a${i}\0${d}`, 1);
    }
    expect(pruned.alarm(NOW + 10 * DAY).pruned).toBe(
      RETAINED_CLASSES.length * ARTIFACT_DATA.caps.pruneRows,
    );
    for (const item of pruned.checked) seen.add(item.kind);
    expect([...seen].sort()).toEqual(Object.keys(OPERATION_ROW_BOUNDS).sort());
    for (const item of [...o.checked, ...pruned.checked])
      expect(withinBound(item.kind, item.cost), `${item.kind} ${JSON.stringify(item.cost)}`).toBe(
        true,
      );
    exact(o);
  });

  it("B3: a measured cost past its bound fails the operation (negative control)", () => {
    const { o, e } = fixture("shared");
    const doc = value<{ _id: string }>(o.create(op(e), OWNER, "items", { n: 1 }, ctx));
    o.rowBounds.get = 1;
    expect(() => o.get(e, OWNER, "items", doc._id, ctx)).toThrow(
      /get measured \d+ rows, past its bound/,
    );
    o.rowBounds.remove = 1;
    expect(() => o.remove(op(e), OWNER, "items", doc._id, ctx)).toThrow(/past its bound/);
    expect(o.durable.documents.has(`items\0${doc._id}`) || o.durable.documents.size === 1).toBe(
      true,
    );
  });

  it("B4 and N1: what was charged equals what the store saw plus the counter writes' overhead", () => {
    const { o, e } = fixture("shared");
    value(o.create(op(e), visitor("a"), "items", { n: 1 }, ctx));
    exact(o);
    value(o.query(e, visitor("a"), { collection: "items" }, ctx));
    exact(o);
    o.alarm(NOW + ARTIFACT_DATA.readFlush.ms); // a flush: its bookkeeping lands under protected
    exact(o);
    const days = o.durable.days.size;
    for (let i = 1; i <= 4; i++) o.alarm(NOW + i * DAY); // idle alarms across midnight
    expect(o.durable.days.size).toBeLessThanOrEqual(days);
    expect(o.pending.deferred).toBeGreaterThan(0);
    exact(o);
    // The next eligible counter write takes the deferred usage, in today's row.
    const deferred = o.pending.deferred;
    value(
      o.create(op(e, NOW + 4 * DAY), OWNER, "items", { n: 2 }, context({ now: NOW + 4 * DAY })),
    );
    expect(o.durable.days.get(dayOf(NOW + 4 * DAY))?.protected).toBeGreaterThanOrEqual(deferred);
    exact(o);
  });

  it("M21: repeated and refused control commands meter their lookups exactly", () => {
    const o = new MemoryObject();
    const held = envelope({ epoch: 1 });
    value(o.declare(op(envelope()), OWNER, { name: "items", mode: "own" }, ctx));
    value(o.fence(held, { kind: "hold", transition: "t" }, NOW));
    for (const repeat of [
      () => o.fence(held, { kind: "hold", transition: "t" }, NOW),
      () => o.fence(held, { kind: "release", transition: "other" }, NOW),
      () => o.quarantine(envelope({ ownerId: "someone" }), "owner", NOW),
    ]) {
      const refusals = () =>
        o.pending.refused + [...o.durable.days.values()].reduce((sum, day) => sum + day.refused, 0);
      const accounted = o.accounted();
      const writes = o.counterWrites;
      const refused = refusals();
      const seen = o.accesses;
      const answer = repeat();
      expect(o.accesses).toBeGreaterThan(seen);
      // Each lookup is accounted for exactly, with any flush it caused at its stated overhead.
      expect(o.accounted() - accounted).toBe(
        o.accesses - seen + COUNTER_WRITE_ROWS * (o.counterWrites - writes),
      );
      expect(refusals() - refused).toBe(answer.ok ? 0 : 1);
      exact(o);
    }
  });

  it("S1: a caller who spent the minute on refusals is refused next, with no durable row", () => {
    const { o, e } = fixture("read");
    const limits = { ...ROOMY, readsPerCallerPerMinute: 3 };
    const c = context({ limits });
    const rows = () => o.durable.rates.size + o.durable.days.size + o.durable.ops.size;
    const before = rows();
    for (let i = 0; i < 3; i++)
      expect(o.create(op(e), visitor("a"), "items", { n: i }, c)).toMatchObject({
        code: "forbidden",
      });
    expect(o.create(op(e), visitor("a"), "items", { n: 9 }, c)).toMatchObject({
      code: "rate_limited",
    });
    expect(o.get(e, visitor("a"), "items", "x", c)).toMatchObject({ code: "rate_limited" });
    expect(o.create(op(e), READER, "items", { n: 9 }, c)).toMatchObject({ code: "forbidden" });
    expect(rows()).toBe(before);
    expect(o.pending.refused).toBeGreaterThanOrEqual(4);
  });

  it("S2: author erasure deletes the author's rights rows in bounded steps counted in more", () => {
    const { o, e } = fixture();
    value(o.exportMine(e, visitor("a", false), null, ctx));
    value(o.exportMine(e, visitor("a", false), null, context({ now: NOW + DAY })));
    expect(authorTraces(o, visitorId("a")).rights).toBe(2);
    let steps = 0;
    for (;;) {
      steps += 1;
      const chunk = value<{ more: boolean }>(o.eraseAuthorChunk(op(e), visitorId("a"), 1, ctx));
      if (!chunk.more) break;
      // Not complete while a rights row is left.
      expect(o.durable.barriers.get(visitorId("a"))?.complete).toBe(false);
    }
    expect(steps).toBeGreaterThanOrEqual(2);
    expect(authorTraces(o, visitorId("a")).rights).toBe(0);
    expect(o.durable.barriers.get(visitorId("a"))?.complete).toBe(true);
    // Aggregate accounting stays: the day rows still hold the rights rows charged.
    expect(o.durable.days.get(dayOf(NOW))?.rights).toBeGreaterThan(0);
  });

  it("S3: only a required erase passes the daily gate, only from its trusted envelope", () => {
    const { o, e } = fixture();
    const ended = opId();
    value(o.prepareErase(e, ended, NOW));
    value(o.cancelErase(e, ended, NOW));
    for (let i = 0; i < 18; i++) {
      const id = opId();
      value(o.prepareErase(e, id, NOW));
      value(o.cancelErase(e, id, NOW));
    }
    const kept = opId();
    value(o.prepareErase(e, kept, NOW)); // the twentieth
    // An existing or ended ID is not a new intent.
    expect(o.prepareErase(e, kept, NOW)).toMatchObject({ ok: true });
    expect(o.prepareErase(e, ended, NOW)).not.toMatchObject({ code: "rate_limited" });
    value(o.cancelErase(e, kept, NOW));
    expect(o.prepareErase(e, opId(), NOW)).toMatchObject({ code: "rate_limited" });
    expect(o.prepareErase(e, kept, NOW)).not.toMatchObject({ code: "rate_limited" });
    for (const requiredErase of REQUIRED_ERASES) {
      const id = opId();
      expect(o.prepareErase({ ...e, requiredErase }, id, NOW)).toMatchObject({ ok: true });
      value(o.cancelErase(e, id, NOW));
    }
    // A caller cannot claim the reason through the document API.
    expect(o.create({ ...op(e), requiredErase: "purge" }, OWNER, "items", {}, ctx)).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "a document command cannot carry an erase reason",
    });
    expect(o.get({ ...e, requiredErase: "purge" }, OWNER, "items", "x", ctx)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("S4: an erasure job's replay is protected work with no repeated effect; others stay reads", () => {
    const { o, e } = fixture();
    const sent = op(e);
    value(o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx));
    const day = () => o.durable.days.get(dayOf(NOW))!;
    const before = { ...day() };
    const charges = o.charges.length;
    expect(o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx)).toMatchObject({ replayed: {} });
    expect(day().cleanup).toBe(before.cleanup);
    expect(day().read).toBe(before.read);
    expect(day().protected).toBeGreaterThan(before.protected);
    expect(o.charges.slice(charges).map((c) => c.charge)).toEqual(["protected"]);
    // An ordinary replay is a budgeted read.
    const create = op(e);
    value(o.create(create, visitor("a"), "items", { n: 1 }, ctx));
    const rows = o.pending.rows;
    expect(o.create(create, visitor("a"), "items", { n: 1 }, ctx)).toMatchObject({ replayed: {} });
    expect(o.pending.rows).toBeGreaterThan(rows);
    exact(o);
  });
});
