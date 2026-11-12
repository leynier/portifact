// The second review's reproductions (pull request #249 at ee9ebb6e). Each states the behavior the
// design must have; against that commit they fail, which is the reproduction. The reproductions
// that were only about owner SQL (a SQL write's operation ID, the sandbox's erase, a failed
// statement's charge, inexact SQL values, copies, SQL spending the visitors' share) went with
// owner SQL; they live in commit c5b84930.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ERASURE_ACTOR, operationKey } from "../src/documents.ts";
import * as gates from "../src/gate.ts";
import { beginTransaction, issueCode, redeem } from "../src/grants.ts";
import { artifact, context, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);
const any = (value: unknown) => value as never;

describe("second review findings, reproduced", () => {
  it("1: an operation ID is the actor's own: another writer's reuse never returns the first body", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const shared = { ...envelope, opId: `${NOW}.reused` };
    ok(await docs.create(shared, context(visitor("v_alice")), "items", { secret: "alice" }));
    const bob = await docs.create(shared, context(visitor("v_bob")), "items", { secret: "bob" });
    expect(JSON.stringify(bob)).not.toContain("alice");
  });

  it("1: a retry after a lost acknowledgement needs no second allowance", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const limits = { ...ROOMY, writesPerAuthorPerMinute: 1 };
    const once = op(envelope);
    ok(await docs.create(once, context(visitor("v_a"), { limits }), "items", { n: 1 }));
    expect(
      (await docs.create(once, context(visitor("v_a"), { limits }), "items", { n: 1 })).ok,
    ).toBe(true);
  });

  it("2: a fence on an empty object is persisted before it is acknowledged", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.fence({ ...envelope, epoch: 1 }, { state: "held", transition: "t_hold" }));
    expect(
      (await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" })).ok,
    ).toBe(false);
  });

  it("2: commit and cancel use the whole envelope", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.prepareErase(envelope, "erase_1"));
    expect(await docs.cancelErase({ ...envelope, artifactId: "other" }, "erase_1")).toBe(false);
    expect(await docs.commitErase({ ...envelope, region: "eu" }, "erase_1")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(await docs.cancelErase({ ...envelope, epoch: -1 }, "erase_1")).toBe(false);
  });

  it("3: prepare adopts the epoch it accepts, so commit can finish", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const later = { ...envelope, epoch: 1 };
    ok(await docs.prepareErase(later, "erase_1"));
    expect(ok(await docs.commitErase(later, "erase_1"))).toEqual({ erased: true });
  });

  it("3: erasing keeps the control records (budgets, obligations)", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    ok(await docs.create(op(envelope), owner, "items", { n: 1 }));
    ok(await docs.prepareErase(envelope, "erase_1"));
    ok(await docs.commitErase(envelope, "erase_1"));
    expect((await docs.budget(NOW)).rows_written ?? 0).toBeGreaterThan(0);
  });

  it("4: a request naming the former owner after a transfer is refused at any epoch", async () => {
    const { envelope, docs } = artifact();
    const withOwner = { ...envelope, ownerId: "owner_a" };
    ok(await docs.declareCollection(op(any(withOwner)), owner, { name: "items", mode: "read" }));
    ok(
      await docs.fence(
        any({ ...withOwner, epoch: 5 }),
        any({ state: "open", toOwner: "owner_b", transition: "t_move" }),
      ),
    );
    expect(
      (await docs.query(any({ ...withOwner, epoch: 5 }), owner, { collection: "items" })).ok,
    ).toBe(false);
  });

  it("5: replaying a create after its author was erased returns no body", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const once = op(envelope);
    ok(await docs.create(once, context(visitor("v_alice")), "items", { secret: "alice" }));
    ok(await docs.eraseAuthorChunk(envelope, "v_alice", 100));
    const replay = await docs.create(once, context(visitor("v_alice")), "items", {
      secret: "alice",
    });
    expect(JSON.stringify(replay)).not.toContain('alice"');
  });

  it("5: replay records are pruned after a day", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    expect(await docs.pruneReplays(Date.now() + 25 * 3_600_000)).toBeGreaterThan(0);
  });

  it("6: after an author's erasure began, a late write from that author is refused", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    ok(await docs.eraseAuthorChunk(envelope, "v_gone", 100));
    expect(
      (await docs.create(op(envelope), context(visitor("v_gone")), "items", { n: 1 })).ok,
    ).toBe(false);
  });

  it("8: renewal is bound to the principal that opened the connection, and can shorten", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_alice",
          principal: "grant:alice",
          deadline: Date.now() + 60_000,
          limits: ROOMY,
          now: Date.now(),
        }),
      },
    });
    response.webSocket?.accept();
    const socketId = response.headers.get("X-Portifact-Socket") ?? "";
    expect(await docs.renew(envelope, socketId, "grant:bob", Date.now() + 60_000)).toBe(false);
  });

  it("10: cleanup works when the day is spent, and a visitor deletes their own without write permission", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const mine = ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    const kept = ok(await docs.create(op(envelope), owner, "items", { n: 2 }));
    const spent = context(OWNER, { limits: { ...ROOMY, rowsWrittenPerDay: 0, rowsReadPerDay: 0 } });
    expect((await docs.remove(op(envelope), spent, "items", kept._id)).ok).toBe(true);
    expect(
      (await docs.remove(op(envelope), context(visitor("v_a", false)), "items", mine._id)).ok,
    ).toBe(true);
  });

  it("13: refused work that grows storage moves the storage report", async () => {
    const { envelope, docs } = artifact();
    // Refused work that did work (here a unique conflict after the insert ran) moves the report;
    // a refusal before any work writes nothing and leaves it (decision 45).
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "read",
        uniqueKey: "k",
      }),
    );
    ok(await docs.create(op(envelope), owner, "items", { k: 1 }));
    const before = (await docs.size()).seq;
    const refused = await docs.create(op(envelope), owner, "items", { k: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.storage.seq).toBeGreaterThan(before);
  });

  it("14: author erasure leaves an audit obligation, and erasure keeps it", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const erase = op(envelope);
    ok(await docs.eraseAuthorChunk(erase, "v_a", 10));
    const key = operationKey(ERASURE_ACTOR, 0, erase.opId as string);
    expect(await docs.auditFor(key)).not.toBeNull();
    ok(await docs.prepareErase(envelope, "erase_1"));
    ok(await docs.commitErase(envelope, "erase_1"));
    expect(await docs.auditFor(key)).not.toBeNull();
  });

  it("15: starting the grant from the page has its own gate, and a code redeems once under concurrency", async () => {
    const begin = new Request("https://abc.portifact.dev/__portifact/data/grant/begin", {
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });
    expect((gates as unknown as { beginGate?: (r: Request) => string }).beginGate?.(begin)).toBe(
      "allowed",
    );
    const browser = await beginTransaction();
    const { code, pending } = await issueCode(browser.nonceHash, "abc.portifact.dev", "g", NOW);
    const both = await Promise.all([
      redeem(pending, code, browser.nonce, "abc.portifact.dev", NOW),
      redeem(pending, code, browser.nonce, "abc.portifact.dev", NOW),
    ]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
  });

  it("16: live bytes are reserved in UTF-8 against the day before sending", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const limits = { ...ROOMY, liveMessagesPerDay: 1 };
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_a",
          principal: "grant:a",
          deadline: Date.now() + 60_000,
          limits,
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
    await docs.create(op(envelope), context(OWNER, { limits }), "items", { text: "€".repeat(100) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.some((message) => message.includes("created"))).toBe(false);
  });

  it("17: erasing an absent author reads a bounded number of rows", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    await docs.seedForMeasure(envelope, "items", 20_000, NOW);
    const outcome = await docs.eraseAuthorChunk(envelope, "v_absent", 100);
    expect(outcome.cost.rowsRead).toBeLessThan(1_000);
  });
});

void env;
void runDurableObjectAlarm;
