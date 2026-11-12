// The third review's reproductions that apply to the documents core (pull request #249 at
// 236a42f7, rebased as c5b84930). Each states the behavior the design must have; against that
// commit they fail, which is the reproduction. Finding 1's schedules held the owner ledger's
// lease await; the ledger and every await on a command's path are gone (decision 45), so they
// are closed by removal, and `invariants.test.ts` shows commands are synchronous and that a
// concurrent hold or duplicate is ordered wholly before or after each write.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as journal from "../src/journal.ts";
import { artifact, context, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const any = (value: unknown) => value as never;

describe("third review: empty objects, generations and maintenance (finding 6)", () => {
  it("leaves a generation barrier when an empty object is erased", async () => {
    const { envelope, docs } = artifact();
    await docs.prepareErase(envelope, "erase_1");
    await docs.commitErase(envelope, "erase_1");
    expect(
      (await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "own" }))
        .ok,
    ).toBe(false);
  });

  it("refuses a fence for an older generation", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "own" }));
    ok(await docs.prepareErase(envelope, "erase_1"));
    ok(await docs.commitErase(envelope, "erase_1"));
    expect(
      (await docs.fence({ ...envelope, epoch: 1 }, any({ state: "held", transition: "t_old" }))).ok,
    ).toBe(false);
  });

  it("keeps maintenance behind the validator: no pruning under a hold, no settlement for another artifact", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    ok(await docs.fence({ ...envelope, epoch: 1 }, any({ state: "held", transition: "t_hold" })));
    await docs.backdateReplays(Date.now() - 3 * 86_400_000);
    expect(await docs.pruneReplays(Date.now())).toBe(0);
    const settled = await docs.settle(
      { ...envelope, artifactId: "other", epoch: 1 },
      "owner:owner",
      "op_x",
    );
    expect(JSON.stringify(settled)).not.toContain('"aborted"');
  });
});

describe("third review: author erasure is terminal (finding 8)", () => {
  it("refuses a late write after erasing an author from an empty object", async () => {
    const { envelope, docs } = artifact();
    await docs.eraseAuthorChunk(envelope, "v_gone", 10);
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    expect(
      (await docs.create(op(envelope), context(visitor("v_gone")), "items", { n: 1 })).ok,
    ).toBe(false);
  });

  it("never revives an erased person's identity under a fresh ID", async () => {
    await journal.claimVisitorId(env.JOURNAL, "user_gone", "a_journal", "v_old", NOW);
    const retire =
      (
        journal as unknown as {
          retireVisitorId?: (b: R2Bucket, u: string, a: string, at: number) => Promise<void>;
        }
      ).retireVisitorId ??
      ((bucket: R2Bucket, user: string, id: string) => bucket.delete(journal.journalKey(user, id)));
    await retire(env.JOURNAL, "user_gone", "a_journal", NOW);
    const claimed = await journal
      .claimVisitorId(env.JOURNAL, "user_gone", "a_journal", "v_new", NOW)
      .catch(() => null);
    expect(claimed).not.toBe("v_new");
  });

  it("closes the author's connections and removes their sequences", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "own" }));
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
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
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    while (ok(await docs.eraseAuthorChunk(envelope, "v_a", 10)).more) {
      // until done
    }
    const code = await Promise.race([
      closed,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 200)),
    ]);
    expect(code).not.toBe(-1);
  });

  it("keeps another creator's document when an editor is erased, marking the edit as erased", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "shared" }),
    );
    const card = ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { t: "a" }));
    ok(await docs.replace(op(envelope), context(visitor("v_b")), "items", card._id, { t: "b" }));
    while (ok(await docs.eraseAuthorChunk(envelope, "v_b", 10)).more) {
      // until done
    }
    const kept = ok(await docs.get(envelope, context(OWNER), "items", card._id));
    expect(kept._editedBy).toBe("erased");
  });

  it("replays a repeated author chunk instead of erasing more (finding 10)", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    for (let index = 0; index < 4; index++)
      ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { index }));
    const chunk = op(envelope);
    await docs.eraseAuthorChunk(chunk, "v_a", 1);
    await docs.eraseAuthorChunk(chunk, "v_a", 1);
    expect(
      ok(await docs.query(envelope, context(OWNER), { collection: "items" })).documents,
    ).toHaveLength(3);
  });
});

describe("third review: accounting (findings 9, 15, 16)", () => {
  it("charges a page at least what it read", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    await docs.seedForMeasure(envelope, "items", 300, NOW);
    const before = (await docs.budget(NOW)).rows_read ?? 0;
    const page = await docs.query(envelope, context(visitor("v_q")), {
      collection: "items",
      limit: 100,
    });
    const after = (await docs.budget(NOW)).rows_read ?? 0;
    expect(after - before).toBeGreaterThanOrEqual(page.cost.rowsRead);
  });

  it("refuses an index build that does not fit the allowance before building it", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    await docs.seedForMeasure(envelope, "items", 2_000, NOW);
    const tight = context(OWNER, {
      limits: { ...ROOMY, rowsWrittenPerDay: 1 },
    });
    expect(
      (
        await docs.declareCollection(op(envelope), tight, {
          name: "items",
          mode: "append",
          indexed: ["tag"],
        })
      ).ok,
    ).toBe(false);
  });

  it("charges live messages for acknowledgements too", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    const response = await docs.fetch("https://data.internal/live", {
      headers: {
        Upgrade: "websocket",
        "X-Portifact-Envelope": JSON.stringify(envelope),
        "X-Portifact-Caller": JSON.stringify({
          author: "v_a",
          principal: "grant:v_a",
          deadline: Date.now() + 60_000,
          limits: { ...ROOMY, liveMessagesPerDay: 0 },
          now: Date.now(),
        }),
      },
    });
    const socket = response.webSocket;
    if (socket === null) return; // refused at connect: the owner has no live bytes, which is also correct
    socket.accept();
    const received: string[] = [];
    socket.addEventListener("message", (event) => received.push(String(event.data)));
    socket.send(JSON.stringify({ subscribe: "items" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([]);
  });

  it("rate-limits shrinking replacements per author", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    const limits = { ...ROOMY, writesPerAuthorPerMinute: 1 };
    const created = ok(
      await docs.create(op(envelope), context(visitor("v_a"), { limits }), "items", { t: "aaaa" }),
    );
    const results = [];
    for (let index = 0; index < 5; index++) {
      results.push(
        (
          await docs.replace(
            op(envelope),
            context(visitor("v_a"), { limits }),
            "items",
            created._id,
            { t: "bbbb" },
          )
        ).ok,
      );
    }
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});

describe("third review: audit, export and pruning (findings 11, 12, 14)", () => {
  it("keys audit obligations by actor and generation, not by the bare operation ID", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    const shared = { ...envelope, opId: `${NOW}.same` };
    ok(await docs.create(shared, context({ kind: "owner", actor: "alice" }), "items", { n: 1 }));
    ok(
      await docs.declareCollection(shared, context({ kind: "owner", actor: "bob" }), {
        name: "more",
        mode: "own",
      }),
    );
    const settled = await docs.settle(envelope, "owner:bob", `${NOW}.same`);
    expect(settled).toMatchObject({ kind: "data.collection_set" });
  });

  it("does not move the payload revision on a quiet export", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    ok(await docs.create(op(envelope), context(OWNER), "items", { n: 1 }));
    const first = ok(await docs.exportPage(envelope, context(OWNER), null, 10));
    const second = ok(await docs.exportPage(envelope, context(OWNER), null, 10));
    expect(second.revision).toBe(first.revision);
  });

  it("bounds an export page in bytes", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    for (let index = 0; index < 120; index++) {
      ok(
        await docs.create(op(envelope), context(OWNER), "items", {
          text: "x".repeat(15_000),
          index,
        }),
      );
    }
    const page = ok(await docs.exportPage(envelope, context(OWNER), null, 500));
    expect(new TextEncoder().encode(JSON.stringify(page.rows)).length).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  it("prunes old replay records from the alarm", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "append" }),
    );
    ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    await docs.backdateReplays(Date.now() - 3 * 86_400_000);
    await runDurableObjectAlarm(docs);
    expect(await docs.pruneReplays(Date.now())).toBe(0);
  });
});
