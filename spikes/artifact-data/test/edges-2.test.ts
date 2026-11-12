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
    ok(await docs.create(op({ ...envelope, epoch: 3 }), owner, "items", { tag: "y" }));
    expect(await docs.create(op(envelope), owner, "items", { tag: "z" })).toMatchObject({
      ok: false,
      error: "stale",
    });
    // An erase drops the declared field indexes with the payload.
    const later = { ...envelope, epoch: 3 };
    ok(await docs.prepareErase(later));
    expect(ok(await docs.commitErase(later))).toEqual({ erased: true });
  });

  it("refuses cleanup past its own daily allowance", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const tight = context(OWNER, { limits: { ...ROOMY, cleanupRowsPerDay: 1 } });
    expect(await docs.remove(op(envelope), tight, "items", "x")).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("answers housekeeping on objects without data and on the wrong artifact", async () => {
    const { envelope, docs } = artifact();
    expect(await docs.pruneReplays(NOW)).toBe(0);
    expect(await docs.quarantine(envelope)).toBe(false);
    expect(await docs.auditFor("x")).toBeNull();
    expect(await docs.settle(envelope, "owner:owner", "op_empty")).toEqual({ state: "aborted" });
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    expect(await docs.quarantine({ ...envelope, artifactId: "other" })).toBe(false);
    expect(await docs.cancelErase(envelope)).toBe(false);
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
    expect(
      await docs.renew(
        envelope,
        first.headers.get("X-Portifact-Socket") ?? "",
        "grant:v_a",
        Date.now() + 20,
      ),
    ).toBe(true);
    // The shortened deadline closes it (the alarm, or the next message, whichever comes first).
    expect(await closed).toBe(4001);
  });
});

describe("sandbox: replays, housekeeping and refusals", () => {
  it("prunes replay records, counts copies of dropped tables as empty, pages exports", async () => {
    const { envelope, sandbox } = artifact();
    ok(await sandbox.execute(op(envelope), owner, "create table t (x)"));
    await sandbox.unsafeExec("insert into t values (1), (2), (3)");
    expect(await sandbox.pruneReplays(Date.now() + 2 * 86_400_000)).toBeGreaterThan(0);
    ok(
      await sandbox.importCopy(
        op(envelope),
        owner,
        {
          copyId: "c",
          page: 0,
          table: "copy_x",
          collection: "x",
          sourceGeneration: 0,
          sourceRevision: 0,
        },
        [],
      ),
    );
    ok(await sandbox.execute(op(envelope), owner, "drop table copy_x"));
    expect(await sandbox.copies()).toMatchObject([{ copyId: "c", documents: 0 }]);
    const first = await sandbox.exportTable(envelope, owner, "t", 0, 2);
    if (!first.ok || !("value" in first)) throw new Error("export failed");
    expect(first.value.rows).toHaveLength(2);
    expect(first.value.next).toBe(2);
    expect(await sandbox.exportTable(envelope, context(visitor("v")), "t", 0, 2)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(
      await sandbox.exportTable(
        envelope,
        context(OWNER, { limits: { ...ROOMY, exportRowsPerDay: 0 } }),
        "t",
        0,
        2,
      ),
    ).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("limits statements per minute and maps SQLite's runtime errors to invalid input", async () => {
    const { envelope, sandbox } = artifact();
    ok(await sandbox.execute(op(envelope), owner, "create table u (x unique)"));
    ok(await sandbox.execute(op(envelope), owner, "insert into u values (1)"));
    expect(await sandbox.execute(op(envelope), owner, "insert into u values (1)")).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    const now = NOW + 11 * 60_000;
    let limited = 0;
    for (let index = 0; index < 32; index++) {
      const outcome = await sandbox.query(envelope, context(OWNER, { now }), "select 1");
      if (!outcome.ok && outcome.error === "rate_limited") limited += 1;
    }
    expect(limited).toBe(2);
    expect(await sandbox.readOnlyProbe("select 1")).toEqual({ refused: false, message: "" });
    expect(await sandbox.quarantine({ ...envelope, artifactId: "other" })).toBe(false);
    expect(
      await sandbox.fence({ ...envelope, artifactId: "other", epoch: 9 }, { state: "open" }),
    ).toBe(false);
    expect(await sandbox.cancelErase(envelope)).toBe(false);
    expect(await sandbox.settle(envelope, "owner:owner", "op_unknown")).toEqual({
      state: "aborted",
    });
    expect(await sandbox.settle(envelope, "owner:owner", "op_unknown")).toEqual({
      state: "aborted",
    });
    expect(await sandbox.query(envelope, context(visitor("v")), "select 1")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
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

  it("acknowledges a repeated fence and keeps a quarantine through fences", () => {
    const envelope = { artifactId: "a", region: "eu", ownerId: "o", generation: 0, epoch: 2 };
    const stored = { ...newControl(envelope, "held", NOW) };
    expect(applyFence(stored, envelope, { state: "held" }, NOW)).toEqual({
      ok: true,
      control: stored,
    });
    expect(applyFence(stored, envelope, { state: "open" }, NOW)).toMatchObject({
      ok: false,
      error: "stale",
    });
    expect(
      applyFence(
        { ...stored, state: "quarantined" },
        { ...envelope, epoch: 3 },
        { state: "open" },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      control: { state: "quarantined" },
    });
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
