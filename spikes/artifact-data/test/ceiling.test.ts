import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/documents.ts";
import { artifact, context, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const DAY = 86_400_000;

async function sandboxWithRows(rows: number) {
  const target = artifact();
  ok(
    await target.sandbox.execute(op(target.envelope), context(OWNER), "create table n (x integer)"),
  );
  await target.sandbox.unsafeExec(
    `insert into n (x) values ${Array.from({ length: rows }, (_, index) => `(${index})`).join(", ")}`,
  );
  return target;
}

describe("the owner SQL spending ceiling (decision 0026, finding 7)", () => {
  it("turns an overdraft into debt that blocks SQL until later days pay it off", async () => {
    const { envelope, sandbox } = await sandboxWithRows(5_000);
    const ownerId = `owner_debt_${crypto.randomUUID()}`;
    const day0 = context(OWNER, { owner: ownerId, sqlWritten: 2_000 });
    // One statement writes 5,000 rows against a 2,000-row day: it runs (it was admitted with a
    // lease) and its overdraft becomes debt.
    ok(await sandbox.execute(op(envelope), day0, "update n set x = x + 1"));
    const ledger = env.LEDGER.get(env.LEDGER.idFromName(ownerId));
    const today = Math.floor(NOW / DAY);
    expect(await ledger.balance("sql_written", today, 2_000)).toBeLessThan(0);
    expect(await sandbox.execute(op(envelope), day0, "update n set x = x + 1")).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    // A day's allowance does not clear a debt of more than a day; two days do.
    const day1 = context(OWNER, { owner: ownerId, sqlWritten: 2_000, now: NOW + DAY });
    expect(
      (await sandbox.execute(op(envelope), day1, "update n set x = x + 1 where x < 0")).ok,
    ).toBe(false);
    const day3 = context(OWNER, { owner: ownerId, sqlWritten: 2_000, now: NOW + 3 * DAY });
    ok(await sandbox.execute(op(envelope), day3, "update n set x = x + 1 where x < 0"));
  });

  it("keeps the debt when the sandbox is erased and recreated", async () => {
    const { envelope, sandbox } = await sandboxWithRows(5_000);
    const ownerId = `owner_debt_${crypto.randomUUID()}`;
    const spender = context(OWNER, { owner: ownerId, sqlWritten: 2_000 });
    ok(await sandbox.execute(op(envelope), spender, "update n set x = x + 1"));
    expect(await sandbox.prepareErase(envelope)).toEqual({ ok: true, prepared: true });
    expect(await sandbox.commitErase(envelope)).toEqual({ ok: true, erased: true });
    const next = { ...envelope, generation: 1 };
    expect(await sandbox.execute(op(next), spender, "create table again (x)")).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });

  it("charges a statement the platform stopped at the plan's worst case, as debt", async () => {
    const { envelope, sandbox } = await sandboxWithRows(10);
    const ownerId = `owner_killed_${crypto.randomUUID()}`;
    const killed = context(OWNER, {
      owner: ownerId,
      sqlWritten: 50_000,
      limits: { ...ROOMY, sqlWorstRowsWritten: 100_000 },
    });
    await sandbox.abandonStatement(envelope, killed);
    // The next statement settles the marker first: 100,000 rows of debt on a 50,000-row day.
    expect(await sandbox.execute(op(envelope), killed, "insert into n values (1)")).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    const ledger = env.LEDGER.get(env.LEDGER.idFromName(ownerId));
    expect(await ledger.balance("sql_written", Math.floor(NOW / DAY), 50_000)).toBeLessThanOrEqual(
      -50_000,
    );
  });

  it("bounds what one write can touch: one source table for INSERT … SELECT, at most 4 indexes", async () => {
    const { envelope, sandbox } = await sandboxWithRows(100);
    const owner = context(OWNER);
    expect(
      await sandbox.execute(op(envelope), owner, "insert into n select a.x from n a, n b"),
    ).toMatchObject({
      ok: false,
      error: "forbidden",
      message: "INSERT … SELECT reads from one table at most",
    });
    expect(
      await sandbox.execute(
        op(envelope),
        owner,
        "insert into n select x from n union all select x from n",
      ),
    ).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    ok(await sandbox.execute(op(envelope), owner, "insert into n select x from n where x < 10"));
    for (let index = 0; index < 4; index++) {
      ok(await sandbox.execute(op(envelope), owner, `create index i${index} on n (x)`));
    }
    expect(await sandbox.execute(op(envelope), owner, "create index i4 on n (x)")).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });

  it("charges cleanup to its own allowance, so a spent SQL day still deletes", async () => {
    const { envelope, sandbox } = await sandboxWithRows(100);
    const spent = context(OWNER, {
      limits: { ...ROOMY, sqlRowsWrittenPerDay: 0, sqlRowsReadPerDay: 0 },
    });
    expect(await sandbox.execute(op(envelope), spent, "insert into n values (1)")).toMatchObject({
      ok: false,
    });
    ok(await sandbox.execute(op(envelope), spent, "delete from n where x < 50"));
    ok(await sandbox.execute(op(envelope), spent, "drop table n"));
    expect((await sandbox.budget(NOW)).cleanup).toBeGreaterThan(0);
  });
});

describe("leases follow the owner (finding 12)", () => {
  it("never uses the former owner's lease after a transfer", async () => {
    const { envelope, docs } = artifact("owner_from");
    const before = context(OWNER, { owner: "owner_from" });
    ok(await docs.declareCollection(op(envelope), before, { name: "items", mode: "append" }));
    ok(
      await docs.create(op(envelope), context(visitor("v_a"), { owner: "owner_from" }), "items", {
        n: 1,
      }),
    );
    const after = { ...envelope, ownerId: "owner_to", epoch: 1 };
    ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "open", toOwner: "owner_to" }));
    const broke = context(visitor("v_a"), {
      owner: `owner_to_${crypto.randomUUID()}`,
      ownerWritten: 0,
    });
    expect(await docs.create(op(after), broke, "items", { n: 2 })).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });
});

describe("live bytes (finding 16)", () => {
  async function subscribed(
    docs: DurableObjectStub<import("../src/documents.ts").ArtifactDocuments>,
    envelope: typeof artifact extends () => infer R
      ? R extends { envelope: infer E }
        ? E
        : never
      : never,
  ) {
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_a",
          principal: "grant:v_a",
          deadline: Date.now() + 60_000,
          limits: ROOMY,
          now: Date.now(),
        }),
      },
    });
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const received: string[] = [];
    socket.addEventListener("message", (event) => received.push(String(event.data)));
    socket.send(JSON.stringify({ subscribe: "items" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return received;
  }

  it("counts what is sent in UTF-8 bytes, acknowledgements included, and notifies a replay once", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    const received = await subscribed(docs, envelope);
    const once = op(envelope);
    ok(await docs.create(once, context(OWNER), "items", { text: "€".repeat(100) }));
    await docs.create(once, context(OWNER), "items", { text: "€".repeat(100) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.filter((message) => message.includes('"created"'))).toHaveLength(1);
    const expected = received.reduce((sum, message) => sum + utf8(message), 0);
    expect((await docs.budget(NOW)).live_bytes).toBe(expected);
  });
});
