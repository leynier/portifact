import { describe, expect, it } from "vitest";
import type { Cost, Outcome } from "../src/artifact-data.ts";
import { artifact, FREE, NOW, OWNER, ok, visitor } from "./harness.ts";

function cost<T>(outcome: Outcome<T>): Cost {
  return outcome.cost;
}

/**
 * The rows SQLite reads and writes per operation, as Cloudflare bills them (`rowsRead`,
 * `rowsWritten` of each cursor). Decision 0026's cost table is these numbers.
 */
describe("rows read and written per operation", () => {
  it("measures each document operation in a collection of 1,000 documents", async () => {
    const { ref, stub } = artifact();
    const limits = { ...FREE, writesPerAuthorPerMinute: 10_000 };
    const first = cost(await stub.declareCollection(ref, { name: "items", mode: "own" }, limits));
    for (let index = 0; index < 999; index++) {
      ok(
        await stub.create(ref, visitor(`v_${index % 50}`), "items", { index }, limits, NOW + index),
      );
    }
    const created = await stub.create(
      ref,
      visitor("v_1"),
      "items",
      { index: 999 },
      limits,
      NOW + 999,
    );
    const document = ok(created);
    const updated = await stub.update(
      ref,
      visitor("v_1"),
      "items",
      document._id,
      { index: 1000 },
      limits,
      NOW + 1000,
    );
    const got = await stub.get(ref, visitor("v_1"), "items", document._id);
    const ownPage = await stub.query(ref, visitor("v_1"), { collection: "items", limit: 20 });
    const ownerPage = await stub.query(ref, OWNER, { collection: "items", limit: 20 });
    const filtered = await stub.query(ref, OWNER, {
      collection: "items",
      filters: [{ field: "index", op: "eq", value: 500 }],
    });
    const removed = await stub.remove(
      ref,
      visitor("v_1"),
      "items",
      document._id,
      limits,
      NOW + 1001,
    );
    const table = {
      firstDeclare: first,
      create: cost(created),
      update: cost(updated),
      get: cost(got),
      queryOwn20: cost(ownPage),
      queryAll20: cost(ownerPage),
      queryUnindexedField: cost(filtered),
      remove: cost(removed),
    };
    console.log(JSON.stringify({ measure: "rows_per_operation", ...table }));
    // Bounded: a write touches a handful of rows whatever the collection holds; a page reads
    // about its size; only a filter on a body field scans the collection, which the document
    // cap bounds.
    expect(table.create.rowsWritten).toBeLessThanOrEqual(12);
    expect(table.get.rowsRead).toBeLessThanOrEqual(6);
    expect(table.queryOwn20.rowsRead).toBeLessThanOrEqual(40);
    expect(table.queryUnindexedField.rowsRead).toBeGreaterThanOrEqual(1000);
    expect(table.queryUnindexedField.rowsRead).toBeLessThanOrEqual(1_100);
  });

  it("measures the size a document adds to the database", async () => {
    const { ref, stub } = artifact();
    const limits = { ...FREE, writesPerAuthorPerMinute: 10_000 };
    ok(await stub.declareCollection(ref, { name: "items", mode: "append" }, limits));
    const empty = await stub.size();
    for (let index = 0; index < 500; index++) {
      ok(
        await stub.create(
          ref,
          visitor("v_a"),
          "items",
          { text: "x".repeat(200), index },
          limits,
          NOW + index,
        ),
      );
    }
    const full = await stub.size();
    console.log(
      JSON.stringify({
        measure: "bytes_per_document",
        empty,
        after500: full,
        perDocument: (full - empty) / 500,
      }),
    );
    expect(full).toBeGreaterThan(empty);
  });
});

describe("queries at the largest proposed collection (100,000 documents)", () => {
  it("times an indexed page, the author's page and a filter on a body field", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    await stub.seedForMeasure(ref, "items", 100_000, NOW);
    const timed = async (run: () => Promise<{ cost: { rowsRead: number } }>) => {
      const started = Date.now();
      const outcome = await run();
      return { ms: Date.now() - started, rowsRead: outcome.cost.rowsRead };
    };
    const ownerPage = await timed(() =>
      stub.query(ref, OWNER, { collection: "items", limit: 100 }),
    );
    const authorPage = await timed(() =>
      stub.query(ref, visitor("v_7"), { collection: "items", limit: 100 }),
    );
    const bodyFilter = await timed(() =>
      stub.query(ref, OWNER, {
        collection: "items",
        filters: [{ field: "index", op: "eq", value: 99_999 }],
      }),
    );
    const size = await stub.size();
    console.log(
      JSON.stringify({
        measure: "query_at_100k",
        ownerPage,
        authorPage,
        bodyFilter,
        databaseBytes: size,
      }),
    );
    expect(ownerPage.rowsRead).toBeLessThanOrEqual(110);
    expect(authorPage.rowsRead).toBeLessThanOrEqual(110);
    expect(bodyFilter.rowsRead).toBeGreaterThanOrEqual(100_000);
  });
});
