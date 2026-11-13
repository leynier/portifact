// The documents object's live surface (decision 0026, delivery 7): the upgrade-only `fetch` that
// opens a connection from `LIVE_CONNECT_HEADER`, the hello message, a subscription receiving a
// change, `liveRenew` by the same principal only, and the open connections the owner reads.
import { ARTIFACT_DATA, LIVE_CONNECT_HEADER, PLANS } from "@portifact/contracts";
import type { DataObjectRpc } from "@portifact/services";
import { lifecycleId } from "@portifact/services";
import { describe, expect, it } from "vitest";
import { artifactId, DATA_NOW, inside, quiet, stubOf } from "./lifecycle.ts";

const rpc = (id: string) => stubOf(id) as unknown as DataObjectRpc;
const LIMITS = PLANS.free.data.perArtifact;
const VISITOR = "v_AAAAAAAAAAAAAAAAAAAA";

function envelope(id: string) {
  return { artifactId: id, region: "default", ownerId: "u_owner", generation: 0, epoch: 0 };
}

function connectRequest(id: string, body: unknown, upgrade = "websocket") {
  return new Request("https://documents.invalid/live", {
    headers: { upgrade, [LIVE_CONNECT_HEADER]: JSON.stringify(body) },
  });
}

const request = (id: string, principal = "dg_one", now = DATA_NOW) => ({
  envelope: envelope(id),
  author: VISITOR,
  principal,
  deadline: now + ARTIFACT_DATA.live.deadlineMs,
  limits: LIMITS,
  now,
});

async function withData(id: string) {
  await quiet(id);
  const object = rpc(id);
  const declared = (await object.ownerCommand(
    { ...envelope(id), opId: lifecycleId(DATA_NOW) },
    "u_owner",
    { kind: "declare", declaration: { name: "votes", mode: "shared" } },
    LIMITS,
    DATA_NOW,
  )) as { ok: boolean };
  expect(declared.ok).toBe(true);
  return object;
}

/** The messages a client end receives, collected as they arrive. */
function listen(socket: WebSocket) {
  const received: string[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => received.push(String(event.data)));
  return {
    received,
    next: async (count: number) => {
      for (let tries = 0; tries < 50 && received.length < count; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return received;
    },
  };
}

describe("the live upgrade", () => {
  it("opens a connection, says hello and sends a subscribed change", async () => {
    const id = artifactId();
    const object = await withData(id);
    // The object reads the clock for messages from the socket, so this connection uses it too.
    const now = Date.now();
    const response = await object.fetch(connectRequest(id, request(id, "dg_one", now)));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("no client end");
    const client = listen(socket);
    const [hello] = await client.next(1);
    const greeted = JSON.parse(hello ?? "null") as { connected: string; deadline: number };
    expect(greeted.deadline).toBe(now + ARTIFACT_DATA.live.deadlineMs);

    socket.send(JSON.stringify({ subscribe: "votes" }));
    await client.next(2);
    expect(JSON.parse(client.received[1] ?? "null")).toEqual({ subscribed: "votes" });
    const created = (await object.ownerCommand(
      { ...envelope(id), opId: lifecycleId(now) },
      "u_owner",
      { kind: "create", collection: "votes", body: { choice: "a" } },
      LIMITS,
      now,
    )) as { ok: boolean };
    expect(created.ok).toBe(true);
    await client.next(3);
    expect(JSON.parse(client.received[2] ?? "null")).toMatchObject({
      collection: "votes",
      kind: "created",
      by: "owner",
    });

    const described = (await object.ownerCommand(
      envelope(id),
      "u_owner",
      { kind: "describe" },
      LIMITS,
      now,
    )) as { value: { connections: number; today: { live: number } } };
    expect(described.value.connections).toBe(1);
    expect(described.value.today.live).toBe(ARTIFACT_DATA.live.reserveChunk);
    expect(await inside(id, (o) => o.clients.size)).toBe(0);
    socket.close(1000);
  });

  it("renews for the same principal only", async () => {
    const id = artifactId();
    const object = await withData(id);
    const response = await object.fetch(connectRequest(id, request(id)));
    const socket = response.webSocket;
    if (socket === null) throw new Error("no client end");
    const client = listen(socket);
    const [hello] = await client.next(1);
    const socketId = (JSON.parse(hello ?? "null") as { connected: string }).connected;
    const later = DATA_NOW + 30_000;
    const deadline = later + ARTIFACT_DATA.live.deadlineMs;
    expect(
      await object.liveRenew(envelope(id), socketId, "dg_other", deadline, LIMITS, later),
    ).toBe(false);
    expect(await object.liveRenew(envelope(id), socketId, "dg_one", deadline, LIMITS, later)).toBe(
      true,
    );
    expect(
      await object.liveRenew(envelope(id), "not a socket", "dg_one", deadline, LIMITS, later),
    ).toBe(false);
    expect(
      await object.liveRenew(envelope(id), "AAAAAAAAAAAAAAAA", "dg_one", deadline, LIMITS, later),
    ).toBe(false);
    socket.close(1000);
  });

  it("refuses what is not an upgrade, an invalid request and an object without data", async () => {
    const id = artifactId();
    await quiet(id);
    const object = rpc(id);
    expect((await object.fetch(connectRequest(id, request(id), "h2c"))).status).toBe(426);
    const invalid = await object.fetch(connectRequest(id, { ...request(id), principal: "a b" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_input" });
    const missing = await object.fetch(
      new Request("https://documents.invalid/live", { headers: { upgrade: "websocket" } }),
    );
    expect(missing.status).toBe(400);
    const empty = await object.fetch(connectRequest(id, request(id)));
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({ ok: false, code: "not_found" });
    // Nothing was bound: the refusal created no object state.
    expect(await inside(id, (o) => o.store.inspect("pf_meta"))).toEqual([]);
  });
});
