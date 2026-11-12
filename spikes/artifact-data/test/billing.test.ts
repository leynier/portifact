import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import source from "../src/documents.ts?raw";
import type { Envelope } from "../src/envelope.ts";
import { artifact, context, NOW, OWNER, ok, op, visitor } from "./harness.ts";

// Experiment 3 of decision 0026's delivery 2, local half: what workerd can show about billed
// work. Rows per command are compared with the record's table; alarms are counted over
// simulated days (the object reads `Date.now()`, which fake timers move inside the object too,
// because the test runs in the object's isolate). Active wall time and hibernation need a
// deployment: drill/runbook.ts measures them.

afterEach(() => {
  vi.useRealTimers();
});

/** The record's "Measured rows per operation" table, read and written. */
const RECORD_ROWS = {
  firstDeclare: [42, 44],
  visitorCreate: [11, 13],
  visitorReplace: [13, 9],
  visitorDelete: [12, 11],
  visitorGet: [4, 0],
  visitorPage20: [25, 0],
  ownerCreateWithAudit: [10, 14],
  ownerCount: [3, 0],
  ownerCountByAuthor: [4, 0],
  ownerBulkRemove10: [55, 47],
  ownerExport100: [106, 2],
  authorEraseChunk20: [279, 89],
} as const;

describe("rows per command against the record's table", () => {
  it("measures exactly the record's numbers", async () => {
    const { envelope, docs } = artifact();
    const owner = context(OWNER);
    const measured: Record<string, [number, number]> = {};
    const keep = (name: string, cost: { rowsRead: number; rowsWritten: number }) => {
      measured[name] = [cost.rowsRead, cost.rowsWritten];
    };
    keep(
      "firstDeclare",
      (await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" })).cost,
    );
    for (let index = 0; index < 999; index++)
      ok(
        await docs.create(
          op(envelope),
          context(visitor(`v_${index % 50}`), { now: NOW + index }),
          "items",
          { index },
        ),
      );
    const caller = context(visitor("v_1"), { now: NOW + 5_000 });
    const created = await docs.create(op(envelope), caller, "items", { index: 999 });
    keep("visitorCreate", created.cost);
    const id = ok(created)._id;
    keep(
      "visitorReplace",
      (await docs.replace(op(envelope), caller, "items", id, { index: 1000 })).cost,
    );
    keep("visitorGet", (await docs.get(envelope, caller, "items", id)).cost);
    keep(
      "visitorPage20",
      (await docs.query(envelope, caller, { collection: "items", limit: 20 })).cost,
    );
    keep("visitorDelete", (await docs.remove(op(envelope), caller, "items", id)).cost);
    keep("ownerCreateWithAudit", (await docs.create(op(envelope), owner, "items", { n: 1 })).cost);
    keep("ownerCount", (await docs.count(envelope, owner, "items")).cost);
    keep("ownerCountByAuthor", (await docs.count(envelope, owner, "items", "v_3")).cost);
    const ids = ok(
      await docs.query(envelope, owner, { collection: "items", limit: 10 }),
    ).documents.map((document) => document._id);
    keep("ownerBulkRemove10", (await docs.bulkRemove(op(envelope), owner, "items", ids)).cost);
    keep("ownerExport100", (await docs.exportPage(envelope, owner, null, 100)).cost);
    keep("authorEraseChunk20", (await docs.eraseAuthorChunk(op(envelope), "v_7", 100)).cost);
    console.log(JSON.stringify({ measure: "rows_vs_record", measured, record: RECORD_ROWS }));
    expect(measured).toEqual(RECORD_ROWS);
  });
});

async function alarmAt(docs: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(docs, (_instance, state) => state.storage.getAlarm());
}

/**
 * Runs the object's alarms in order of their time, moving the clock to each, until none is set
 * or `until` is reached. Returns the alarms per UTC day since `start`.
 */
async function runAlarms(
  docs: DurableObjectStub,
  start: number,
  until: number,
): Promise<{ perDay: number[]; total: number; last: number | null }> {
  const perDay: number[] = [];
  let total = 0;
  for (;;) {
    // The object schedules with promises it does not await; let them land first.
    await runInDurableObject(docs, () => undefined);
    const next = await alarmAt(docs);
    if (next === null || next > until) return { perDay, total, last: next };
    vi.setSystemTime(next);
    expect(await runDurableObjectAlarm(docs)).toBe(true);
    const index = Math.floor((next - start) / 86_400_000);
    perDay[index] = (perDay[index] ?? 0) + 1;
    total += 1;
    if (total > 20_000) throw new Error("alarm loop did not settle");
  }
}

function at(envelope: Envelope, now: number, tag: string): Envelope {
  return { ...envelope, opId: `${now}.${tag}` };
}

describe("alarms and timers", () => {
  it("uses no timer in the object: only the alarm and hibernatable sockets wake it", () => {
    expect(source).not.toMatch(/\bset(Timeout|Interval)\s*\(/);
    expect(source).toContain("acceptWebSocket");
  });

  it("an idle object sets no alarm once its records have aged out", async () => {
    const { envelope, docs } = artifact();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2031, 0, 1);
    vi.setSystemTime(start);
    ok(
      await docs.declareCollection(at(envelope, start, "d"), context(OWNER, { now: start }), {
        name: "items",
        mode: "own",
      }),
    );
    const { perDay, total, last } = await runAlarms(docs, start, start + 30 * 86_400_000);
    console.log(JSON.stringify({ measure: "alarms_idle", perDay, total }));
    expect(last).toBeNull();
    // The declaration's operation record (a day) and the day's counter (three days).
    expect(total).toBeLessThanOrEqual(3);
  });

  it("a held object without connections sets no alarm at all", async () => {
    const { envelope, docs } = artifact();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2031, 1, 1);
    vi.setSystemTime(start);
    ok(
      await docs.declareCollection(at(envelope, start, "d"), context(OWNER, { now: start }), {
        name: "items",
        mode: "own",
      }),
    );
    for (let index = 0; index < 20; index++) {
      const now = start + index * 1_000;
      vi.setSystemTime(now);
      ok(
        await docs.create(
          at(envelope, now, `w${index}`),
          context(visitor("v_a"), { now }),
          "items",
          {
            index,
          },
        ),
      );
    }
    ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_hold" }));
    await runInDurableObject(docs, () => undefined);
    expect(await alarmAt(docs)).toBeNull();
    const { total } = await runAlarms(docs, start, start + 30 * 86_400_000);
    console.log(JSON.stringify({ measure: "alarms_held", total }));
    expect(total).toBe(0);
  });

  it("an object with a steady write history wakes once per expiring record, not once a minute", async () => {
    // 120 visitor writes, one every 30 seconds for an hour, with no live connection. The record's
    // cost formula counts alarms only for artifacts with connections (one a minute at most).
    const { envelope, docs } = artifact();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2031, 2, 1);
    vi.setSystemTime(start);
    ok(
      await docs.declareCollection(at(envelope, start, "d"), context(OWNER, { now: start }), {
        name: "items",
        mode: "own",
      }),
    );
    const writes = 120;
    for (let index = 0; index < writes; index++) {
      const now = start + 60_000 + index * 30_000;
      vi.setSystemTime(now);
      ok(
        await docs.create(
          at(envelope, now, `w${index}`),
          context(visitor("v_a"), { now }),
          "items",
          {
            index,
          },
        ),
      );
    }
    const { perDay, total, last } = await runAlarms(docs, start, start + 30 * 86_400_000);
    const busiest = Math.max(...perDay.filter((n) => n !== undefined));
    console.log(
      JSON.stringify({ measure: "alarms_expiring_records", writes, perDay, total, busiest }),
    );
    expect(last).toBeNull();
    // Counterexample to "one a minute per artifact with connections": the day after the writes,
    // the object wakes at least once per write, inside one hour, with no connection at all.
    expect(perDay[1]).toBeGreaterThanOrEqual(writes);
    expect(busiest).toBeGreaterThan(60);
  });

  it("a live connection's deadline wakes the object once per renewal period", async () => {
    const { envelope, docs } = artifact();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2031, 3, 1);
    vi.setSystemTime(start);
    ok(
      await docs.declareCollection(at(envelope, start, "d"), context(OWNER, { now: start }), {
        name: "items",
        mode: "own",
      }),
    );
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_a",
          principal: "p_1",
          deadline: start + 60_000,
          limits: context(OWNER).limits,
          now: start,
        }),
      },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    await runInDurableObject(docs, () => undefined);
    // The first alarm is the connection's deadline, 60 seconds out; it closes the socket.
    expect(await alarmAt(docs)).toBe(start + 60_000);
    vi.setSystemTime(start + 60_000);
    expect(await runDurableObjectAlarm(docs)).toBe(true);
    const sockets = await runInDurableObject(
      docs,
      (_instance, state) => state.getWebSockets().length,
    );
    console.log(JSON.stringify({ measure: "alarms_live_deadline", socketsAfterDeadline: sockets }));
    response.webSocket?.close();
  });
});
