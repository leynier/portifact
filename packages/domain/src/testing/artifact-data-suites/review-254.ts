// The independent code review of pull request #254 (R01 to R11), its reproductions as written.

import { ARTIFACT_DATA, MAX_INDEXED_FIELDS } from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import {
  batched,
  bulkBodies,
  dayOf,
  operationKey,
  planCount,
  reconcile,
  reconcile as reconcileAgain,
  valueCountDeltas,
  withinBound,
} from "../../artifact-data/index.ts";
import type { DataObject, MakeObject } from "../artifact-data-driver.ts";
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
import { rows } from "../artifact-data-object.ts";

export function review254Suite(make: MakeObject): void {
  const ctx = context();
  async function fixture(mode: "own" | "append" | "shared" = "own") {
    const o = await make();
    const e = envelope();
    value(await o.declare(op(e), OWNER, { name: "items", mode }, ctx));
    return { o, e };
  }

  describe("second review of PR 254: reproductions", () => {
    it("R01: a first request must not consume a pending hold epoch", async () => {
      const o = await make();
      const e = envelope({ epoch: 1 });
      value(await o.declare(op(e), OWNER, { name: "items", mode: "own" }, ctx));
      expect(await o.fence(e, { kind: "hold", transition: "pending_hold" }, NOW)).toMatchObject({
        ok: true,
      });
      expect(await o.create(op(e), visitor("a"), "items", {}, ctx)).toMatchObject({
        ok: false,
        code: "held",
      });
    });
    it("R02: a prepared erase must remain resumable after the operation horizon", async () => {
      const { o, e } = await fixture();
      const id = opId();
      value(await o.create(op(e), visitor("a"), "items", {}, ctx));
      value(await o.prepareErase(e, id, NOW));
      const later = NOW + ARTIFACT_DATA.replayMs + 1;
      expect(
        reconcile(
          { ownerId: e.ownerId, generation: 0, epoch: 0, held: false },
          (await o.view()).durable.control,
        ),
      ).toMatchObject({ action: "resume_erase", eraseId: id });
      expect(await o.commitErase({ ...e, epoch: 1 }, id, later)).toMatchObject({
        ok: true,
        value: { outcome: "committed" },
      });
    });
    it("R03a: read refusals charge their measured lookup work", async () => {
      const { o, e } = await fixture();
      const before = (await o.view()).pending.rows;
      const answer = await o.get(e, visitor("a"), "items", "xxxxxxxxxxxxxxxx", ctx);
      expect(answer).toMatchObject({ ok: false, code: "not_found" });
      expect((await o.view()).pending.rows - before).toBeGreaterThanOrEqual(answer.cost.rowsRead);
    });
    it("R03b: pre-work mutation refusals charge their measured lookup work", async () => {
      const { o, e } = await fixture();
      const before = (await o.view()).pending.rows;
      const answer = await o.create(op(e), visitor("a", false), "items", {}, ctx);
      expect(answer).toMatchObject({ ok: false, code: "forbidden" });
      expect((await o.view()).pending.rows - before).toBeGreaterThanOrEqual(answer.cost.rowsRead);
    });
    // R03c as decided by the maintainer: quarantine cleanup is protected work, measured with real
    // counts under the protected class, which draws on no visitor's or owner's allowance.
    it("R03c: quarantine erasure is charged, by its measured rows, to the protected class", async () => {
      const { o, e } = await fixture();
      value(await o.create(op(e), visitor("a"), "items", {}, ctx));
      value(await o.quarantine(e, "orphan", NOW));
      const state = (await o.view()).durable;
      const before = state.days.get(dayOf(NOW))!.protected;
      // Every payload row is measured as it goes: at least one row of work for each.
      const payload =
        state.documents.size +
        state.collections.size +
        state.fields.length +
        state.authorCounts.size +
        state.valueCounts.size +
        state.seq.size +
        state.ops.size;
      const answer = await o.resolveQuarantine(e, "erase", NOW);
      expect(answer.ok).toBe(true);
      expect(
        (await o.view()).durable.days.get(dayOf(NOW))!.protected - before,
      ).toBeGreaterThanOrEqual(answer.cost.rowsRead + answer.cost.rowsWritten);
      expect(answer.cost.rowsRead + answer.cost.rowsWritten).toBeGreaterThanOrEqual(payload);
    });
    it("R04a: repeated operations obey the read budget once lookup work spends it", async () => {
      const { o, e } = await fixture();
      const sent = op(e);
      value(await o.create(sent, visitor("a"), "items", {}, ctx));
      const limited = context({ limits: { ...ROOMY, rowsReadPerDay: 1 } });
      await o.create(sent, visitor("a"), "items", {}, limited);
      expect(await o.create(sent, visitor("a"), "items", {}, limited)).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
    });
    it("R04b: replay-only traffic cannot lose more than the read flush bound on eviction", async () => {
      const { o, e } = await fixture();
      const sent = op(e);
      value(await o.create(sent, visitor("a"), "items", {}, ctx));
      await o.createMany(sent, visitor("a"), "items", {}, ctx, 2600);
      expect((await o.view()).pending.rows).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
    });
    it("R05a: the first pending read schedules the 30-second flush", async () => {
      const { o, e } = await fixture();
      value(await o.query(e, visitor("a"), { collection: "items" }, ctx));
      expect((await o.view()).durable.alarm).toBeLessThanOrEqual(NOW + ARTIFACT_DATA.readFlush.ms);
    });
    it("R05b: UTC midnight persists the previous days pending reads", async () => {
      const midnight = (dayOf(NOW) + 1) * 86400000;
      const o = await make();
      const e = envelope();
      value(
        await o.declare(
          op(e, midnight - 2),
          OWNER,
          { name: "items", mode: "own" },
          context({ now: midnight - 2 }),
        ),
      );
      value(
        await o.query(e, visitor("a"), { collection: "items" }, context({ now: midnight - 1 })),
      );
      const pending = (await o.view()).pending.rows;
      await o.flushReads(midnight);
      expect((await o.view()).durable.days.get(dayOf(NOW))!.read).toBeGreaterThanOrEqual(pending);
    });
    it("R06: one visitors export cannot exhaust another visitors own rights", async () => {
      const { o, e } = await fixture();
      const doc = value<{ _id: string }>(await o.create(op(e), visitor("b"), "items", {}, ctx));
      const limits = { ...ROOMY, rightsRowsPerDay: 1 };
      const limited = context({ limits });
      value(await o.exportMine(e, visitor("a", false), null, limited));
      expect(await o.remove(op(e), visitor("b", false), "items", doc._id, limited)).toMatchObject({
        ok: true,
      });
    });
    it("R07: yesterday's reserved messages cannot be sent against a zero limit today", async () => {
      const { o, e } = await fixture("append");
      const midnight = (dayOf(NOW) + 1) * 86400000;
      const socket = value<string>(
        await o.connect(
          e,
          visitorId("a"),
          "grant:a",
          midnight + 30000,
          context({ now: midnight - 1000 }),
        ),
      );
      await o.message(socket, JSON.stringify({ subscribe: "items" }), midnight - 1000);
      expect(
        await o.renew(
          e,
          socket,
          "grant:a",
          midnight + 30000,
          context({ now: midnight, limits: { ...ROOMY, liveMessagesPerDay: 0 } }),
        ),
      ).toBe(true);
      const before = (await o.view()).sockets.get(socket)!.received.length;
      await o.message(socket, JSON.stringify({ subscribe: "items" }), midnight);
      expect((await o.view()).sockets.get(socket)!.received.length).toBe(before);
      expect((await o.view()).sockets.get(socket)!.closed).toBe(4029);
    });
    it("R08: no-op index maintenance does not change the payload revision", async () => {
      const { o, e } = await fixture();
      const before = (await o.view()).durable.control!.payloadRevision;
      value(await o.indexStep(op(e), OWNER, ctx));
      expect((await o.view()).durable.control!.payloadRevision).toBe(before);
    });
    it("R09: owner index steps record their audit obligation", async () => {
      const { o, e } = await fixture();
      value(
        await o.declare(op(e), OWNER, { name: "items", mode: "own", indexed: ["f1", "f2"] }, ctx),
      );
      const sent = op(e);
      value(await o.indexStep(sent, OWNER, ctx));
      expect((await o.view()).durable.audit.has(operationKey("owner:owner", 0, sent.opId!))).toBe(
        true,
      );
    });
    // R11 at the absolute cap the contracts now pin (MAX_INDEXED_FIELDS): 32 fields is no longer a
    // legal declaration, so the largest legal shape is tested instead.
    it("R11: bulk removal respects its row cap at the most indexed fields a collection can hold", async () => {
      const o = await make();
      const e = envelope();
      const fields = Array.from({ length: MAX_INDEXED_FIELDS }, (_, i) => "f" + i);
      const c = context({ limits: { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS } });
      value(await o.declare(op(e), OWNER, { name: "items", mode: "append", indexed: fields }, c));
      while ((await o.view()).durable.fields.some((f) => f.state === "building"))
        value(await o.indexStep(op(e), OWNER, c));
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push(
          value<{ _id: string }>(
            await o.create(op(e), OWNER, "items", Object.fromEntries(fields.map((f) => [f, 1])), c),
          )._id,
        );
      }
      const result = await o.bulkRemove(op(e), OWNER, "items", ids, c);
      expect(result.ok).toBe(true);
      expect(withinBound("bulk_remove", result.cost)).toBe(true);
      expect((await o.view()).checked.length).toBeGreaterThan(0);
      expect((await o.view()).checked.every((item) => withinBound(item.kind, item.cost))).toBe(
        true,
      );
    });
    it("R10: prepare binds its epoch target, so an older commit envelope cannot erase it", async () => {
      const { o, e } = await fixture();
      const id = opId();
      value(await o.prepareErase({ ...e, epoch: 5 }, id, NOW));
      expect(await o.commitErase(e, id, NOW)).toMatchObject({ ok: false, code: "stale" });
    });
  });

  const DAY = 86_400_000;

  describe("decisions on the review of PR 254", () => {
    it("R01: binding on a first request, a failed first write, a settlement or an erasure never counts as a fence", async () => {
      const hold = async (o: DataObject, e: ReturnType<typeof envelope>) =>
        await o.fence(e, { kind: "hold", transition: "h" }, NOW);
      const bound = envelope({ epoch: 1 });
      // A successful first declaration.
      const a = await make();
      value(await a.declare(op(bound), OWNER, { name: "items", mode: "own" }, ctx));
      expect(await hold(a, bound)).toMatchObject({ ok: true, value: { held: true } });
      // A failed first declaration still binds, and still leaves the epoch to the fence.
      const b = await make();
      await b.setFaults({ afterWork: () => true });
      expect((await b.declare(op(bound), OWNER, { name: "items", mode: "own" }, ctx)).ok).toBe(
        false,
      );
      expect((await b.view()).durable.control).toMatchObject({
        epoch: 1,
        boundEpoch: 1,
        fencedEpoch: null,
      });
      expect(await hold(b, bound)).toMatchObject({ ok: true });
      // A settlement and an erasure chunk binding the object.
      const c = await make();
      await c.settle(bound, "owner:owner", opId(), NOW);
      expect((await c.view()).durable.control?.fencedEpoch).toBeNull();
      expect(await hold(c, bound)).toMatchObject({ ok: true });
      const d = await make();
      value(await d.eraseAuthorChunk(op(bound), visitorId("x"), 1, ctx));
      expect(
        await d.fence(bound, { kind: "transfer", toOwner: "owner_b", transition: "m" }, NOW),
      ).toMatchObject({ ok: true, value: { ownerId: "owner_b" } });
      expect(await d.query(bound, OWNER, { collection: "items" }, ctx)).toMatchObject({
        ok: false,
        code: "stale",
      });
      // Once a fence applied at that epoch, another one there is stale.
      expect(await a.fence(bound, { kind: "release", transition: "r" }, NOW)).toMatchObject({
        ok: false,
        code: "stale",
      });
    });

    it("R02: a prepared intent is finished and cancelled under its ID after any delay, and reconciliation resumes it", async () => {
      const { o, e } = await fixture();
      const id = opId();
      value(await o.prepareErase(e, id, NOW));
      const later = NOW + 30 * DAY;
      expect(value(await o.prepareErase(e, id, later))).toEqual({ outcome: "prepared" });
      expect(value(await o.cancelErase(e, id, later))).toEqual({ outcome: "cancelled" });
      const fresh = opId();
      expect(await o.prepareErase(e, fresh, NOW + ARTIFACT_DATA.horizonMs + 1)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(await o.prepareErase(e, opId(NOW + 30 * DAY), later)).toMatchObject({ ok: true });
    });

    it("R03: every access is accounted for, refusals, replays, failures, flushes, protected work and alarms included", async () => {
      const { o, e } = await fixture("append");
      const doc = value<{ _id: string }>(
        await o.create(op(e), visitor("a"), "items", { n: 1 }, ctx),
      );
      const once = op(e);
      value(await o.create(once, OWNER, "items", { n: 2 }, ctx));
      await o.create(once, OWNER, "items", { n: 2 }, ctx);
      await o.get(e, visitor("b"), "items", "xxxxxxxxxxxxxxxx", ctx);
      await o.create(op(e), READER, "items", {}, ctx);
      await o.setFaults({ afterWork: (kind) => kind === "replace" });
      await o.replace(op(e), visitor("a"), "items", doc._id, { n: 3 }, ctx);
      await o.setFaults({ afterWork: () => false });
      await o.fence({ ...e, epoch: 1 }, { kind: "epoch", transition: "t" }, NOW);
      await o.settle(e, "owner:owner", opId(), NOW);
      value(await o.quarantine({ ...e, epoch: 1 }, "orphan", NOW));
      value(await o.resolveQuarantine({ ...e, epoch: 1 }, "erase", NOW));
      expect((await o.view()).durable.days.get(dayOf(NOW))?.protected).toBeGreaterThan(0);
      expect((await o.view()).accounted()).toBeGreaterThanOrEqual((await o.view()).accesses);
      await o.alarm(NOW + 5 * DAY);
      await o.evict();
      expect((await o.view()).accounted()).toBeGreaterThanOrEqual((await o.view()).accesses);
    });

    it("R04: a replay is a read attempt: refused at the caller's minute or a spent read day, never re-applied", async () => {
      const { o, e } = await fixture("append");
      const sent = op(e);
      value(await o.create(sent, visitor("a"), "items", {}, ctx));
      const limits = { ...ROOMY, readsPerCallerPerMinute: 2 };
      const minute = context({ limits, now: NOW + 120_000 });
      expect(await o.create(sent, visitor("a"), "items", {}, minute)).toMatchObject({
        ok: true,
        replayed: {},
      });
      expect(await o.create(sent, visitor("a"), "items", {}, minute)).toMatchObject({
        ok: true,
        replayed: {},
      });
      expect(await o.create(sent, visitor("a"), "items", {}, minute)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      const spent = context({ limits: { ...ROOMY, rowsReadPerDay: 1 }, now: NOW + 240_000 });
      expect(await o.create(sent, visitor("a"), "items", {}, spent)).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      expect((await o.view()).durable.documents.size).toBe(1);
    });

    it("R05: the alarm alone flushes pending usage; a held object is not woken for it; an eviction loses at most the bound", async () => {
      const { o, e } = await fixture("append");
      value(await o.query(e, OWNER, { collection: "items" }, ctx));
      const due = (await o.view()).durable.alarm as number;
      expect(due).toBe(NOW + ARTIFACT_DATA.readFlush.ms);
      await o.alarm(due);
      expect((await o.view()).pending.rows).toBe(0);
      expect((await o.view()).durable.days.get(dayOf(NOW))?.read).toBeGreaterThan(0);
      value(await o.fence({ ...e, epoch: 1 }, { kind: "hold", transition: "h" }, NOW));
      await o.query({ ...e, epoch: 1 }, OWNER, { collection: "items" }, ctx);
      expect((await o.view()).pending.refused).toBe(1);
      expect((await o.view()).durable.alarm).toBeNull();
      // Rows flush synchronously at the bound, so what an eviction can lose stays under it.
      const { o: busy, e: be } = await fixture("append");
      await busy.getMany(be, OWNER, "items", "xxxxxxxxxxxxxxxx", ctx, 4_000);
      expect((await busy.view()).pending.rows).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
      expect((await busy.view()).pending.refused).toBeLessThan(ARTIFACT_DATA.readFlush.refusals);
    });

    it("R06: the owner and other visitors never spend a visitor's rights, and rights rows are pruned after their day", async () => {
      const { o, e } = await fixture("append");
      const mine = value<{ _id: string }>(await o.create(op(e), visitor("b"), "items", {}, ctx));
      const theirs = value<{ _id: string }>(await o.create(op(e), visitor("a"), "items", {}, ctx));
      const limited = context({ limits: { ...ROOMY, rightsRowsPerDay: 1 } });
      value(await o.remove(op(e), OWNER, "items", theirs._id, limited));
      value(await o.exportMine(e, visitor("a"), null, limited));
      expect(await o.exportMine(e, visitor("a"), null, limited)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      value(await o.remove(op(e), visitor("b", false), "items", mine._id, limited));
      expect([...(await o.view()).durable.rights.keys()].length).toBe(2);
      await o.alarm(NOW + 4 * DAY);
      expect((await o.view()).durable.rights.size).toBe(0);
    });

    it("R07: a lowered plan applies at the next renewal, and credits expire with their day", async () => {
      const { o, e } = await fixture("append");
      const socket = value<string>(await o.connect(e, null, "reader", NOW + 60_000, ctx));
      await o.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
      expect((await o.view()).sockets.get(socket)!.attachment.reserved).toBe(99);
      await o.renew(
        e,
        socket,
        "reader",
        NOW + 50_000,
        context({ limits: { ...ROOMY, liveMessagesPerDay: 100 } }),
      );
      expect((await o.view()).sockets.get(socket)!.attachment.reserved).toBe(0);
      await o.message(socket, JSON.stringify({ subscribe: "items" }), NOW + 1_000);
      expect((await o.view()).sockets.get(socket)!.closed).toBe(4029);
    });

    it("R08: the payload revision rises with a document or a declaration change, and only then", async () => {
      const { o, e } = await fixture("append");
      const revision = async () => (await o.view()).durable.control!.payloadRevision;
      let before = await revision();
      value(await o.declare(op(e), OWNER, { name: "items", mode: "append" }, ctx));
      expect(await revision()).toBe(before);
      value(await o.declare(op(e), OWNER, { name: "items", mode: "append", indexed: ["n"] }, ctx));
      expect(await revision()).toBe(before + 1);
      before = await revision();
      expect(await o.bulkRemove(op(e), OWNER, "items", ["xxxxxxxxxxxxxxxx"], ctx)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      value(await o.eraseAuthorChunk(op(e), visitorId("nobody"), 10, ctx));
      value(await o.indexStep(op(e), OWNER, ctx));
      expect(await revision()).toBe(before);
      value(await o.declare(op(e), OWNER, { name: "other", mode: "own" }, ctx));
      expect(await revision()).toBe(before + 1);
    });

    it("R11: the largest legal shapes stay within their derived bounds", async () => {
      const o = await make();
      const e = envelope();
      const fields = Array.from({ length: MAX_INDEXED_FIELDS }, (_, i) => "f" + i);
      const c = context({ limits: { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS } });
      value(await o.declare(op(e), OWNER, { name: "items", mode: "shared", indexed: fields }, c));
      const body = (n: number) => Object.fromEntries(fields.map((f) => [f, n]));
      const ids: string[] = [];
      for (let batch = 0; batch < 6; batch++) {
        ids.push(
          ...value<{ ids: string[] }>(
            await o.bulkCreate(
              op(e),
              OWNER,
              { collection: "items", documents: Array.from({ length: 100 }, (_, i) => body(i)) },
              c,
            ),
          ).ids,
        );
      }
      while ((await o.view()).durable.fields.some((f) => f.state === "building"))
        value(await o.indexStep(op(e), OWNER, c));
      value(
        await o.bulkReplace(
          op(e),
          OWNER,
          {
            collection: "items",
            documents: ids.slice(0, 100).map((id, i) => ({ id, body: body(i + 1) })),
          },
          c,
        ),
      );
      for (const id of ids.slice(100, 600))
        value(await o.replace(op(e), visitor("ed"), "items", id, body(7), c));
      for (let i = 0; i < 500; i++)
        value(await o.create(op(e), visitor("gone"), "items", body(i), c));
      value(await o.eraseAuthorChunk(op(e), visitorId("gone"), 500, c));
      value(await o.eraseAuthorChunk(op(e), visitorId("ed"), 500, c));
      value(await o.bulkRemove(op(e), OWNER, "items", ids.slice(0, 100), c));
      expect((await o.view()).checked.length).toBeGreaterThan(0);
      expect((await o.view()).checked.every((item) => withinBound(item.kind, item.cost))).toBe(
        true,
      );
      expect(
        await o.declare(op(e), OWNER, { name: "items", mode: "shared", indexed: ["extra"] }, c),
      ).toMatchObject({ ok: false, code: "quota_exceeded" });
    });

    it("R12: bulk create and replace are all or nothing, counts by indexed value read one row, describe is the owner's", async () => {
      const { o, e } = await fixture("append");
      value(
        await o.declare(
          op(e),
          OWNER,
          { name: "votes", mode: "append", uniqueKey: "slot", indexed: ["choice"] },
          ctx,
        ),
      );
      const created = value<{ ids: string[] }>(
        await o.bulkCreate(
          op(e),
          OWNER,
          {
            collection: "votes",
            documents: [
              { slot: 1, choice: "a" },
              { slot: 2, choice: "b" },
              { slot: 3, choice: "a" },
            ],
          },
          ctx,
        ),
      );
      expect(created.ids).toHaveLength(3);
      expect(
        await o.bulkCreate(
          op(e),
          OWNER,
          { collection: "votes", documents: [{ slot: 4 }, { slot: 4 }] },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "conflict" });
      expect(
        await o.bulkCreate(
          op(e),
          OWNER,
          { collection: "votes", documents: [{ slot: 5 }, { slot: 1 }] },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "conflict" });
      expect((await o.view()).durable.documents.size).toBe(3);
      expect(
        await o.bulkCreate(
          op(e),
          visitor("a"),
          { collection: "votes", documents: [{ slot: 9 }] },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "forbidden" });
      const counted = await o.count(
        e,
        OWNER,
        { collection: "votes", equals: { field: "choice", value: "a" } },
        ctx,
      );
      expect(value(counted)).toEqual({ documents: 2 });
      // The control record, the collection, its fields and the one value-count row: no document.
      expect(counted.cost.rowsRead).toBeLessThanOrEqual(6);
      value(
        await o.bulkReplace(
          op(e),
          OWNER,
          {
            collection: "votes",
            documents: [{ id: created.ids[0]!, body: { slot: 1, choice: "b" } }],
          },
          ctx,
        ),
      );
      expect(
        value(
          await o.count(
            e,
            OWNER,
            { collection: "votes", equals: { field: "choice", value: "b" } },
            ctx,
          ),
        ),
      ).toEqual({ documents: 2 });
      expect(
        await o.bulkReplace(
          op(e),
          OWNER,
          {
            collection: "votes",
            documents: [
              { id: created.ids[0]!, body: { slot: 7 } },
              { id: "xxxxxxxxxxxxxxxx", body: { slot: 8 } },
            ],
          },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "not_found" });
      expect(
        await o.bulkReplace(
          op(e),
          OWNER,
          {
            collection: "votes",
            documents: [
              { id: created.ids[0]!, body: { slot: 7 } },
              { id: created.ids[0]!, body: { slot: 8 } },
            ],
          },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "invalid_input" });
      value(await o.bulkRemove(op(e), OWNER, "votes", [created.ids[1]!], ctx));
      expect(
        value(
          await o.count(
            e,
            OWNER,
            { collection: "votes", equals: { field: "choice", value: "b" } },
            ctx,
          ),
        ),
      ).toEqual({ documents: 1 });
      expect(await o.count(e, visitor("a"), { collection: "votes" }, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      const described = value<import("@portifact/contracts/artifact-data").DataDescription>(
        await o.describe(e, OWNER, ctx),
      );
      expect(described.collections.map((c) => [c.name, c.documents, c.indexed])).toEqual([
        ["items", 0, []],
        ["votes", 2, [{ field: "choice", state: "ready" }]],
      ]);
      expect(await o.describe(e, visitor("a"), ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(
        planCount({ collection: "v", by: "x", equals: { field: "f", value: 1 } }, OWNER, ["f"]),
      ).toMatchObject({ code: "invalid_input" });
      expect(
        planCount({ collection: "v", equals: { field: "f", value: 1 } }, OWNER, []),
      ).toMatchObject({ code: "invalid_input" });
      expect(valueCountDeltas([{ field: "f", value: "1" }], [{ field: "f", value: "1" }])).toEqual(
        [],
      );
      expect(bulkBodies([], null, [], ROOMY)).toMatchObject({ code: "invalid_input" });
    });

    it("alarms: 120 writes spread over an hour wake the object once for retention the next day, twice in all", async () => {
      const { o, e } = await fixture("append");
      for (let i = 0; i < 120; i++)
        value(
          await o.create(
            op(e, NOW + i * 30_000),
            visitor("a"),
            "items",
            { i },
            context({ now: NOW + i * 30_000 }),
          ),
        );
      let wakes = 0;
      for (let at = (await o.view()).durable.alarm; at !== null && at < NOW + 2 * DAY; ) {
        await o.alarm(at);
        wakes += 1;
        at = (await o.view()).durable.alarm;
      }
      expect(wakes).toBe(1);
      expect((await o.view()).durable.ops.size + (await o.view()).durable.rates.size).toBe(0);
      for (let at = (await o.view()).durable.alarm; at !== null && wakes < 10; ) {
        await o.alarm(at);
        wakes += 1;
        at = (await o.view()).durable.alarm;
      }
      expect(wakes).toBe(2);
      expect((await o.view()).durable.days.size).toBe(0);
      expect(batched(NOW + 1)).toBe(NOW + ARTIFACT_DATA.alarmBatchMs);
    });

    it("reconciliation raises D1 only when it is behind; a second run changes nothing", async () => {
      const { o, e } = await fixture("append");
      value(await o.fence({ ...e, epoch: 4 }, { kind: "epoch", transition: "t" }, NOW));
      const first = reconcileAgain(
        { ownerId: e.ownerId, generation: 0, epoch: 1, held: false },
        (await o.view()).durable.control,
      );
      expect(first).toEqual({ action: "raise", generation: 0, epoch: 5 });
      const raised = first as { epoch: number; generation: number };
      expect(
        reconcileAgain(
          { ownerId: e.ownerId, generation: raised.generation, epoch: raised.epoch, held: false },
          (await o.view()).durable.control,
        ),
      ).toEqual({ action: "none" });
      expect(rows((await o.view()).durable)).toEqual(rows((await o.view()).durable));
    });
  });
}
