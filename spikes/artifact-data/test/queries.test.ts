import { describe, expect, it } from "vitest";
import { buildQuery, MAX_PAGE } from "../src/model.ts";
import { artifact, context, NOW, OWNER, ok, op, visitor } from "./harness.ts";

const owner = context(OWNER);

/**
 * Decision 0026, "Queries": every allowed shape names its index and seeks, so the rows it reads
 * are bounded by the page, whether the match is dense, sparse or empty (finding 11).
 */
describe("bounded query shapes at 100,000 documents", () => {
  it("reads at most the page plus a few rows for every allowed shape, matching or not", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "append",
        indexed: ["tag"],
      }),
    );
    await docs.seedForMeasure(envelope, "items", 100_000, NOW);
    const caller = context(visitor("v_q"));
    const shapes = [
      { collection: "items", limit: 100 },
      { collection: "items", order: "-created" as const, limit: 100 },
      { collection: "items", equals: { field: "_by", value: "v_7" }, limit: 100 },
      { collection: "items", equals: { field: "_by", value: "nobody" }, limit: 100 },
      { collection: "items", equals: { field: "tag", value: "t5" }, limit: 100 },
      { collection: "items", equals: { field: "tag", value: "absent" }, limit: 100 },
      { collection: "items", created: { op: "gt" as const, value: NOW + 99_990 }, limit: 100 },
      { collection: "items", created: { op: "gt" as const, value: NOW + 1_000_000 }, limit: 100 },
      {
        collection: "items",
        equals: { field: "_by", value: "v_7" },
        created: { op: "gt" as const, value: NOW + 99_000 },
        limit: 1,
      },
    ];
    const measured = [];
    for (const spec of shapes) {
      const started = Date.now();
      const outcome = await docs.query(envelope, caller, spec);
      ok(outcome);
      measured.push({
        spec: JSON.stringify(spec),
        ms: Date.now() - started,
        rowsRead: outcome.cost.rowsRead,
      });
      // The page, one more, the collection row, the index list and the budget rows.
      expect(outcome.cost.rowsRead).toBeLessThanOrEqual(MAX_PAGE + 20);
    }
    console.log(JSON.stringify({ measure: "bounded_queries_at_100k", measured }));
  });

  it("seeks in every allowed shape, by SQLite's own plan", async () => {
    const { envelope, docs } = artifact();
    ok(
      await docs.declareCollection(op(envelope), owner, {
        name: "items",
        mode: "append",
        indexed: ["tag"],
      }),
    );
    const plans = [
      await docs.explainQuery({ collection: "items" }, "all", ["tag"]),
      await docs.explainQuery({ collection: "items" }, "own", ["tag"]),
      await docs.explainQuery(
        { collection: "items", equals: { field: "_by", value: "x" } },
        "all",
        ["tag"],
      ),
      await docs.explainQuery(
        { collection: "items", equals: { field: "tag", value: "x" } },
        "all",
        ["tag"],
      ),
      await docs.explainQuery(
        { collection: "items", created: { op: "lt", value: 1 }, order: "-created" },
        "all",
        [],
      ),
    ];
    for (const plan of plans) {
      expect(plan.join(" ")).toMatch(/^SEARCH (d|v) USING (COVERING )?INDEX/);
      expect(plan.join(" ")).not.toMatch(/SCAN|TEMP B-TREE/);
    }
  });

  it("refuses every shape that is not on the list", () => {
    const refused = [
      { collection: "items", equals: { field: "body_field", value: 1 } },
      { collection: "items", equals: { field: "_updated", value: 1 } },
      { collection: "items", equals: { field: "_id", value: "x" } },
      { collection: "items", equals: { field: "_by", value: 1 } },
      { collection: "items", created: { op: "like" as "gt", value: 1 } },
      { collection: "items", created: { op: "gt" as const, value: 1.5 } },
      { collection: "items", after: "not a cursor" },
      { collection: "Bad" },
    ];
    for (const spec of refused) expect(() => buildQuery(spec, "all", null, [])).toThrow();
    expect(() =>
      buildQuery({ collection: "items", equals: { field: "_by", value: "x" } }, "own", "v", []),
    ).toThrow();
    expect(buildQuery({ collection: "items", limit: 1_000 }, "all", null, []).limit).toBe(MAX_PAGE);
    expect(
      buildQuery({ collection: "items", equals: { field: "flag", value: true } }, "all", null, [
        "flag",
      ]).params,
    ).toContain(1);
  });
});
