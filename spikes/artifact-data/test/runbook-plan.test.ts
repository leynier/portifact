import { describe, expect, it } from "vitest";
import {
  alreadyGone,
  DELETION_ENTRY,
  datasetQuery,
  datasets,
  deletionConfig,
  guardName,
  phaseReport,
  resourceNames,
  round,
  runSuffix,
  table,
  totals,
  workerConfig,
  workersDevUrl,
} from "../src/runbook-plan.ts";

// The deployed runbook's pure rules: it must never name a resource outside `pf-exp-`, and its
// arithmetic must turn Cloudflare's microseconds into the record's milliseconds and GB-seconds.

describe("the runbook's resource guard", () => {
  it("names every resource pf-exp-… and refuses anything else", () => {
    expect(resourceNames("abc123")).toEqual({
      worker: "pf-exp-data-abc123",
      database: "pf-exp-data-abc123-db",
      bucket: "pf-exp-data-abc123-r2",
    });
    for (const name of [
      "portifact-control",
      "portifact-data",
      "pf-exp",
      "PF-EXP-data-x1",
      "pf-exp-data/../x",
      "xpf-exp-data",
    ])
      expect(() => guardName(name), name).toThrow(/refusing/);
    expect(() => runSuffix("ab")).toThrow();
    expect(() => runSuffix("Bad_suffix")).toThrow();
  });

  it("builds configurations that only name guarded resources", () => {
    const names = resourceNames("run1");
    const config = workerConfig(names, "/x/worker.ts", "uuid") as Record<string, unknown>;
    expect(JSON.stringify(config)).not.toMatch(/portifact-(control|content|app|jobs)/);
    expect(config).toMatchObject({
      name: "pf-exp-data-run1",
      d1_databases: [{ database_name: "pf-exp-data-run1-db", database_id: "uuid" }],
      r2_buckets: [{ bucket_name: "pf-exp-data-run1-r2" }],
    });
    expect(deletionConfig(names, "/x/deleted.js")).toMatchObject({
      name: "pf-exp-data-run1",
      migrations: [{ tag: "v1" }, { tag: "v2", deleted_classes: ["ArtifactDocuments"] }],
    });
    expect(() => workerConfig({ ...names, bucket: "portifact-artifacts" }, "/x", "u")).toThrow();
    expect(DELETION_ENTRY).not.toMatch(/ArtifactDocuments/);
  });

  it("reads wrangler's answers", () => {
    expect(alreadyGone("✘ [ERROR] The specified bucket does not exist. [code: 10006]")).toBe(true);
    expect(alreadyGone("Couldn't find a D1 DB with the name or binding")).toBe(true);
    expect(alreadyGone("✘ [ERROR] Authentication error [code: 10000]")).toBe(false);
    expect(workersDevUrl("Deployed\n  https://pf-exp-data-run1.team.workers.dev\n")).toBe(
      "https://pf-exp-data-run1.team.workers.dev",
    );
    expect(workersDevUrl("no url")).toBeNull();
  });
});

describe("the runbook's analytics arithmetic", () => {
  it("queries the Worker and Durable Object datasets, the latter only with a namespace", () => {
    const names = resourceNames("run1");
    expect(datasets(names, null).map((set) => set.key)).toEqual(["worker", "invocations"]);
    const all = datasets(names, "ns123");
    expect(all.map((set) => set.key)).toEqual(["worker", "invocations", "periodic", "storage"]);
    const periodic = all.find((set) => set.key === "periodic");
    if (periodic === undefined) throw new Error("no periodic dataset");
    const query = datasetQuery(periodic, ["activeTime"]);
    expect(query).toContain('namespaceId: "ns123"');
    expect(query).toContain("sum { activeTime }");
    expect(datasetQuery(all[3] ?? periodic)).toContain("max { storedBytes }");
  });

  it("sums groups, keeps maxima for storage and converts to the record's units", () => {
    expect(
      totals([{ sum: { requests: 2, wallTime: 3_000 } }, { sum: { requests: 3 } }, {}], "sum"),
    ).toEqual({ requests: 5, wallTime: 3_000 });
    expect(totals([{ max: { storedBytes: 5 } }, { max: { storedBytes: 9 } }], "max")).toEqual({
      storedBytes: 9,
    });
    // 50 commands, 250,000 µs of active time: 5 ms a command, the record's low assumption.
    const report = phaseReport(
      "create",
      50,
      { requests: 50, wallTime: 400_000 },
      { activeTime: 250_000, rowsRead: 550, rowsWritten: 650 },
    );
    expect(report).toEqual({
      phase: "create",
      commands: 50,
      requests: 50,
      activeMsPerCommand: 5,
      wallMsPerRequest: 8,
      gbSeconds: 0.25 * 0.128,
      rowsReadPerCommand: 11,
      rowsWrittenPerCommand: 13,
    });
    expect(phaseReport("idle", 1, {}, {})).toMatchObject({
      requests: null,
      activeMsPerCommand: null,
      gbSeconds: null,
    });
    expect(round(null)).toBeNull();
    expect(round(1.23456, 3)).toBe(1.235);
    expect(table(["A", "Bee"], [["x", null]])).toBe("| A | Bee |\n| x | n/a |");
  });
});
