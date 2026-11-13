// The reproductions of decision 0026's four design reviews that still apply (spikes/artifact-data,
// review-findings*.test.ts), carried over to the production decisions. Names are review and
// finding (R2-5 is the second review's finding 5; D01 is the fourth review's case). Cases about
// owner SQL, the owner ledger and leases are closed by removal; cases about SQLite query plans
// (R1-11's plan, D12) stay with the spike and delivery 4, which owns the statements.
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";
import { describe, expect, it } from "vitest";
import { OPERATION_ROW_BOUNDS, withinBound } from "../../artifact-data/charging.ts";
import {
  batched,
  beginGate,
  claimOutcome,
  redeemable,
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
  ROOMY,
  value,
  visitor,
  visitorId,
} from "../artifact-data-fixtures.ts";
import { authorTraces, rows } from "../artifact-data-object.ts";

export function reviewFindingsSuite(make: MakeObject): void {
  const ctx = context();
  const DAY = 86_400_000;

  async function fresh(
    mode: "own" | "append" | "shared" = "append",
    extra: { uniqueKey?: string; indexed?: string[] } = {},
  ) {
    const object = await make();
    const base = envelope();
    value(await object.declare(op(base), OWNER, { name: "items", mode, ...extra }, ctx));
    return { object, base };
  }

  const drain = async (object: DataObject, base: ReturnType<typeof envelope>, author: string) => {
    while (
      value<{ more: boolean }>(await object.eraseAuthorChunk(op(base), author, 500, ctx)).more
    ) {
      // until done
    }
  };

  describe("first review", () => {
    it("R1-2: nothing the owner declares can block a visitor's deletion or an account's erasure", async () => {
      const { object, base } = await fresh("append", { uniqueKey: "k", indexed: ["k"] });
      const doc = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { k: 1 }, ctx),
      );
      value(await object.create(op(base), visitor("a"), "items", { k: 2 }, ctx));
      value(await object.remove(op(base), visitor("a", false), "items", doc._id, ctx));
      await drain(object, base, visitorId("a"));
      expect((await object.view()).durable.documents.size).toBe(0);
    });

    it("R1-4: retrying an earlier erase never deletes data created after it", async () => {
      const { object, base } = await fresh();
      const id = opId();
      value(await object.prepareErase(base, id, NOW));
      value(await object.commitErase(base, id, NOW));
      const next = { ...base, generation: 1 };
      value(await object.declare(op(next), OWNER, { name: "items", mode: "append" }, ctx));
      value(await object.create(op(next), OWNER, "items", { n: 1 }, ctx));
      value(await object.prepareErase(base, id, NOW));
      value(await object.commitErase(base, id, NOW));
      expect((await object.view()).durable.documents.size).toBe(1);
    });

    it("R1-10: refused attempts are counted against the writer's minute", async () => {
      const limits = { ...ROOMY, writesPerAuthorPerMinute: 2 };
      const { object, base } = await fresh("append", { uniqueKey: "k" });
      value(await object.create(op(base), visitor("a"), "items", { k: 1 }, context({ limits })));
      expect(
        (await object.create(op(base), visitor("a"), "items", { k: 1 }, context({ limits }))).ok,
      ).toBe(false);
      expect(
        await object.create(op(base), visitor("a"), "items", { k: 2 }, context({ limits })),
      ).toMatchObject({ ok: false, code: "rate_limited" });
    });

    it("R1-11: a visitor query that finds nothing reads a bounded number of rows", async () => {
      const { object, base } = await fresh("own");
      for (let index = 0; index < 300; index++)
        value(await object.create(op(base), visitor("a"), "items", { index }, ctx));
      expect(
        (await object.query(base, visitor("b"), { collection: "items" }, ctx)).cost.rowsRead,
      ).toBeLessThan(10);
    });

    it("R1-12: deleting works while the artifact is over its quota", async () => {
      const limits = { ...ROOMY, rowsWrittenPerDay: 1 };
      const { object, base } = await fresh();
      const doc = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx),
      );
      value(await object.remove(op(base), visitor("a"), "items", doc._id, context({ limits })));
    });

    it("R1-13: replacing a document keeps one value of the unique key per author", async () => {
      const { object, base } = await fresh("append", { uniqueKey: "k" });
      const one = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { k: 1 }, ctx),
      );
      value(await object.create(op(base), visitor("a"), "items", { k: 2 }, ctx));
      expect(
        await object.replace(op(base), visitor("a"), "items", one._id, { k: 2 }, ctx),
      ).toMatchObject({
        ok: false,
        code: "conflict",
      });
    });

    it("R1-15: a visitor's sequence numbers do not reveal other authors' private writes", async () => {
      const { object, base } = await fresh("own");
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
      for (let index = 0; index < 5; index++)
        value(await object.create(op(base), visitor("b"), "items", { index }, ctx));
      expect(
        value<{ _seq: number }>(await object.create(op(base), visitor("a"), "items", { n: 2 }, ctx))
          ._seq,
      ).toBe(2);
    });

    it("R1-16: the grant's navigation has a gate it can pass, and only that navigation", async () => {
      const navigate = (site: string, dest: string) =>
        beginGate(
          "GET",
          new Headers({
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": site,
            "Sec-Fetch-Dest": dest,
          }),
        );
      expect(navigate("same-origin", "document")).toBe("allowed");
      expect(navigate("same-site", "iframe")).toBe("refused");
    });

    it("R1-27: every call checks the artifact it names", async () => {
      const { object, base } = await fresh();
      expect(
        await object.query(
          { ...base, artifactId: "zzzzzzzz22" },
          OWNER,
          { collection: "items" },
          ctx,
        ),
      ).toMatchObject({ ok: false, code: "forbidden" });
    });
  });

  describe("second review", () => {
    it("R2-1: another writer's reuse of an operation ID never returns the first body", async () => {
      const { object, base } = await fresh();
      const shared = op(base);
      value(await object.create(shared, visitor("a"), "items", { secret: 1 }, ctx));
      expect(
        JSON.stringify(await object.create(shared, visitor("b"), "items", { secret: 2 }, ctx)),
      ).not.toContain('"secret":1');
    });

    it("R2-1: a retry after a lost acknowledgement needs no second allowance", async () => {
      const limits = { ...ROOMY, writesPerAuthorPerMinute: 1 };
      const { object, base } = await fresh();
      const once = op(base);
      value(await object.create(once, visitor("a"), "items", { n: 1 }, context({ limits })));
      expect(
        await object.create(once, visitor("a"), "items", { n: 1 }, context({ limits })),
      ).toMatchObject({ ok: true, replayed: {} });
    });

    it("R2-2: a fence on an empty object is persisted before it is acknowledged", async () => {
      const object = await make();
      value(await object.fence(envelope({ epoch: 1 }), { kind: "hold", transition: "t" }, NOW));
      expect((await object.view()).durable.control?.hold).not.toBeNull();
    });

    it("R2-2: commit and cancel use the whole envelope", async () => {
      const { object, base } = await fresh();
      const id = opId();
      value(await object.prepareErase(base, id, NOW));
      expect(await object.commitErase({ ...base, ownerId: "someone" }, id, NOW)).toMatchObject({
        ok: false,
        code: "stale",
      });
      expect(await object.cancelErase({ ...base, region: "eu" }, id, NOW)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    });

    it("R2-3: a prepare at a newer epoch lets its commit finish", async () => {
      const { object, base } = await fresh();
      const id = opId();
      const newer = { ...base, epoch: 4 };
      value(await object.prepareErase(newer, id, NOW));
      expect(value(await object.commitErase(newer, id, NOW))).toEqual({ outcome: "committed" });
    });

    it("R2-3: erasing keeps the control records", async () => {
      const { object, base } = await fresh();
      value(await object.create(op(base), OWNER, "items", { n: 1 }, ctx));
      const id = opId();
      value(await object.prepareErase(base, id, NOW));
      value(await object.commitErase(base, id, NOW));
      expect((await object.view()).durable.audit.size).toBe(2);
      expect((await object.view()).durable.days.size).toBe(1);
    });

    it("R2-4: a request naming the former owner after a transfer is refused at any epoch", async () => {
      const { object, base } = await fresh();
      value(
        await object.fence(
          { ...base, epoch: 1 },
          { kind: "transfer", toOwner: "owner_b", transition: "t" },
          NOW,
        ),
      );
      expect(
        await object.query({ ...base, epoch: 99 }, OWNER, { collection: "items" }, ctx),
      ).toMatchObject({ ok: false, code: "stale" });
    });

    it("R2-5: replaying a create after its author was erased returns no body", async () => {
      const { object, base } = await fresh();
      const once = op(base);
      value(await object.create(once, visitor("a"), "items", { secret: 1 }, ctx));
      await drain(object, base, visitorId("a"));
      const again = await object.create(once, visitor("a"), "items", { secret: 1 }, ctx);
      expect(again).toMatchObject({ ok: false, code: "forbidden" });
      expect(JSON.stringify(again)).not.toContain("secret");
    });

    it("R2-5: replay records are pruned after a day", async () => {
      const { object, base } = await fresh();
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
      await object.alarm(NOW + ARTIFACT_DATA.replayMs + 1);
      expect((await object.view()).durable.ops.size).toBe(0);
    });

    it("R2-6: after an author's erasure began, a late write from that author is refused", async () => {
      const { object, base } = await fresh();
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
      value(await object.create(op(base), visitor("a"), "items", { n: 2 }, ctx));
      value(await object.eraseAuthorChunk(op(base), visitorId("a"), 1, ctx));
      expect(await object.create(op(base), visitor("a"), "items", { n: 3 }, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    });

    it("R2-8: renewal is bound to the principal that opened the connection, and can shorten", async () => {
      const { object, base } = await fresh();
      const socket = value(
        await object.connect(base, visitorId("a"), "grant:a", NOW + 60_000, ctx),
      );
      expect(await object.renew(base, socket, "grant:b", NOW + 60_000, ctx)).toBe(false);
      expect(await object.renew(base, socket, "grant:a", NOW + 10_000, ctx)).toBe(true);
      expect((await object.view()).sockets.get(socket)?.attachment.deadline).toBe(NOW + 10_000);
    });

    it("R2-10: cleanup works when the day is spent, and a visitor deletes their own without write permission", async () => {
      const limits = { ...ROOMY, rowsWrittenPerDay: 1 };
      const { object, base } = await fresh();
      const doc = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx),
      );
      expect(
        (await object.create(op(base), OWNER, "items", { n: 2 }, context({ limits }))).ok,
      ).toBe(false);
      value(
        await object.remove(op(base), visitor("a", false), "items", doc._id, context({ limits })),
      );
    });

    it("R2-13: refused work that grew storage moves the storage report", async () => {
      const { object, base } = await fresh("append", { uniqueKey: "k" });
      const first = await object.create(op(base), visitor("a"), "items", { k: 1 }, ctx);
      const failed = await object.create(op(base), visitor("a"), "items", { k: 1 }, ctx);
      expect(failed.storage.seq).toBeGreaterThan(first.storage.seq);
    });

    it("R2-14: author erasure leaves an audit obligation, and a whole erase keeps it", async () => {
      const { object, base } = await fresh();
      value(await object.eraseAuthorChunk(op(base), visitorId("a"), 1, ctx));
      const id = opId();
      value(await object.prepareErase(base, id, NOW));
      value(await object.commitErase(base, id, NOW));
      expect(
        [...(await object.view()).durable.audit.values()].some(
          (row) => row.kind === "data.author_erased",
        ),
      ).toBe(true);
    });

    it("R2-15: a code redeems once, in the browser that began it", async () => {
      const pending = {
        codeHash: "c",
        nonceHash: "n",
        host: "h",
        grantId: "g",
        expiresAt: NOW + 1,
        used: false,
      };
      expect(redeemable(pending, { codeHash: "c", nonceHash: "n", host: "h" }, NOW)).toBe(true);
      pending.used = true;
      expect(redeemable(pending, { codeHash: "c", nonceHash: "n", host: "h" }, NOW)).toBe(false);
    });

    it("R2-16: live bytes are counted in UTF-8 before sending", async () => {
      const { object, base } = await fresh();
      const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
      const text = JSON.stringify({ subscribe: "items" });
      await object.message(socket, text, NOW);
      const sent = (await object.view()).sockets.get(socket)?.received[0] ?? "";
      expect((await object.view()).sockets.get(socket)?.attachment.bytesOut).toBe(
        new TextEncoder().encode(sent).length,
      );
    });

    it("R2-17: erasing an absent author reads a bounded number of rows", async () => {
      const { object, base } = await fresh();
      for (let index = 0; index < 200; index++)
        value(await object.create(op(base), visitor("a"), "items", { index }, ctx));
      const chunk = await object.eraseAuthorChunk(op(base), visitorId("nobody"), 500, ctx);
      expect(value<{ more: boolean }>(chunk).more).toBe(false);
      expect(chunk.cost.rowsRead).toBeLessThan(20);
    });
  });

  describe("third review", () => {
    it("R3-6: an empty object's erase leaves a generation barrier", async () => {
      const object = await make();
      const id = opId();
      value(await object.prepareErase(envelope(), id, NOW));
      value(await object.commitErase(envelope(), id, NOW));
      expect(
        await object.declare(op(envelope()), OWNER, { name: "items", mode: "own" }, ctx),
      ).toMatchObject({ ok: false, code: "stale" });
    });

    it("R3-6: a fence for an older generation is refused", async () => {
      const { object, base } = await fresh();
      const id = opId();
      value(await object.prepareErase(base, id, NOW));
      value(await object.commitErase(base, id, NOW));
      expect(
        await object.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "t" }, NOW),
      ).toMatchObject({ ok: false, code: "stale" });
    });

    it("R3-6: maintenance stays behind the validator: no pruning under a hold, no settlement for another artifact", async () => {
      const { object, base } = await fresh();
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
      value(await object.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "t" }, NOW));
      expect((await object.alarm(NOW + 10 * DAY)).pruned).toBe(0);
      expect(
        (await object.settle({ ...base, artifactId: "zzzzzzzz22" }, "owner:owner", opId(), NOW))
          .state,
      ).toBe("refused");
    });

    it("R3-8: a late write after erasing an author from an empty object is refused", async () => {
      const object = await make();
      const base = envelope();
      value(await object.eraseAuthorChunk(op(base), visitorId("a"), 1, ctx));
      value(await object.declare(op(base), OWNER, { name: "items", mode: "own" }, ctx));
      expect(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    });

    it("R3-8: an erased person's identity is never revived under a fresh ID", async () => {
      expect(
        claimOutcome(
          retired({ visitorId: visitorId("a"), firstGrantAt: NOW }, NOW),
          visitorId("fresh"),
        ),
      ).toMatchObject({ ok: false });
    });

    it("R3-8: erasure closes the author's connections and removes their sequences", async () => {
      const { object, base } = await fresh("own");
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
      const socket = value(
        await object.connect(base, visitorId("a"), "grant:a", NOW + 60_000, ctx),
      );
      await drain(object, base, visitorId("a"));
      expect((await object.view()).sockets.get(socket)?.closed).toBe(4410);
      expect(authorTraces(await object.view(), visitorId("a")).sequences).toBe(0);
    });

    it("R3-8: erasing an editor keeps the creator's document and marks the edit erased", async () => {
      const { object, base } = await fresh("shared");
      const doc = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx),
      );
      value(await object.replace(op(base), visitor("b"), "items", doc._id, { n: 2 }, ctx));
      await drain(object, base, visitorId("b"));
      expect(value(await object.get(base, OWNER, "items", doc._id, ctx))).toMatchObject({
        n: 2,
        _editedBy: "erased",
      });
    });

    it("R3-10: a repeated author chunk replays instead of erasing more", async () => {
      const { object, base } = await fresh();
      for (let index = 0; index < 3; index++)
        value(await object.create(op(base), visitor("a"), "items", { index }, ctx));
      const chunk = op(base);
      value(await object.eraseAuthorChunk(chunk, visitorId("a"), 1, ctx));
      expect(await object.eraseAuthorChunk(chunk, visitorId("a"), 1, ctx)).toMatchObject({
        ok: true,
        replayed: {},
      });
      expect((await object.view()).durable.documents.size).toBe(2);
    });

    it("R3-9: a page is charged at least what it read", async () => {
      const { object, base } = await fresh();
      for (let index = 0; index < 30; index++)
        value(await object.create(op(base), visitor("a"), "items", { index }, ctx));
      const page = await object.query(base, OWNER, { collection: "items", limit: 30 }, ctx);
      expect((await object.view()).pending.rows).toBeGreaterThanOrEqual(page.cost.rowsRead);
    });

    it("R3-9: an index build is refused before it starts when growth is spent", async () => {
      const { object, base } = await fresh();
      const limits = { ...ROOMY, rowsWrittenPerDay: 1 };
      const durable = structuredClone((await object.view()).durable);
      expect(
        await object.declare(
          op(base),
          OWNER,
          { name: "items", mode: "append", indexed: ["n"] },
          context({ limits }),
        ),
      ).toMatchObject({ ok: false, code: "quota_exceeded" });
      expect(rows((await object.view()).durable)).toEqual(rows(durable));
    });

    it("R3-15: live acknowledgements spend reserved messages too", async () => {
      const { object, base } = await fresh();
      const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
      await object.message(socket, JSON.stringify({ subscribe: "nothing" }), NOW);
      expect((await object.view()).sockets.get(socket)?.attachment.reserved).toBe(
        ARTIFACT_DATA.live.reserveChunk - 1,
      );
    });

    it("R3-16: shrinking replacements are rate-limited per author", async () => {
      const limits = { ...ROOMY, writesPerAuthorPerMinute: 1 };
      const { object, base } = await fresh();
      const doc = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { text: "long" }, context({ limits })),
      );
      expect(
        await object.replace(
          op(base),
          visitor("a"),
          "items",
          doc._id,
          { t: "" },
          context({ limits }),
        ),
      ).toMatchObject({ ok: false, code: "rate_limited" });
    });

    it("R3-11: audit obligations are keyed by actor and generation, not the bare operation ID", async () => {
      const { object, base } = await fresh();
      const once = op(base);
      value(await object.create(once, OWNER, "items", { n: 1 }, ctx));
      expect([...(await object.view()).durable.audit.keys()]).toContain(
        `owner:owner|0|${once.opId}`,
      );
    });

    it("R3-12: a quiet export does not move the payload revision; pages are byte-bounded", async () => {
      const { object, base } = await fresh();
      for (let index = 0; index < 70; index++)
        value(await object.create(op(base), OWNER, "items", { pad: "x".repeat(16_000) }, ctx));
      const first = value<{ revision: number; bytes: number }>(
        await object.exportPage(base, OWNER, null, 500, ctx),
      );
      const second = value<{ revision: number }>(
        await object.exportPage(base, OWNER, null, 500, ctx),
      );
      expect(second.revision).toBe(first.revision);
      expect(first.bytes).toBeLessThanOrEqual(ARTIFACT_DATA.caps.exportBytes);
    });
  });

  describe("fourth review", () => {
    it("D01: a held object refuses erasure through quarantine resolution", async () => {
      const { object, base } = await fresh();
      value(await object.create(op(base), OWNER, "items", { n: 1 }, ctx));
      const held = { ...base, epoch: 1 };
      value(await object.fence(held, { kind: "hold", transition: "t" }, NOW));
      value(await object.quarantine(held, "owner", NOW));
      expect(await object.resolveQuarantine(held, "erase", NOW)).toMatchObject({
        ok: false,
        code: "held",
      });
      expect((await object.view()).durable.documents.size).toBe(1);
    });

    it("D03: a delayed cancel of an earlier erase intent does not cancel a later one", async () => {
      const { object, base } = await fresh();
      const [first, second] = [opId(), opId()];
      value(await object.prepareErase(base, first, NOW));
      value(await object.cancelErase(base, first, NOW));
      value(await object.prepareErase(base, second, NOW));
      value(await object.cancelErase(base, first, NOW));
      expect((await object.view()).durable.control?.erasing?.id).toBe(second);
    });

    it("D29: a transition ID repeated with other contents is a conflict", async () => {
      const { object, base } = await fresh();
      value(await object.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "t" }, NOW));
      expect(
        await object.fence({ ...base, epoch: 1 }, { kind: "release", transition: "t" }, NOW),
      ).toMatchObject({ ok: false, code: "conflict" });
    });

    it("D36: a request at a pending fence's epoch does not consume that epoch", async () => {
      const { object, base } = await fresh();
      value(await object.exportPage({ ...base, epoch: 1 }, OWNER, null, 10, ctx));
      value(await object.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "t" }, NOW));
    });

    it("D04: a hold does not leave an alarm that wakes the object to do nothing", async () => {
      const { object, base } = await fresh();
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
      value(await object.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "t" }, NOW));
      await object.alarm(NOW + 3 * DAY);
      expect((await object.view()).durable.alarm).toBeNull();
    });

    it("D02: the first durable write on an empty object binds its identity", async () => {
      const object = await make();
      await object.settle(envelope(), "owner:owner", opId(), NOW);
      expect((await object.view()).durable.control).not.toBeNull();
      expect(
        (await object.settle(envelope({ artifactId: "zzzzzzzz22" }), "owner:owner", opId(), NOW))
          .state,
      ).toBe("refused");
    });

    it("D23, D05, D06: after an owner edit between chunks, no sequence, operation or rate row of the author remains or comes back", async () => {
      const { object, base } = await fresh("own");
      value(await object.create(op(base), visitor("gone"), "items", { n: 1 }, ctx));
      const second = value<{ _id: string }>(
        await object.create(op(base), visitor("gone"), "items", { n: 2 }, ctx),
      );
      value(await object.eraseAuthorChunk(op(base), visitorId("gone"), 1, ctx));
      await object.replace(op(base), OWNER, "items", second._id, { n: 3 }, ctx);
      await drain(object, base, visitorId("gone"));
      await object.settle(base, visitorId("gone"), opId(), NOW);
      expect((await object.create(op(base), visitor("gone"), "items", { n: 9 }, ctx)).ok).toBe(
        false,
      );
      expect(authorTraces(await object.view(), visitorId("gone"))).toMatchObject({
        sequences: 0,
        operations: 0,
        rates: 0,
      });
    });

    it("D18: an operation ID past the replay horizon is refused, not applied again", async () => {
      const { object, base } = await fresh();
      const old = op(base);
      value(await object.create(old, visitor("a"), "items", { n: 1 }, ctx));
      const later = NOW + 2 * DAY;
      await object.alarm(later);
      expect(
        (await object.create(old, visitor("a"), "items", { n: 1 }, context({ now: later }))).ok,
      ).toBe(false);
      expect((await object.view()).durable.documents.size).toBe(1);
    });

    it("D13: a delivered audit record keeps an alarm for its own expiry", async () => {
      const { object, base } = await fresh();
      const once = op(base);
      value(await object.create(once, OWNER, "items", { n: 1 }, ctx));
      await object.acknowledge(base, "owner:owner", once.opId as string, NOW);
      await object.alarm(NOW + 3 * DAY);
      expect((await object.view()).durable.alarm).toBe(
        batched(NOW + ARTIFACT_DATA.deliveredMs + 1),
      );
    });

    it("D08: reads write no counter row per request", async () => {
      const { object, base } = await fresh();
      const doc = value<{ _id: string }>(
        await object.create(op(base), OWNER, "items", { n: 1 }, ctx),
      );
      let written = 0;
      for (let index = 0; index < 20; index++)
        written += (await object.get(base, OWNER, "items", doc._id, ctx)).cost.rowsWritten;
      expect(written).toBe(0);
    });

    it("D40: an index over existing documents is built in bounded steps", async () => {
      const { object, base } = await fresh();
      for (let index = 0; index < 1_200; index++)
        value(await object.create(op(base), OWNER, "items", { tag: index }, ctx));
      const declared = await object.declare(
        op(base),
        OWNER,
        { name: "items", mode: "append", indexed: ["tag"] },
        ctx,
      );
      expect(
        withinBound("declare", declared.cost) &&
          declared.cost.rowsRead + declared.cost.rowsWritten <= OPERATION_ROW_BOUNDS.declare,
      ).toBe(true);
      // One step of `indexStepDocuments`, never all 1,200 documents in one command.
      expect(declared.cost.rowsWritten).toBeLessThan(
        3 * ARTIFACT_DATA.caps.indexStepDocuments + 100,
      );
    });

    it("D11: counting one author's documents does not scan them", async () => {
      const { object, base } = await fresh();
      for (let index = 0; index < 300; index++)
        value(await object.create(op(base), visitor("a"), "items", { index }, ctx));
      expect(
        (await object.count(base, OWNER, { collection: "items", by: visitorId("a") }, ctx)).cost
          .rowsRead,
      ).toBeLessThanOrEqual(6);
    });

    it("D09: an author erasure chunk is charged at least the work it did", async () => {
      const { object, base } = await fresh("append", { indexed: ["a"] });
      for (let index = 0; index < 30; index++)
        value(await object.create(op(base), visitor("x"), "items", { a: index }, ctx));
      const chunk = await object.eraseAuthorChunk(op(base), visitorId("x"), 30, ctx);
      const entry = (await object.view()).charges.at(-1);
      expect(entry?.kind).toBe("erase_author_chunk");
      expect((entry?.dayAfter ?? 0) - (entry?.usedBefore ?? 0)).toBeGreaterThanOrEqual(
        chunk.cost.rowsRead + chunk.cost.rowsWritten,
      );
    });

    it("D28: a live reservation advances the storage sequence", async () => {
      const { object, base } = await fresh();
      const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
      const before = (await object.view()).durable.control?.storageSeq ?? 0;
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
      expect((await object.view()).durable.control?.storageSeq).toBeGreaterThan(before);
    });

    it("D31: a bulk delete notifies subscribers", async () => {
      const { object, base } = await fresh();
      const doc = value<{ _id: string }>(
        await object.create(op(base), OWNER, "items", { n: 1 }, ctx),
      );
      const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
      await object.message(socket, JSON.stringify({ subscribe: "items" }), NOW);
      value(await object.bulkRemove(op(base), OWNER, "items", [doc._id], ctx));
      expect(
        (await object.view()).sockets
          .get(socket)
          ?.received.some((message) => message.includes('"deleted"')),
      ).toBe(true);
    });

    it("D30: preparing an erase closes live connections", async () => {
      const { object, base } = await fresh();
      const socket = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
      value(await object.prepareErase(base, opId(), NOW));
      expect((await object.view()).sockets.get(socket)?.closed).toBe(4003);
    });

    it("D38: a visitor exports their own documents without write permission", async () => {
      const { object, base } = await fresh("own");
      value(await object.create(op(base), visitor("a"), "items", { mine: true }, ctx));
      expect(
        JSON.stringify(value(await object.exportMine(base, visitor("a", false), null, ctx))),
      ).toContain("mine");
    });

    it("D41: an owner spending the cleanup allowance does not stop a visitor deleting their own", async () => {
      const limits = { ...ROOMY, cleanupRowsPerDay: 50 };
      const { object, base } = await fresh();
      const mine = value<{ _id: string }>(
        await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx),
      );
      while (
        (await object.bulkRemove(op(base), OWNER, "items", ["missing"], context({ limits }))).ok
      ) {
        // spend cleanup
      }
      value(await object.remove(op(base), visitor("a"), "items", mine._id, context({ limits })));
    });
  });

  describe("delivery 3: cases where the record was not specific enough (Implementation notes)", () => {
    it("note 2: a delayed duplicate of an intent that ended before another one ended does not prepare again", async () => {
      const { object, base } = await fresh();
      const [a, b] = [opId(), opId()];
      value(await object.prepareErase(base, a, NOW));
      value(await object.cancelErase(base, a, NOW));
      value(await object.prepareErase(base, b, NOW));
      value(await object.cancelErase(base, b, NOW));
      // With only the last ended intent remembered (b), this would prepare a again.
      expect(value(await object.prepareErase(base, a, NOW))).toEqual({ outcome: "cancelled" });
      expect((await object.view()).durable.control?.erasing).toBeNull();
      value(await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx));
    });

    it("note 1: a transfer cannot end a hold as a side effect", async () => {
      const { object, base } = await fresh();
      value(await object.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "h" }, NOW));
      expect(
        await object.fence(
          { ...base, epoch: 2 },
          { kind: "transfer", toOwner: "owner_b", transition: "m" },
          NOW,
        ),
      ).toMatchObject({ ok: false, code: "held" });
      expect((await object.view()).durable.control?.hold).not.toBeNull();
    });

    it("note 4: a redeclaration cannot turn an append collection into an own one, which would leak other authors' counts through _seq", async () => {
      const { object, base } = await fresh("append");
      for (let index = 0; index < 4; index++)
        value(await object.create(op(base), visitor("b"), "items", { index }, ctx));
      const mine = value<{ _seq: number }>(
        await object.create(op(base), visitor("a"), "items", { n: 1 }, ctx),
      );
      expect(mine._seq).toBe(5);
      expect(
        await object.declare(op(base), OWNER, { name: "items", mode: "own" }, ctx),
      ).toMatchObject({
        ok: false,
        code: "conflict",
      });
    });

    it("note 8: replaying one operation is counted as reads, so replays are not free", async () => {
      const { object, base } = await fresh();
      const once = op(base);
      value(await object.create(once, visitor("a"), "items", { n: 1 }, ctx));
      const before = (await object.view()).pending.rows;
      for (let index = 0; index < 10; index++)
        await object.create(once, visitor("a"), "items", { n: 1 }, ctx);
      expect((await object.view()).pending.rows).toBeGreaterThanOrEqual(before + 10);
    });
  });
}
