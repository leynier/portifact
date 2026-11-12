// "Acceptance tests for delivery 3" of decision 0026, one named test per item (A01 is item 1),
// against the production decisions composed by the in-memory object (`src/testing`), which is the
// shape delivery 4's documents object takes over SQLite.
import {
  ARTIFACT_DATA,
  type DataEnvelope,
  type JournalEntry,
} from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import * as protocols from "../../artifact-data/index.ts";
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
import { authorTraces, rows } from "../artifact-data-object.ts";

/** Loads an export file into a SQLite database: one table, bodies through `json()`. */
export type LoadExport = (file: string) => Promise<{
  /** The `text` and `big` fields of collection `b`'s document, through `json_extract`. */
  b: { text: string; big: number };
  documents: number;
}>;

/** The SQL that loads an export file's document lines, shared by every loader. */
export const EXPORT_TABLE =
  "create table documents (collection text, id text, by text, edited_by text, created integer, updated integer, body text)";
export const EXPORT_INSERT = "insert into documents values (?, ?, ?, ?, ?, ?, json(?))";
export const EXPORT_SELECT =
  "select json_extract(body, '$.text') as text, json_extract(body, '$.big') as big from documents where collection = 'b'";
export const EXPORT_COUNT = "select count(*) as n from documents";

/** The insert's values for each document line of an export file. */
export function exportRows(file: string): (string | number | null)[][] {
  return file
    .split("\n")
    .slice(1, -2)
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      return [
        String(row.collection),
        String(row.id),
        String(row.by),
        (row.editedBy as string | null) ?? null,
        Number(row.created),
        Number(row.updated),
        JSON.stringify(row.body),
      ];
    });
}

export function acceptanceSuite(make: MakeObject, options: { loadExport: LoadExport }): void {
  const DAY = 86_400_000;
  const ctx = context();
  const alice = visitor("alice");
  const bob = visitor("bob");

  /** An object with one collection declared by the owner side. */
  async function withCollection(
    mode: "own" | "append" | "read" | "shared",
    options: { uniqueKey?: string; indexed?: string[]; limits?: typeof ROOMY } = {},
  ) {
    const object = await make();
    const base = envelope();
    const declaration = {
      name: "items",
      mode,
      ...(options.uniqueKey === undefined ? {} : { uniqueKey: options.uniqueKey }),
      ...(options.indexed === undefined ? {} : { indexed: options.indexed }),
    };
    value(
      await object.declare(
        op(base),
        OWNER,
        declaration,
        context({ limits: options.limits ?? ROOMY }),
      ),
    );
    return { object, base };
  }

  describe("identity, replay and authorization", () => {
    it("A01: a visitor never reaches another visitor's own documents by ID, filter, cursor or live fan-out, and sequences are per author", async () => {
      const { object, base } = await withCollection("own");
      const listening = value(
        await object.connect(base, visitorId("bob"), "grant:bob", NOW + 60_000, ctx),
      );
      await object.message(listening, JSON.stringify({ subscribe: "items" }), NOW);
      const before = (await object.view()).sockets.get(listening)?.received.length;
      const mine = value<{ _id: string; _seq: number }>(
        await object.create(op(base), alice, "items", { n: 1 }, ctx),
      );
      value(await object.create(op(base), bob, "items", { n: 2 }, ctx));
      const second = value<{ _seq: number }>(
        await object.create(op(base), alice, "items", { n: 3 }, ctx),
      );
      expect([mine._seq, second._seq]).toEqual([1, 2]);
      expect(await object.get(base, bob, "items", mine._id, ctx)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await object.replace(op(base), bob, "items", mine._id, { n: 9 }, ctx)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await object.remove(op(base), bob, "items", mine._id, ctx)).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(
        await object.query(
          base,
          bob,
          { collection: "items", equals: { field: "_by", value: visitorId("alice") } },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "invalid_input" });
      for (const order of ["created", "-created"] as const) {
        const pages = [
          await object.query(base, bob, { collection: "items", order, limit: 1 }, ctx),
        ];
        const cursor = protocols.encodeCursor(NOW - 1, "");
        pages.push(
          await object.query(base, bob, { collection: "items", order, after: cursor }, ctx),
        );
        pages.push(
          await object.query(
            base,
            bob,
            { collection: "items", created: { op: "gte", value: 0 } },
            ctx,
          ),
        );
        for (const page of pages) {
          for (const doc of value<{ documents: { _by: string }[] }>(page).documents) {
            expect(doc._by).toBe(visitorId("bob"));
          }
        }
      }
      expect(await object.query(base, READER, { collection: "items" }, ctx)).toMatchObject({
        ok: true,
        value: { documents: [] },
      });
      const heard = (await object.view()).sockets.get(listening)?.received.slice(before) ?? [];
      expect(heard.every((message) => message.includes(visitorId("bob")))).toBe(true);
      expect(heard).toHaveLength(1);
    });

    it("A02: an operation ID is the actor's own and bound to the request; replays answer after current authorization and hold no body", async () => {
      const { object, base } = await withCollection("append");
      const shared = op(base);
      const first = value<{ _id: string }>(
        await object.create(shared, alice, "items", { secret: "alice" }, ctx),
      );
      const other = await object.create(shared, bob, "items", { secret: "bob" }, ctx);
      expect(value<{ _id: string; secret: string }>(other).secret).toBe("bob");
      expect(await object.create(shared, alice, "items", { secret: "changed" }, ctx)).toMatchObject(
        {
          ok: false,
          code: "conflict",
        },
      );
      const replay = await object.create(shared, alice, "items", { secret: "alice" }, ctx);
      expect(replay).toMatchObject({
        ok: true,
        replayed: { kind: "document", target: `items/${first._id}` },
      });
      expect(JSON.stringify(replay)).not.toContain("secret");
      expect(
        await object.create(shared, visitor("alice", false), "items", { secret: "alice" }, ctx),
      ).toMatchObject({ ok: false, code: "forbidden" });
      for (const record of (await object.view()).durable.ops.values())
        expect(JSON.stringify(record)).not.toContain("secret");
      const keys = [...(await object.view()).durable.ops.keys()].filter((key) =>
        key.endsWith(`|0|${shared.opId}`),
      );
      expect(keys.sort()).toEqual([
        `${visitorId("alice")}|0|${shared.opId}`,
        `${visitorId("bob")}|0|${shared.opId}`,
      ]);
    });

    it("A03: a replay never applies, charges or notifies twice", async () => {
      const { object, base } = await withCollection("append");
      const socket = value(
        await object.connect(base, visitorId("bob"), "grant:bob", NOW + 60_000, ctx),
      );
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
      const once = op(base);
      value(await object.create(once, alice, "items", { n: 1 }, ctx));
      const days = structuredClone((await object.view()).durable.days);
      const heard = (await object.view()).sockets.get(socket)?.received.length;
      const seq = (await object.view()).durable.control?.storageSeq;
      for (let index = 0; index < 5; index++) {
        expect(await object.create(once, alice, "items", { n: 1 }, ctx)).toMatchObject({
          ok: true,
          replayed: {},
        });
      }
      expect((await object.view()).durable.documents.size).toBe(1);
      expect((await object.view()).durable.days).toEqual(days);
      expect((await object.view()).sockets.get(socket)?.received.length).toBe(heard);
      expect((await object.view()).durable.control?.storageSeq).toBe(seq);
      // A replay's own lookup is counted as reads, in memory: no attempt is free.
      const pending = (await object.view()).pending.rows;
      await object.create(once, alice, "items", { n: 1 }, ctx);
      expect((await object.view()).pending.rows).toBeGreaterThan(pending);
    });

    it("A04: an operation ID past the horizon or from the future is refused, and a pruned ID never applies again", async () => {
      const { object, base } = await withCollection("append");
      const late = { ...base, opId: opId(NOW - ARTIFACT_DATA.horizonMs - 1) };
      expect(await object.create(late, alice, "items", { n: 1 }, ctx)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      const future = { ...base, opId: opId(NOW + ARTIFACT_DATA.clockSkewMs + 1) };
      expect(await object.create(future, alice, "items", { n: 1 }, ctx)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      const committed = op(base);
      value(await object.create(committed, alice, "items", { n: 1 }, ctx));
      const aborted = opId();
      expect(await object.settle(base, visitorId("alice"), aborted, NOW)).toEqual({
        state: "aborted",
      });
      const later = NOW + ARTIFACT_DATA.replayMs + 1;
      await object.alarm(later);
      expect((await object.view()).durable.ops.size).toBe(0);
      await object.evict();
      const after = context({ now: later });
      expect(await object.create(committed, alice, "items", { n: 1 }, after)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(
        await object.create({ ...base, opId: aborted }, alice, "items", { n: 2 }, after),
      ).toMatchObject({ ok: false, code: "conflict" });
      // A D1 restore rewinds the envelope the Worker sends, never the ID's issue time.
      expect(
        await object.create({ ...committed, epoch: 0 }, alice, "items", { n: 1 }, after),
      ).toMatchObject({ ok: false, code: "conflict" });
      expect((await object.view()).durable.documents.size).toBe(1);
    });

    it("A05: the unique key holds on create and on replace", async () => {
      const { object, base } = await withCollection("append", { uniqueKey: "slot" });
      const one = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { slot: 1 }, ctx),
      );
      value(await object.create(op(base), alice, "items", { slot: 2 }, ctx));
      expect(await object.create(op(base), alice, "items", { slot: 1 }, ctx)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(
        await object.replace(op(base), alice, "items", one._id, { slot: 2 }, ctx),
      ).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(await object.create(op(base), alice, "items", { other: 1 }, ctx)).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
      value(await object.create(op(base), alice, "items", { slot: "1" }, ctx));
      value(await object.create(op(base), bob, "items", { slot: 1 }, ctx));
      value(await object.replace(op(base), alice, "items", one._id, { slot: 3 }, ctx));
      value(await object.create(op(base), alice, "items", { slot: 1 }, ctx));
    });

    it("A06: every command, maintenance included, is refused for another artifact or region", async () => {
      const { object, base } = await withCollection("append");
      const doc = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { n: 1 }, ctx),
      );
      for (const wrong of [
        { ...base, artifactId: "zzzzzzzz22" },
        { ...base, region: "eu" },
      ]) {
        const refusals = [
          await object.declare(op(wrong), OWNER, { name: "x", mode: "own" }, ctx),
          await object.indexStep(op(wrong), OWNER, ctx),
          await object.create(op(wrong), alice, "items", { n: 1 }, ctx),
          await object.replace(op(wrong), alice, "items", doc._id, { n: 2 }, ctx),
          await object.remove(op(wrong), alice, "items", doc._id, ctx),
          await object.bulkRemove(op(wrong), OWNER, "items", [doc._id], ctx),
          await object.eraseAuthorChunk(op(wrong), visitorId("alice"), 10, ctx),
          await object.get(wrong, alice, "items", doc._id, ctx),
          await object.query(wrong, alice, { collection: "items" }, ctx),
          await object.count(wrong, OWNER, { collection: "items" }, ctx),
          await object.exportPage(wrong, OWNER, null, 10, ctx),
          await object.exportPage(wrong, OWNER, null, 10, ctx, true),
          await object.exportMine(wrong, alice, null, ctx),
          await object.fence({ ...wrong, epoch: 1 }, { kind: "hold", transition: "t1" }, NOW),
          await object.quarantine(wrong, "owner", NOW),
          await object.prepareErase(wrong, opId(), NOW),
          await object.connect(wrong, null, "p", NOW + 1_000, ctx),
        ];
        for (const refusal of refusals)
          expect(refusal).toMatchObject({ ok: false, code: "forbidden" });
        expect(await object.settle(wrong, "owner:owner", opId(), NOW)).toEqual({
          state: "refused",
          code: "forbidden",
        });
        expect(await object.acknowledge(wrong, "owner:owner", opId(), NOW)).toBe(false);
      }
      expect((await object.view()).durable.documents.size).toBe(1);
      expect((await object.view()).durable.control?.hold).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("A07: a fence is persisted before it is acknowledged, on an empty object too, checks the generation, and a repeated transition must carry the same contents", async () => {
      const object = await make();
      const held = envelope({ epoch: 3 });
      expect(await object.fence(held, { kind: "hold", transition: "t_hold" }, NOW)).toMatchObject({
        ok: true,
        value: { held: true, epoch: 3 },
      });
      expect((await object.view()).durable.control).toMatchObject({
        epoch: 3,
        hold: { transition: "t_hold" },
        last: { id: "t_hold", kind: "hold" },
      });
      expect(await object.fence(held, { kind: "hold", transition: "t_hold" }, NOW)).toMatchObject({
        ok: true,
      });
      expect(
        await object.fence(held, { kind: "release", transition: "t_hold" }, NOW),
      ).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(
        await object.fence({ ...held, epoch: 4 }, { kind: "hold", transition: "t_hold" }, NOW),
      ).toMatchObject({ ok: false, code: "conflict" });
      expect(
        await object.fence(
          envelope({ epoch: 5, generation: 1 }),
          { kind: "release", transition: "t_r" },
          NOW,
        ),
      ).toMatchObject({ ok: false, code: "stale" });
      expect(
        await object.fence(envelope({ epoch: 3 }), { kind: "release", transition: "t_r" }, NOW),
      ).toMatchObject({ ok: false, code: "stale" });
      expect(
        await object.fence(envelope({ epoch: 5 }), { kind: "release", transition: "t_r" }, NOW),
      ).toMatchObject({ ok: true, value: { held: false } });
    });

    it("A08: a request with a newer epoch never consumes the epoch a pending fence needs", async () => {
      const { object, base } = await withCollection("append");
      const newer = { ...base, epoch: 1 };
      value(await object.create(op(newer), alice, "items", { n: 1 }, ctx));
      value(await object.query(newer, OWNER, { collection: "items" }, ctx));
      value(await object.exportPage(newer, OWNER, null, 10, ctx));
      expect((await object.view()).durable.control?.epoch).toBe(0);
      expect(await object.fence(newer, { kind: "hold", transition: "t_hold" }, NOW)).toMatchObject({
        ok: true,
        value: { held: true },
      });
    });

    it("A09: a hold refuses every payload erasure, quarantine resolution included, until a separately authorized release was acknowledged", async () => {
      const { object, base } = await withCollection("append");
      value(await object.create(op(base), alice, "items", { n: 1 }, ctx));
      const held = { ...base, epoch: 1 };
      value(await object.fence(held, { kind: "hold", transition: "t_hold" }, NOW));
      expect(await object.prepareErase(held, opId(), NOW)).toMatchObject({
        ok: false,
        code: "held",
      });
      expect(await object.eraseAuthorChunk(op(held), visitorId("alice"), 10, ctx)).toMatchObject({
        ok: false,
        code: "held",
      });
      value(await object.quarantine(held, "owner", NOW));
      expect(await object.resolveQuarantine(held, "erase", NOW)).toMatchObject({
        ok: false,
        code: "held",
      });
      // A transfer cannot end a hold either: only a release does.
      expect(
        await object.fence(
          { ...base, epoch: 2 },
          { kind: "transfer", toOwner: "owner_b", transition: "t_move" },
          NOW,
        ),
      ).toMatchObject({ ok: false, code: "held" });
      expect((await object.view()).durable.documents.size).toBe(1);
      const released = { ...base, epoch: 2 };
      value(await object.fence(released, { kind: "release", transition: "t_release" }, NOW));
      value(await object.resolveQuarantine(released, "erase", NOW));
      expect((await object.view()).durable.documents.size).toBe(0);
      expect((await object.view()).durable.control?.generation).toBe(1);
    });

    it("A10: erase steps match their ID and target; a delayed step of another intent changes nothing; a retry answers the terminal result", async () => {
      const { object, base } = await withCollection("append");
      const [a, b, c] = [opId(), opId(), opId()];
      expect(value(await object.prepareErase(base, a, NOW))).toEqual({ outcome: "prepared" });
      expect(value(await object.prepareErase(base, a, NOW))).toEqual({ outcome: "prepared" });
      expect(await object.prepareErase(base, b, NOW)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(await object.commitErase(base, b, NOW)).toMatchObject({ ok: false, code: "conflict" });
      expect(value(await object.cancelErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
      value(await object.prepareErase(base, b, NOW));
      value(await object.cancelErase(base, b, NOW));
      value(await object.prepareErase(base, c, NOW));
      // Delayed steps of the earlier intents: each answers how it ended and changes nothing.
      const control = structuredClone((await object.view()).durable.control);
      expect(value(await object.prepareErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
      expect(value(await object.cancelErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
      expect(value(await object.commitErase(base, b, NOW))).toEqual({ outcome: "cancelled" });
      expect((await object.view()).durable.control).toEqual(control);
      expect(value(await object.commitErase(base, c, NOW))).toEqual({ outcome: "committed" });
      expect(value(await object.commitErase(base, c, NOW))).toEqual({ outcome: "committed" });
      expect(value(await object.prepareErase({ ...base, generation: 0 }, opId(), NOW))).toEqual({
        outcome: "superseded",
      });
    });

    it("A11: a commit deletes the payload and writes the next generation in one transaction, keeps control state, and an earlier erase's retry never deletes later data", async () => {
      const { object, base } = await withCollection("append");
      const owned = op(base);
      value(await object.create(owned, OWNER, "items", { n: 1 }, ctx));
      value(await object.eraseAuthorChunk(op(base), visitorId("gone"), 10, ctx));
      const erase = opId();
      value(await object.prepareErase(base, erase, NOW));
      await object.setFaults({ afterWork: () => false });
      value(await object.commitErase(base, erase, NOW));
      const next = { ...base, generation: 1 };
      expect((await object.view()).durable.control).toMatchObject({
        generation: 1,
        erasing: null,
        lastErase: { id: erase, outcome: "committed" },
      });
      expect(
        (await object.view()).durable.documents.size +
          (await object.view()).durable.collections.size +
          (await object.view()).durable.ops.size,
      ).toBe(0);
      expect((await object.view()).durable.barriers.has(visitorId("gone"))).toBe(true);
      expect((await object.view()).durable.audit.size).toBeGreaterThan(0);
      expect((await object.view()).durable.days.size).toBe(1);
      value(await object.declare(op(next), OWNER, { name: "items", mode: "append" }, ctx));
      value(await object.create(op(next), alice, "items", { n: 2 }, ctx));
      expect(value(await object.prepareErase(base, erase, NOW))).toEqual({ outcome: "committed" });
      expect(value(await object.commitErase(base, erase, NOW))).toEqual({ outcome: "committed" });
      expect(value(await object.commitErase(base, opId(), NOW))).toEqual({ outcome: "superseded" });
      expect((await object.view()).durable.documents.size).toBe(1);
    });

    it("A12: after a restore a former owner is refused at any epoch, mismatches quarantine, a prepared erase resumes under its ID, and objects without a row are quarantined", async () => {
      const object = await make();
      const old = envelope({ ownerId: "owner_old" });
      value(await object.declare(op(old), OWNER, { name: "items", mode: "append" }, ctx));
      value(
        await object.fence(
          { ...old, epoch: 5 },
          { kind: "transfer", toOwner: "owner_new", transition: "t_move" },
          NOW,
        ),
      );
      for (const epoch of [0, 5, 6, 1_000]) {
        expect(
          await object.query({ ...old, epoch }, OWNER, { collection: "items" }, ctx),
        ).toMatchObject({
          ok: false,
          code: "stale",
        });
      }
      const control = (await object.view()).durable.control;
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
      value(await object.prepareErase(current, erase, NOW));
      expect(
        reconcile(
          { ownerId: "owner_new", generation: 0, epoch: 1, held: false },
          (await object.view()).durable.control,
        ),
      ).toEqual({ action: "resume_erase", eraseId: erase, generation: 0, epoch: 5 });
      value(await object.quarantine(current, "orphan", NOW));
      expect(await object.query(current, OWNER, { collection: "items" }, ctx)).toMatchObject({
        ok: false,
        code: "quarantined",
      });
      expect(
        reconcile(
          { ownerId: "owner_new", generation: 0, epoch: 5, held: false },
          (await object.view()).durable.control,
        ),
      ).toEqual({ action: "operator" });
      expect(await object.resolveQuarantine(old, "adopt", NOW)).toMatchObject({
        ok: false,
        code: "stale",
      });
      value(await object.resolveQuarantine(current, "adopt", NOW));
      expect((await object.view()).durable.control?.quarantine).toBeNull();
    });

    it("A13: the first durable write on an empty object binds its identity; an unauthorized caller writes nothing there", async () => {
      const object = await make();
      const base = envelope();
      const empty = structuredClone((await object.view()).durable);
      const attempts = [
        await object.create(op(base), alice, "items", { n: 1 }, ctx),
        await object.create(op(base), OWNER, "items", { n: 1 }, ctx),
        await object.declare(op(base), alice, { name: "items", mode: "own" }, ctx),
        await object.declare(op(base), READER, { name: "items", mode: "own" }, ctx),
        await object.indexStep(op(base), OWNER, ctx),
        await object.bulkRemove(op(base), OWNER, "items", ["x"], ctx),
        await object.remove(op(base), alice, "items", "x", ctx),
        await object.connect(base, visitorId("alice"), "p", NOW + 1_000, ctx),
      ];
      for (const attempt of attempts) expect(attempt.ok).toBe(false);
      for (const read of [
        await object.query(base, alice, { collection: "items" }, ctx),
        await object.count(base, OWNER, { collection: "items" }, ctx),
        await object.exportPage(base, OWNER, null, 10, ctx),
        await object.exportMine(base, alice, null, ctx),
      ]) {
        expect(read.ok).toBe(true);
      }
      expect(
        await object.settle(
          base,
          "owner:owner",
          `${NOW + ARTIFACT_DATA.clockSkewMs + 1}.future00`,
          NOW,
        ),
      ).toMatchObject({ state: "refused" });
      expect(rows((await object.view()).durable)).toEqual(rows(empty));
      value(await object.declare(op(base), OWNER, { name: "items", mode: "own" }, ctx));
      expect((await object.view()).durable.control).toMatchObject({
        artifactId: base.artifactId,
        region: "default",
        ownerId: "owner_a",
      });
      expect(
        await object.declare(
          op({ ...base, artifactId: "zzzzzzzz22" }),
          OWNER,
          { name: "b", mode: "own" },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "forbidden" });
    });

    it("A14: nothing is pruned and no pruning alarm is set under a hold or a quarantine; a release re-arms maintenance", async () => {
      const { object, base } = await withCollection("append");
      value(await object.create(op(base), alice, "items", { n: 1 }, ctx));
      expect((await object.view()).durable.alarm).not.toBeNull();
      const held = { ...base, epoch: 1 };
      value(await object.fence(held, { kind: "hold", transition: "t_hold" }, NOW));
      expect((await object.view()).durable.alarm).toBeNull();
      const later = NOW + 5 * DAY;
      expect(await object.alarm(later)).toEqual({ pruned: 0 });
      expect((await object.view()).durable.alarm).toBeNull();
      expect((await object.view()).durable.ops.size).toBe(2);
      const released = { ...base, epoch: 2 };
      value(await object.fence(released, { kind: "release", transition: "t_release" }, later));
      expect((await object.view()).durable.alarm).toBe(later + ARTIFACT_DATA.alarmFloorMs);
      expect((await object.alarm(later)).pruned).toBeGreaterThan(0);
      value(await object.quarantine(released, "owner", later));
      expect((await object.view()).durable.alarm).toBeNull();
      expect(await object.alarm(later + 5 * DAY)).toEqual({ pruned: 0 });
    });

    it("A15: no command awaits anything between its admission and its work", async () => {
      for (const [name, exported] of Object.entries(protocols)) {
        if (typeof exported === "function") {
          expect(exported.constructor.name, name).not.toBe("AsyncFunction");
        }
      }
      const { object, base } = await withCollection("append");
      const commands: (() => unknown)[] = [
        () => object.create(op(base), alice, "items", { n: 1 }, ctx),
        () => object.query(base, alice, { collection: "items" }, ctx),
        () => object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t" }, NOW),
        () => object.prepareErase({ ...base, epoch: 1 }, opId(), NOW),
        () => object.settle(base, "owner:owner", opId(), NOW),
      ];
      for (const command of commands) {
        const answer = command();
        // Checked before any await. The real object's driver is an asynchronous transport, so
        // its store's synchronous answers are asserted inside the object (apps/data, storage).
        if (object.kind === "memory") {
          expect(typeof (answer as { then?: unknown } | null)?.then).not.toBe("function");
        }
        await answer;
      }
      expect(admit(null, base, { kind: "request", create: false })).not.toBeInstanceOf(Promise);
    });
  });

  describe("erasure", () => {
    it("A16: author erasure is terminal, on empty objects too, and leaves only the listed evidence", async () => {
      const empty = await make();
      const base = envelope();
      value(await empty.eraseAuthorChunk(op(base), visitorId("gone"), 10, ctx));
      expect((await empty.view()).durable.barriers.get(visitorId("gone"))).toEqual({
        at: NOW,
        complete: true,
      });
      const { object } = await withCollection("own");
      const gone = visitor("gone");
      const doc = value<{ _id: string }>(
        await object.create(op(base), gone, "items", { n: 1 }, ctx),
      );
      value(await object.create(op(base), gone, "items", { n: 2 }, ctx));
      const socket = value(
        await object.connect(base, visitorId("gone"), "grant:gone", NOW + 60_000, ctx),
      );
      expect(
        value(await object.eraseAuthorChunk(op(base), visitorId("gone"), 1, ctx)),
      ).toMatchObject({
        documents: 1,
        more: true,
      });
      expect((await object.view()).sockets.get(socket)?.closed).toBe(4410);
      // Between chunks every path that could recreate the author's state is refused.
      expect(await object.create(op(base), gone, "items", { n: 3 }, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(
        await object.replace(
          op(base),
          OWNER,
          "items",
          [...(await object.view()).durable.documents.values()][0]?.id ?? "",
          { n: 4 },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "conflict" });
      expect(await object.remove(op(base), gone, "items", doc._id, ctx)).toMatchObject({
        ok: false,
      });
      expect(
        await object.connect(base, visitorId("gone"), "grant:gone", NOW + 60_000, ctx),
      ).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await object.query(base, gone, { collection: "items" }, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await object.exportMine(base, gone, null, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      while (
        value<{ more: boolean }>(await object.eraseAuthorChunk(op(base), visitorId("gone"), 1, ctx))
          .more
      ) {
        // until the terminal chunk
      }
      expect(await object.settle(base, visitorId("gone"), opId(), NOW)).toEqual({
        state: "aborted",
      });
      expect((await object.create(op(base), gone, "items", { n: 5 }, ctx)).ok).toBe(false);
      expect(authorTraces(await object.view(), visitorId("gone"))).toEqual({
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
      expect((await object.view()).durable.barriers.get(visitorId("gone"))?.complete).toBe(true);
      const evidence = [...(await object.view()).durable.ops.values()].filter(
        (row) => row.actor === "system:erasure",
      );
      expect(evidence.length).toBeGreaterThan(0);
      for (const row of evidence) expect(row.result).not.toBeNull();
      const audit = [...(await object.view()).durable.audit.values()].filter(
        (row) => row.kind === "data.author_erased",
      );
      for (const row of audit)
        expect(Object.keys(row.detail).sort()).toEqual(["documents", "edits"]);
    });

    it("A17: erasing a creator deletes the document with others' edits; erasing an editor keeps it and marks the attribution erased", async () => {
      const { object, base } = await withCollection("shared");
      const byCreator = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { n: 1 }, ctx),
      );
      const byOther = value<{ _id: string }>(
        await object.create(op(base), bob, "items", { n: 2 }, ctx),
      );
      value(await object.replace(op(base), bob, "items", byCreator._id, { n: 10 }, ctx));
      value(await object.replace(op(base), alice, "items", byOther._id, { n: 20 }, ctx));
      while (
        value<{ more: boolean }>(
          await object.eraseAuthorChunk(op(base), visitorId("alice"), 10, ctx),
        ).more
      ) {
        // until done
      }
      expect((await object.view()).durable.documents.has(`items\u0000${byCreator._id}`)).toBe(
        false,
      );
      const kept = value<Record<string, unknown>>(
        await object.get(base, OWNER, "items", byOther._id, ctx),
      );
      expect(kept).toMatchObject({ n: 20, _by: visitorId("bob"), _editedBy: "erased" });
    });

    it("A18: two racing first grants get one identity; a retired entry refuses every claim for its retention; a delayed first grant cannot revive the person", async () => {
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

    it("A19: author erasure chunks are bounded by work in every part, and a repeated chunk replays its counts", async () => {
      const { object, base } = await withCollection("append");
      const author = visitorId("many");
      for (let index = 0; index < 7; index++)
        value(await object.create(op(base), visitor("many"), "items", { index }, ctx));
      const chunk = op(base);
      const first = value<{ documents: number; more: boolean }>(
        await object.eraseAuthorChunk(chunk, author, 3, ctx),
      );
      expect(first).toEqual({ documents: 3, edits: 0, more: true });
      expect(await object.eraseAuthorChunk(chunk, author, 3, ctx)).toMatchObject({
        ok: true,
        replayed: { result: { documents: 3, edits: 0, more: 1 } },
      });
      expect((await object.view()).durable.documents.size).toBe(4);
      expect(protocols.chunkSize(10_000)).toBe(ARTIFACT_DATA.caps.eraseChunkDocuments);
      // Seven operation records and seven rate rows of the author: each chunk deletes at most three.
      const before = authorTraces(await object.view(), author);
      value(await object.eraseAuthorChunk(op(base), author, 3, ctx));
      const after = authorTraces(await object.view(), author);
      expect(before.documents - after.documents).toBeLessThanOrEqual(3);
      expect(before.operations - after.operations).toBeLessThanOrEqual(3);
      expect(before.rates - after.rates).toBeLessThanOrEqual(3);
    });
  });

  describe("counting and limits", () => {
    it("A20: every operation's measured work lands in its class's counter in its own transaction, or in the next for a failure after the work began", async () => {
      const { object, base } = await withCollection("append", { uniqueKey: "k" });
      value(await object.create(op(base), alice, "items", { k: 1 }, ctx));
      expect(await object.create(op(base), alice, "items", { k: 1 }, ctx)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      await object.setFaults({ afterWork: (kind) => kind === "create" });
      expect(await object.create(op(base), alice, "items", { k: 2 }, ctx)).toMatchObject({
        ok: false,
      });
      expect((await object.view()).durable.documents.size).toBe(1);
      for (const entry of (await object.view()).charges) {
        expect(entry.dayAfter - entry.usedBefore).toBe(protocols.measuredCharge(entry.cost));
        expect(entry.cost.rowsRead + entry.cost.rowsWritten).toBeGreaterThan(0);
      }
      expect((await object.view()).charges.filter((entry) => entry.failed)).toHaveLength(2);
      // The failed attempts' rate rows stay: failed work is never free.
      expect(
        (await object.view()).durable.rates.get(
          `${visitorId("alice")}\u0000writes\u0000${protocols.minuteOf(NOW)}`,
        ),
      ).toBe(3);
    });

    it("A21: a spent class refuses before any work and writes nothing; refusals are counted", async () => {
      const tight = { ...ROOMY, rowsWrittenPerDay: 1 };
      const { object, base } = await withCollection("append", { limits: tight });
      const durable = structuredClone((await object.view()).durable);
      for (let index = 0; index < 3; index++) {
        expect(
          await object.create(op(base), alice, "items", { n: index }, context({ limits: tight })),
        ).toMatchObject({ ok: false, code: "quota_exceeded" });
      }
      expect(rows((await object.view()).durable)).toEqual(rows(durable));
      expect((await object.view()).pending.refused).toBe(3);
      await object.alarm(NOW);
      expect((await object.view()).durable.days.get(protocols.dayOf(NOW))?.refused).toBe(3);
    });

    it("A22: one operation's overshoot is at most its own charge, within its stated bound", async () => {
      const tight = { ...ROOMY, rowsWrittenPerDay: 60 };
      const { object, base } = await withCollection("append", { limits: tight });
      const limit = context({ limits: tight });
      let refused = 0;
      for (let index = 0; index < 20; index++) {
        if (!(await object.create(op(base), alice, "items", { n: index }, limit)).ok) refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
      const growth = (await object.view()).charges.filter((entry) => entry.charge === "growth");
      for (const entry of growth) expect(entry.usedBefore).toBeLessThan(tight.rowsWrittenPerDay);
      const last = growth.at(-1) as (typeof growth)[number];
      expect(last.dayAfter - tight.rowsWrittenPerDay).toBeLessThanOrEqual(
        protocols.measuredCharge(last.cost),
      );
      for (const entry of (await object.view()).charges) {
        const kind = entry.kind as keyof typeof OPERATION_ROW_BOUNDS;
        expect(protocols.withinBound(kind, entry.cost), kind).toBe(true);
      }
    });

    it("A23: an index over existing documents is built in bounded steps, and queries on it are refused until it is built", async () => {
      const { object, base } = await withCollection("append");
      const documents = ARTIFACT_DATA.caps.indexStepDocuments * 2 + 7;
      for (let index = 0; index < documents; index++)
        value(await object.create(op(base), OWNER, "items", { tag: index % 3 }, ctx));
      const declared = await object.declare(
        op(base),
        OWNER,
        { name: "items", mode: "append", indexed: ["tag"] },
        ctx,
      );
      expect(value(declared)).toEqual({ building: 1 });
      expect(
        await object.query(
          base,
          OWNER,
          { collection: "items", equals: { field: "tag", value: 1 } },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "invalid_input" });
      let steps = 1;
      let building = 1;
      while (building > 0) {
        building = value<{ building: number }>(
          await object.indexStep(op(base), OWNER, ctx),
        ).building;
        steps += 1;
      }
      expect(steps).toBe(Math.ceil(documents / ARTIFACT_DATA.caps.indexStepDocuments));
      for (const entry of (await object.view()).charges.filter(
        (item) => item.kind === "index_step" || item.kind === "declare",
      )) {
        // A step reads each document it covers, its value and its count once, never every document.
        expect(entry.cost.rowsRead).toBeLessThanOrEqual(
          3 * ARTIFACT_DATA.caps.indexStepDocuments + protocols.COMMAND_ROWS,
        );
        expect(protocols.withinBound(entry.kind as protocols.OperationKind, entry.cost)).toBe(true);
      }
      const page = value<{ documents: { tag: number }[] }>(
        await object.query(
          base,
          OWNER,
          { collection: "items", equals: { field: "tag", value: 1 }, limit: 100 },
          ctx,
        ),
      );
      expect(page.documents).toHaveLength(100);
      expect(page.documents.every((doc) => doc.tag === 1)).toBe(true);
    });

    it("A24: reads write no row per request, and an eviction loses at most the stated flush", async () => {
      const { object, base } = await withCollection("append");
      const doc = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { n: 1 }, ctx),
      );
      const durable = structuredClone((await object.view()).durable);
      for (let index = 0; index < 50; index++) {
        expect((await object.get(base, alice, "items", doc._id, ctx)).cost.rowsWritten).toBe(0);
      }
      expect(rows((await object.view()).durable)).toEqual(rows(durable));
      expect((await object.view()).pending.rows).toBeGreaterThan(0);
      expect((await object.view()).pending.rows).toBeLessThan(ARTIFACT_DATA.readFlush.rows);
      await object.evict();
      expect((await object.view()).pending.rows).toBe(0);
      let reads = 0;
      while (
        (await object.view()).durable.days.get(protocols.dayOf(NOW))?.read ===
        durable.days.get(protocols.dayOf(NOW))?.read
      ) {
        value(await object.get(base, alice, "items", doc._id, ctx));
        reads += 1;
      }
      expect((await object.view()).pending.rows).toBe(0);
      expect(reads).toBeLessThanOrEqual(ARTIFACT_DATA.readFlush.rows);
      value(await object.get(base, alice, "items", doc._id, ctx));
      const flushedAt = (await object.view()).durable.days.get(protocols.dayOf(NOW))?.read;
      value(
        await object.get(
          base,
          alice,
          "items",
          doc._id,
          context({ now: NOW + ARTIFACT_DATA.readFlush.ms }),
        ),
      );
      expect((await object.view()).durable.days.get(protocols.dayOf(NOW))?.read).toBeGreaterThan(
        flushedAt ?? 0,
      );
    });

    it("A25: cleanup, export and rights never meet the growth counter; a visitor deletes and exports their own when the shared counters are spent, without write permission", async () => {
      // Growth leaves room for more fills than the cleanup allowance can delete, whatever the
      // object's measured rows per command.
      const limits = {
        ...ROOMY,
        rowsWrittenPerDay: 1_000,
        cleanupRowsPerDay: 50,
        exportRowsPerDay: 50,
      };
      const tight = context({ limits });
      const { object, base } = await withCollection("append", { limits });
      const mine = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { n: 1 }, tight),
      );
      const other = value<{ _id: string }>(
        await object.create(op(base), bob, "items", { n: 2 }, tight),
      );
      const fills: string[] = [];
      for (;;) {
        const filled = await object.create(op(base), OWNER, "items", { fill: true }, tight);
        if (!filled.ok) break;
        fills.push(value<{ _id: string }>(filled)._id);
      }
      while ((await object.exportPage(base, OWNER, null, 500, tight)).ok) {
        // spend export
      }
      let spent = false;
      for (const id of fills) {
        if (!(await object.remove(op(base), OWNER, "items", id, tight)).ok) {
          spent = true;
          break;
        }
      }
      expect(spent).toBe(true);
      expect(await object.remove(op(base), OWNER, "items", other._id, tight)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      const readOnly = visitor("alice", false);
      expect(
        value<{ rows: unknown[] }>(await object.exportMine(base, readOnly, null, tight)).rows,
      ).toHaveLength(1);
      value(await object.remove(op(base), readOnly, "items", mine._id, tight));
      const day = (await object.view()).durable.days.get(protocols.dayOf(NOW));
      expect(day?.rights).toBeGreaterThan(0);
      expect(await object.create(op(base), alice, "items", { n: 3 }, tight)).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
    });

    it("A26: shrinking replacements are under the author's write rate", async () => {
      const limits = { ...ROOMY, writesPerAuthorPerMinute: 3 };
      const { object, base } = await withCollection("append", { limits });
      const doc = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { text: "long text" }, context({ limits })),
      );
      value(
        await object.replace(
          op(base),
          alice,
          "items",
          doc._id,
          { text: "short" },
          context({ limits }),
        ),
      );
      value(
        await object.replace(op(base), alice, "items", doc._id, { text: "s" }, context({ limits })),
      );
      expect((await object.view()).charges.at(-1)?.charge).toBe("cleanup");
      expect(
        await object.replace(op(base), alice, "items", doc._id, { t: "" }, context({ limits })),
      ).toMatchObject({ ok: false, code: "rate_limited" });
      value(
        await object.replace(
          op(base),
          alice,
          "items",
          doc._id,
          { t: "" },
          context({ limits, now: NOW + 60_000 }),
        ),
      );
    });

    it("A27: counts come from maintained counters, retained data after a downgrade included", async () => {
      const { object, base } = await withCollection("append");
      for (let index = 0; index < 12; index++)
        value(
          await object.create(op(base), index % 3 === 0 ? bob : alice, "items", { index }, ctx),
        );
      const downgraded = context({ limits: { ...ROOMY, documentsPerCollection: 5 } });
      const counted = await object.count(base, OWNER, { collection: "items" }, downgraded);
      expect(value(counted)).toEqual({ documents: 12 });
      // The control record, the collection and its counter: no document row.
      expect(counted.cost.rowsRead).toBeLessThanOrEqual(5);
      expect(
        value(
          await object.count(
            base,
            OWNER,
            { collection: "items", by: visitorId("bob") },
            downgraded,
          ),
        ),
      ).toEqual({
        documents: 4,
      });
      expect(await object.create(op(base), alice, "items", { n: 1 }, downgraded)).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      expect(await object.count(base, alice, { collection: "items" }, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    });
  });

  describe("live, storage, audit, export", () => {
    it("A28: live messages are reserved against the day, renewal is bound to its principal, and every mutation and barrier reaches connections", async () => {
      const limits = { ...ROOMY, liveMessagesPerDay: 150 };
      const { object, base } = await withCollection("append", { limits });
      const live = context({ limits });
      const socket = value(
        await object.connect(base, visitorId("bob"), "grant:bob", NOW + 60_000, live),
      );
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
      expect((await object.view()).durable.days.get(protocols.dayOf(NOW))?.live).toBe(100);
      expect(await object.renew(base, socket, "grant:other", NOW + 50_000, live)).toBe(false);
      expect(
        await object.renew(
          base,
          socket,
          "grant:bob",
          NOW + 30_000,
          context({ limits: { ...limits, liveMessagesPerDay: 120 } }),
        ),
      ).toBe(true);
      expect((await object.view()).sockets.get(socket)?.attachment).toMatchObject({
        deadline: NOW + 30_000,
        liveMessagesPerDay: 120,
      });
      const created = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { n: 1 }, live),
      );
      value(await object.bulkRemove(op(base), OWNER, "items", [created._id], live));
      value(await object.create(op(base), alice, "items", { n: 2 }, live));
      value(await object.eraseAuthorChunk(op(base), visitorId("alice"), 10, live));
      const received = (await object.view()).sockets.get(socket)?.received ?? [];
      expect(received.filter((message) => message.includes('"deleted"'))).toHaveLength(2);
      expect(received.filter((message) => message.includes('"created"'))).toHaveLength(2);
      // Survives hibernation: the deadline is in the attachment and closes the connection after it.
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW + 30_001);
      expect((await object.view()).sockets.get(socket)?.closed).toBe(4001);
      for (const close of [
        async (o: DataObject, e: DataEnvelope) => await o.prepareErase(e, opId(), NOW),
        async (o: DataObject, e: DataEnvelope) =>
          await o.fence({ ...e, epoch: 1 }, { kind: "epoch", transition: "t_e" }, NOW),
        async (o: DataObject, e: DataEnvelope) =>
          await o.fence(
            { ...e, epoch: 1 },
            { kind: "transfer", toOwner: "owner_b", transition: "t_t" },
            NOW,
          ),
        async (o: DataObject, e: DataEnvelope) => await o.quarantine(e, "owner", NOW),
      ]) {
        const fresh = await withCollection("append");
        const open = value(
          await fresh.object.connect(fresh.base, null, "reader", NOW + 60_000, ctx),
        );
        close(fresh.object, fresh.base);
        expect((await fresh.object.view()).sockets.get(open)?.closed).toBe(4003);
      }
      const spent = await withCollection("append", { limits: { ...ROOMY, liveMessagesPerDay: 1 } });
      const one = value(
        await spent.object.connect(
          spent.base,
          null,
          "reader",
          NOW + 60_000,
          context({ limits: { ...ROOMY, liveMessagesPerDay: 1 } }),
        ),
      );
      await spent.object.message(one, JSON.stringify({ subscribe: "items" }), NOW);
      await spent.object.message(one, JSON.stringify({ subscribe: "items" }), NOW);
      expect((await spent.object.view()).sockets.get(one)?.closed).toBe(4029);
      expect((await spent.object.view()).durable.days.get(protocols.dayOf(NOW))?.live).toBe(1);
    });

    it("A29: the storage sequence advances on every durable write and the payload revision only on document changes; reports order by generation then sequence", async () => {
      const { object, base } = await withCollection("append");
      const seen: number[] = [(await object.view()).durable.control?.storageSeq ?? 0];
      const revisions: number[] = [(await object.view()).durable.control?.payloadRevision ?? 0];
      const step = async (expectPayload: boolean) => {
        seen.push((await object.view()).durable.control?.storageSeq ?? 0);
        revisions.push((await object.view()).durable.control?.payloadRevision ?? 0);
        expect(seen.at(-1)).toBeGreaterThan(seen.at(-2) ?? 0);
        expect((revisions.at(-1) ?? 0) > (revisions.at(-2) ?? 0)).toBe(expectPayload);
      };
      const doc = value<{ _id: string }>(
        await object.create(op(base), alice, "items", { n: 1 }, ctx),
      );
      await step(true);
      value(await object.exportPage(base, OWNER, null, 10, ctx));
      await step(false);
      value(await object.fence({ ...base, epoch: 1 }, { kind: "epoch", transition: "t1" }, NOW));
      await step(false);
      value(await object.remove(op({ ...base, epoch: 1 }), alice, "items", doc._id, ctx));
      await step(true);
      const refused = await object.create(op(base), alice, "items", { n: 1 }, ctx);
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

    it("A30: every retained control class is pruned in bounded passes, and the next alarm covers every class", async () => {
      const { object, base } = await withCollection("append");
      for (let index = 0; index < ARTIFACT_DATA.caps.pruneRows + 3; index++) {
        value(
          await object.create(
            op(base),
            alice,
            "items",
            { index },
            context({ now: NOW + index * 120_000 }),
          ),
        );
      }
      const later = NOW + 4 * DAY;
      const records = (await object.view()).durable.ops.size;
      await object.alarm(later);
      expect((await object.view()).durable.ops.size).toBe(records - ARTIFACT_DATA.caps.pruneRows);
      expect((await object.view()).durable.alarm).toBeLessThanOrEqual(
        later + ARTIFACT_DATA.morePruneMs,
      );
      await object.alarm(later + ARTIFACT_DATA.morePruneMs);
      expect(
        (await object.view()).durable.ops.size + (await object.view()).durable.rates.size,
      ).toBe(0);
      const owned = op({ ...base }, later);
      value(await object.create(owned, OWNER, "items", { n: 1 }, context({ now: later })));
      await object.acknowledge(base, "owner:owner", owned.opId as string, later);
      // Following the alarms alone empties every retained class, and then no alarm is left.
      let wakes = 0;
      for (let at = (await object.view()).durable.alarm; at !== null && wakes < 50; ) {
        await object.alarm(at);
        wakes += 1;
        at = (await object.view()).durable.alarm;
      }
      const d = (await object.view()).durable;
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

    it("A31: an audit obligation's key equals its mutation's; delivered and aborted are distinct; obligations survive a whole erase; an erased author's late settlement writes nothing", async () => {
      const { object, base } = await withCollection("append");
      const owned = op(base);
      value(await object.create(owned, OWNER, "items", { n: 1 }, ctx));
      const key = protocols.operationKey("owner:owner", 0, owned.opId as string);
      expect((await object.view()).durable.audit.has(key)).toBe(true);
      expect((await object.view()).durable.ops.has(key)).toBe(true);
      expect(await object.settle(base, "owner:owner", owned.opId as string, NOW)).toMatchObject({
        state: "committed",
        delivered: false,
      });
      expect(await object.acknowledge(base, "owner:owner", owned.opId as string, NOW)).toBe(true);
      expect(await object.acknowledge(base, "owner:owner", owned.opId as string, NOW)).toBe(false);
      expect(await object.settle(base, "owner:owner", owned.opId as string, NOW)).toMatchObject({
        state: "committed",
        delivered: true,
      });
      const never = opId();
      expect(await object.settle(base, "owner:owner", never, NOW)).toEqual({ state: "aborted" });
      expect(
        await object.create({ ...base, opId: never }, OWNER, "items", { n: 2 }, ctx),
      ).toMatchObject({
        ok: false,
        code: "conflict",
      });
      const erase = opId();
      value(await object.prepareErase(base, erase, NOW));
      value(await object.commitErase(base, erase, NOW));
      expect((await object.view()).durable.audit.has(key)).toBe(true);
      expect(await object.settle(base, "owner:owner", owned.opId as string, NOW)).toMatchObject({
        state: "committed",
      });
      const next = { ...base, generation: 1 };
      value(await object.eraseAuthorChunk(op(next), visitorId("gone"), 10, ctx));
      const before = structuredClone((await object.view()).durable);
      expect(await object.settle(next, visitorId("gone"), opId(), NOW)).toEqual({
        state: "aborted",
      });
      expect(rows((await object.view()).durable)).toEqual(rows(before));
    });

    it("A32: the export is exact, in primary key order, byte-bounded and stable, the visitor's own export works, and the file loads into SQLite", async () => {
      const object = await make();
      const base = envelope();
      value(
        await object.declare(op(base), OWNER, { name: "b", mode: "append", indexed: ["n"] }, ctx),
      );
      value(await object.declare(op(base), OWNER, { name: "a", mode: "own" }, ctx));
      const body = {
        big: 9007199254740991,
        text: 'é€😀"\\\n',
        nested: { list: [1, "x", null, true] },
        n: 0.1,
      };
      value(await object.create(op(base), alice, "b", body, ctx));
      for (let index = 0; index < 80; index++)
        value(
          await object.create(
            op(base),
            index % 2 ? alice : bob,
            "a",
            { index, pad: "x".repeat(15_000) },
            ctx,
          ),
        );
      const start = value<protocols.ExportPage>(
        await object.exportPage(base, OWNER, null, 500, ctx),
      );
      expect(start.bytes).toBeLessThanOrEqual(ARTIFACT_DATA.caps.exportBytes);
      expect(start.rows.length).toBeLessThan(81);
      const rows = [...start.rows];
      let next = start.next;
      while (next !== null) {
        const page = value<protocols.ExportPage>(
          await object.exportPage(base, OWNER, next, 500, ctx),
        );
        expect(page.revision).toBe(start.revision);
        rows.push(...page.rows);
        next = page.next;
      }
      expect(rows.map((row) => `${row.collection}/${row.id}`)).toEqual(
        [...rows].map((row) => `${row.collection}/${row.id}`).sort(),
      );
      expect(rows).toHaveLength(81);
      const mine = value<protocols.ExportPage>(await object.exportMine(base, alice, null, ctx));
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
        exportFooter(
          start.revision,
          (await object.view()).durable.control?.payloadRevision ?? -1,
          rows.length,
        );
      const parsed = value<protocols.ExportFile>(parseExportFile(file));
      expect(parsed.footer.consistent).toBe(true);
      expect(parsed.rows.find((row) => row.collection === "b")?.body).toEqual(body);
      const stored = [...(await object.view()).durable.documents.values()].find(
        (doc) => doc.collection === "b",
      )?.body;
      expect(file).toContain(`"body":${stored}}`);
      const loaded = await options.loadExport(file);
      expect(loaded.b).toEqual({ text: body.text, big: body.big });
      expect(loaded.documents).toBe(81);
    });

    it("A33: every allowed query shape reads at most the page plus a few rows, dense, sparse or empty", async () => {
      const { object, base } = await withCollection("append", { indexed: ["tag"] });
      for (let index = 0; index < 400; index++) {
        value(
          await object.create(
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
          const answer = await object.query(base, OWNER, { ...shape, limit }, ctx);
          expect(answer.ok).toBe(true);
          // The page plus one, and fixed rows: the control record, the collection, its fields and
          // the seek. A seek through the values index also reads each match's document, which real
          // SQLite measures as a second row per match (decision 0026, delivery 4's measurements).
          const perMatch = "equals" in shape && shape.equals.field !== "_by" ? 2 : 1;
          expect(answer.cost.rowsRead).toBeLessThanOrEqual(perMatch * (limit + 1) + 7);
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

    it("A34: the grant's start and redeem gates and its one-use, browser-bound codes", async () => {
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
}
