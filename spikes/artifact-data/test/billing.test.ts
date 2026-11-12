import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDocuments, Outcome } from "../src/documents.ts";
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

/**
 * Rows read per command that the reported cost leaves out, as the scratch deployment billed
 * them less the schema check's 0.48 a command: replace 15.5 against 13, get 5.5 against 4,
 * page 26.5 against 25, ownerCreate 12.5 against 10, count 4.5 against 3, export 106.5 against
 * 106, delete 15.5 against 12.
 */
const UNREPORTED_READS = {
  get: 1,
  page: 1,
  count: 1,
  export: 1,
  create: 2,
  ownerCreate: 2,
  replace: 2,
  delete: 2,
};

/** Rows read and written per minute as the deployment billed them, one phase per minute. */
const DEPLOYED_PHASES: Record<string, [number, number]> = {
  replace: [773, 451],
  get: [274, 0],
  page: [1324, 0],
  ownerCreate: [624, 700],
  count: [224, 0],
  export: [5324, 100],
  delete: [773, 501],
};

describe("what billing counts beyond the reported cost (the scratch run of 2026-11-12)", () => {
  /** Runs `call` inside the object, counting the rows of every SQL cursor it opens. */
  async function tally<T>(
    docs: DurableObjectStub<ArtifactDocuments>,
    call: (instance: ArtifactDocuments) => T,
  ): Promise<{ result: T; read: number; written: number }> {
    return runInDurableObject(docs, (instance: ArtifactDocuments, state) => {
      const sql = state.storage.sql;
      const original = sql.exec.bind(sql);
      const cursors: { rowsRead: number; rowsWritten: number }[] = [];
      sql.exec = ((query: string, ...bindings: unknown[]) => {
        const cursor = original(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      }) as typeof sql.exec;
      try {
        const result = call(instance);
        return {
          result,
          read: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
          written: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
        };
      } finally {
        sql.exec = original;
      }
    });
  }

  it("reads one row after the cost is taken: the storage report's control record", async () => {
    const { envelope, docs } = artifact();
    const owner = context(OWNER);
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const caller = context(visitor("v_1"), { now: NOW + 1_000 });
    const id = ok(await docs.create(op(envelope), caller, "items", { a: 1 }))._id;
    const other = ok(await docs.create(op(envelope), caller, "items", { a: 2 }))._id;
    const measured: Record<string, { read: number; written: number }> = {};
    const commands: [string, (i: ArtifactDocuments) => Outcome<unknown>][] = [
      ["get", (i) => i.get(envelope, caller, "items", id)],
      ["page", (i) => i.query(envelope, caller, { collection: "items", limit: 20 })],
      ["count", (i) => i.count(envelope, owner, "items")],
      ["export", (i) => i.exportPage(envelope, owner, null, 100)],
      ["create", (i) => i.create(op(envelope), caller, "items", { b: 2 })],
      ["ownerCreate", (i) => i.create(op(envelope), owner, "items", { c: 3 })],
      ["replace", (i) => i.replace(op(envelope), caller, "items", id, { a: 3 })],
      ["delete", (i) => i.remove(op(envelope), caller, "items", other)],
    ];
    for (const [name, run] of commands) {
      const { result, read, written } = await tally(docs, run);
      measured[name] = {
        read: read - result.cost.rowsRead,
        written: written - result.cost.rowsWritten,
      };
    }
    console.log(JSON.stringify({ measure: "rows_after_cost_snapshot", measured }));
    // Rows the cost does not report: the storage report's control record (every command) and
    // the charge statement's own read (mutations).
    expect(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.read]))).toEqual(
      UNREPORTED_READS,
    );
  });

  it("scans sqlite_schema once per object instance: about two dozen rows read on a cold start", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "own" }));
    const scan = await runInDurableObject(docs, (_instance, state) => {
      const cursor = state.storage.sql.exec(
        "select 1 as found from sqlite_schema where name = 'pf_meta'",
      );
      cursor.toArray();
      const [count] = state.storage.sql
        .exec<{ n: number }>("select count(*) as n from sqlite_schema")
        .toArray();
      return { rowsRead: cursor.rowsRead, entries: count?.n ?? 0 };
    });
    console.log(JSON.stringify({ measure: "schema_check_rows", ...scan }));
    // `#hasSchema` runs this once per instance (then caches it); the deployed object paid it
    // again after every hibernation or eviction: 24 extra rows in each minute of the command
    // phases and on every write 15 seconds apart in the live phase.
    expect(scan.rowsRead).toBe(scan.entries);
    expect(scan.rowsRead).toBe(24);
  });

  it("writes one row more on an author's first write of a minute: the new rate row", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "own" }));
    const ids: string[] = [];
    for (let index = 0; index < 3; index++)
      ids.push(
        ok(await docs.create(op(envelope), context(visitor("v_2")), "items", { index }))._id,
      );
    const deletes = [];
    for (const id of ids.slice(0, 2)) {
      const later = context(visitor("v_2"), { now: NOW + 70_000 });
      deletes.push((await docs.remove(op(envelope), later, "items", id)).cost.rowsWritten);
    }
    console.log(JSON.stringify({ measure: "rate_row_first_of_minute", deletes }));
    // The first delete of the minute inserts the rate row (and its index entry); later ones
    // update it. 50 deletes in one minute: 11 + 49 × 10 = 501 rows, as the deployment billed.
    expect(deletes[0]).toBe((deletes[1] ?? 0) + 1);
  });

  it("reproduces every deployed phase's billed rows exactly, with one schema check per phase", async () => {
    // The scratch Worker's workload in order, 50 commands a phase, one phase a minute; each
    // phase is counted cursor by cursor and the cold start's schema check (24 rows) added.
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "notes", mode: "own" }));
    const minute = (n: number) => NOW + n * 60_000;
    const bench = (n: number) => context(visitor("v_bench"), { now: minute(n) });
    const owner = (n: number) => context(OWNER, { now: minute(n) });
    const ids: string[] = [];
    for (let index = 0; index < 50; index++)
      ids.push(ok(await docs.create(op(envelope), bench(1), "notes", { t: index }))._id);
    const phases: [string, (i: ArtifactDocuments, index: number) => Outcome<unknown>][] = [
      ["replace", (i, k) => i.replace(op(envelope), bench(2), "notes", ids[k] ?? "", { t: k })],
      ["get", (i, k) => i.get(envelope, bench(3), "notes", ids[k] ?? "")],
      ["page", (i) => i.query(envelope, bench(4), { collection: "notes", limit: 20 })],
      ["ownerCreate", (i, k) => i.create(op(envelope), owner(5), "notes", { t: k })],
      ["count", (i) => i.count(envelope, owner(6), "notes")],
      ["export", (i) => i.exportPage(envelope, owner(7), null, 100)],
      ["delete", (i, k) => i.remove(op(envelope), bench(8), "notes", ids[k] ?? "")],
    ];
    const local: Record<string, [number, number]> = {};
    for (const [name, run] of phases) {
      let read = 24;
      let written = 0;
      for (let index = 0; index < 50; index++) {
        const counted = await tally(docs, (instance) => {
          const outcome = run(instance, index);
          if (!outcome.ok) throw new Error(`${name} refused: ${outcome.error}`);
          return outcome;
        });
        read += counted.read;
        written += counted.written;
      }
      local[name] = [read, written];
    }
    console.log(
      JSON.stringify({ measure: "deployed_phases_reproduced", local, deployed: DEPLOYED_PHASES }),
    );
    expect(local).toEqual(DEPLOYED_PHASES);
  });

  it("measures a write's rows with a subscribed live connection", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "notes", mode: "own" }));
    const now = Date.now();
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_bench",
          principal: "p_bench",
          deadline: now + 600_000,
          limits: context(OWNER).limits,
          now,
        }),
      },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();
    const received: string[] = [];
    socket.addEventListener("message", (event) => received.push(String(event.data)));
    socket.send(JSON.stringify({ subscribe: "notes" }));
    await expect.poll(() => received.length).toBe(1);
    const writes: [number, number][] = [];
    const plain: [number, number][] = [];
    for (let index = 0; index < 4; index++) {
      const counted = await tally(docs, (instance) =>
        instance.create(op(envelope), context(visitor("v_bench"), { now }), "notes", { index }),
      );
      writes.push([counted.read, counted.written]);
    }
    await expect.poll(() => received.length).toBe(5);
    for (let index = 0; index < 4; index++) {
      const counted = await tally(docs, (instance) =>
        instance.create(op(envelope), context(visitor("v_other"), { now }), "notes", { index }),
      );
      plain.push([counted.read, counted.written]);
    }
    console.log(JSON.stringify({ measure: "live_write_rows", writes, plain, received }));
    socket.close();
  });
});
