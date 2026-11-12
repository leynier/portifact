import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ArtifactDocuments } from "../src/documents.ts";
import type { Envelope } from "../src/envelope.ts";
import type { DataLimits } from "../src/model.ts";
import { artifact, context, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);

interface Live {
  socket: WebSocket;
  id: string;
  received: unknown[];
  closed: Promise<number>;
  next(): Promise<unknown>;
}

async function connect(
  docs: DurableObjectStub<ArtifactDocuments>,
  envelope: Envelope,
  author: string | null,
  options: { limits?: DataLimits; deadline?: number; now?: number } = {},
): Promise<Live | number> {
  const now = options.now ?? Date.now();
  const response = await docs.fetch("https://data.internal/live", {
    headers: {
      Upgrade: "websocket",
      "X-Portifact-Envelope": JSON.stringify(envelope),
      "X-Portifact-Caller": JSON.stringify({
        author,
        deadline: options.deadline ?? now + 60_000,
        limits: options.limits ?? ROOMY,
        now,
      }),
    },
  });
  if (response.webSocket === null) return response.status;
  const socket = response.webSocket;
  socket.accept();
  const received: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as unknown;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else received.push(message);
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code)),
  );
  return {
    socket,
    id: response.headers.get("X-Portifact-Socket") ?? "",
    received,
    closed,
    next: () =>
      received.length > 0
        ? Promise.resolve(received.shift())
        : new Promise((resolve) => waiting.push(resolve)),
  };
}

function live(value: Live | number): Live {
  if (typeof value === "number") throw new Error(`refused with ${value}`);
  return value;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("live updates over hibernatable WebSockets", () => {
  it("in own mode delivers a change only to its author's connections", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const alice = live(await connect(docs, envelope, "v_alice"));
    const bob = live(await connect(docs, envelope, "v_bob"));
    const reader = live(await connect(docs, envelope, null));
    for (const connection of [alice, bob]) {
      connection.socket.send(JSON.stringify({ subscribe: "items" }));
      expect(await connection.next()).toEqual({ subscribed: "items" });
    }
    reader.socket.send(JSON.stringify({ subscribe: "items" }));
    expect(await reader.next()).toEqual({ error: "not_found" });
    const created = ok(
      await docs.create(op(envelope), context(visitor("v_alice")), "items", { secret: "a" }),
    );
    expect(await alice.next()).toMatchObject({ kind: "created", id: created._id });
    await settle();
    expect(bob.received).toEqual([]);
    expect(reader.received).toEqual([]);
  });

  it("refuses a connection whose deadline has passed and closes one when its deadline passes", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    expect(await connect(docs, envelope, "v_a", { deadline: NOW - 1, now: NOW })).toBe(403);
    // A deadline a moment away: the stored alarm closes the connection at its deadline, with no
    // JavaScript timer keeping the object awake meanwhile.
    const short = live(await connect(docs, envelope, "v_a", { deadline: Date.now() + 50 }));
    expect(await short.closed).toBe(4001);
    // Nothing is left to close: the alarm reschedules only for open connections.
    expect(await runDurableObjectAlarm(docs)).toBe(false);
  });

  it("extends a connection only through renewal, with the envelope checked", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const connection = live(await connect(docs, envelope, "v_a", { deadline: Date.now() + 100 }));
    expect(await docs.renew(envelope, connection.id, Date.now() + 60_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    connection.socket.send(JSON.stringify({ subscribe: "items" }));
    expect(await connection.next()).toEqual({ subscribed: "items" });
    expect(
      await docs.renew({ ...envelope, artifactId: "other" }, connection.id, Date.now() + 60_000),
    ).toBe(false);
    expect(await docs.renew(envelope, "unknown", Date.now() + 60_000)).toBe(false);
  });

  it("bounds messages in, connects per minute and connections", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const big = live(await connect(docs, envelope, "v_a"));
    big.socket.send(JSON.stringify({ subscribe: "x".repeat(2_000) }));
    expect(await big.closed).toBe(4008);
    const chatty = live(await connect(docs, envelope, "v_b"));
    for (let index = 0; index < 25; index++)
      chatty.socket.send(JSON.stringify({ subscribe: "items" }));
    expect(await chatty.closed).toBe(4008);
    const limits = { ...ROOMY, connectsPerAuthorPerMinute: 2, connectionsPerAuthor: 10 };
    const now = NOW + 3_600_000;
    live(await connect(docs, envelope, "v_c", { limits, now, deadline: Date.now() + 60_000 }));
    live(await connect(docs, envelope, "v_c", { limits, now, deadline: Date.now() + 60_000 }));
    expect(
      await connect(docs, envelope, "v_c", { limits, now, deadline: Date.now() + 60_000 }),
    ).toBe(429);
    const capped = { ...ROOMY, connectionsPerArtifact: 1 };
    expect(await connect(docs, envelope, "v_d", { limits: capped })).toBe(429);
  });

  it("closes a connection that receives more than its per-minute bytes, and counts what was sent", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const slow = live(await connect(docs, envelope, "v_a"));
    slow.socket.send(JSON.stringify({ subscribe: "items" }));
    await slow.next();
    let index = 0;
    while (index < 40) {
      await docs.create(op(envelope), owner, "items", { text: "z".repeat(15_000), index });
      index += 1;
    }
    expect(await slow.closed).toBe(4009);
    expect((await docs.budget(Date.now())).live_bytes).toBeGreaterThan(200_000);
  });

  it("closes every connection on a hold", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const connection = live(await connect(docs, envelope, "v_a"));
    ok(await docs.fence({ ...envelope, epoch: 1 }, "held"));
    expect(await connection.closed).toBe(4003);
  });
});
