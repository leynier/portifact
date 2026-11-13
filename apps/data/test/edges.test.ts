// The documents object's edges on real storage: refusals at each step of the commands, the
// Durable Object's own handlers (WebSocket messages and closes, the platform alarm, the Worker's
// fetch), schema versions on a wake, bounds logged in production, and live refusals.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { MAX_INDEXED_FIELDS } from "@portifact/contracts/artifact-data";
import {
  context,
  envelope,
  NOW,
  OWNER,
  op,
  ROOMY,
  value,
  visitor,
  visitorId,
} from "@portifact/domain/testing/artifact-data";
import { describe, expect, it, vi } from "vitest";
import { storeFor } from "../src/documents.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import { DocumentsStore, Instrument, randomId } from "../src/store.ts";
import { RealObject } from "./driver.ts";

const ctx = context();

async function withCollection(mode: "own" | "append" | "shared" = "append") {
  const object = new RealObject();
  const base = envelope();
  value(await object.declare(op(base), OWNER, { name: "items", mode }, ctx));
  return { object, base };
}

describe("refusals at each step", () => {
  it("answers missing collections, documents and owner-only paths like the reference", async () => {
    const { object, base } = await withCollection("own");
    expect(await object.get(base, OWNER, "nothing", "xxxxxxxxxxxxxxxx", ctx)).toMatchObject({
      code: "not_found",
    });
    expect(await object.get(base, OWNER, "items", "xxxxxxxxxxxxxxxx", ctx)).toMatchObject({
      code: "not_found",
    });
    expect(await object.query(base, OWNER, { collection: "nothing" }, ctx)).toMatchObject({
      code: "not_found",
    });
    expect(
      await object.query(
        base,
        visitor("a"),
        { collection: "items", equals: { field: "_by", value: visitorId("b") } },
        ctx,
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await object.query(base, { kind: "reader" }, { collection: "items" }, ctx),
    ).toMatchObject({
      ok: true,
      value: { documents: [] },
    });
    expect(await object.count(base, visitor("a"), { collection: "items" }, ctx)).toMatchObject({
      code: "forbidden",
    });
    expect(await object.count(base, OWNER, { collection: "nothing" }, ctx)).toMatchObject({
      code: "not_found",
    });
    expect(
      await object.count(
        base,
        OWNER,
        { collection: "items", equals: { field: "n", value: 1 } },
        ctx,
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(await object.exportPage(base, visitor("a"), null, 10, ctx)).toMatchObject({
      code: "forbidden",
    });
    expect(await object.exportMine(base, OWNER, null, ctx)).toMatchObject({ code: "forbidden" });
    expect(await object.describe(base, visitor("a"), ctx)).toMatchObject({ code: "forbidden" });
  });

  it("answers an empty description and an empty page for an object no write bound", async () => {
    const object = new RealObject();
    expect(await object.describe(envelope(), OWNER, ctx)).toMatchObject({
      ok: true,
      value: { generation: 0, revision: 0, collections: [] },
    });
    expect((await object.view()).durable.documents.size).toBe(0);
  });

  it("refuses invalid bodies, a full collection and a duplicate in bulk, writing nothing", async () => {
    const { object, base } = await withCollection();
    const doc = value<{ _id: string }>(
      await object.create(op(base), OWNER, "items", { n: 1 }, ctx),
    );
    expect(await object.replace(op(base), OWNER, "items", doc._id, undefined, ctx)).toMatchObject({
      code: "invalid_input",
    });
    expect(await object.replace(op(base), OWNER, "items", doc._id, [1], ctx)).toMatchObject({
      code: "invalid_input",
    });
    const small = context({ limits: { ...ROOMY, documentsPerCollection: 2 } });
    expect(
      await object.bulkCreate(op(base), OWNER, { collection: "items", documents: [{}, {}] }, small),
    ).toMatchObject({ code: "quota_exceeded" });
    expect(
      await object.bulkReplace(
        op(base),
        OWNER,
        { collection: "items", documents: [{ id: doc._id, body: { _bad: 1 } }] },
        ctx,
      ),
    ).toMatchObject({ code: "invalid_input" });
    const view = await object.view();
    expect(view.durable.documents.size).toBe(1);
  });

  it("writes no operation record for a mutation without an operation ID", async () => {
    const { object, base } = await withCollection();
    const before = (await object.view()).durable;
    value(await object.create(base, OWNER, "items", { n: 1 }, ctx));
    const after = (await object.view()).durable;
    expect(after.ops.size).toBe(before.ops.size);
    expect(after.audit.size).toBe(before.audit.size);
    expect(after.documents.size).toBe(1);
  });

  it("logs a bound passed in production instead of failing the command", async () => {
    const { object, base } = await withCollection();
    const doc = value<{ _id: string }>(await object.create(op(base), OWNER, "items", {}, ctx));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await object.run((_store, instance, state) => {
        const lenient = storeFor(state, instance.clients, { ids: randomId });
        lenient.rowBounds.get = 1;
        expect(lenient.get(base, OWNER, "items", doc._id, ctx).ok).toBe(true);
      });
      expect(logged.mock.calls.flat().join()).toContain("artifact_data_bound_passed");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("schema versions on a wake", () => {
  it("migrates an older stored version and refuses a newer one", async () => {
    const { object } = await withCollection();
    await object.run((_store, instance, state) => {
      state.storage.sql.exec("UPDATE pf_meta SET value = '0' WHERE key = 'schema'");
      const woken = storeFor(state, instance.clients);
      expect(woken.inspect("pf_meta").find((row) => row.key === "schema")?.value).toBe(
        String(SCHEMA_VERSION),
      );
      state.storage.sql.exec("UPDATE pf_meta SET value = '99' WHERE key = 'schema'");
      expect(() => storeFor(state, instance.clients)).toThrow(/newer than this code/);
      state.storage.sql.exec(
        "UPDATE pf_meta SET value = ? WHERE key = 'schema'",
        String(SCHEMA_VERSION),
      );
    });
  });

  it("inspects only its own tables", async () => {
    const object = new RealObject();
    await object.run((store) => {
      expect(() => store.inspect("sqlite_schema")).toThrow(/not a documents table/);
      expect(store.inspect("pf_documents")).toEqual([]);
    });
  });
});

describe("live connections", () => {
  it("refuses renewals and messages it cannot admit, and closes on too many messages", async () => {
    const { object, base } = await withCollection();
    const socket = value(await object.connect(base, visitorId("a"), "grant:a", NOW + 60_000, ctx));
    value(await object.connect(base, visitorId("a"), "grant:a", NOW + 60_000, ctx));
    expect(await object.renew(base, "nobody", "grant:a", NOW + 1_000, ctx)).toBe(false);
    expect(
      await object.renew({ ...base, ownerId: "someone" }, socket, "grant:a", NOW + 1_000, ctx),
    ).toBe(false);
    expect(await object.renew(base, socket, "grant:b", NOW + 1_000, ctx)).toBe(false);
    await object.message("nobody", "{}", NOW);
    await object.message(socket, "not json", NOW);
    expect((await object.view()).sockets.get(socket)?.received).toEqual(['{"error":"not_found"}']);
    for (let index = 0; index < 4; index++) await object.message(socket, "{}", NOW);
    expect((await object.view()).sockets.get(socket)?.closed).toBe(4008);
    expect(await object.renew(base, socket, "grant:a", NOW + 1_000, ctx)).toBe(false);
    const late = value(await object.connect(base, null, "reader", NOW + 60_000, ctx));
    expect(await object.renew(base, late, "reader", NOW, ctx)).toBe(false);
    expect((await object.view()).sockets.get(late)?.closed).toBe(4001);
  });

  it("refuses an attachment past its size, rolling the connection back", async () => {
    const { object, base } = await withCollection();
    await expect(object.connect(base, null, "p".repeat(20_000), NOW + 60_000, ctx)).rejects.toThrow(
      /attachment passed its size/,
    );
    const view = await object.view();
    expect(view.sockets.size).toBe(0);
    expect([...view.durable.rates.keys()].some((key) => key.startsWith("readers"))).toBe(false);
  });

  it("hands the client's messages and close to the store through the object's handlers", async () => {
    const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName("handlers"));
    const now = Date.now();
    const received: string[] = [];
    const socketId = await runInDurableObject(stub, (instance) => {
      const base = envelope();
      const at = context({ now });
      value(instance.store.declare(op(base, now), OWNER, { name: "items", mode: "append" }, at));
      const id = value(instance.store.connect(base, null, "reader", now + 60_000, at));
      const client = instance.clients.get(id) as WebSocket;
      client.accept();
      client.addEventListener("message", (event) => {
        received.push(String(event.data));
      });
      client.send(JSON.stringify({ subscribe: "items" }));
      return id;
    });
    await vi.waitFor(() => expect(received).toEqual(['{"subscribed":"items"}']));
    await runInDurableObject(stub, (instance) => {
      (instance.clients.get(socketId) as WebSocket).close(1000, "done");
    });
    await vi.waitFor(async () => {
      const closed = await runInDurableObject(
        stub,
        (instance) => instance.store.sockets.get(socketId)?.closed,
      );
      expect(closed).not.toBeNull();
    });
  });
});

describe("the Durable Object and its Worker", () => {
  it("answers 404 to every request: the data Worker has no routes", async () => {
    const response = await SELF.fetch("https://data.internal/anything");
    expect(response.status).toBe(404);
  });

  it("deletes the platform alarm when nothing is due, and draws random document IDs", async () => {
    const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName("delete-alarm"));
    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      const base = envelope();
      value(
        instance.store.declare(
          op(base, now),
          OWNER,
          { name: "items", mode: "append" },
          context({ now }),
        ),
      );
      const doc = value<{ _id: string }>(
        instance.store.create(base, OWNER, "items", {}, context({ now })),
      );
      expect(doc._id).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(await state.storage.getAlarm()).not.toBeNull();
      // A held object with no connection wants no alarm: the scheduler deletes it.
      value(instance.store.fence({ ...base, epoch: 1 }, { kind: "hold", transition: "h" }, now));
      expect(instance.store.alarmAt).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("rebuilds the store with every option it is given, and its defaults", async () => {
    const object = new RealObject();
    await object.run((_store, _instance, state) => {
      const store = new DocumentsStore({
        storage: state.storage,
        scheduler: { set: () => undefined },
        accept: () => {
          throw new Error("no sockets here");
        },
      });
      expect(store.meters).toBeInstanceOf(Instrument);
      expect(store.meters.record).toBe(false);
      expect(store.meters.coldStarts).toEqual([0]);
      expect(MAX_INDEXED_FIELDS).toBe(8);
    });
  });
});
