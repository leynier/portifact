import { describe, expect, it } from "vitest";
import { CHARGE_SELF, type Cost } from "../src/documents.ts";
import { artifact, context, NOW, OWNER, ok, op, visitor } from "./harness.ts";

const owner = context(OWNER);

/**
 * Rows SQLite reads and writes per operation, as Cloudflare bills them, with the production
 * shape of each command: the budget counters charged first, the operation ID, the sequence, the
 * revision and the audit obligation included. Decision 0026's cost table is these numbers.
 */
describe("rows read and written per operation", () => {
  it("measures each document operation in a collection of 1,000 documents", async () => {
    const { envelope, docs } = artifact();
    const first = (
      await docs.declareCollection(op(envelope), owner, { name: "items", mode: "own" })
    ).cost;
    for (let index = 0; index < 999; index++) {
      ok(
        await docs.create(
          op(envelope),
          context(visitor(`v_${index % 50}`), { now: NOW + index }),
          "items",
          { index },
        ),
      );
    }
    const caller = context(visitor("v_1"), { now: NOW + 5_000 });
    const created = await docs.create(op(envelope), caller, "items", { index: 999 });
    const document = ok(created);
    const replaced = await docs.replace(op(envelope), caller, "items", document._id, {
      index: 1000,
    });
    const got = await docs.get(envelope, caller, "items", document._id);
    const page = await docs.query(envelope, caller, { collection: "items", limit: 20 });
    const removed = await docs.remove(op(envelope), caller, "items", document._id);
    const ownerCreate = await docs.create(op(envelope), owner, "items", { n: 1 });
    const counted = await docs.count(envelope, owner, "items");
    const countedByAuthor = await docs.count(envelope, owner, "items", "v_3");
    const ids = ok(
      await docs.query(envelope, owner, { collection: "items", limit: 10 }),
    ).documents.map((d) => d._id);
    const bulk = await docs.bulkRemove(op(envelope), owner, "items", ids);
    const exported = await docs.exportPage(envelope, owner, null, 100);
    const erased = await docs.eraseAuthorChunk(op(envelope), "v_7", 100);
    const table: Record<string, Cost> = {
      firstDeclare: first,
      visitorCreate: created.cost,
      visitorReplace: replaced.cost,
      visitorGet: got.cost,
      visitorPage20: page.cost,
      visitorDelete: removed.cost,
      ownerCreateWithAudit: ownerCreate.cost,
      ownerCount: counted.cost,
      ownerCountByAuthor: countedByAuthor.cost,
      ownerBulkRemove10: bulk.cost,
      ownerExport100: exported.cost,
      authorEraseChunk: erased.cost,
    };
    console.log(JSON.stringify({ measure: "rows_per_operation", ...table }));
    expect(table.visitorCreate?.rowsWritten).toBeLessThanOrEqual(24);
    expect(table.visitorGet?.rowsWritten).toBeLessThanOrEqual(8);
    expect(table.visitorPage20?.rowsRead).toBeLessThanOrEqual(50);
    // Each mutation is charged what it measured, its own counter row included (decision 45).
    const charged = (cost: Cost) =>
      cost.rowsRead + cost.rowsWritten + CHARGE_SELF.read + CHARGE_SELF.written;
    for (const cost of [
      created.cost,
      replaced.cost,
      removed.cost,
      ownerCreate.cost,
      bulk.cost,
      erased.cost,
    ]) {
      expect(charged(cost)).toBeGreaterThan(cost.rowsRead + cost.rowsWritten);
    }
    // Reads write nothing per request.
    expect(got.cost.rowsWritten + page.cost.rowsWritten + counted.cost.rowsWritten).toBe(0);
  });

  it("measures the size a document adds to the database", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), owner, { name: "items", mode: "append" }));
    const empty = (await docs.size()).bytes;
    for (let index = 0; index < 500; index++) {
      ok(
        await docs.create(op(envelope), context(visitor("v_a")), "items", {
          text: "x".repeat(200),
          index,
        }),
      );
    }
    const full = (await docs.size()).bytes;
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
