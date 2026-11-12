// Fault schedules (decision 0026, "Every await is a fault point"): every command that awaits the
// owner's ledger is held at that await while a hold, a transfer or a duplicate delivery lands,
// and must then refuse, refuse without leaking, or apply once. Property tests run random command
// sequences and check the invariants the record states after every step.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BULK_MAX, type Outcome, operationKey } from "../src/documents.ts";
import type { Envelope } from "../src/envelope.ts";
import {
  artifact,
  context,
  FREE,
  FREE_OWNER,
  NOW,
  OWNER,
  ok,
  op,
  ROOMY,
  visitor,
} from "./harness.ts";

const DAY = Math.floor(NOW / 86_400_000);
const WRITTEN = 400;

/** A fresh owner whose small allowances make every call ask the ledger for a lease. */
function coldOwner() {
  const id = `owner_${crypto.randomUUID()}`;
  return { id, options: { owner: id, ownerWritten: WRITTEN, ownerRead: 2_000 } };
}

async function latched<T>(ownerId: string, run: () => Promise<T>, during: () => Promise<void>) {
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(ownerId));
  await ledger.arm();
  const pending = run();
  for (let tries = 0; !(await ledger.waiting()); tries++) {
    if (tries > 500) throw new Error("the call never reached the ledger");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await during();
  await ledger.release();
  return pending;
}

type Docs = ReturnType<typeof artifact>["docs"];

interface Command {
  name: string;
  mutation: boolean;
  /** Runs the command; `once` is the envelope with its operation ID for mutations. */
  run(
    docs: Docs,
    once: Envelope,
    options: ReturnType<typeof coldOwner>["options"],
    id: string,
  ): Promise<Outcome<unknown>>;
}

const COMMANDS: Command[] = [
  {
    name: "create",
    mutation: true,
    run: (docs, once, options) =>
      docs.create(once, context(visitor("v_a"), options), "items", { n: 2 }),
  },
  {
    name: "replace",
    mutation: true,
    run: (docs, once, options, id) =>
      docs.replace(once, context(OWNER, options), "items", id, { n: 3, more: "x".repeat(20) }),
  },
  {
    name: "declare",
    mutation: true,
    run: (docs, once, options) =>
      docs.declareCollection(once, context(OWNER, options), { name: "more", mode: "append" }),
  },
  {
    name: "get",
    mutation: false,
    run: (docs, once, options, id) => docs.get(once, context(OWNER, options), "items", id),
  },
  {
    name: "query",
    mutation: false,
    run: (docs, once, options) =>
      docs.query(once, context(OWNER, options), { collection: "items" }),
  },
];

async function prepared(ownerId = "owner_from") {
  const { envelope, docs } = artifact(ownerId);
  const cold = coldOwner();
  ok(
    await docs.declareCollection(op(envelope), context(OWNER, cold.options), {
      name: "items",
      mode: "shared",
    }),
  );
  const seed = ok(
    await docs.create(op(envelope), context(OWNER, cold.options), "items", { secret: "kept" }),
  );
  return { envelope, docs, cold, id: seed._id };
}

async function state(docs: Docs, envelope: Envelope) {
  const page = ok(await docs.exportPage(envelope, context(OWNER), null, 100, true));
  const control = await docs.controlRecord();
  return {
    rows: page.rows.map((row) => `${row.collection}/${row.body}`),
    collections: control?.payloadRevision,
  };
}

describe("fault schedules: a hold during the lease await", () => {
  for (const command of COMMANDS) {
    it(`${command.name} refuses and changes nothing`, async () => {
      const { envelope, docs, cold, id } = await prepared();
      const before = await state(docs, envelope);
      const outcome = await latched(
        cold.id,
        () => command.run(docs, op(envelope), cold.options, id),
        async () => {
          ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_hold" }));
        },
      );
      // Refused by the hold, or by its newer epoch: either way before any read or write.
      expect(outcome.ok).toBe(false);
      expect(["held", "stale"]).toContain((outcome as { error: string }).error);
      const held = { ...envelope, epoch: 1 };
      expect((await state(docs, held)).rows).toEqual(before.rows);
    });
  }
});

describe("fault schedules: a transfer during the lease await", () => {
  for (const command of COMMANDS) {
    it(`${command.name} refuses without leaking and gives the lease back`, async () => {
      const { envelope, docs, cold, id } = await prepared();
      const ledger = env.LEDGER.get(env.LEDGER.idFromName(cold.id));
      const pool = command.mutation ? "documents_written" : "documents_read";
      const limit = command.mutation ? WRITTEN : 2_000;
      const balance = await ledger.balance(pool, DAY, limit);
      const before = await state(docs, envelope);
      const outcome = await latched(
        cold.id,
        () => command.run(docs, op(envelope), cold.options, id),
        async () => {
          ok(
            await docs.fence(
              { ...envelope, epoch: 1 },
              { state: "open", toOwner: "owner_to", transition: "t_move" },
            ),
          );
        },
      );
      expect(outcome).toMatchObject({ ok: false, error: "stale" });
      expect(JSON.stringify(outcome)).not.toContain("kept");
      expect(await ledger.balance(pool, DAY, limit)).toBe(balance);
      const after = { ...envelope, ownerId: "owner_to", epoch: 1 };
      expect((await state(docs, after)).rows).toEqual(before.rows);
    });
  }
});

describe("fault schedules: a duplicate delivered during the lease await", () => {
  for (const command of COMMANDS.filter((each) => each.mutation)) {
    it(`${command.name} applies once and the late call replays`, async () => {
      const { envelope, docs, cold, id } = await prepared();
      const once = op(envelope);
      const roomy = { owner: `owner_${crypto.randomUUID()}` };
      let duplicate: Outcome<unknown> | null = null;
      const first = await latched(
        cold.id,
        () => command.run(docs, once, cold.options, id),
        async () => {
          duplicate = await command.run(docs, once, roomy as never, id);
        },
      );
      expect(duplicate).toMatchObject({ ok: true, value: expect.anything() });
      expect(first).toMatchObject({ ok: true, replayed: expect.anything() });
      const rows = (await state(docs, envelope)).rows;
      expect(new Set(rows).size).toBe(rows.length);
      if (command.name === "create") expect(rows).toHaveLength(2);
    });
  }

  it("remove applies once when a live connection makes it lease live bytes", async () => {
    const { envelope, docs, cold, id } = await prepared();
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_b",
          principal: "grant:v_b",
          deadline: Date.now() + 60_000,
          limits: ROOMY,
          now: Date.now(),
          owner: {
            id: `owner_${crypto.randomUUID()}`,
            allowances: { documents_read: 0, documents_written: 0, live_bytes: 16 * 1024 },
          },
        }),
      },
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    // The acknowledgement spends the connection's whole lease, so the remove must lease again.
    const acked = new Promise((resolve) => socket.addEventListener("message", resolve));
    socket.send(JSON.stringify({ subscribe: "items" }));
    await acked;
    const once = op(envelope);
    let duplicate: unknown = null;
    const first = await latched<unknown>(
      cold.id,
      async () => await docs.remove(once, context(OWNER, cold.options), "items", id),
      async () => {
        duplicate = await docs.remove(once, context(OWNER), "items", id);
      },
    );
    expect(duplicate).toMatchObject({ ok: true, value: { id } });
    expect(first).toMatchObject({ ok: true, replayed: { kind: "deleted" } });
  });
});

describe("the owner side's document API", () => {
  it("counts a collection from its counter and one author through the author index", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    for (let index = 0; index < 5; index++)
      ok(
        await docs.create(op(envelope), context(visitor(index < 3 ? "v_a" : "v_b")), "items", {
          index,
        }),
      );
    const all = await docs.count(envelope, context(OWNER), "items");
    expect(ok(all)).toEqual({ documents: 5 });
    expect(all.cost.rowsRead).toBeLessThan(40);
    expect(ok(await docs.count(envelope, context(OWNER), "items", "v_a"))).toEqual({
      documents: 3,
    });
    expect(await docs.count(envelope, context(visitor("v_a")), "items")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(ok(await artifact().docs.count(envelope, context(OWNER), "items"))).toEqual({
      documents: 0,
    });
  });

  it("deletes in bulk within the cleanup allowance, once, with one audit obligation", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    const ids: string[] = [];
    for (let index = 0; index < 6; index++)
      ids.push(
        ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { index }))._id,
      );
    const once = { ...envelope, opId: "op_bulk" };
    expect(
      ok(await docs.bulkRemove(once, context(OWNER), "items", [...ids.slice(0, 4), "missing"])),
    ).toEqual({
      removed: 4,
    });
    expect(
      await docs.bulkRemove(once, context(OWNER), "items", [...ids.slice(0, 4), "missing"]),
    ).toMatchObject({
      ok: true,
      replayed: { kind: "bulk_deleted" },
    });
    expect(ok(await docs.count(envelope, context(OWNER), "items"))).toEqual({ documents: 2 });
    expect(await docs.auditFor(operationKey("owner:owner", 0, "op_bulk"))).toMatchObject({
      kind: "data.documents_deleted",
    });
    expect(await docs.bulkRemove(op(envelope), context(OWNER), "items", [])).toMatchObject({
      error: "invalid_input",
    });
    expect(
      await docs.bulkRemove(
        op(envelope),
        context(OWNER),
        "items",
        Array.from({ length: BULK_MAX + 1 }, (_, i) => `x${i}`),
      ),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await docs.bulkRemove(op(envelope), context(visitor("v_a")), "items", [ids[4] as string]),
    ).toMatchObject({
      error: "forbidden",
    });
    const tight = context(OWNER, { limits: { ...ROOMY, cleanupRowsPerDay: 10 } });
    expect(await docs.bulkRemove(op(envelope), tight, "items", [ids[4] as string])).toMatchObject({
      error: "rate_limited",
    });
    expect(
      await artifact().docs.bulkRemove(op(envelope), context(OWNER), "items", ["x"]),
    ).toMatchObject({
      error: "not_found",
    });
  });
});

describe("the owner ledger", () => {
  it("never refills the same day twice when a delayed call carries an older day, and gives a lease back once", async () => {
    const ledger = env.LEDGER.get(env.LEDGER.idFromName(`owner_${crypto.randomUUID()}`));
    expect(await ledger.lease("documents_written", 100, 600, 1_000)).toBe(600);
    expect(await ledger.lease("documents_written", 101, 1_000, 1_000)).toBe(1_000);
    // A call still carrying day 100 arrives late: it gets only what day 101 left (nothing).
    expect(await ledger.lease("documents_written", 100, 1_000, 1_000)).toBe(0);
    expect(await ledger.giveBack("documents_written", 101, 300, 1_000, "lease_1")).toBe(true);
    expect(await ledger.giveBack("documents_written", 101, 300, 1_000, "lease_1")).toBe(false);
    expect(await ledger.balance("documents_written", 101, 1_000)).toBe(300);
  });
});

describe("plan B Free, end to end on one artifact", () => {
  it("stops growth at the owner's day, keeps cleanup on its own owner pool, and never refuses erasure", async () => {
    const { envelope, docs } = artifact();
    const ownerId = `owner_free_${crypto.randomUUID()}`;
    const free = (caller: Parameters<typeof context>[0]) =>
      context(caller, {
        limits: { ...FREE, writesPerAuthorPerMinute: 1_000 },
        owner: ownerId,
        ...FREE_OWNER,
      });
    ok(await docs.declareCollection(op(envelope), free(OWNER), { name: "items", mode: "append" }));
    const ids: string[] = [];
    let refused: Outcome<unknown> | null = null;
    for (let index = 0; index < 200 && refused === null; index++) {
      const outcome = await docs.create(op(envelope), free(visitor("v_a")), "items", { index });
      if (outcome.ok && "value" in outcome) ids.push(outcome.value._id);
      else refused = outcome;
    }
    // 5,000 rows written a day: the declaration's 60, then 40 a create, so 123 creates.
    expect(ids).toHaveLength(123);
    expect(refused).toMatchObject({ ok: false, error: "quota_exceeded" });
    // The spent growth day still deletes, from the cleanup pool.
    ok(await docs.remove(op(envelope), free(visitor("v_a")), "items", ids[0] as string));
    // The owner's cleanup pool (10,000 rows a day at 80 a delete) runs out too, and is refused.
    let cleanupRefused: Outcome<unknown> | null = null;
    for (const id of ids.slice(1)) {
      const outcome = await docs.remove(op(envelope), free(visitor("v_a")), "items", id);
      if (!outcome.ok) {
        cleanupRefused = outcome;
        break;
      }
    }
    expect(cleanupRefused).toMatchObject({ ok: false, error: "rate_limited" });
    // Erasure is protected: it is counted, never refused.
    expect(ok(await docs.eraseAuthorChunk(op(envelope), "v_a", 500, free(OWNER))).more).toBe(false);
    expect(ok(await docs.count(envelope, free(OWNER), "items"))).toEqual({ documents: 0 });
  });
});

describe("live bytes are reserved in chunks against the artifact's day", () => {
  it("writes the counter once per chunk and closes the connection when the day is spent", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    const limits = { ...ROOMY, liveBytesPerDay: 40_000 };
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_a",
          principal: "grant:v_a",
          deadline: Date.now() + 60_000,
          limits,
          now: Date.now(),
        }),
      },
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.send(JSON.stringify({ subscribe: "items" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await docs.budget(Date.now())).live_bytes).toBe(16 * 1024);
    for (let index = 0; index < 8; index++)
      await docs.create(op(envelope), context(OWNER), "items", { text: "w".repeat(6_000), index });
    expect(await closed).toBe(4029);
    expect(((await docs.budget(Date.now())).live_bytes ?? -1) % (16 * 1024)).toBe(0);
  });
});

/** A small deterministic generator, so a failing sequence can be replayed from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("properties over random command sequences", () => {
  for (const seed of [1, 7, 42]) {
    it(`keeps counters, barriers and charges consistent (seed ${seed})`, async () => {
      const next = random(seed);
      const { envelope, docs } = artifact();
      ok(
        await docs.declareCollection(op(envelope), context(OWNER), {
          name: "items",
          mode: "shared",
        }),
      );
      const authors = ["v_a", "v_b", "v_c", "v_d"];
      const erased = new Set<string>();
      const live = new Map<string, string>();
      for (let step = 0; step < 120; step++) {
        const author = authors[Math.floor(next() * authors.length)] as string;
        const roll = next();
        const ids = [...live.keys()];
        const target = ids[Math.floor(next() * ids.length)];
        const spentBefore = await docs.budget(NOW);
        let outcome: Outcome<unknown> = {
          ok: false,
          error: "not_found",
          message: "",
          cost: { rowsRead: 0, rowsWritten: 0 },
          storage: { generation: 0, seq: 0, bytes: 0 },
        };
        if (roll < 0.45 || target === undefined) {
          outcome = await docs.create(op(envelope), context(visitor(author)), "items", {
            step,
            text: "t".repeat(Math.floor(next() * 200)),
          });
          if (outcome.ok && "value" in outcome)
            live.set((outcome.value as { _id: string })._id, author);
        } else if (roll < 0.65) {
          outcome = await docs.replace(op(envelope), context(visitor(author)), "items", target, {
            step,
          });
        } else if (roll < 0.8) {
          outcome = await docs.remove(op(envelope), context(visitor(author)), "items", target);
          if (outcome.ok) live.delete(target);
        } else if (roll < 0.9) {
          outcome = await docs.query(envelope, context(visitor(author)), {
            collection: "items",
            limit: 20,
          });
        } else {
          do {
            outcome = await docs.eraseAuthorChunk(op(envelope), author, 2);
          } while (outcome.ok && "value" in outcome && (outcome.value as { more: boolean }).more);
          erased.add(author);
          for (const [id, by] of live) if (by === author) live.delete(id);
        }
        // Invariant 1: what was charged before the work covers the work it did.
        if (outcome.ok && roll < 0.9) {
          const spentAfter = await docs.budget(NOW);
          const charged = ["rows_read", "rows_written", "cleanup"].reduce(
            (sum, key) => sum + (spentAfter[key] ?? 0) - (spentBefore[key] ?? 0),
            0,
          );
          expect(charged).toBeGreaterThanOrEqual(outcome.cost.rowsRead + outcome.cost.rowsWritten);
        }
      }
      // Invariant 2: the counter equals the documents; invariant 3: no erased author has data.
      const page = ok(await docs.exportPage(envelope, context(OWNER), null, 500));
      expect(ok(await docs.count(envelope, context(OWNER), "items")).documents).toBe(
        page.rows.length,
      );
      expect(page.rows.map((row) => row.id).sort()).toEqual([...live.keys()].sort());
      for (const row of page.rows) {
        expect(erased.has(row.by)).toBe(false);
        expect(
          row.editedBy === null || row.editedBy === "erased" || !erased.has(row.editedBy),
        ).toBe(true);
      }
      for (const author of erased) {
        expect(
          (await docs.create(op(envelope), context(visitor(author)), "items", { late: true })).ok,
        ).toBe(false);
      }
    });
  }
});
