import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyFence, newControl } from "../src/envelope.ts";
import { beginGate } from "../src/gate.ts";
import { newerReport } from "../src/model.ts";
import { artifact, context, NOW, OWNER, ok, op, READER, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("documents: replays, scopes and housekeeping", () => {
  it("replays declarations, replacements and deletions, and works without operation IDs", async () => {
    const { envelope, docs } = artifact();
    const declare = op(envelope);
    ok(
      await docs.declareCollection(declare, owner, {
        name: "items",
        mode: "shared",
        indexed: ["tag"],
      }),
    );
    expect(
      await docs.declareCollection(declare, owner, {
        name: "items",
        mode: "shared",
        indexed: ["tag"],
      }),
    ).toMatchObject({
      replayed: { kind: "collection" },
    });
    const created = ok(await docs.create(envelope, context(visitor("v_a")), "items", { tag: "x" }));
    const replace = op(envelope);
    ok(
      await docs.replace(replace, context(visitor("v_b")), "items", created._id, {
        tag: "a longer value",
      }),
    );
    expect(
      await docs.replace(replace, context(visitor("v_b")), "items", created._id, {
        tag: "a longer value",
      }),
    ).toMatchObject({
      replayed: { kind: "document" },
    });
    const remove = op(envelope);
    ok(await docs.remove(remove, context(visitor("v_b")), "items", created._id));
    expect(await docs.remove(remove, context(visitor("v_b")), "items", created._id)).toMatchObject({
      replayed: { kind: "deleted" },
    });
    expect(await docs.remove(op(envelope), context(READER), "items", created._id)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    // A newer epoch on an ordinary request is adopted.
    // A newer epoch is admitted but never adopted (fourth review, finding 2): a fence at that
    // epoch can still apply, and the older envelope stays valid until it does.
    ok(await docs.create(op({ ...envelope, epoch: 3 }), owner, "items", { tag: "y" }));
    ok(await docs.create(op(envelope), owner, "items", { tag: "z" }));
    // An erase drops the declared field indexes with the payload.
    const later = { ...envelope, epoch: 3 };
    ok(await docs.prepareErase(later, "erase_1"));
    expect(ok(await docs.commitErase(later, "erase_1"))).toEqual({ erased: true });
  });

  it("refuses cleanup past its own daily allowance", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const tight = context(OWNER, { limits: { ...ROOMY, cleanupRowsPerDay: 1 } });
    // The first attempt runs and its failure is charged; the spent allowance refuses the next.
    expect(await docs.remove(op(envelope), tight, "items", "x")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await docs.remove(op(envelope), tight, "items", "x")).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("answers housekeeping on objects without data and on the wrong artifact", async () => {
    const { envelope, docs } = artifact();
    expect(await docs.pruneReplays(NOW)).toBe(0);
    expect(await docs.quarantine(envelope, "owner")).toBe(false);
    expect(await docs.auditFor("x")).toBeNull();
    expect(await docs.settle(envelope, "owner:owner", "op_empty")).toEqual({ state: "aborted" });
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    expect(await docs.quarantine({ ...envelope, artifactId: "other" }, "owner")).toBe(false);
    expect(await docs.cancelErase(envelope, "erase_1")).toBe(false);
  });

  it("caps connections per author and closes a connection whose renewal shortened its deadline", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const limits = { ...ROOMY, connectionsPerAuthor: 1 };
    const open = (deadline: number) =>
      docs.fetch("https://data.internal/live", {
        headers: {
          Upgrade: "websocket",
          "X-Portifact-Envelope": JSON.stringify(envelope),
          "X-Portifact-Caller": JSON.stringify({
            author: "v_a",
            principal: "grant:v_a",
            deadline,
            limits,
            now: Date.now(),
          }),
        },
      });
    const first = await open(Date.now() + 60_000);
    expect((await open(Date.now() + 60_000)).status).toBe(429);
    const socket = first.webSocket as WebSocket;
    socket.accept();
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.send("not json");
    const socketId = first.headers.get("X-Portifact-Socket") ?? "";
    // The shortening is proven by the stored value, with a deadline far enough away that no
    // runner's speed matters; the close by a renewal whose deadline has already passed.
    const shorter = Date.now() + 30_000;
    expect(await docs.renew(envelope, socketId, "grant:v_a", shorter)).toBe(true);
    const deadlines = await runInDurableObject(docs, (_instance, state) =>
      state
        .getWebSockets()
        .map((ws) => (ws.deserializeAttachment() as { deadline: number }).deadline),
    );
    expect(deadlines).toEqual([shorter]);
    expect(await docs.renew(envelope, socketId, "grant:v_a", Date.now() - 1)).toBe(false);
    expect(await closed).toBe(4001);
  });
});

describe("pure rules", () => {
  it("compares storage reports by generation then sequence", () => {
    const a = { generation: 0, seq: 3, bytes: 10 };
    expect(newerReport(null, a)).toBe(true);
    expect(newerReport(a, { generation: 0, seq: 2, bytes: 99 })).toBe(false);
    expect(newerReport(a, { generation: 0, seq: 4, bytes: 1 })).toBe(true);
    expect(newerReport(a, { generation: 1, seq: 0, bytes: 0 })).toBe(true);
    expect(newerReport({ ...a, generation: 2 }, { generation: 1, seq: 99, bytes: 0 })).toBe(false);
  });

  it("acknowledges a repeated fence by its transition and keeps a quarantine through fences", () => {
    const envelope = { artifactId: "a", region: "eu", ownerId: "o", generation: 0, epoch: 2 };
    const held = applyFence(
      newControl({ ...envelope, epoch: 1 }, NOW),
      envelope,
      { state: "held", transition: "t_1" },
      NOW,
    );
    if (!held.ok) throw new Error("fence refused");
    expect(applyFence(held.control, envelope, { state: "held", transition: "t_1" }, NOW)).toEqual({
      ok: true,
      control: held.control,
      repeated: true,
    });
    // Another transition at the same epoch is stale, whatever it asks.
    expect(
      applyFence(held.control, envelope, { state: "open", transition: "t_2" }, NOW),
    ).toMatchObject({
      ok: false,
      error: "stale",
    });
    const quarantined = { ...held.control, quarantine: { reason: "owner" as const, at: NOW } };
    expect(
      applyFence(quarantined, { ...envelope, epoch: 3 }, { state: "open", transition: "t_3" }, NOW),
    ).toMatchObject({ ok: true, control: { quarantine: { reason: "owner" }, hold: null } });
  });

  it("starts a grant only from the page's own navigation or the viewer's frame", () => {
    const begin = (method: string, headers: Record<string, string>) =>
      new Request("https://abc.portifact.dev/__portifact/data/grant/begin", { method, headers });
    expect(beginGate(begin("POST", {}))).toBe("refused");
    expect(beginGate(begin("GET", { "Sec-Fetch-Mode": "cors" }))).toBe("refused");
    expect(
      beginGate(
        begin("GET", {
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Dest": "iframe",
        }),
      ),
    ).toBe("allowed");
    expect(
      beginGate(
        begin("GET", {
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-site",
          "Sec-Fetch-Dest": "document",
        }),
      ),
    ).toBe("refused");
  });
});
