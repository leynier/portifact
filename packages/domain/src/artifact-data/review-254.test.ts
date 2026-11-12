// The independent code review of pull request #254 (R01 to R11), its reproductions as written.

import { ARTIFACT_DATA, MAX_INDEXED_FIELDS } from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
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
  visitorId,
} from "../testing/artifact-data-fixtures.ts";
import { MemoryObject } from "../testing/artifact-data-object.ts";
import { dayOf, minuteOf, operationKey, reconcile, withinBound } from "./index.ts";

const ctx = context();
function fixture(mode: "own" | "append" | "shared" = "own") {
  const o = new MemoryObject();
  const e = envelope();
  value(o.declare(op(e), OWNER, { name: "items", mode }, ctx));
  return { o, e };
}

describe("second review of PR 254: reproductions", () => {
  it("R01: a first request must not consume a pending hold epoch", () => {
    const o = new MemoryObject();
    const e = envelope({ epoch: 1 });
    value(o.declare(op(e), OWNER, { name: "items", mode: "own" }, ctx));
    expect(o.fence(e, { kind: "hold", transition: "pending_hold" }, NOW)).toMatchObject({
      ok: true,
    });
    expect(o.create(op(e), visitor("a"), "items", {}, ctx)).toMatchObject({
      ok: false,
      code: "held",
    });
  });
  it("R02: a prepared erase must remain resumable after the operation horizon", () => {
    const { o, e } = fixture();
    const id = opId();
    value(o.create(op(e), visitor("a"), "items", {}, ctx));
    value(o.prepareErase(e, id, NOW));
    const later = NOW + ARTIFACT_DATA.replayMs + 1;
    expect(
      reconcile({ ownerId: e.ownerId, generation: 0, epoch: 0, held: false }, o.durable.control),
    ).toMatchObject({ action: "resume_erase", eraseId: id });
    expect(o.commitErase({ ...e, epoch: 1 }, id, later)).toMatchObject({
      ok: true,
      value: { outcome: "committed" },
    });
  });
  it("R03a: read refusals charge their measured lookup work", () => {
    const { o, e } = fixture();
    const before = o.pending.rows;
    const answer = o.get(e, visitor("a"), "items", "xxxxxxxxxxxxxxxx", ctx);
    expect(answer).toMatchObject({ ok: false, code: "not_found" });
    expect(o.pending.rows - before).toBeGreaterThanOrEqual(answer.cost.rowsRead);
  });
  it("R03b: pre-work mutation refusals charge their measured lookup work", () => {
    const { o, e } = fixture();
    const before = o.pending.rows;
    const answer = o.create(op(e), visitor("a", false), "items", {}, ctx);
    expect(answer).toMatchObject({ ok: false, code: "forbidden" });
    expect(o.pending.rows - before).toBeGreaterThanOrEqual(answer.cost.rowsRead);
  });
  // R03c as decided by the maintainer: quarantine cleanup is protected work, measured with real
  // counts under the protected class, which draws on no visitor's or owner's allowance.
  it("R03c: quarantine erasure is charged, by its measured rows, to the protected class", () => {
    const { o, e } = fixture();
    value(o.create(op(e), visitor("a"), "items", {}, ctx));
    value(o.quarantine(e, "orphan", NOW));
    const before = o.durable.days.get(dayOf(NOW))!.protected;
    const answer = o.resolveQuarantine(e, "erase", NOW);
    expect(answer.ok).toBe(true);
    expect(o.durable.days.get(dayOf(NOW))!.protected - before).toBeGreaterThanOrEqual(
      answer.cost.rowsRead + answer.cost.rowsWritten,
    );
    expect(answer.cost.rowsRead + answer.cost.rowsWritten).toBeGreaterThan(10);
  });
  it("R04a: repeated operations obey the read budget once lookup work spends it", () => {
    const { o, e } = fixture();
    const sent = op(e);
    value(o.create(sent, visitor("a"), "items", {}, ctx));
    const limited = context({ limits: { ...ROOMY, rowsReadPerDay: 1 } });
    o.create(sent, visitor("a"), "items", {}, limited);
    expect(o.create(sent, visitor("a"), "items", {}, limited)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });
  it("R04b: replay-only traffic cannot lose more than the read flush bound on eviction", () => {
    const { o, e } = fixture();
    const sent = op(e);
    value(o.create(sent, visitor("a"), "items", {}, ctx));
    for (let i = 0; i < 2600; i++) o.create(sent, visitor("a"), "items", {}, ctx);
    expect(o.pending.rows).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
  });
  it("R05a: the first pending read schedules the 30-second flush", () => {
    const { o, e } = fixture();
    value(o.query(e, visitor("a"), { collection: "items" }, ctx));
    expect(o.durable.alarm).toBeLessThanOrEqual(NOW + ARTIFACT_DATA.readFlush.ms);
  });
  it("R05b: UTC midnight persists the previous days pending reads", () => {
    const midnight = (dayOf(NOW) + 1) * 86400000;
    const o = new MemoryObject();
    const e = envelope();
    value(
      o.declare(
        op(e, midnight - 2),
        OWNER,
        { name: "items", mode: "own" },
        context({ now: midnight - 2 }),
      ),
    );
    value(o.query(e, visitor("a"), { collection: "items" }, context({ now: midnight - 1 })));
    const pending = o.pending.rows;
    o.flushReads(midnight);
    expect(o.durable.days.get(dayOf(NOW))!.read).toBeGreaterThanOrEqual(pending);
  });
  it("R06: one visitors export cannot exhaust another visitors own rights", () => {
    const { o, e } = fixture();
    const doc = value<{ _id: string }>(o.create(op(e), visitor("b"), "items", {}, ctx));
    const limits = { ...ROOMY, rightsRowsPerDay: 1 };
    const limited = context({ limits });
    value(o.exportMine(e, visitor("a", false), null, limited));
    expect(o.remove(op(e), visitor("b", false), "items", doc._id, limited)).toMatchObject({
      ok: true,
    });
  });
  it("R07: yesterday's reserved messages cannot be sent against a zero limit today", () => {
    const { o, e } = fixture("append");
    const midnight = (dayOf(NOW) + 1) * 86400000;
    const socket = value<string>(
      o.connect(e, visitorId("a"), "grant:a", midnight + 30000, context({ now: midnight - 1000 })),
    );
    o.message(socket, JSON.stringify({ subscribe: "items" }), midnight - 1000);
    expect(
      o.renew(
        e,
        socket,
        "grant:a",
        midnight + 30000,
        context({ now: midnight, limits: { ...ROOMY, liveMessagesPerDay: 0 } }),
      ),
    ).toBe(true);
    const before = o.sockets.get(socket)!.received.length;
    o.message(socket, JSON.stringify({ subscribe: "items" }), midnight);
    expect(o.sockets.get(socket)!.received.length).toBe(before);
    expect(o.sockets.get(socket)!.closed).toBe(4029);
  });
  it("R08: no-op index maintenance does not change the payload revision", () => {
    const { o, e } = fixture();
    const before = o.durable.control!.payloadRevision;
    value(o.indexStep(op(e), OWNER, ctx));
    expect(o.durable.control!.payloadRevision).toBe(before);
  });
  it("R09: owner index steps record their audit obligation", () => {
    const { o, e } = fixture();
    value(o.declare(op(e), OWNER, { name: "items", mode: "own", indexed: ["f1", "f2"] }, ctx));
    const sent = op(e);
    value(o.indexStep(sent, OWNER, ctx));
    expect(o.durable.audit.has(operationKey("owner:owner", 0, sent.opId!))).toBe(true);
  });
  // R11 at the absolute cap the contracts now pin (MAX_INDEXED_FIELDS): 32 fields is no longer a
  // legal declaration, so the largest legal shape is tested instead.
  it("R11: bulk removal respects its row cap at the most indexed fields a collection can hold", () => {
    const o = new MemoryObject();
    const e = envelope();
    const fields = Array.from({ length: MAX_INDEXED_FIELDS }, (_, i) => "f" + i);
    const c = context({ limits: { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS } });
    value(o.declare(op(e), OWNER, { name: "items", mode: "append", indexed: fields }, c));
    while (o.durable.fields.some((f) => f.state === "building"))
      value(o.indexStep(op(e), OWNER, c));
    const ids = Array.from(
      { length: 100 },
      () =>
        value<{ _id: string }>(
          o.create(op(e), OWNER, "items", Object.fromEntries(fields.map((f) => [f, 1])), c),
        )._id,
    );
    const result = o.bulkRemove(op(e), OWNER, "items", ids, c);
    expect(result.ok).toBe(true);
    expect(withinBound("bulk_remove", result.cost)).toBe(true);
    expect(o.exceeded).toEqual([]);
  });
  it("R10: prepare binds its epoch target, so an older commit envelope cannot erase it", () => {
    const { o, e } = fixture();
    const id = opId();
    value(o.prepareErase({ ...e, epoch: 5 }, id, NOW));
    expect(o.commitErase(e, id, NOW)).toMatchObject({ ok: false, code: "stale" });
  });
});

import { READER } from "../testing/artifact-data-fixtures.ts";
import { rows } from "../testing/artifact-data-object.ts";
// The maintainer's decisions on the review, each tested in both directions where it has two.
import {
  batched,
  bulkBodies,
  planCount,
  reconcile as reconcileAgain,
  valueCountDeltas,
} from "./index.ts";

const DAY = 86_400_000;

describe("decisions on the review of PR 254", () => {
  it("R01: binding on a first request, a failed first write, a settlement or an erasure never counts as a fence", () => {
    const hold = (o: MemoryObject, e: ReturnType<typeof envelope>) =>
      o.fence(e, { kind: "hold", transition: "h" }, NOW);
    const bound = envelope({ epoch: 1 });
    // A successful first declaration.
    const a = new MemoryObject();
    value(a.declare(op(bound), OWNER, { name: "items", mode: "own" }, ctx));
    expect(hold(a, bound)).toMatchObject({ ok: true, value: { held: true } });
    // A failed first declaration still binds, and still leaves the epoch to the fence.
    const b = new MemoryObject();
    b.faults.afterWork = () => true;
    expect(b.declare(op(bound), OWNER, { name: "items", mode: "own" }, ctx).ok).toBe(false);
    expect(b.durable.control).toMatchObject({ epoch: 1, boundEpoch: 1, fencedEpoch: null });
    expect(hold(b, bound)).toMatchObject({ ok: true });
    // A settlement and an erasure chunk binding the object.
    const c = new MemoryObject();
    c.settle(bound, "owner:owner", opId(), NOW);
    expect(c.durable.control?.fencedEpoch).toBeNull();
    expect(hold(c, bound)).toMatchObject({ ok: true });
    const d = new MemoryObject();
    value(d.eraseAuthorChunk(op(bound), visitorId("x"), 1, ctx));
    expect(
      d.fence(bound, { kind: "transfer", toOwner: "owner_b", transition: "m" }, NOW),
    ).toMatchObject({ ok: true, value: { ownerId: "owner_b" } });
    expect(d.query(bound, OWNER, { collection: "items" }, ctx)).toMatchObject({
      ok: false,
      code: "stale",
    });
    // Once a fence applied at that epoch, another one there is stale.
    expect(a.fence(bound, { kind: "release", transition: "r" }, NOW)).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  it("R02: a prepared intent is finished and cancelled under its ID after any delay, and reconciliation resumes it", () => {
    const { o, e } = fixture();
    const id = opId();
    value(o.prepareErase(e, id, NOW));
    const later = NOW + 30 * DAY;
    expect(value(o.prepareErase(e, id, later))).toEqual({ outcome: "prepared" });
    expect(value(o.cancelErase(e, id, later))).toEqual({ outcome: "cancelled" });
    const fresh = opId();
    expect(o.prepareErase(e, fresh, NOW + ARTIFACT_DATA.horizonMs + 1)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(o.prepareErase(e, opId(NOW + 30 * DAY), later)).toMatchObject({ ok: true });
  });

  it("R03: every access is accounted for, refusals, replays, failures, flushes, protected work and alarms included", () => {
    const { o, e } = fixture("append");
    const doc = value<{ _id: string }>(o.create(op(e), visitor("a"), "items", { n: 1 }, ctx));
    const once = op(e);
    value(o.create(once, OWNER, "items", { n: 2 }, ctx));
    o.create(once, OWNER, "items", { n: 2 }, ctx);
    o.get(e, visitor("b"), "items", "xxxxxxxxxxxxxxxx", ctx);
    o.create(op(e), READER, "items", {}, ctx);
    o.faults.afterWork = (kind) => kind === "replace";
    o.replace(op(e), visitor("a"), "items", doc._id, { n: 3 }, ctx);
    o.faults.afterWork = () => false;
    o.fence({ ...e, epoch: 1 }, { kind: "epoch", transition: "t" }, NOW);
    o.settle(e, "owner:owner", opId(), NOW);
    value(o.quarantine({ ...e, epoch: 1 }, "orphan", NOW));
    value(o.resolveQuarantine({ ...e, epoch: 1 }, "erase", NOW));
    expect(o.durable.days.get(dayOf(NOW))?.protected).toBeGreaterThan(0);
    expect(o.accounted()).toBeGreaterThanOrEqual(o.accesses);
    o.alarm(NOW + 5 * DAY);
    o.evict();
    expect(o.accounted()).toBeGreaterThanOrEqual(o.accesses);
  });

  it("R04: a replay is a read attempt: refused at the caller's minute or a spent read day, never re-applied", () => {
    const { o, e } = fixture("append");
    const sent = op(e);
    value(o.create(sent, visitor("a"), "items", {}, ctx));
    const limits = { ...ROOMY, readsPerCallerPerMinute: 2 };
    const minute = context({ limits, now: NOW + 120_000 });
    expect(o.create(sent, visitor("a"), "items", {}, minute)).toMatchObject({
      ok: true,
      replayed: {},
    });
    expect(o.create(sent, visitor("a"), "items", {}, minute)).toMatchObject({
      ok: true,
      replayed: {},
    });
    expect(o.create(sent, visitor("a"), "items", {}, minute)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    const spent = context({ limits: { ...ROOMY, rowsReadPerDay: 1 }, now: NOW + 240_000 });
    expect(o.create(sent, visitor("a"), "items", {}, spent)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    expect(o.durable.documents.size).toBe(1);
  });

  it("R05: the alarm alone flushes pending usage; a held object is not woken for it; an eviction loses at most the bound", () => {
    const { o, e } = fixture("append");
    value(o.query(e, OWNER, { collection: "items" }, ctx));
    const due = o.durable.alarm as number;
    expect(due).toBe(NOW + ARTIFACT_DATA.readFlush.ms);
    o.alarm(due);
    expect(o.pending.rows).toBe(0);
    expect(o.durable.days.get(dayOf(NOW))?.read).toBeGreaterThan(0);
    value(o.fence({ ...e, epoch: 1 }, { kind: "hold", transition: "h" }, NOW));
    o.query({ ...e, epoch: 1 }, OWNER, { collection: "items" }, ctx);
    expect(o.pending.refused).toBe(1);
    expect(o.durable.alarm).toBeNull();
    // Rows flush synchronously at the bound, so what an eviction can lose stays under it.
    const { o: busy, e: be } = fixture("append");
    for (let i = 0; i < 4_000; i++) busy.get(be, OWNER, "items", "xxxxxxxxxxxxxxxx", ctx);
    expect(busy.pending.rows).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
    expect(busy.pending.refused).toBeLessThan(ARTIFACT_DATA.readFlush.refusals);
  });

  it("R06: the owner and other visitors never spend a visitor's rights, and rights rows are pruned after their day", () => {
    const { o, e } = fixture("append");
    const mine = value<{ _id: string }>(o.create(op(e), visitor("b"), "items", {}, ctx));
    const theirs = value<{ _id: string }>(o.create(op(e), visitor("a"), "items", {}, ctx));
    const limited = context({ limits: { ...ROOMY, rightsRowsPerDay: 1 } });
    value(o.remove(op(e), OWNER, "items", theirs._id, limited));
    value(o.exportMine(e, visitor("a"), null, limited));
    expect(o.exportMine(e, visitor("a"), null, limited)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    value(o.remove(op(e), visitor("b", false), "items", mine._id, limited));
    expect([...o.durable.rights.keys()].length).toBe(2);
    o.alarm(NOW + 4 * DAY);
    expect(o.durable.rights.size).toBe(0);
  });

  it("R07: a lowered plan applies at the next renewal, and credits expire with their day", () => {
    const { o, e } = fixture("append");
    const socket = value<string>(o.connect(e, null, "reader", NOW + 60_000, ctx));
    o.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
    expect(o.sockets.get(socket)!.attachment.reserved).toBe(99);
    o.renew(
      e,
      socket,
      "reader",
      NOW + 50_000,
      context({ limits: { ...ROOMY, liveMessagesPerDay: 100 } }),
    );
    expect(o.sockets.get(socket)!.attachment.reserved).toBe(0);
    o.message(socket, JSON.stringify({ subscribe: "items" }), NOW + 1_000);
    expect(o.sockets.get(socket)!.closed).toBe(4029);
  });

  it("R08: the payload revision rises with a document or a declaration change, and only then", () => {
    const { o, e } = fixture("append");
    const revision = () => o.durable.control!.payloadRevision;
    let before = revision();
    value(o.declare(op(e), OWNER, { name: "items", mode: "append" }, ctx));
    expect(revision()).toBe(before);
    value(o.declare(op(e), OWNER, { name: "items", mode: "append", indexed: ["n"] }, ctx));
    expect(revision()).toBe(before + 1);
    before = revision();
    value(o.bulkRemove(op(e), OWNER, "items", ["xxxxxxxxxxxxxxxx"], ctx));
    value(o.eraseAuthorChunk(op(e), visitorId("nobody"), 10, ctx));
    value(o.indexStep(op(e), OWNER, ctx));
    expect(revision()).toBe(before);
    value(o.declare(op(e), OWNER, { name: "other", mode: "own" }, ctx));
    expect(revision()).toBe(before + 1);
  });

  it("R11: the largest legal shapes stay within their derived bounds", () => {
    const o = new MemoryObject();
    const e = envelope();
    const fields = Array.from({ length: MAX_INDEXED_FIELDS }, (_, i) => "f" + i);
    const c = context({ limits: { ...ROOMY, indexedFields: MAX_INDEXED_FIELDS } });
    value(o.declare(op(e), OWNER, { name: "items", mode: "shared", indexed: fields }, c));
    const body = (n: number) => Object.fromEntries(fields.map((f) => [f, n]));
    const ids: string[] = [];
    for (let batch = 0; batch < 6; batch++) {
      ids.push(
        ...value<{ ids: string[] }>(
          o.bulkCreate(
            op(e),
            OWNER,
            { collection: "items", documents: Array.from({ length: 100 }, (_, i) => body(i)) },
            c,
          ),
        ).ids,
      );
    }
    while (o.durable.fields.some((f) => f.state === "building"))
      value(o.indexStep(op(e), OWNER, c));
    value(
      o.bulkReplace(
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
      value(o.replace(op(e), visitor("ed"), "items", id, body(7), c));
    for (let i = 0; i < 500; i++) value(o.create(op(e), visitor("gone"), "items", body(i), c));
    value(o.eraseAuthorChunk(op(e), visitorId("gone"), 500, c));
    value(o.eraseAuthorChunk(op(e), visitorId("ed"), 500, c));
    value(o.bulkRemove(op(e), OWNER, "items", ids.slice(0, 100), c));
    expect(o.exceeded).toEqual([]);
    expect(
      o.declare(op(e), OWNER, { name: "items", mode: "shared", indexed: ["extra"] }, c),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("R12: bulk create and replace are all or nothing, counts by indexed value read one row, describe is the owner's", () => {
    const { o, e } = fixture("append");
    value(
      o.declare(
        op(e),
        OWNER,
        { name: "votes", mode: "append", uniqueKey: "slot", indexed: ["choice"] },
        ctx,
      ),
    );
    const created = value<{ ids: string[] }>(
      o.bulkCreate(
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
      o.bulkCreate(
        op(e),
        OWNER,
        { collection: "votes", documents: [{ slot: 4 }, { slot: 4 }] },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(
      o.bulkCreate(
        op(e),
        OWNER,
        { collection: "votes", documents: [{ slot: 5 }, { slot: 1 }] },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(o.durable.documents.size).toBe(3);
    expect(
      o.bulkCreate(op(e), visitor("a"), { collection: "votes", documents: [{ slot: 9 }] }, ctx),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const counted = o.count(
      e,
      OWNER,
      { collection: "votes", equals: { field: "choice", value: "a" } },
      ctx,
    );
    expect(value(counted)).toEqual({ documents: 2 });
    expect(counted.cost.rowsRead).toBeLessThanOrEqual(4);
    value(
      o.bulkReplace(
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
        o.count(e, OWNER, { collection: "votes", equals: { field: "choice", value: "b" } }, ctx),
      ),
    ).toEqual({ documents: 2 });
    expect(
      o.bulkReplace(
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
      o.bulkReplace(
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
    value(o.bulkRemove(op(e), OWNER, "votes", [created.ids[1]!], ctx));
    expect(
      value(
        o.count(e, OWNER, { collection: "votes", equals: { field: "choice", value: "b" } }, ctx),
      ),
    ).toEqual({ documents: 1 });
    expect(o.count(e, visitor("a"), { collection: "votes" }, ctx)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    const described = value<import("@portifact/contracts/artifact-data").DataDescription>(
      o.describe(e, OWNER, ctx),
    );
    expect(described.collections.map((c) => [c.name, c.documents, c.indexed])).toEqual([
      ["items", 0, []],
      ["votes", 2, [{ field: "choice", state: "ready" }]],
    ]);
    expect(o.describe(e, visitor("a"), ctx)).toMatchObject({ ok: false, code: "forbidden" });
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

  it("alarms: 120 writes spread over an hour wake the object once for retention the next day, twice in all", () => {
    const { o, e } = fixture("append");
    for (let i = 0; i < 120; i++)
      value(
        o.create(
          op(e, NOW + i * 30_000),
          visitor("a"),
          "items",
          { i },
          context({ now: NOW + i * 30_000 }),
        ),
      );
    let wakes = 0;
    while (o.durable.alarm !== null && o.durable.alarm < NOW + 2 * DAY) {
      o.alarm(o.durable.alarm);
      wakes += 1;
    }
    expect(wakes).toBe(1);
    expect(o.durable.ops.size + o.durable.rates.size).toBe(0);
    while (o.durable.alarm !== null && wakes < 10) {
      o.alarm(o.durable.alarm);
      wakes += 1;
    }
    expect(wakes).toBe(2);
    expect(o.durable.days.size).toBe(0);
    expect(batched(NOW + 1)).toBe(NOW + ARTIFACT_DATA.alarmBatchMs);
  });

  it("reconciliation raises D1 only when it is behind; a second run changes nothing", () => {
    const { o, e } = fixture("append");
    value(o.fence({ ...e, epoch: 4 }, { kind: "epoch", transition: "t" }, NOW));
    const first = reconcileAgain(
      { ownerId: e.ownerId, generation: 0, epoch: 1, held: false },
      o.durable.control,
    );
    expect(first).toEqual({ action: "raise", generation: 0, epoch: 5 });
    const raised = first as { epoch: number; generation: number };
    expect(
      reconcileAgain(
        { ownerId: e.ownerId, generation: raised.generation, epoch: raised.epoch, held: false },
        o.durable.control,
      ),
    ).toEqual({ action: "none" });
    expect(rows(o.durable)).toEqual(rows(o.durable));
  });
});
