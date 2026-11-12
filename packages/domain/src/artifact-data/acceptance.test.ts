// "Acceptance tests for delivery 3" of decision 0026, one named test per item (A01 is item 1),
// against the production decisions composed by the in-memory object (`src/testing`), which is the
// shape delivery 4's documents object takes over SQLite.
import { DatabaseSync } from "node:sqlite";
import {
  ARTIFACT_DATA,
  type DataEnvelope,
  type JournalEntry,
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
import { authorTraces, MemoryObject, rows } from "../testing/artifact-data-object.ts";
import * as protocols from "./index.ts";
import {
  admit,
  apiGate,
  beginGate,
  claimOutcome,
  exportFooter,
  exportHeader,
  exportLine,
  journalPrunable,
  newControl,
  newerReport,
  type OPERATION_ROW_BOUNDS,
  parseExportFile,
  planQuery,
  reconcile,
  redeemable,
  redeemGate,
  retired,
} from "./index.ts";

const DAY = 86_400_000;
const ctx = context();
const alice = visitor("alice");
const bob = visitor("bob");

/** An object with one collection declared by the owner side. */
function withCollection(
  mode: "own" | "append" | "read" | "shared",
  options: { uniqueKey?: string; indexed?: string[]; limits?: typeof ROOMY } = {},
) {
  const object = new MemoryObject();
  const base = envelope();
  const declaration = {
    name: "items",
    mode,
    ...(options.uniqueKey === undefined ? {} : { uniqueKey: options.uniqueKey }),
    ...(options.indexed === undefined ? {} : { indexed: options.indexed }),
  };
  value(object.declare(op(base), OWNER, declaration, context({ limits: options.limits ?? ROOMY })));
  return { object, base };
}

describe("identity, replay and authorization", () => {
  it("A01: a visitor never reaches another visitor's own documents by ID, filter, cursor or live fan-out, and sequences are per author", () => {
    const { object, base } = withCollection("own");
    const listening = value(object.connect(base, visitorId("bob"), "grant:bob", NOW + 60_000, ctx));
    object.message(listening, JSON.stringify({ subscribe: "items" }), NOW);
    const before = object.sockets.get(listening)?.received.length;
    const mine = value<{ _id: string; _seq: number }>(
      object.create(op(base), alice, "items", { n: 1 }, ctx),
    );
    value(object.create(op(base), bob, "items", { n: 2 }, ctx));
    const second = value<{ _seq: number }>(object.create(op(base), alice, "items", { n: 3 }, ctx));
    expect([mine._seq, second._seq]).toEqual([1, 2]);
    expect(object.get(base, bob, "items", mine._id, ctx)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(object.replace(op(base), bob, "items", mine._id, { n: 9 }, ctx)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(object.remove(op(base), bob, "items", mine._id, ctx)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      object.query(
        base,
        bob,
        { collection: "items", equals: { field: "_by", value: visitorId("alice") } },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    for (const order of ["created", "-created"] as const) {
      const pages = [object.query(base, bob, { collection: "items", order, limit: 1 }, ctx)];
      const cursor = protocols.encodeCursor(NOW - 1, "");
      pages.push(object.query(base, bob, { collection: "items", order, after: cursor }, ctx));
      pages.push(
        object.query(base, bob, { collection: "items", created: { op: "gte", value: 0 } }, ctx),
      );
      for (const page of pages) {
        for (const doc of value<{ documents: { _by: string }[] }>(page).documents) {
          expect(doc._by).toBe(visitorId("bob"));
        }
      }
    }
    expect(object.query(base, READER, { collection: "items" }, ctx)).toMatchObject({
      ok: true,
      value: { documents: [] },
    });
    const heard = object.sockets.get(listening)?.received.slice(before) ?? [];
    expect(heard.every((message) => message.includes(visitorId("bob")))).toBe(true);
    expect(heard).toHaveLength(1);
  });

  it("A02: an operation ID is the actor's own and bound to the request; replays answer after current authorization and hold no body", () => {
    const { object, base } = withCollection("append");
    const shared = op(base);
    const first = value<{ _id: string }>(
      object.create(shared, alice, "items", { secret: "alice" }, ctx),
    );
    const other = object.create(shared, bob, "items", { secret: "bob" }, ctx);
    expect(value<{ _id: string; secret: string }>(other).secret).toBe("bob");
    expect(object.create(shared, alice, "items", { secret: "changed" }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    const replay = object.create(shared, alice, "items", { secret: "alice" }, ctx);
    expect(replay).toMatchObject({
      ok: true,
      replayed: { kind: "document", target: `items/${first._id}` },
    });
    expect(JSON.stringify(replay)).not.toContain("secret");
    expect(
      object.create(shared, visitor("alice", false), "items", { secret: "alice" }, ctx),
    ).toMatchObject({ ok: false, code: "forbidden" });
    for (const record of object.durable.ops.values())
      expect(JSON.stringify(record)).not.toContain("secret");
    const keys = [...object.durable.ops.keys()].filter((key) => key.endsWith(`|0|${shared.opId}`));
    expect(keys.sort()).toEqual([
      `${visitorId("alice")}|0|${shared.opId}`,
      `${visitorId("bob")}|0|${shared.opId}`,
    ]);
  });

  it("A03: a replay never applies, charges or notifies twice", () => {
    const { object, base } = withCollection("append");
    const socket = value(object.connect(base, visitorId("bob"), "grant:bob", NOW + 60_000, ctx));
    object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
    const once = op(base);
    value(object.create(once, alice, "items", { n: 1 }, ctx));
    const days = structuredClone(object.durable.days);
    const heard = object.sockets.get(socket)?.received.length;
    const seq = object.durable.control?.storageSeq;
    for (let index = 0; index < 5; index++) {
      expect(object.create(once, alice, "items", { n: 1 }, ctx)).toMatchObject({
        ok: true,
        replayed: {},
      });
    }
    expect(object.durable.documents.size).toBe(1);
    expect(object.durable.days).toEqual(days);
    expect(object.sockets.get(socket)?.received.length).toBe(heard);
    expect(object.durable.control?.storageSeq).toBe(seq);
    // A replay's own lookup is counted as reads, in memory: no attempt is free.
    const pending = object.pending.rows;
    object.create(once, alice, "items", { n: 1 }, ctx);
    expect(object.pending.rows).toBeGreaterThan(pending);
  });

  it("A04: an operation ID past the horizon or from the future is refused, and a pruned ID never applies again", () => {
    const { object, base } = withCollection("append");
    const late = { ...base, opId: opId(NOW - ARTIFACT_DATA.horizonMs - 1) };
    expect(object.create(late, alice, "items", { n: 1 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    const future = { ...base, opId: opId(NOW + ARTIFACT_DATA.clockSkewMs + 1) };
    expect(object.create(future, alice, "items", { n: 1 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    const committed = op(base);
    value(object.create(committed, alice, "items", { n: 1 }, ctx));
    const aborted = opId();
    expect(object.settle(base, visitorId("alice"), aborted, NOW)).toEqual({ state: "aborted" });
    const later = NOW + ARTIFACT_DATA.replayMs + 1;
    object.alarm(later);
    expect(object.durable.ops.size).toBe(0);
    object.evict();
    const after = context({ now: later });
    expect(object.create(committed, alice, "items", { n: 1 }, after)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(
      object.create({ ...base, opId: aborted }, alice, "items", { n: 2 }, after),
    ).toMatchObject({ ok: false, code: "conflict" });
    // A D1 restore rewinds the envelope the Worker sends, never the ID's issue time.
    expect(
      object.create({ ...committed, epoch: 0 }, alice, "items", { n: 1 }, after),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(object.durable.documents.size).toBe(1);
  });

  it("A05: the unique key holds on create and on replace", () => {
    const { object, base } = withCollection("append", { uniqueKey: "slot" });
    const one = value<{ _id: string }>(object.create(op(base), alice, "items", { slot: 1 }, ctx));
    value(object.create(op(base), alice, "items", { slot: 2 }, ctx));
    expect(object.create(op(base), alice, "items", { slot: 1 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(object.replace(op(base), alice, "items", one._id, { slot: 2 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(object.create(op(base), alice, "items", { other: 1 }, ctx)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    value(object.create(op(base), alice, "items", { slot: "1" }, ctx));
    value(object.create(op(base), bob, "items", { slot: 1 }, ctx));
    value(object.replace(op(base), alice, "items", one._id, { slot: 3 }, ctx));
    value(object.create(op(base), alice, "items", { slot: 1 }, ctx));
  });

  it("A06: every command, maintenance included, is refused for another artifact or region", () => {
    const { object, base } = withCollection("append");
    const doc = value<{ _id: string }>(object.create(op(base), alice, "items", { n: 1 }, ctx));
    for (const wrong of [
      { ...base, artifactId: "zzzzzzzz22" },
      { ...base, region: "eu" },
    ]) {
      const refusals = [
        object.declare(op(wrong), OWNER, { name: "x", mode: "own" }, ctx),
        object.indexStep(op(wrong), OWNER, ctx),
        object.create(op(wrong), alice, "items", { n: 1 }, ctx),
        object.replace(op(wrong), alice, "items", doc._id, { n: 2 }, ctx),
        object.remove(op(wrong), alice, "items", doc._id, ctx),
        object.bulkRemove(op(wrong), OWNER, "items", [doc._id], ctx),
        object.eraseAuthorChunk(op(wrong), visitorId("alice"), 10, ctx),
        object.get(wrong, alice, "items", doc._id, ctx),
        object.query(wrong, alice, { collection: "items" }, ctx),
        object.count(wrong, OWNER, { collection: "items" }, ctx),
        object.exportPage(wrong, OWNER, null, 10, ctx),
        object.exportPage(wrong, OWNER, null, 10, ctx, true),
        object.exportMine(wrong, alice, null, ctx),
        object.fence({ ...wrong, epoch: 1 }, { kind: "hold", transition: "t1" }, NOW),
        object.quarantine(wrong, "owner", NOW),
        object.prepareErase(wrong, opId(), NOW),
        object.connect(wrong, null, "p", NOW + 1_000, ctx),
      ];
      for (const refusal of refusals)
        expect(refusal).toMatchObject({ ok: false, code: "forbidden" });
      expect(object.settle(wrong, "owner:owner", opId(), NOW)).toEqual({
        state: "refused",
        code: "forbidden",
      });
      expect(object.acknowledge(wrong, "owner:owner", opId(), NOW)).toBe(false);
    }
    expect(object.durable.documents.size).toBe(1);
    expect(object.durable.control?.hold).toBeNull();
  });
});

describe("lifecycle", () => {
  it("A07: a fence is persisted before it is acknowledged, on an empty object too, checks the generation, and a repeated transition must carry the same contents", () => {
    const object = new MemoryObject();
    const held = envelope({ epoch: 3 });
    expect(object.fence(held, { kind: "hold", transition: "t_hold" }, NOW)).toMatchObject({
      ok: true,
      value: { held: true, epoch: 3 },
    });
    expect(object.durable.control).toMatchObject({
      epoch: 3,
      hold: { transition: "t_hold" },
      last: { id: "t_hold", kind: "hold" },
    });
    expect(object.fence(held, { kind: "hold", transition: "t_hold" }, NOW)).toMatchObject({
      ok: true,
    });
    expect(object.fence(held, { kind: "release", transition: "t_hold" }, NOW)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(
      object.fence({ ...held, epoch: 4 }, { kind: "hold", transition: "t_hold" }, NOW),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(
      object.fence(
        envelope({ epoch: 5, generation: 1 }),
        { kind: "release", transition: "t_r" },
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(
      object.fence(envelope({ epoch: 3 }), { kind: "release", transition: "t_r" }, NOW),
    ).toMatchObject({ ok: false, code: "stale" });
    expect(
      object.fence(envelope({ epoch: 5 }), { kind: "release", transition: "t_r" }, NOW),
    ).toMatchObject({ ok: true, value: { held: false } });
  });

  it("A08: a request with a newer epoch never consumes the epoch a pending fence needs", () => {
    const { object, base } = withCollection("append");
    const newer = { ...base, epoch: 1 };
    value(object.create(op(newer), alice, "items", { n: 1 }, ctx));
    value(object.query(newer, OWNER, { collection: "items" }, ctx));
    value(object.exportPage(newer, OWNER, null, 10, ctx));
    expect(object.durable.control?.epoch).toBe(0);
    expect(object.fence(newer, { kind: "hold", transition: "t_hold" }, NOW)).toMatchObject({
      ok: true,
      value: { held: true },
    });
  });

  it("A09: a hold refuses every payload erasure, quarantine resolution included, until a separately authorized release was acknowledged", () => {
    const { object, base } = withCollection("append");
    value(object.create(op(base), alice, "items", { n: 1 }, ctx));
    const held = { ...base, epoch: 1 };
    value(object.fence(held, { kind: "hold", transition: "t_hold" }, NOW));
    expect(object.prepareErase(held, opId(), NOW)).toMatchObject({ ok: false, code: "held" });
    expect(object.eraseAuthorChunk(op(held), visitorId("alice"), 10, ctx)).toMatchObject({
      ok: false,
      code: "held",
    });
    value(object.quarantine(held, "owner", NOW));
    expect(object.resolveQuarantine(held, "erase", NOW)).toMatchObject({ ok: false, code: "held" });
    // A transfer cannot end a hold either: only a release does.
    expect(
      object.fence(
        { ...base, epoch: 2 },
        { kind: "transfer", toOwner: "owner_b", transition: "t_move" },
        NOW,
      ),
    ).toMatchObject({ ok: false, code: "held" });
    expect(object.durable.documents.size).toBe(1);
    const released = { ...base, epoch: 2 };
    value(object.fence(released, { kind: "release", transition: "t_release" }, NOW));
    value(object.resolveQuarantine(released, "erase", NOW));
    expect(object.durable.documents.size).toBe(0);
    expect(object.durable.control?.generation).toBe(1);
  });

  it("A10: erase steps match their ID and target; a delayed step of another intent changes nothing; a retry answers the terminal result", () => {
    const { object, base } = withCollection("append");
    const [a, b, c] = [opId(), opId(), opId()];
    expect(value(object.prepareErase(base, a, NOW))).toEqual({ outcome: "prepared" });
    expect(value(object.prepareErase(base, a, NOW))).toEqual({ outcome: "prepared" });
    expect(object.prepareErase(base, b, NOW)).toMatchObject({ ok: false, code: "conflict" });
    expect(object.commitErase(base, b, NOW)).toMatchObject({ ok: false, code: "conflict" });
    expect(value(object.cancelErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
    value(object.prepareErase(base, b, NOW));
    value(object.cancelErase(base, b, NOW));
    value(object.prepareErase(base, c, NOW));
    // Delayed steps of the earlier intents: each answers how it ended and changes nothing.
    const control = structuredClone(object.durable.control);
    expect(value(object.prepareErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
    expect(value(object.cancelErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
    expect(value(object.commitErase(base, b, NOW))).toEqual({ outcome: "cancelled" });
    expect(object.durable.control).toEqual(control);
    expect(value(object.commitErase(base, c, NOW))).toEqual({ outcome: "committed" });
    expect(value(object.commitErase(base, c, NOW))).toEqual({ outcome: "committed" });
    expect(value(object.prepareErase({ ...base, generation: 0 }, opId(), NOW))).toEqual({
      outcome: "superseded",
    });
  });

  it("A11: a commit deletes the payload and writes the next generation in one transaction, keeps control state, and an earlier erase's retry never deletes later data", () => {
    const { object, base } = withCollection("append");
    const owned = op(base);
    value(object.create(owned, OWNER, "items", { n: 1 }, ctx));
    value(object.eraseAuthorChunk(op(base), visitorId("gone"), 10, ctx));
    const erase = opId();
    value(object.prepareErase(base, erase, NOW));
    object.faults.afterWork = () => false;
    value(object.commitErase(base, erase, NOW));
    const next = { ...base, generation: 1 };
    expect(object.durable.control).toMatchObject({
      generation: 1,
      erasing: null,
      lastErase: { id: erase, outcome: "committed" },
    });
    expect(
      object.durable.documents.size + object.durable.collections.size + object.durable.ops.size,
    ).toBe(0);
    expect(object.durable.barriers.has(visitorId("gone"))).toBe(true);
    expect(object.durable.audit.size).toBeGreaterThan(0);
    expect(object.durable.days.size).toBe(1);
    value(object.declare(op(next), OWNER, { name: "items", mode: "append" }, ctx));
    value(object.create(op(next), alice, "items", { n: 2 }, ctx));
    expect(value(object.prepareErase(base, erase, NOW))).toEqual({ outcome: "committed" });
    expect(value(object.commitErase(base, erase, NOW))).toEqual({ outcome: "committed" });
    expect(value(object.commitErase(base, opId(), NOW))).toEqual({ outcome: "superseded" });
    expect(object.durable.documents.size).toBe(1);
  });

  it("A12: after a restore a former owner is refused at any epoch, mismatches quarantine, a prepared erase resumes under its ID, and objects without a row are quarantined", () => {
    const object = new MemoryObject();
    const old = envelope({ ownerId: "owner_old" });
    value(object.declare(op(old), OWNER, { name: "items", mode: "append" }, ctx));
    value(
      object.fence(
        { ...old, epoch: 5 },
        { kind: "transfer", toOwner: "owner_new", transition: "t_move" },
        NOW,
      ),
    );
    for (const epoch of [0, 5, 6, 1_000]) {
      expect(object.query({ ...old, epoch }, OWNER, { collection: "items" }, ctx)).toMatchObject({
        ok: false,
        code: "stale",
      });
    }
    const control = object.durable.control;
    expect(
      reconcile({ ownerId: "owner_old", generation: 0, epoch: 0, held: false }, control),
    ).toEqual({ action: "quarantine", reason: "owner" });
    expect(
      reconcile({ ownerId: "owner_new", generation: 0, epoch: 5, held: true }, control),
    ).toEqual({ action: "quarantine", reason: "hold" });
    expect(
      reconcile({ ownerId: "owner_new", generation: 0, epoch: 2, held: false }, control),
    ).toEqual({ action: "raise", generation: 0, epoch: 6 });
    expect(reconcile(null, control)).toEqual({ action: "quarantine", reason: "orphan" });
    const current = envelope({ ownerId: "owner_new", epoch: 5 });
    const erase = opId();
    value(object.prepareErase(current, erase, NOW));
    expect(
      reconcile(
        { ownerId: "owner_new", generation: 0, epoch: 1, held: false },
        object.durable.control,
      ),
    ).toEqual({ action: "resume_erase", eraseId: erase, generation: 0, epoch: 5 });
    value(object.quarantine(current, "orphan", NOW));
    expect(object.query(current, OWNER, { collection: "items" }, ctx)).toMatchObject({
      ok: false,
      code: "quarantined",
    });
    expect(
      reconcile(
        { ownerId: "owner_new", generation: 0, epoch: 5, held: false },
        object.durable.control,
      ),
    ).toEqual({ action: "operator" });
    expect(object.resolveQuarantine(old, "adopt", NOW)).toMatchObject({ ok: false, code: "stale" });
    value(object.resolveQuarantine(current, "adopt", NOW));
    expect(object.durable.control?.quarantine).toBeNull();
  });

  it("A13: the first durable write on an empty object binds its identity; an unauthorized caller writes nothing there", () => {
    const object = new MemoryObject();
    const base = envelope();
    const empty = structuredClone(object.durable);
    const attempts = [
      object.create(op(base), alice, "items", { n: 1 }, ctx),
      object.create(op(base), OWNER, "items", { n: 1 }, ctx),
      object.declare(op(base), alice, { name: "items", mode: "own" }, ctx),
      object.declare(op(base), READER, { name: "items", mode: "own" }, ctx),
      object.indexStep(op(base), OWNER, ctx),
      object.bulkRemove(op(base), OWNER, "items", ["x"], ctx),
      object.remove(op(base), alice, "items", "x", ctx),
      object.connect(base, visitorId("alice"), "p", NOW + 1_000, ctx),
    ];
    for (const attempt of attempts) expect(attempt.ok).toBe(false);
    for (const read of [
      object.query(base, alice, { collection: "items" }, ctx),
      object.count(base, OWNER, { collection: "items" }, ctx),
      object.exportPage(base, OWNER, null, 10, ctx),
      object.exportMine(base, alice, null, ctx),
    ]) {
      expect(read.ok).toBe(true);
    }
    expect(
      object.settle(base, "owner:owner", `${NOW + ARTIFACT_DATA.clockSkewMs + 1}.future00`, NOW),
    ).toMatchObject({ state: "refused" });
    expect(rows(object.durable)).toEqual(rows(empty));
    value(object.declare(op(base), OWNER, { name: "items", mode: "own" }, ctx));
    expect(object.durable.control).toMatchObject({
      artifactId: base.artifactId,
      region: "default",
      ownerId: "owner_a",
    });
    expect(
      object.declare(
        op({ ...base, artifactId: "zzzzzzzz22" }),
        OWNER,
        { name: "b", mode: "own" },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("A14: nothing is pruned and no pruning alarm is set under a hold or a quarantine; a release re-arms maintenance", () => {
    const { object, base } = withCollection("append");
    value(object.create(op(base), alice, "items", { n: 1 }, ctx));
    expect(object.durable.alarm).not.toBeNull();
    const held = { ...base, epoch: 1 };
    value(object.fence(held, { kind: "hold", transition: "t_hold" }, NOW));
    expect(object.durable.alarm).toBeNull();
    const later = NOW + 5 * DAY;
    expect(object.alarm(later)).toEqual({ pruned: 0 });
    expect(object.durable.alarm).toBeNull();
    expect(object.durable.ops.size).toBe(2);
    const released = { ...base, epoch: 2 };
    value(object.fence(released, { kind: "release", transition: "t_release" }, later));
    expect(object.durable.alarm).toBe(later + ARTIFACT_DATA.alarmFloorMs);
    expect(object.alarm(later).pruned).toBeGreaterThan(0);
    value(object.quarantine(released, "owner", later));
    expect(object.durable.alarm).toBeNull();
    expect(object.alarm(later + 5 * DAY)).toEqual({ pruned: 0 });
  });

  it("A15: no command awaits anything between its admission and its work", async () => {
    for (const [name, exported] of Object.entries(protocols)) {
      if (typeof exported === "function") {
        expect(exported.constructor.name, name).not.toBe("AsyncFunction");
      }
    }
    const { object, base } = withCollection("append");
    const answers: unknown[] = [
      object.create(op(base), alice, "items", { n: 1 }, ctx),
      object.query(base, alice, { collection: "items" }, ctx),
      object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t" }, NOW),
      object.prepareErase({ ...base, epoch: 1 }, opId(), NOW),
      object.settle(base, "owner:owner", opId(), NOW),
      admit(null, base, { kind: "request", create: false }),
    ];
    for (const answer of answers) expect(answer).not.toBeInstanceOf(Promise);
  });
});

describe("erasure", () => {
  it("A16: author erasure is terminal, on empty objects too, and leaves only the listed evidence", () => {
    const empty = new MemoryObject();
    const base = envelope();
    value(empty.eraseAuthorChunk(op(base), visitorId("gone"), 10, ctx));
    expect(empty.durable.barriers.get(visitorId("gone"))).toEqual({ at: NOW, complete: true });
    const { object } = withCollection("own");
    const gone = visitor("gone");
    const doc = value<{ _id: string }>(object.create(op(base), gone, "items", { n: 1 }, ctx));
    value(object.create(op(base), gone, "items", { n: 2 }, ctx));
    const socket = value(object.connect(base, visitorId("gone"), "grant:gone", NOW + 60_000, ctx));
    expect(value(object.eraseAuthorChunk(op(base), visitorId("gone"), 1, ctx))).toMatchObject({
      documents: 1,
      more: true,
    });
    expect(object.sockets.get(socket)?.closed).toBe(4410);
    // Between chunks every path that could recreate the author's state is refused.
    expect(object.create(op(base), gone, "items", { n: 3 }, ctx)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(
      object.replace(
        op(base),
        OWNER,
        "items",
        [...object.durable.documents.values()][0]?.id ?? "",
        { n: 4 },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(object.remove(op(base), gone, "items", doc._id, ctx)).toMatchObject({ ok: false });
    expect(object.connect(base, visitorId("gone"), "grant:gone", NOW + 60_000, ctx)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(object.query(base, gone, { collection: "items" }, ctx)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(object.exportMine(base, gone, null, ctx)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    while (
      value<{ more: boolean }>(object.eraseAuthorChunk(op(base), visitorId("gone"), 1, ctx)).more
    ) {
      // until the terminal chunk
    }
    expect(object.settle(base, visitorId("gone"), opId(), NOW)).toEqual({ state: "aborted" });
    expect(object.create(op(base), gone, "items", { n: 5 }, ctx).ok).toBe(false);
    expect(authorTraces(object, visitorId("gone"))).toEqual({
      documents: 0,
      edits: 0,
      sequences: 0,
      rates: 0,
      operations: 0,
      counts: 0,
      connections: 0,
      rights: 0,
      orphanValues: 0,
    });
    expect(object.durable.barriers.get(visitorId("gone"))?.complete).toBe(true);
    const evidence = [...object.durable.ops.values()].filter(
      (row) => row.actor === "system:erasure",
    );
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect(row.result).not.toBeNull();
    const audit = [...object.durable.audit.values()].filter(
      (row) => row.kind === "data.author_erased",
    );
    for (const row of audit) expect(Object.keys(row.detail).sort()).toEqual(["documents", "edits"]);
  });

  it("A17: erasing a creator deletes the document with others' edits; erasing an editor keeps it and marks the attribution erased", () => {
    const { object, base } = withCollection("shared");
    const byCreator = value<{ _id: string }>(
      object.create(op(base), alice, "items", { n: 1 }, ctx),
    );
    const byOther = value<{ _id: string }>(object.create(op(base), bob, "items", { n: 2 }, ctx));
    value(object.replace(op(base), bob, "items", byCreator._id, { n: 10 }, ctx));
    value(object.replace(op(base), alice, "items", byOther._id, { n: 20 }, ctx));
    while (
      value<{ more: boolean }>(object.eraseAuthorChunk(op(base), visitorId("alice"), 10, ctx)).more
    ) {
      // until done
    }
    expect(object.durable.documents.has(`items\u0000${byCreator._id}`)).toBe(false);
    const kept = value<Record<string, unknown>>(object.get(base, OWNER, "items", byOther._id, ctx));
    expect(kept).toMatchObject({ n: 20, _by: visitorId("bob"), _editedBy: "erased" });
  });

  it("A18: two racing first grants get one identity; a retired entry refuses every claim for its retention; a delayed first grant cannot revive the person", () => {
    // R2's conditional put: the first writer wins, the others read its entry.
    const bucket = new Map<string, JournalEntry>();
    const claim = (key: string, candidate: string) => {
      const existing = bucket.get(key) ?? null;
      if (existing === null) bucket.set(key, { visitorId: candidate, firstGrantAt: NOW });
      return claimOutcome(existing, candidate);
    };
    const key = protocols.journalKey("user_1", "abcdefgh23");
    const claims = [1, 2, 3, 4, 5].map((index) => claim(key, visitorId(`cand${index}`)));
    expect(new Set(claims.map((result) => value(result))).size).toBe(1);
    bucket.set(key, retired(bucket.get(key) ?? null, NOW));
    expect(claim(key, visitorId("later"))).toMatchObject({ ok: false, code: "forbidden" });
    const never = protocols.journalKey("user_1", "zzzzzzzz22");
    bucket.set(never, retired(null, NOW));
    expect(claim(never, visitorId("delayed"))).toMatchObject({ ok: false, code: "forbidden" });
    const entry = bucket.get(key) as JournalEntry;
    // The longest a grant or code issued before the retirement can live: 30 days and 60 seconds.
    const longestGrant = 30 * DAY + 60_000;
    expect(journalPrunable(entry, NOW + longestGrant)).toBe(false);
    expect(journalPrunable(entry, NOW + ARTIFACT_DATA.journalRetiredMs)).toBe(true);
    expect(ARTIFACT_DATA.journalRetiredMs).toBeGreaterThan(longestGrant);
  });

  it("A19: author erasure chunks are bounded by work in every part, and a repeated chunk replays its counts", () => {
    const { object, base } = withCollection("append");
    const author = visitorId("many");
    for (let index = 0; index < 7; index++)
      value(object.create(op(base), visitor("many"), "items", { index }, ctx));
    const chunk = op(base);
    const first = value<{ documents: number; more: boolean }>(
      object.eraseAuthorChunk(chunk, author, 3, ctx),
    );
    expect(first).toEqual({ documents: 3, edits: 0, more: true });
    expect(object.eraseAuthorChunk(chunk, author, 3, ctx)).toMatchObject({
      ok: true,
      replayed: { result: { documents: 3, edits: 0, more: 1 } },
    });
    expect(object.durable.documents.size).toBe(4);
    expect(protocols.chunkSize(10_000)).toBe(ARTIFACT_DATA.caps.eraseChunkDocuments);
    // Seven operation records and seven rate rows of the author: each chunk deletes at most three.
    const before = authorTraces(object, author);
    value(object.eraseAuthorChunk(op(base), author, 3, ctx));
    const after = authorTraces(object, author);
    expect(before.documents - after.documents).toBeLessThanOrEqual(3);
    expect(before.operations - after.operations).toBeLessThanOrEqual(3);
    expect(before.rates - after.rates).toBeLessThanOrEqual(3);
  });
});

describe("counting and limits", () => {
  it("A20: every operation's measured work lands in its class's counter in its own transaction, or in the next for a failure after the work began", () => {
    const { object, base } = withCollection("append", { uniqueKey: "k" });
    value(object.create(op(base), alice, "items", { k: 1 }, ctx));
    expect(object.create(op(base), alice, "items", { k: 1 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    object.faults.afterWork = (kind) => kind === "create";
    expect(object.create(op(base), alice, "items", { k: 2 }, ctx)).toMatchObject({ ok: false });
    expect(object.durable.documents.size).toBe(1);
    for (const entry of object.charges) {
      expect(entry.dayAfter - entry.usedBefore).toBe(protocols.measuredCharge(entry.cost));
      expect(entry.cost.rowsRead + entry.cost.rowsWritten).toBeGreaterThan(0);
    }
    expect(object.charges.filter((entry) => entry.failed)).toHaveLength(2);
    // The failed attempts' rate rows stay: failed work is never free.
    expect(
      object.durable.rates.get(`${visitorId("alice")}\u0000writes\u0000${protocols.minuteOf(NOW)}`),
    ).toBe(3);
  });

  it("A21: a spent class refuses before any work and writes nothing; refusals are counted", () => {
    const tight = { ...ROOMY, rowsWrittenPerDay: 1 };
    const { object, base } = withCollection("append", { limits: tight });
    const durable = structuredClone(object.durable);
    for (let index = 0; index < 3; index++) {
      expect(
        object.create(op(base), alice, "items", { n: index }, context({ limits: tight })),
      ).toMatchObject({ ok: false, code: "quota_exceeded" });
    }
    expect(rows(object.durable)).toEqual(rows(durable));
    expect(object.pending.refused).toBe(3);
    object.alarm(NOW);
    expect(object.durable.days.get(protocols.dayOf(NOW))?.refused).toBe(3);
  });

  it("A22: one operation's overshoot is at most its own charge, within its stated bound", () => {
    const tight = { ...ROOMY, rowsWrittenPerDay: 60 };
    const { object, base } = withCollection("append", { limits: tight });
    const limit = context({ limits: tight });
    let refused = 0;
    for (let index = 0; index < 20; index++) {
      if (!object.create(op(base), alice, "items", { n: index }, limit).ok) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    const growth = object.charges.filter((entry) => entry.charge === "growth");
    for (const entry of growth) expect(entry.usedBefore).toBeLessThan(tight.rowsWrittenPerDay);
    const last = growth.at(-1) as (typeof growth)[number];
    expect(last.dayAfter - tight.rowsWrittenPerDay).toBeLessThanOrEqual(
      protocols.measuredCharge(last.cost),
    );
    for (const entry of object.charges) {
      const kind = entry.kind as keyof typeof OPERATION_ROW_BOUNDS;
      expect(protocols.withinBound(kind, entry.cost), kind).toBe(true);
    }
  });

  it("A23: an index over existing documents is built in bounded steps, and queries on it are refused until it is built", () => {
    const { object, base } = withCollection("append");
    const documents = ARTIFACT_DATA.caps.indexStepDocuments * 2 + 7;
    for (let index = 0; index < documents; index++)
      value(object.create(op(base), OWNER, "items", { tag: index % 3 }, ctx));
    const declared = object.declare(
      op(base),
      OWNER,
      { name: "items", mode: "append", indexed: ["tag"] },
      ctx,
    );
    expect(value(declared)).toEqual({ building: 1 });
    expect(
      object.query(base, OWNER, { collection: "items", equals: { field: "tag", value: 1 } }, ctx),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    let steps = 1;
    let building = 1;
    while (building > 0) {
      building = value<{ building: number }>(object.indexStep(op(base), OWNER, ctx)).building;
      steps += 1;
    }
    expect(steps).toBe(Math.ceil(documents / ARTIFACT_DATA.caps.indexStepDocuments));
    for (const entry of object.charges.filter(
      (item) => item.kind === "index_step" || item.kind === "declare",
    )) {
      // A step reads each document it covers, its value and its count once, never every document.
      expect(entry.cost.rowsRead).toBeLessThanOrEqual(
        3 * ARTIFACT_DATA.caps.indexStepDocuments + protocols.COMMAND_ROWS,
      );
      expect(protocols.withinBound(entry.kind as protocols.OperationKind, entry.cost)).toBe(true);
    }
    const page = value<{ documents: { tag: number }[] }>(
      object.query(
        base,
        OWNER,
        { collection: "items", equals: { field: "tag", value: 1 }, limit: 100 },
        ctx,
      ),
    );
    expect(page.documents).toHaveLength(100);
    expect(page.documents.every((doc) => doc.tag === 1)).toBe(true);
  });

  it("A24: reads write no row per request, and an eviction loses at most the stated flush", () => {
    const { object, base } = withCollection("append");
    const doc = value<{ _id: string }>(object.create(op(base), alice, "items", { n: 1 }, ctx));
    const durable = structuredClone(object.durable);
    for (let index = 0; index < 50; index++) {
      expect(object.get(base, alice, "items", doc._id, ctx).cost.rowsWritten).toBe(0);
    }
    expect(rows(object.durable)).toEqual(rows(durable));
    expect(object.pending.rows).toBeGreaterThan(0);
    expect(object.pending.rows).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
    object.evict();
    expect(object.pending.rows).toBe(0);
    let reads = 0;
    while (
      object.durable.days.get(protocols.dayOf(NOW))?.read ===
      durable.days.get(protocols.dayOf(NOW))?.read
    ) {
      value(object.get(base, alice, "items", doc._id, ctx));
      reads += 1;
    }
    expect(object.pending.rows).toBe(0);
    expect(reads).toBeLessThanOrEqual(ARTIFACT_DATA.readFlush.rows);
    value(object.get(base, alice, "items", doc._id, ctx));
    const flushedAt = object.durable.days.get(protocols.dayOf(NOW))?.read;
    value(
      object.get(base, alice, "items", doc._id, context({ now: NOW + ARTIFACT_DATA.readFlush.ms })),
    );
    expect(object.durable.days.get(protocols.dayOf(NOW))?.read).toBeGreaterThan(flushedAt ?? 0);
  });

  it("A25: cleanup, export and rights never meet the growth counter; a visitor deletes and exports their own when the shared counters are spent, without write permission", () => {
    const limits = {
      ...ROOMY,
      rowsWrittenPerDay: 200,
      cleanupRowsPerDay: 50,
      exportRowsPerDay: 50,
    };
    const tight = context({ limits });
    const { object, base } = withCollection("append", { limits });
    const mine = value<{ _id: string }>(object.create(op(base), alice, "items", { n: 1 }, tight));
    const other = value<{ _id: string }>(object.create(op(base), bob, "items", { n: 2 }, tight));
    const fills: string[] = [];
    for (;;) {
      const filled = object.create(op(base), OWNER, "items", { fill: true }, tight);
      if (!filled.ok) break;
      fills.push(value<{ _id: string }>(filled)._id);
    }
    while (object.exportPage(base, OWNER, null, 500, tight).ok) {
      // spend export
    }
    for (const id of fills) {
      if (!object.remove(op(base), OWNER, "items", id, tight).ok) break;
    }
    expect(object.remove(op(base), OWNER, "items", other._id, tight)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    const readOnly = visitor("alice", false);
    expect(
      value<{ rows: unknown[] }>(object.exportMine(base, readOnly, null, tight)).rows,
    ).toHaveLength(1);
    value(object.remove(op(base), readOnly, "items", mine._id, tight));
    const day = object.durable.days.get(protocols.dayOf(NOW));
    expect(day?.rights).toBeGreaterThan(0);
    expect(object.create(op(base), alice, "items", { n: 3 }, tight)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("A26: shrinking replacements are under the author's write rate", () => {
    const limits = { ...ROOMY, writesPerAuthorPerMinute: 3 };
    const { object, base } = withCollection("append", { limits });
    const doc = value<{ _id: string }>(
      object.create(op(base), alice, "items", { text: "long text" }, context({ limits })),
    );
    value(
      object.replace(op(base), alice, "items", doc._id, { text: "short" }, context({ limits })),
    );
    value(object.replace(op(base), alice, "items", doc._id, { text: "s" }, context({ limits })));
    expect(object.charges.at(-1)?.charge).toBe("cleanup");
    expect(
      object.replace(op(base), alice, "items", doc._id, { t: "" }, context({ limits })),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    value(
      object.replace(
        op(base),
        alice,
        "items",
        doc._id,
        { t: "" },
        context({ limits, now: NOW + 60_000 }),
      ),
    );
  });

  it("A27: counts come from maintained counters, retained data after a downgrade included", () => {
    const { object, base } = withCollection("append");
    for (let index = 0; index < 12; index++)
      value(object.create(op(base), index % 3 === 0 ? bob : alice, "items", { index }, ctx));
    const downgraded = context({ limits: { ...ROOMY, documentsPerCollection: 5 } });
    const counted = object.count(base, OWNER, { collection: "items" }, downgraded);
    expect(value(counted)).toEqual({ documents: 12 });
    // The control record, the collection and its counter: no document row.
    expect(counted.cost.rowsRead).toBeLessThanOrEqual(5);
    expect(
      value(object.count(base, OWNER, { collection: "items", by: visitorId("bob") }, downgraded)),
    ).toEqual({
      documents: 4,
    });
    expect(object.create(op(base), alice, "items", { n: 1 }, downgraded)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    expect(object.count(base, alice, { collection: "items" }, ctx)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});

describe("live, storage, audit, export", () => {
  it("A28: live messages are reserved against the day, renewal is bound to its principal, and every mutation and barrier reaches connections", () => {
    const limits = { ...ROOMY, liveMessagesPerDay: 150 };
    const { object, base } = withCollection("append", { limits });
    const live = context({ limits });
    const socket = value(object.connect(base, visitorId("bob"), "grant:bob", NOW + 60_000, live));
    object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
    expect(object.durable.days.get(protocols.dayOf(NOW))?.live).toBe(100);
    expect(object.renew(base, socket, "grant:other", NOW + 50_000, live)).toBe(false);
    expect(
      object.renew(
        base,
        socket,
        "grant:bob",
        NOW + 30_000,
        context({ limits: { ...limits, liveMessagesPerDay: 120 } }),
      ),
    ).toBe(true);
    expect(object.sockets.get(socket)?.attachment).toMatchObject({
      deadline: NOW + 30_000,
      liveMessagesPerDay: 120,
    });
    const created = value<{ _id: string }>(object.create(op(base), alice, "items", { n: 1 }, live));
    value(object.bulkRemove(op(base), OWNER, "items", [created._id], live));
    value(object.create(op(base), alice, "items", { n: 2 }, live));
    value(object.eraseAuthorChunk(op(base), visitorId("alice"), 10, live));
    const received = object.sockets.get(socket)?.received ?? [];
    expect(received.filter((message) => message.includes('"deleted"'))).toHaveLength(2);
    expect(received.filter((message) => message.includes('"created"'))).toHaveLength(2);
    // Survives hibernation: the deadline is in the attachment and closes the connection after it.
    object.message(socket, JSON.stringify({ subscribe: "items" }), NOW + 30_001);
    expect(object.sockets.get(socket)?.closed).toBe(4001);
    for (const close of [
      (o: MemoryObject, e: DataEnvelope) => o.prepareErase(e, opId(), NOW),
      (o: MemoryObject, e: DataEnvelope) =>
        o.fence({ ...e, epoch: 1 }, { kind: "epoch", transition: "t_e" }, NOW),
      (o: MemoryObject, e: DataEnvelope) =>
        o.fence(
          { ...e, epoch: 1 },
          { kind: "transfer", toOwner: "owner_b", transition: "t_t" },
          NOW,
        ),
      (o: MemoryObject, e: DataEnvelope) => o.quarantine(e, "owner", NOW),
    ]) {
      const fresh = withCollection("append");
      const open = value(fresh.object.connect(fresh.base, null, "reader", NOW + 60_000, ctx));
      close(fresh.object, fresh.base);
      expect(fresh.object.sockets.get(open)?.closed).toBe(4003);
    }
    const spent = withCollection("append", { limits: { ...ROOMY, liveMessagesPerDay: 1 } });
    const one = value(
      spent.object.connect(
        spent.base,
        null,
        "reader",
        NOW + 60_000,
        context({ limits: { ...ROOMY, liveMessagesPerDay: 1 } }),
      ),
    );
    spent.object.message(one, JSON.stringify({ subscribe: "items" }), NOW);
    spent.object.message(one, JSON.stringify({ subscribe: "items" }), NOW);
    expect(spent.object.sockets.get(one)?.closed).toBe(4029);
    expect(spent.object.durable.days.get(protocols.dayOf(NOW))?.live).toBe(1);
  });

  it("A29: the storage sequence advances on every durable write and the payload revision only on document changes; reports order by generation then sequence", () => {
    const { object, base } = withCollection("append");
    const seen: number[] = [object.durable.control?.storageSeq ?? 0];
    const revisions: number[] = [object.durable.control?.payloadRevision ?? 0];
    const step = (expectPayload: boolean) => {
      seen.push(object.durable.control?.storageSeq ?? 0);
      revisions.push(object.durable.control?.payloadRevision ?? 0);
      expect(seen.at(-1)).toBeGreaterThan(seen.at(-2) ?? 0);
      expect((revisions.at(-1) ?? 0) > (revisions.at(-2) ?? 0)).toBe(expectPayload);
    };
    const doc = value<{ _id: string }>(object.create(op(base), alice, "items", { n: 1 }, ctx));
    step(true);
    value(object.exportPage(base, OWNER, null, 10, ctx));
    step(false);
    value(object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t1" }, NOW));
    step(false);
    value(object.remove(op({ ...base, epoch: 1 }), alice, "items", doc._id, ctx));
    step(true);
    const refused = object.create(op(base), alice, "items", { n: 1 }, ctx);
    expect(refused.storage.seq).toBe(seen.at(-1));
    expect(
      newerReport({ generation: 1, seq: 1, bytes: 0 }, { generation: 0, seq: 99, bytes: 0 }),
    ).toBe(false);
    expect(
      newerReport({ generation: 0, seq: 5, bytes: 0 }, { generation: 1, seq: 0, bytes: 0 }),
    ).toBe(true);
    expect(
      newerReport({ generation: 0, seq: 5, bytes: 0 }, { generation: 0, seq: 5, bytes: 9 }),
    ).toBe(false);
  });

  it("A30: every retained control class is pruned in bounded passes, and the next alarm covers every class", () => {
    const { object, base } = withCollection("append");
    for (let index = 0; index < ARTIFACT_DATA.caps.pruneRows + 3; index++) {
      value(
        object.create(op(base), alice, "items", { index }, context({ now: NOW + index * 120_000 })),
      );
    }
    const later = NOW + 4 * DAY;
    const records = object.durable.ops.size;
    object.alarm(later);
    expect(object.durable.ops.size).toBe(records - ARTIFACT_DATA.caps.pruneRows);
    expect(object.durable.alarm).toBeLessThanOrEqual(later + ARTIFACT_DATA.morePruneMs);
    object.alarm(later + ARTIFACT_DATA.morePruneMs);
    expect(object.durable.ops.size + object.durable.rates.size).toBe(0);
    const owned = op({ ...base }, later);
    value(object.create(owned, OWNER, "items", { n: 1 }, context({ now: later })));
    object.acknowledge(base, "owner:owner", owned.opId as string, later);
    // Following the alarms alone empties every retained class, and then no alarm is left.
    let wakes = 0;
    while (object.durable.alarm !== null && wakes < 50) {
      object.alarm(object.durable.alarm);
      wakes += 1;
    }
    const d = object.durable;
    expect([d.ops.size, d.ended.size, d.rates.size, d.days.size, d.alarm]).toEqual([
      0,
      0,
      0,
      0,
      null,
    ]);
    // Only the declaration's obligation, never delivered, is kept: pending evidence is not pruned.
    expect([...d.audit.values()].map((row) => [row.kind, row.state])).toEqual([
      ["data.collection_set", "pending"],
    ]);
  });

  it("A31: an audit obligation's key equals its mutation's; delivered and aborted are distinct; obligations survive a whole erase; an erased author's late settlement writes nothing", () => {
    const { object, base } = withCollection("append");
    const owned = op(base);
    value(object.create(owned, OWNER, "items", { n: 1 }, ctx));
    const key = protocols.operationKey("owner:owner", 0, owned.opId as string);
    expect(object.durable.audit.has(key)).toBe(true);
    expect(object.durable.ops.has(key)).toBe(true);
    expect(object.settle(base, "owner:owner", owned.opId as string, NOW)).toMatchObject({
      state: "committed",
      delivered: false,
    });
    expect(object.acknowledge(base, "owner:owner", owned.opId as string, NOW)).toBe(true);
    expect(object.acknowledge(base, "owner:owner", owned.opId as string, NOW)).toBe(false);
    expect(object.settle(base, "owner:owner", owned.opId as string, NOW)).toMatchObject({
      state: "committed",
      delivered: true,
    });
    const never = opId();
    expect(object.settle(base, "owner:owner", never, NOW)).toEqual({ state: "aborted" });
    expect(object.create({ ...base, opId: never }, OWNER, "items", { n: 2 }, ctx)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    const erase = opId();
    value(object.prepareErase(base, erase, NOW));
    value(object.commitErase(base, erase, NOW));
    expect(object.durable.audit.has(key)).toBe(true);
    expect(object.settle(base, "owner:owner", owned.opId as string, NOW)).toMatchObject({
      state: "committed",
    });
    const next = { ...base, generation: 1 };
    value(object.eraseAuthorChunk(op(next), visitorId("gone"), 10, ctx));
    const before = structuredClone(object.durable);
    expect(object.settle(next, visitorId("gone"), opId(), NOW)).toEqual({ state: "aborted" });
    expect(rows(object.durable)).toEqual(rows(before));
  });

  it("A32: the export is exact, in primary key order, byte-bounded and stable, the visitor's own export works, and the file loads into SQLite", () => {
    const object = new MemoryObject();
    const base = envelope();
    value(object.declare(op(base), OWNER, { name: "b", mode: "append", indexed: ["n"] }, ctx));
    value(object.declare(op(base), OWNER, { name: "a", mode: "own" }, ctx));
    const body = {
      big: 9007199254740991,
      text: 'é€😀"\\\n',
      nested: { list: [1, "x", null, true] },
      n: 0.1,
    };
    value(object.create(op(base), alice, "b", body, ctx));
    for (let index = 0; index < 80; index++)
      value(
        object.create(
          op(base),
          index % 2 ? alice : bob,
          "a",
          { index, pad: "x".repeat(15_000) },
          ctx,
        ),
      );
    const start = value<protocols.ExportPage>(object.exportPage(base, OWNER, null, 500, ctx));
    expect(start.bytes).toBeLessThanOrEqual(ARTIFACT_DATA.caps.exportBytes);
    expect(start.rows.length).toBeLessThan(81);
    const rows = [...start.rows];
    let next = start.next;
    while (next !== null) {
      const page = value<protocols.ExportPage>(object.exportPage(base, OWNER, next, 500, ctx));
      expect(page.revision).toBe(start.revision);
      rows.push(...page.rows);
      next = page.next;
    }
    expect(rows.map((row) => `${row.collection}/${row.id}`)).toEqual(
      [...rows].map((row) => `${row.collection}/${row.id}`).sort(),
    );
    expect(rows).toHaveLength(81);
    const mine = value<protocols.ExportPage>(object.exportMine(base, alice, null, ctx));
    expect(mine.rows.every((row) => row.by === visitorId("alice"))).toBe(true);
    const file =
      exportHeader({
        artifact: base.artifactId,
        generation: 0,
        revision: start.revision,
        collections: [
          { name: "a", mode: "own", uniqueKey: null, indexed: [] },
          { name: "b", mode: "append", uniqueKey: null, indexed: ["n"] },
        ],
      }) +
      rows.map(exportLine).join("") +
      exportFooter(start.revision, object.durable.control?.payloadRevision ?? -1, rows.length);
    const parsed = value<protocols.ExportFile>(parseExportFile(file));
    expect(parsed.footer.consistent).toBe(true);
    expect(parsed.rows.find((row) => row.collection === "b")?.body).toEqual(body);
    const stored = [...object.durable.documents.values()].find(
      (doc) => doc.collection === "b",
    )?.body;
    expect(file).toContain(`"body":${stored}}`);
    const database = new DatabaseSync(":memory:");
    database.exec(
      "create table documents (collection text, id text, by text, edited_by text, created integer, updated integer, body text)",
    );
    const insert = database.prepare("insert into documents values (?, ?, ?, ?, ?, ?, json(?))");
    for (const line of file.split("\n").slice(1, -2)) {
      const row = JSON.parse(line) as Record<string, unknown>;
      insert.run(
        String(row.collection),
        String(row.id),
        String(row.by),
        (row.editedBy as string | null) ?? null,
        Number(row.created),
        Number(row.updated),
        JSON.stringify(row.body),
      );
    }
    const loaded = database
      .prepare(
        "select json_extract(body, '$.text') as text, json_extract(body, '$.big') as big from documents where collection = 'b'",
      )
      .get() as { text: string; big: number };
    expect(loaded).toEqual({ text: body.text, big: body.big });
    expect((database.prepare("select count(*) as n from documents").get() as { n: number }).n).toBe(
      81,
    );
    database.close();
  });

  it("A33: every allowed query shape reads at most the page plus a few rows, dense, sparse or empty", () => {
    const { object, base } = withCollection("append", { indexed: ["tag"] });
    for (let index = 0; index < 400; index++) {
      value(
        object.create(
          op(base),
          index % 50 === 0 ? bob : alice,
          "items",
          { tag: index % 100 === 0 ? "rare" : "common" },
          ctx,
        ),
      );
    }
    const shapes = [
      { collection: "items" },
      { collection: "items", order: "-created" as const },
      { collection: "items", equals: { field: "_by", value: visitorId("bob") } },
      { collection: "items", equals: { field: "_by", value: visitorId("nobody") } },
      { collection: "items", equals: { field: "tag", value: "rare" } },
      { collection: "items", equals: { field: "tag", value: "none" } },
      {
        collection: "items",
        equals: { field: "tag", value: "common" },
        created: { op: "gte" as const, value: NOW },
      },
    ];
    for (const limit of [1, 20, 100]) {
      for (const shape of shapes) {
        const answer = object.query(base, OWNER, { ...shape, limit }, ctx);
        expect(answer.ok).toBe(true);
        // The page plus one, and fixed rows: the control record, the collection, its fields and the seek.
        expect(answer.cost.rowsRead).toBeLessThanOrEqual(limit + 1 + 7);
      }
    }
    for (const shape of [
      { collection: "items", equals: { field: "untracked", value: 1 } },
      { collection: "items", equals: { field: "_by", value: 1 } },
    ]) {
      expect(planQuery(shape, "append", OWNER, ["tag"])).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    }
    expect(
      planQuery(
        { collection: "items", equals: { field: "tag", value: "x".repeat(300) } },
        "append",
        OWNER,
        ["tag"],
      ),
    ).toMatchObject({ ok: false });
  });

  it("A34: the grant's start and redeem gates and its one-use, browser-bound codes", () => {
    const headers = (values: Record<string, string>) => new Headers(values);
    const navigate = { "Sec-Fetch-Mode": "navigate" };
    expect(
      beginGate(
        "GET",
        headers({ ...navigate, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "document" }),
      ),
    ).toBe("allowed");
    expect(
      beginGate(
        "GET",
        headers({ ...navigate, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe" }),
      ),
    ).toBe("allowed");
    expect(
      beginGate(
        "GET",
        headers({ ...navigate, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "document" }),
      ),
    ).toBe("refused");
    expect(
      redeemGate(
        "GET",
        headers({ ...navigate, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" }),
        "top",
      ),
    ).toBe("allowed");
    expect(
      redeemGate(
        "GET",
        headers({ ...navigate, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "document" }),
        "top",
      ),
    ).toBe("refused");
    expect(
      apiGate(headers({ "Sec-Fetch-Site": "same-site" }), "https://a.portifact.dev", false),
    ).toBe("refused");
    const pending = {
      codeHash: "c",
      nonceHash: "n",
      host: "abcdefgh23.portifact.dev",
      grantId: "g",
      expiresAt: NOW + 60_000,
      used: false,
    };
    const presented = { codeHash: "c", nonceHash: "n", host: "abcdefgh23.portifact.dev" };
    expect(redeemable(pending, presented, NOW)).toBe(true);
    expect(redeemable(pending, { ...presented, nonceHash: "attacker" }, NOW)).toBe(false);
    expect(redeemable({ ...pending, used: true }, presented, NOW)).toBe(false);
    expect(newControl(envelope(), NOW).last.kind).toBe("created");
  });
});
