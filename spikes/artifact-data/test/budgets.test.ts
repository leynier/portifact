import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { artifact, context, FREE, NOW, OWNER, ok, op, ROOMY, visitor } from "./harness.ts";

const owner = context(OWNER);

describe("budgets of work, charged before the work and kept when it is refused", () => {
  it("refuses the 31st write of a minute, attempts included, and opens the next minute", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const limits = { ...ROOMY, writesPerAuthorPerMinute: 30 };
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        docs.create(op(envelope), context(visitor("v_a"), { limits }), "items", { index }),
      ),
    );
    expect(burst.filter((outcome) => outcome.ok)).toHaveLength(30);
    expect(burst.filter((outcome) => !outcome.ok && outcome.error === "rate_limited")).toHaveLength(
      10,
    );
    ok(await docs.create(op(envelope), context(visitor("v_b"), { limits }), "items", { n: 1 }));
    ok(
      await docs.create(
        op(envelope),
        context(visitor("v_a"), { limits, now: NOW + 60_000 }),
        "items",
        { n: 1 },
      ),
    );
  });

  it("refuses work past the artifact's daily rows, and counts the refusals", async () => {
    const { envelope, docs } = artifact();
    const limits = { ...ROOMY, rowsWrittenPerDay: 200 };
    ok(
      await docs.declareCollection(op(envelope), context(OWNER, { limits }), {
        name: "items",
        mode: "append",
      }),
    );
    let refused = 0;
    for (let index = 0; index < 30; index++) {
      const outcome = await docs.create(
        op(envelope),
        context(visitor(`v_${index}`), { limits }),
        "items",
        { index },
      );
      if (!outcome.ok && outcome.error === "quota_exceeded") refused += 1;
    }
    expect(refused).toBeGreaterThan(10);
    const spent = await docs.budget(NOW);
    expect(spent.rows_written).toBeGreaterThan(limits.rowsWrittenPerDay);
    // The next day opens again.
    ok(
      await docs.create(
        op(envelope),
        context(visitor("v_x"), { limits, now: NOW + 86_400_000 }),
        "items",
        { n: 1 },
      ),
    );
  });

  it("shares one owner budget across the owner's artifacts through the ledger", async () => {
    const first = artifact();
    const second = artifact();
    const ownerId = "owner_ledger_test";
    const options = { owner: ownerId, ownerWritten: 400 };
    for (const target of [first, second]) {
      ok(
        await target.docs.declareCollection(op(target.envelope), context(OWNER, options), {
          name: "items",
          mode: "append",
        }),
      );
    }
    let accepted = 0;
    for (let index = 0; index < 40; index++) {
      const target = index % 2 === 0 ? first : second;
      const outcome = await target.docs.create(
        op(target.envelope),
        context(visitor(`v_${index}`), options),
        "items",
        { index },
      );
      if (outcome.ok) accepted += 1;
    }
    const ledger = env.LEDGER.get(env.LEDGER.idFromName(ownerId));
    // The ledger never granted more than the owner's day: what is left is at least zero.
    const leased =
      400 - (await ledger.balance("documents_written", Math.floor(NOW / 86_400_000), 400));
    expect(leased).toBeLessThanOrEqual(400);
    expect(accepted).toBeLessThan(40);
    expect(accepted).toBeGreaterThan(0);
  });

  it("keeps deletes working when writing and the daily budget are spent", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" }));
    const created = ok(await docs.create(op(envelope), context(visitor("v_a")), "items", { n: 1 }));
    const spent = { ...ROOMY, rowsWrittenPerDay: 0, writesPerAuthorPerMinute: 0 };
    expect(
      await docs.create(op(envelope), context(visitor("v_a"), { limits: spent }), "items", {
        n: 2,
      }),
    ).toMatchObject({
      ok: false,
    });
    ok(
      await docs.remove(
        op(envelope),
        context(visitor("v_a"), { limits: spent }),
        "items",
        created._id,
      ),
    );
  });

  it("refuses a document past its size and a collection past its count", async () => {
    const { envelope, docs } = artifact();
    const limits = { ...ROOMY, documentBytes: FREE.documentBytes, documentsPerCollection: 2 };
    ok(
      await docs.declareCollection(op(envelope), context(OWNER, { limits }), {
        name: "items",
        mode: "append",
      }),
    );
    ok(
      await docs.create(op(envelope), context(visitor("v_a"), { limits }), "items", {
        text: "x".repeat(FREE.documentBytes - 11),
      }),
    );
    expect(
      await docs.create(op(envelope), context(visitor("v_a"), { limits }), "items", {
        text: "x".repeat(FREE.documentBytes - 10),
      }),
    ).toMatchObject({ ok: false, error: "quota_exceeded" });
    ok(await docs.create(op(envelope), context(visitor("v_b"), { limits }), "items", { n: 1 }));
    expect(
      await docs.create(op(envelope), context(OWNER, { limits }), "items", { n: 1 }),
    ).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });

  it("refuses growth past the artifact's size but lets a smaller replacement through", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "read" }));
    const big = ok(await docs.create(op(envelope), owner, "items", { text: "y".repeat(12_000) }));
    const full = context(OWNER, { limits: { ...ROOMY, bytesPerArtifact: 1_000 } });
    expect(
      await docs.create(op(envelope), full, "items", { text: "z".repeat(12_000) }),
    ).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    ok(await docs.replace(op(envelope), full, "items", big._id, { text: "small" }));
  });
});
