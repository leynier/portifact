// The fourth review's reproductions that still apply after the simplification (pull request #249
// at 65b85f06). Each states the behavior the design must have; against that commit they fail,
// which is the reproduction. The cases about the owner ledger and leases (D15, D16, D26 and the
// lease-await schedules) are closed by removing the ledger, so they are not reproduced.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ArtifactDocuments } from "../src/documents.ts";
import type { Envelope } from "../src/envelope.ts";
import { artifact, context, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const any = (value: unknown) => value as never;
const owner = context(OWNER);
type Docs = DurableObjectStub<ArtifactDocuments>;

async function rows(docs: Docs, sql: string, ...params: unknown[]): Promise<number> {
  return runInDurableObject(docs, (_instance, state) => {
    try {
      const [row] = state.storage.sql.exec<{ n: number }>(sql, ...params).toArray();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  });
}

async function nextAlarm(docs: Docs): Promise<number | null> {
  return runInDurableObject(docs, (_instance, state) => state.storage.getAlarm());
}

async function socket(docs: Docs, envelope: Envelope, author: string | null) {
  const response = await docs.fetch("https://data.internal/live", {
    headers: {
      Upgrade: "websocket",
      "X-Portifact-Envelope": JSON.stringify(envelope),
      "X-Portifact-Caller": JSON.stringify({
        author,
        principal: `grant:${author ?? "reader"}`,
        deadline: Date.now() + 60_000,
        limits: ROOMY,
        now: Date.now(),
      }),
    },
  });
  const ws = response.webSocket as WebSocket;
  ws.accept();
  const received: string[] = [];
  ws.addEventListener("message", (event) => received.push(String(event.data)));
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code)),
  );
  return { ws, received, closed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("fourth review: lifecycle (findings 1, 2, 6, 8)", () => {
  it("D01: a held object refuses erasure through quarantine resolution", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    const held = { ...envelope, epoch: 1 };
    ok(await docs.fence(held, { state: "held", transition: "t_hold" }));
    expect(await docs.quarantine(held, "owner")).toBe(true);
    expect(await docs.resolveQuarantine(held, "erase")).toMatchObject({ ok: false });
    expect(await rows(docs, "select count(*) as n from pf_documents")).toBe(1);
  });

  it("D03: a delayed cancel of an earlier erase intent does not cancel a later one", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const prepare = (e: Envelope, id: string) => docs.prepareErase(e, id);
    const cancel = (e: Envelope, id: string) => docs.cancelErase(e, id);
    await prepare(envelope, "erase_1");
    expect(await cancel(envelope, "erase_1")).toBe(true);
    await prepare(envelope, "erase_2");
    expect(await cancel(envelope, "erase_1")).toBe(false);
    expect((await docs.controlRecord())?.erasing).not.toBeNull();
  });

  it("D29: a transition ID repeated with other contents is a conflict", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const held = { ...envelope, epoch: 1 };
    ok(await docs.fence(held, { state: "held", transition: "t_same" }));
    expect(await docs.fence(held, { state: "open", transition: "t_same" })).toMatchObject({
      ok: false,
    });
  });

  it("D36: a request at a pending fence's epoch does not consume that epoch", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const next = { ...envelope, epoch: 1 };
    ok(await docs.exportPage(next, owner, null, 10));
    expect(ok(await docs.fence(next, { state: "held", transition: "t_hold" }))).toMatchObject({
      held: true,
    });
  });

  it("D04: a hold does not leave an alarm that wakes the object to do nothing", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    await docs.backdateReplays(Date.now() - 3 * 86_400_000);
    ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_hold" }));
    await runDurableObjectAlarm(docs);
    expect(await nextAlarm(docs)).toBeNull();
  });

  it("D02: the first durable write on an empty object binds its identity", async () => {
    const { envelope, docs } = artifact();
    await docs.settle(envelope, "owner:owner", `${NOW}.x`);
    expect(await docs.controlRecord()).not.toBeNull();
    expect(
      await docs.settle({ ...envelope, artifactId: "different" }, "owner:owner", `${NOW}.y`),
    ).toEqual({ state: "refused" });
  });
});

describe("fourth review: author erasure is terminal (finding 7)", () => {
  async function erased() {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    ok(await docs.create(op(envelope), context(visitor("gone")), "items", { n: 1 }));
    const second = ok(await docs.create(op(envelope), context(visitor("gone")), "items", { n: 2 }));
    ok(await docs.eraseAuthorChunk(op(envelope), "gone", 1));
    // An owner edit between chunks must not recreate the author's sequence.
    await docs.replace(op(envelope), owner, "items", second._id, { n: 3 });
    while (ok(await docs.eraseAuthorChunk(op(envelope), "gone", 1)).more) {
      // until done
    }
    return { envelope, docs };
  }

  it("D23: no sequence of the author remains after an owner edit between chunks", async () => {
    const { docs } = await erased();
    expect(await rows(docs, "select count(*) as n from pf_seq where scope = 'author:gone'")).toBe(
      0,
    );
  });

  it("D05: a late settlement for the author writes nothing about them", async () => {
    const { envelope, docs } = await erased();
    await docs.settle(envelope, "gone", `${NOW}.late`);
    expect(await rows(docs, "select count(*) as n from pf_ops where actor = 'gone'")).toBe(0);
  });

  it("D06: a refused late write leaves no rate row for the author", async () => {
    const { envelope, docs } = await erased();
    expect((await docs.create(op(envelope), context(visitor("gone")), "items", { n: 9 })).ok).toBe(
      false,
    );
    expect(await rows(docs, "select count(*) as n from pf_rate where subject = 'gone'")).toBe(0);
  });
});

describe("fourth review: replay, retention and accounting (findings 3, 4, 9, 10)", () => {
  it("D18: an operation ID past the replay horizon is refused, not applied again", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const old = { ...envelope, opId: `${NOW}.d18` };
    ok(await docs.create(old, context(visitor("v_a")), "items", { n: 1 }));
    const later = NOW + 2 * 86_400_000;
    await docs.pruneReplays(later);
    expect(
      (await docs.create(old, context(visitor("v_a"), { now: later }), "items", { n: 1 })).ok,
    ).toBe(false);
    expect(await rows(docs, "select count(*) as n from pf_documents")).toBe(1);
  });

  it("D12: rate rows are pruned through an index that leads with their age", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const plan = await runInDurableObject(docs, (_instance, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "explain query plan select subject from pf_rate where window < ? limit 500",
          1,
        )
        .toArray()
        .map((row) => row.detail)
        .join(" "),
    );
    expect(plan).toMatch(/USING (COVERING )?INDEX/);
  });

  it("D13: a delivered audit record keeps an alarm for its own expiry", async () => {
    const { envelope, docs } = artifact();
    const declared = op(envelope);
    ok(await docs.declareCollection(declared, owner, { name: "items", mode: "append" }));
    await docs.acknowledge(envelope, "owner:owner", declared.opId as string);
    await docs.backdateReplays(Date.now() - 3 * 86_400_000);
    await runDurableObjectAlarm(docs);
    expect(await nextAlarm(docs)).not.toBeNull();
  });

  it("D08: reads write no counter row per request", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const created = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    let written = 0;
    for (let index = 0; index < 20; index++) {
      written += (await docs.get(envelope, owner, "items", created._id)).cost.rowsWritten;
    }
    expect(written).toBe(0);
  });

  it("D40: an index over existing documents is built in bounded steps", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    await docs.seedForMeasure(envelope, "items", 2_000, NOW);
    const declared = await docs.declareCollection(op(envelope), owner, {
      name: "items",
      mode: "append",
      indexed: ["tag"],
    });
    // One step covers at most CAPS.indexStepDocuments documents, however many exist.
    expect(declared.cost.rowsRead + declared.cost.rowsWritten).toBeLessThan(3_000);
  });

  it("D11: counting one author's documents does not scan them", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    await docs.seedForMeasure(envelope, "items", 2_000, NOW, 1);
    const counted = await docs.count(envelope, owner, "items", "v_0");
    expect(counted.cost.rowsRead).toBeLessThan(100);
  });

  it("D09: an author erasure chunk is charged at least the work it did", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "append",
        indexed: ["a", "b", "c"],
      }),
    );
    for (let index = 0; index < 30; index++)
      ok(
        await docs.create(op(envelope), context(visitor("v_x")), "items", { a: index, b: 1, c: 2 }),
      );
    const before = (await docs.budget(NOW)).cleanup ?? 0;
    const chunk = await docs.eraseAuthorChunk(op(envelope), "v_x", 30, owner);
    const after = (await docs.budget(NOW)).cleanup ?? 0;
    expect(after - before).toBeGreaterThanOrEqual(chunk.cost.rowsRead + chunk.cost.rowsWritten);
  });
});

describe("fourth review: live invalidation and visitors' rights (findings 11, 12)", () => {
  it("D28: a live reservation advances the storage sequence", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const before = (await docs.size()).seq;
    const live = await socket(docs, envelope, "v_a");
    live.ws.send(JSON.stringify({ subscribe: "items" }));
    await settle();
    expect((await docs.size()).seq).toBeGreaterThan(before);
  });

  it("D31: a bulk delete notifies subscribers", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const created = ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    const live = await socket(docs, envelope, "v_a");
    live.ws.send(JSON.stringify({ subscribe: "items" }));
    await settle();
    ok(await docs.bulkRemove(op(envelope), owner, "items", [created._id]));
    await settle();
    expect(live.received.some((message) => message.includes('"deleted"'))).toBe(true);
  });

  it("D30: preparing an erase closes live connections", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const live = await socket(docs, envelope, "v_a");
    await docs.prepareErase(envelope, "erase_1");
    const code = await Promise.race([
      live.closed,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 200)),
    ]);
    expect(code).not.toBe(-1);
  });

  it("D38: a visitor exports their own documents without write permission", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { mine: true }));
    const page = await docs.exportMine(envelope, context(visitor("v_a", false)), null);
    expect(JSON.stringify(page)).toContain("mine");
  });

  it("D41: an owner spending the cleanup allowance does not stop a visitor deleting their own", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const mine = ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    const tight = { limits: { ...ROOMY, cleanupRowsPerDay: 100 } };
    for (let index = 0; index < 5; index++)
      await docs.remove(op(envelope), context(OWNER, tight), "items", `missing_${index}`);
    expect(
      (await docs.remove(op(envelope), context(visitor("v_a"), tight), "items", mine._id)).ok,
    ).toBe(true);
  });
});
