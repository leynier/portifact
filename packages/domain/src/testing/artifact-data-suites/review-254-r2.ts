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
  COUNTER_WRITE_ROWS,
  dayOf,
  emptyDay,
  OPERATION_ROW_BOUNDS,
  RETAINED_CLASSES,
  withinBound,
} from "../../artifact-data/index.ts";
import type { DataObject, MakeObject, SeedRows } from "../artifact-data-driver.ts";
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
} from "../artifact-data-fixtures.ts";
import { authorTraces, orphanValueCounts } from "../artifact-data-object.ts";

export function review254R2Suite(make: MakeObject): void {
  const DAY = 86400000;
  const ctx = context();
  async function fixture(
    mode: "own" | "append" | "shared" | "read" = "own",
    indexed: string[] = [],
  ) {
    const o = await make();
    const e = envelope();
    value(await o.declare(op(e), OWNER, { name: "items", mode, indexed }, ctx));
    return { o, e };
  }
  describe("independent round two counterexamples", () => {
    it("F01 bulk replacement must honor every creators terminal barrier", async () => {
      const { o, e } = await fixture("shared");
      value(await o.create(op(e), visitor("a"), "items", { n: 1 }, ctx));
      const doc = value<{ _id: string }>(
        await o.create(op(e), visitor("a"), "items", { n: 2 }, ctx),
      );
      value(await o.eraseAuthorChunk(op(e), visitorId("a"), 1, ctx));
      expect(await o.replace(op(e), OWNER, "items", doc._id, { n: 3 }, ctx)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(
        await o.bulkReplace(
          op(e),
          OWNER,
          { collection: "items", documents: [{ id: doc._id, body: { n: 3 } }] },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "conflict" });
    });
    it("F02 a declaration building an index over 500 existing documents stays within its cap", async () => {
      const { o, e } = await fixture("append");
      for (let batch = 0; batch < 5; batch++)
        value(
          await o.bulkCreate(
            op(e),
            OWNER,
            { collection: "items", documents: Array.from({ length: 100 }, () => ({ f: 1 })) },
            ctx,
          ),
        );
      const answer = await o.declare(
        op(e),
        OWNER,
        { name: "items", mode: "append", indexed: ["f"] },
        ctx,
      );
      expect(answer.ok).toBe(true);
      expect(withinBound("declare", answer.cost), JSON.stringify(answer.cost)).toBe(true);
    });
    it("F03 erased documents leave no indexed body values in zero-count rows", async () => {
      const { o, e } = await fixture("own", ["secret"]);
      value(await o.create(op(e), visitor("a"), "items", { secret: "private-value" }, ctx));
      const erased = value<{ more: boolean }>(
        await o.eraseAuthorChunk(op(e), visitorId("a"), 500, ctx),
      );
      expect(erased.more).toBe(false);
      expect((await o.view()).durable.documents.size).toBe(0);
      expect(
        [...(await o.view()).durable.valueCounts.keys()].filter((k) => k.includes("private-value")),
      ).toEqual([]);
    });
    it("F04 a midnight alarm must not lose its deferred pruning usage", async () => {
      const { o, e } = await fixture();
      const at = (dayOf(NOW) + 4) * DAY - 10000;
      await o.alarm(at);
      const deferred = (await o.view()).pending.deferred;
      expect(deferred).toBeGreaterThan(0);
      value(await o.query(e, visitor("a"), { collection: "items" }, context({ now: at })));
      await o.alarm(at + ARTIFACT_DATA.readFlush.ms);
      const recorded =
        [...(await o.view()).durable.days.values()].reduce((s, d) => s + d.protected, 0) +
        (await o.view()).pending.deferred;
      expect(recorded).toBeGreaterThanOrEqual(deferred);
    });
    it("F05 pre-work refusals must consume the callers minute allowance", async () => {
      const { o, e } = await fixture();
      const c = context({
        limits: { ...ROOMY, readsPerCallerPerMinute: 2, writesPerAuthorPerMinute: 2 },
      });
      for (let i = 0; i < 2; i++)
        expect(await o.create(op(e), visitor("a", false), "items", {}, c)).toMatchObject({
          ok: false,
          code: "forbidden",
        });
      // The allowance is the caller's minute (`readsPerCallerPerMinute`), shared with reads: the
      // refusals spent it, so the next attempt of any kind is refused, with no durable row per refusal.
      expect(await o.create(op(e), visitor("a", false), "items", {}, c)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      expect(await o.query(e, visitor("a"), { collection: "items" }, c)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
    });
    it("F06 completed author erasure removes the new author-associated rights rows", async () => {
      const { o, e } = await fixture();
      value(await o.exportMine(e, visitor("a", false), null, ctx));
      value(await o.eraseAuthorChunk(op(e), visitorId("a"), 500, ctx));
      expect((await o.view()).durable.barriers.get(visitorId("a"))?.complete).toBe(true);
      expect(
        [...(await o.view()).durable.rights.keys()].filter((k) =>
          k.startsWith(visitorId("a") + "\0"),
        ),
      ).toEqual([]);
    });
    // F07 as decided: a required erase (purge, account or workspace deletion) says so in its trusted
    // envelope and is never rate limited; an optional owner reset still is.
    it("F07 exhausting voluntary erase intents must not block a required lifecycle erasure", async () => {
      const { o, e } = await fixture();
      for (let i = 0; i < 20; i++) {
        const id = opId();
        value(await o.prepareErase(e, id, NOW));
        value(await o.cancelErase(e, id, NOW));
      }
      expect(await o.prepareErase(e, opId(), NOW)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      expect(await o.prepareErase({ ...e, requiredErase: "purge" }, opId(), NOW)).toMatchObject({
        ok: true,
        value: { outcome: "prepared" },
      });
    });
    it("F08 one pruning pass across six full retained classes stays within its cap", async () => {
      const { o } = await fixture();
      const d = dayOf(NOW);
      // Model a long-held object released after old records accumulated. Every row is legal.
      const seed: SeedRows = {
        clear: ["ops", "audit", "days"],
        ops: [],
        ended: [],
        audit: [],
        rates: [],
        days: [],
        rights: [],
      };
      for (let i = 0; i < 500; i++) {
        seed.ops?.push([
          "op" + i,
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
        seed.ended?.push(["end" + i, { outcome: "cancelled", at: NOW - i * DAY }]);
        seed.audit?.push([
          "audit" + i,
          {
            kind: "x",
            detail: {},
            owner: "owner_a",
            state: "delivered",
            at: NOW,
          },
        ]);
        seed.rates?.push([`a${i}\0writes\0${Math.floor(NOW / 60000)}`, 1]);
        seed.days?.push({ ...emptyDay(d - i) });
        seed.rights?.push([`a${i}\0${d}`, 1]);
      }
      await o.seed(seed);
      expect((await o.alarm(NOW + 10 * DAY)).pruned).toBe(3000);
      expect((await o.view()).checked.length).toBeGreaterThan(0);
      expect((await o.view()).checked.every((item) => withinBound(item.kind, item.cost))).toBe(
        true,
      );
    });
  });

  it("F09 erasure-job replays use protected accounting, not the public read allowance", async () => {
    const o = await make(),
      e = envelope(),
      ctx = context();
    value(await o.declare(op(e), OWNER, { name: "items", mode: "own" }, ctx));
    const sent = op(e);
    value(await o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx));
    const readBefore =
      (await o.view()).durable.days.get(dayOf(NOW))!.read + (await o.view()).pending.rows;
    const answer = await o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx);
    expect(answer).toMatchObject({ ok: true, replayed: {} });
    expect(
      (await o.view()).durable.days.get(dayOf(NOW))!.read + (await o.view()).pending.rows,
    ).toBe(readBefore);
  });
  it("F10 an alarm flush accounts for its own counter and control-row writes", async () => {
    const o = await make(),
      e = envelope(),
      ctx = context();
    value(await o.declare(op(e), OWNER, { name: "items", mode: "own" }, ctx));
    value(await o.query(e, OWNER, { collection: "items" }, ctx));
    const beforeAccounted = (await o.view()).accounted(),
      beforeAccesses = (await o.view()).accesses;
    await o.alarm(NOW + 30000);
    expect((await o.view()).pending.rows).toBe(0);
    // A day counter was updated and the control storage sequence was written.
    expect((await o.view()).accounted() - beforeAccounted).toBeGreaterThanOrEqual(2);
    expect((await o.view()).accesses - beforeAccesses).toBeGreaterThanOrEqual(2);
  });

  // F11 as decided: the declaration's bound is corrected (B3), so the failure is within it; what
  // the test keeps is that a failure after work is checked against its operation's bound.
  it("F11 failures after work still check the operation row bound", async () => {
    const { o, e } = await fixture("append");
    for (let b = 0; b < 5; b++)
      value(
        await o.bulkCreate(
          op(e),
          OWNER,
          { collection: "items", documents: Array.from({ length: 100 }, () => ({ f: 1 })) },
          ctx,
        ),
      );
    await o.setFaults({ afterWork: (k) => k === "declare" });
    const answer = await o.declare(
      op(e),
      OWNER,
      { name: "items", mode: "append", indexed: ["f"] },
      ctx,
    );
    expect(answer).toMatchObject({ ok: false, code: "conflict" });
    expect(withinBound("declare", answer.cost)).toBe(true);
    expect((await o.view()).checked.some((item) => item.kind === "declare" && item.failed)).toBe(
      true,
    );
  });

  // The decisions on the second review, each beyond its counterexample.
  describe("decisions on the second review of PR 254", () => {
    const FIELDS = Array.from({ length: MAX_INDEXED_FIELDS }, (_, i) => `f${i}`);
    const DENSE = context({
      limits: { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS, collections: MAX_COLLECTIONS },
    });
    const full = (n: number) => Object.fromEntries(FIELDS.map((f) => [f, `${f}-${n}`]));
    const exact = async (o: DataObject) =>
      expect((await o.view()).accounted()).toBe(
        (await o.view()).accesses + COUNTER_WRITE_ROWS * (await o.view()).counterWrites,
      );

    it("B1: bulk commands authorize every target as the single command does, all or nothing", async () => {
      const { o, e } = await fixture("shared");
      const kept = value<{ _id: string }>(
        await o.create(op(e), visitor("b"), "items", { n: 1 }, ctx),
      );
      value(await o.create(op(e), visitor("a"), "items", { n: 2 }, ctx));
      value(await o.create(op(e), visitor("a"), "items", { n: 3 }, ctx));
      // One chunk of one: the creator is barred and one of their documents is left.
      value(await o.eraseAuthorChunk(op(e), visitorId("a"), 1, ctx));
      const gone = {
        _id: [...(await o.view()).durable.documents.values()].find(
          (doc) => doc.author === visitorId("a"),
        )!.id,
      };
      const before = structuredClone([...(await o.view()).durable.documents.entries()]);
      // One barred target, wherever it stands, refuses the whole replacement.
      for (const ids of [[gone._id], [kept._id, gone._id], [gone._id, kept._id]]) {
        expect(
          await o.bulkReplace(
            op(e),
            OWNER,
            { collection: "items", documents: ids.map((id) => ({ id, body: { n: 9 } })) },
            ctx,
          ),
        ).toMatchObject({ ok: false, code: "conflict" });
      }
      // A missing target refuses the whole removal: before, it was skipped.
      expect(await o.bulkRemove(op(e), OWNER, "items", [kept._id, "missing"], ctx)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect([...(await o.view()).durable.documents.entries()]).toEqual(before);
      // The owner may remove a barred creator's document, singly or in bulk, as the single rule says.
      expect(value(await o.bulkRemove(op(e), OWNER, "items", [kept._id, gone._id], ctx))).toEqual({
        removed: 2,
      });
      await exact(o);
    });

    it("B2: a value-count row goes when its count reaches zero, and no indexed value outlives its document", async () => {
      const { o, e } = await fixture("shared", ["tag"]);
      const counts = async () => Object.fromEntries((await o.view()).durable.valueCounts);
      const one = value<{ _id: string }>(await o.create(op(e), OWNER, "items", { tag: "x" }, ctx));
      const two = value<{ _id: string }>(await o.create(op(e), OWNER, "items", { tag: "x" }, ctx));
      expect(Object.values(await counts())).toEqual([2]);
      value(await o.remove(op(e), OWNER, "items", one._id, ctx)); // one of several
      expect(Object.values(await counts())).toEqual([1]);
      value(await o.replace(op(e), OWNER, "items", two._id, { tag: "y" }, ctx)); // replacement
      expect(Object.keys(await counts()).join()).not.toContain("x");
      value(await o.remove(op(e), OWNER, "items", two._id, ctx)); // the last reference
      expect((await o.view()).durable.valueCounts.size).toBe(0);
      // An index built over existing documents, then a bulk removal.
      value(await o.declare(op(e), OWNER, { name: "late", mode: "append" }, ctx));
      const ids = value<{ ids: string[] }>(
        await o.bulkCreate(
          op(e),
          OWNER,
          { collection: "late", documents: [{ k: 1 }, { k: 1 }] },
          ctx,
        ),
      ).ids;
      value(await o.declare(op(e), OWNER, { name: "late", mode: "append", indexed: ["k"] }, ctx));
      expect((await o.view()).durable.valueCounts.size).toBe(1);
      expect(orphanValueCounts(await o.view())).toBe(0);
      value(await o.bulkRemove(op(e), OWNER, "late", ids, ctx));
      expect((await o.view()).durable.valueCounts.size).toBe(0);
      // Author erasure.
      value(await o.create(op(e), visitor("a"), "items", { tag: "secret" }, ctx));
      const size = (await o.view()).fileBytes();
      value(await o.eraseAuthorChunk(op(e), visitorId("a"), 500, ctx));
      expect((await o.view()).durable.valueCounts.size).toBe(0);
      expect(authorTraces(await o.view(), visitorId("a")).orphanValues).toBe(0);
      // The modelled file shrinks by the value-count row with the document.
      // The reference counts every row at a fixed size; real SQLite frees whole pages, so the file
      // shrinks there only when a page empties (apps/data's storage tests measure it).
      if (o.kind === "memory") expect((await o.view()).fileBytes()).toBeLessThan(size);
      else expect((await o.view()).fileBytes()).toBeLessThanOrEqual(size);
      await exact(o);
    });

    it("B3: every operation kind at its densest legal shape stays within its bound", async () => {
      const seen = new Set<string>();
      const o = await make();
      const e = envelope();
      value(await o.declare(op(e), OWNER, { name: "big", mode: "shared" }, DENSE));
      for (let batch = 0; batch < 6; batch++)
        value(
          await o.bulkCreate(
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
      value(await o.declare(op(e), OWNER, { name: "big", mode: "shared", indexed: FIELDS }, DENSE));
      while (value(await o.indexStep(op(e), OWNER, DENSE)).building > 0) {
        // until built
      }
      const ids = value<{ ids: string[] }>(
        await o.bulkCreate(
          op(e),
          OWNER,
          { collection: "big", documents: Array.from({ length: 100 }, (_, i) => full(1_000 + i)) },
          DENSE,
        ),
      ).ids;
      value(
        await o.bulkReplace(
          op(e),
          OWNER,
          {
            collection: "big",
            documents: ids.map((id, i) => ({ id, body: full(2_000 + i) })),
          },
          DENSE,
        ),
      );
      const one = value<{ _id: string }>(await o.create(op(e), OWNER, "big", full(3_000), DENSE));
      value(await o.replace(op(e), OWNER, "big", one._id, full(3_001), DENSE));
      value(await o.get(e, OWNER, "big", one._id, DENSE));
      value(await o.query(e, OWNER, { collection: "big", limit: 100 }, DENSE));
      value(
        await o.query(
          e,
          OWNER,
          { collection: "big", equals: { field: "f0", value: "f0-1" }, limit: 100 },
          DENSE,
        ),
      );
      value(
        await o.count(
          e,
          OWNER,
          { collection: "big", equals: { field: "f1", value: "f1-1" } },
          DENSE,
        ),
      );
      value(await o.remove(op(e), OWNER, "big", one._id, DENSE));
      value(await o.bulkRemove(op(e), OWNER, "big", ids, DENSE));
      value(await o.exportPage(e, OWNER, null, ARTIFACT_DATA.caps.exportRows, DENSE));
      for (let c = 1; c < MAX_COLLECTIONS; c++)
        value(
          await o.declare(op(e), OWNER, { name: `c${c}`, mode: "shared", indexed: FIELDS }, DENSE),
        );
      value(await o.describe(e, OWNER, DENSE));
      // An author with a full chunk: documents with eight values, edits, rights rows, rates.
      const author = visitor("dense");
      for (let i = 0; i < ARTIFACT_DATA.caps.eraseChunkDocuments; i++)
        value(await o.create(op(e), author, "c1", full(i), DENSE));
      value(
        await o.replace(
          op(e),
          author,
          "big",
          value<{ documents: { _id: string }[] }>(
            await o.query(e, OWNER, { collection: "big", limit: 1 }, DENSE),
          ).documents[0]!._id,
          full(9),
          DENSE,
        ),
      );
      value(await o.exportMine(e, author, null, DENSE));
      value(await o.eraseAuthorChunk(op(e), visitorId("dense"), 500, DENSE));
      for (const item of (await o.view()).checked) seen.add(item.kind);
      // Pruning: six full retained classes (F08's shape).
      const pruned = (await fixture()).o;
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
          {
            kind: "x",
            detail: {},
            owner: "owner_a",
            state: "delivered",
            at: NOW,
          },
        ]);
        seed.rates?.push([`a${i}\0writes\0${Math.floor(NOW / 60000)}`, 1]);
        seed.days?.push({ ...emptyDay(d - 10 - i) });
        seed.rights?.push([`a${i}\0${d}`, 1]);
      }
      await pruned.seed(seed);
      expect((await pruned.alarm(NOW + 10 * DAY)).pruned).toBe(
        RETAINED_CLASSES.length * ARTIFACT_DATA.caps.pruneRows,
      );
      for (const item of (await pruned.view()).checked) seen.add(item.kind);
      expect([...seen].sort()).toEqual(Object.keys(OPERATION_ROW_BOUNDS).sort());
      for (const item of [...(await o.view()).checked, ...(await pruned.view()).checked])
        expect(withinBound(item.kind, item.cost), `${item.kind} ${JSON.stringify(item.cost)}`).toBe(
          true,
        );
      await exact(o);
    });

    it("B3: a measured cost past its bound fails the operation (negative control)", async () => {
      const { o, e } = await fixture("shared");
      const doc = value<{ _id: string }>(await o.create(op(e), OWNER, "items", { n: 1 }, ctx));
      await o.setRowBounds({ get: 1 });
      await expect(async () => await o.get(e, OWNER, "items", doc._id, ctx)).rejects.toThrow(
        /get measured \d+ rows, past its bound/,
      );
      await o.setRowBounds({ remove: 1 });
      await expect(async () => await o.remove(op(e), OWNER, "items", doc._id, ctx)).rejects.toThrow(
        /past its bound/,
      );
      expect(
        (await o.view()).durable.documents.has(`items\0${doc._id}`) ||
          (await o.view()).durable.documents.size === 1,
      ).toBe(true);
    });

    it("B4 and N1: what was charged equals what the store saw plus the counter writes' overhead", async () => {
      const { o, e } = await fixture("shared");
      value(await o.create(op(e), visitor("a"), "items", { n: 1 }, ctx));
      await exact(o);
      value(await o.query(e, visitor("a"), { collection: "items" }, ctx));
      await exact(o);
      await o.alarm(NOW + ARTIFACT_DATA.readFlush.ms); // a flush: its bookkeeping lands under protected
      await exact(o);
      const days = (await o.view()).durable.days.size;
      for (let i = 1; i <= 4; i++) await o.alarm(NOW + i * DAY); // idle alarms across midnight
      expect((await o.view()).durable.days.size).toBeLessThanOrEqual(days);
      expect((await o.view()).pending.deferred).toBeGreaterThan(0);
      await exact(o);
      // The next eligible counter write takes the deferred usage, in today's row.
      const deferred = (await o.view()).pending.deferred;
      value(
        await o.create(
          op(e, NOW + 4 * DAY),
          OWNER,
          "items",
          { n: 2 },
          context({ now: NOW + 4 * DAY }),
        ),
      );
      expect(
        (await o.view()).durable.days.get(dayOf(NOW + 4 * DAY))?.protected,
      ).toBeGreaterThanOrEqual(deferred);
      await exact(o);
    });

    it("M21: repeated and refused control commands meter their lookups exactly", async () => {
      const o = await make();
      const held = envelope({ epoch: 1 });
      value(await o.declare(op(envelope()), OWNER, { name: "items", mode: "own" }, ctx));
      value(await o.fence(held, { kind: "hold", transition: "t" }, NOW));
      for (const repeat of [
        async () => await o.fence(held, { kind: "hold", transition: "t" }, NOW),
        async () => await o.fence(held, { kind: "release", transition: "other" }, NOW),
        async () => await o.quarantine(envelope({ ownerId: "someone" }), "owner", NOW),
      ]) {
        const refusals = async () =>
          (await o.view()).pending.refused +
          [...(await o.view()).durable.days.values()].reduce((sum, day) => sum + day.refused, 0);
        const accounted = (await o.view()).accounted();
        const writes = (await o.view()).counterWrites;
        const refused = await refusals();
        const seen = (await o.view()).accesses;
        const answer = await repeat();
        // The reference reads the control record for every lookup; the real object keeps the
        // control record it last read or wrote, so a repeat may read nothing at all.
        if (o.kind === "memory") expect((await o.view()).accesses).toBeGreaterThan(seen);
        // Each lookup is accounted for exactly, with any flush it caused at its stated overhead.
        expect((await o.view()).accounted() - accounted).toBe(
          (await o.view()).accesses -
            seen +
            COUNTER_WRITE_ROWS * ((await o.view()).counterWrites - writes),
        );
        expect((await refusals()) - refused).toBe(answer.ok ? 0 : 1);
        await exact(o);
      }
    });

    it("S1: a caller who spent the minute on refusals is refused next, with no durable row", async () => {
      const { o, e } = await fixture("read");
      const limits = { ...ROOMY, readsPerCallerPerMinute: 3 };
      const c = context({ limits });
      const rows = async () =>
        (await o.view()).durable.rates.size +
        (await o.view()).durable.days.size +
        (await o.view()).durable.ops.size;
      const before = await rows();
      for (let i = 0; i < 3; i++)
        expect(await o.create(op(e), visitor("a"), "items", { n: i }, c)).toMatchObject({
          code: "forbidden",
        });
      expect(await o.create(op(e), visitor("a"), "items", { n: 9 }, c)).toMatchObject({
        code: "rate_limited",
      });
      expect(await o.get(e, visitor("a"), "items", "x", c)).toMatchObject({ code: "rate_limited" });
      expect(await o.create(op(e), READER, "items", { n: 9 }, c)).toMatchObject({
        code: "forbidden",
      });
      expect(await rows()).toBe(before);
      expect((await o.view()).pending.refused).toBeGreaterThanOrEqual(4);
    });

    it("S2: author erasure deletes the author's rights rows in bounded steps counted in more", async () => {
      const { o, e } = await fixture();
      value(await o.exportMine(e, visitor("a", false), null, ctx));
      value(await o.exportMine(e, visitor("a", false), null, context({ now: NOW + DAY })));
      expect(authorTraces(await o.view(), visitorId("a")).rights).toBe(2);
      let steps = 0;
      for (;;) {
        steps += 1;
        const chunk = value<{ more: boolean }>(
          await o.eraseAuthorChunk(op(e), visitorId("a"), 1, ctx),
        );
        if (!chunk.more) break;
        // Not complete while a rights row is left.
        expect((await o.view()).durable.barriers.get(visitorId("a"))?.complete).toBe(false);
      }
      expect(steps).toBeGreaterThanOrEqual(2);
      expect(authorTraces(await o.view(), visitorId("a")).rights).toBe(0);
      expect((await o.view()).durable.barriers.get(visitorId("a"))?.complete).toBe(true);
      // Aggregate accounting stays: the day rows still hold the rights rows charged.
      expect((await o.view()).durable.days.get(dayOf(NOW))?.rights).toBeGreaterThan(0);
    });

    it("S3: only a required erase passes the daily gate, only from its trusted envelope", async () => {
      const { o, e } = await fixture();
      const ended = opId();
      value(await o.prepareErase(e, ended, NOW));
      value(await o.cancelErase(e, ended, NOW));
      for (let i = 0; i < 18; i++) {
        const id = opId();
        value(await o.prepareErase(e, id, NOW));
        value(await o.cancelErase(e, id, NOW));
      }
      const kept = opId();
      value(await o.prepareErase(e, kept, NOW)); // the twentieth
      // An existing or ended ID is not a new intent.
      expect(await o.prepareErase(e, kept, NOW)).toMatchObject({ ok: true });
      expect(await o.prepareErase(e, ended, NOW)).not.toMatchObject({ code: "rate_limited" });
      value(await o.cancelErase(e, kept, NOW));
      expect(await o.prepareErase(e, opId(), NOW)).toMatchObject({ code: "rate_limited" });
      expect(await o.prepareErase(e, kept, NOW)).not.toMatchObject({ code: "rate_limited" });
      for (const requiredErase of REQUIRED_ERASES) {
        const id = opId();
        expect(await o.prepareErase({ ...e, requiredErase }, id, NOW)).toMatchObject({ ok: true });
        value(await o.cancelErase(e, id, NOW));
      }
      // A caller cannot claim the reason through the document API.
      expect(
        await o.create({ ...op(e), requiredErase: "purge" }, OWNER, "items", {}, ctx),
      ).toMatchObject({
        ok: false,
        code: "invalid_input",
        message: "a document command cannot carry an erase reason",
      });
      expect(await o.get({ ...e, requiredErase: "purge" }, OWNER, "items", "x", ctx)).toMatchObject(
        {
          ok: false,
          code: "invalid_input",
        },
      );
    });

    it("S4: an erasure job's replay is protected work with no repeated effect; others stay reads", async () => {
      const { o, e } = await fixture();
      const sent = op(e);
      value(await o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx));
      const day = async () => (await o.view()).durable.days.get(dayOf(NOW))!;
      const before = { ...(await day()) };
      const charges = (await o.view()).charges.length;
      expect(await o.eraseAuthorChunk(sent, visitorId("gone"), 500, ctx)).toMatchObject({
        replayed: {},
      });
      expect((await day()).cleanup).toBe(before.cleanup);
      expect((await day()).read).toBe(before.read);
      expect((await day()).protected).toBeGreaterThan(before.protected);
      expect((await o.view()).charges.slice(charges).map((c) => c.charge)).toEqual(["protected"]);
      // An ordinary replay is a budgeted read.
      const create = op(e);
      value(await o.create(create, visitor("a"), "items", { n: 1 }, ctx));
      const rows = (await o.view()).pending.rows;
      expect(await o.create(create, visitor("a"), "items", { n: 1 }, ctx)).toMatchObject({
        replayed: {},
      });
      expect((await o.view()).pending.rows).toBeGreaterThan(rows);
      await exact(o);
    });
  });
}
