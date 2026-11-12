import { describe, expect, it } from "vitest";
import type { ArtifactData } from "../src/artifact-data.ts";
import type { DataLimits } from "../src/model.ts";
import { artifact, FREE, NOW, OWNER, ok, visitor } from "./harness.ts";

interface Live {
  socket: WebSocket;
  received: unknown[];
  next(): Promise<unknown>;
}

/** Opens the live channel as the Worker would after authorizing `author` (null: a reader). */
async function connect(
  stub: DurableObjectStub<ArtifactData>,
  author: string | null,
  limits: DataLimits = FREE,
): Promise<Live | number> {
  const response = await stub.fetch("https://data.internal/live", {
    headers: { Upgrade: "websocket", "X-Portifact-Caller": JSON.stringify({ author, limits }) },
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
  return {
    socket,
    received,
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

/** Lets in-flight messages arrive before asserting that none did. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("live updates over a hibernatable WebSocket", () => {
  it("in own mode delivers a change only to its author's connections", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    const alice = live(await connect(stub, "v_alice"));
    const bob = live(await connect(stub, "v_bob"));
    const reader = live(await connect(stub, null));
    for (const connection of [alice, bob]) {
      connection.socket.send(JSON.stringify({ subscribe: "items" }));
      expect(await connection.next()).toEqual({ subscribed: "items" });
    }
    // A reader cannot subscribe to an own-mode collection at all.
    reader.socket.send(JSON.stringify({ subscribe: "items" }));
    expect(await reader.next()).toEqual({ error: "not_found" });

    const created = ok(
      await stub.create(ref, visitor("v_alice"), "items", { secret: "a" }, FREE, NOW),
    );
    expect(await alice.next()).toMatchObject({
      kind: "created",
      id: created._id,
      document: { secret: "a" },
    });
    ok(await stub.remove(ref, visitor("v_alice"), "items", created._id, FREE, NOW));
    expect(await alice.next()).toMatchObject({ kind: "deleted", id: created._id });
    await settle();
    expect(bob.received).toEqual([]);
    expect(reader.received).toEqual([]);
  });

  it("in append mode delivers to every subscribed connection, readers included, and not to others", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "votes", mode: "append" }, FREE));
    ok(await stub.declareCollection(ref, { name: "other", mode: "append" }, FREE));
    const alice = live(await connect(stub, "v_alice"));
    const reader = live(await connect(stub, null));
    const elsewhere = live(await connect(stub, "v_carol"));
    alice.socket.send(JSON.stringify({ subscribe: "votes" }));
    reader.socket.send(JSON.stringify({ subscribe: "votes" }));
    elsewhere.socket.send(JSON.stringify({ subscribe: "other" }));
    for (const connection of [alice, reader, elsewhere]) await connection.next();
    ok(await stub.create(ref, visitor("v_bob"), "votes", { choice: "a" }, FREE, NOW));
    expect(await alice.next()).toMatchObject({ kind: "created", document: { _by: "v_bob" } });
    expect(await reader.next()).toMatchObject({ kind: "created" });
    await settle();
    expect(elsewhere.received).toEqual([]);
  });

  it("caps connections per artifact and per author", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    const limits = { ...FREE, connectionsPerArtifact: 3, connectionsPerAuthor: 2 };
    live(await connect(stub, "v_a", limits));
    live(await connect(stub, "v_a", limits));
    expect(await connect(stub, "v_a", limits)).toBe(429);
    live(await connect(stub, "v_b", limits));
    expect(await connect(stub, "v_c", limits)).toBe(429);
  });

  it("refuses anything but a WebSocket upgrade on the live path, and malformed messages", async () => {
    const { ref, stub } = artifact();
    expect((await stub.fetch("https://data.internal/live")).status).toBe(404);
    const connection = live(await connect(stub, "v_a"));
    connection.socket.send("not json");
    expect(await connection.next()).toEqual({ error: "not_found" });
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    connection.socket.send(JSON.stringify({ subscribe: "Bad Name" }));
    expect(await connection.next()).toEqual({ error: "invalid_input" });
  });

  it("closes every connection on request, so each reconnects through authorization", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "append" }, FREE));
    const connection = live(await connect(stub, "v_a"));
    const closed = new Promise<number>((resolve) =>
      connection.socket.addEventListener("close", (event) => resolve(event.code)),
    );
    expect(await stub.closeConnections(4001)).toBe(1);
    expect(await closed).toBe(4001);
    ok(await stub.create(ref, OWNER, "items", { n: 1 }, FREE, NOW));
  });
});
