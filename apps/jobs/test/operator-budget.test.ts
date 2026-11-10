import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { recordBudgetMeasurement } from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const db = () => regionsFromEnv(env).get("default").db;
// November has 30 days: the 16th at 00:00 is half the cycle, so counters project to double.
const MID = Date.UTC(2026, 10, 16);
const run = (...argv: string[]) => runOperator(db(), argv, MID);

async function measure(usd: number) {
  await recordBudgetMeasurement(db().global, {
    metrics: {
      storedBytes: 0,
      r2ClassA: null,
      r2ClassB: null,
      workerRequests: null,
      d1RowsRead: null,
      d1RowsWritten: (50_000_000 + (usd - 9) * 1e6) / 2,
      emails: null,
    },
    analytics: "off",
    now: MID,
  });
}

beforeEach(async () => {
  await db().delete(schema.platformBudget);
  await db().delete(schema.budgetAlerts);
});

describe("operator budget commands", () => {
  it("explains usage for bad budget arguments", async () => {
    for (const argv of [
      ["budget-override"],
      ["budget-override", "panic", "--note", "x"],
      ["budget-override", "protect100"],
      ["budget-override", "protect100", "--note", " "],
      ["budget-override", "protect100", "--note", "x", "--steps", "5"],
      ["budget-override", "protect100", "--note", "x", "--steps", "1.5"],
      ["budget-override", "none", "--note", "x", "--hours", "0"],
      ["budget-override", "none", "--note", "x", "--hours", "800"],
      ["budget-alerts", "--limit", "0"],
    ]) {
      const result = await run(...argv);
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(result.output).toContain(OPERATOR_USAGE);
    }
  });

  it("says when there is nothing to show yet", async () => {
    expect(await run("budget")).toEqual({
      exitCode: 0,
      output: "No budget state yet: the jobs Worker has not run.",
    });
    expect((await run("budget-alerts")).output).toBe("No budget alerts.");
    expect((await run("budget-override", "clear")).output).toBe("No budget state.");
  });

  it("shows the state, metrics and this cycle's alerts", async () => {
    await measure(60);
    const shown = await run("budget");
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain("measured    2026-11-16T00:00:00.000Z (analytics off)");
    expect(shown.output).toContain("projected   US$60.00");
    expect(shown.output).toContain("automatic   alert50: none (since 2026-11-16T00:00:00.000Z)");
    expect(shown.output).toContain("effective   alert50: none");
    expect(shown.output).toContain("  d1RowsWritten  50500000");
    expect(shown.output).toContain("  r2ClassB       unmeasured");
    expect(shown.output).toContain("2026-11-16T00:00:00.000Z  spend_25  US$60.00  not emailed");

    const alerts = await run("budget-alerts", "--limit", "1");
    expect(alerts.output.split("\n")).toHaveLength(1);
    expect(alerts.output).toContain("cycle 2026-11  alert50  2026-11-16T00:00:00.000Z  spend_50");

    await db().update(schema.budgetAlerts).set({ notifiedAt: MID });
    expect((await run("budget")).output).toContain("US$60.00  emailed");
    // A new cycle has no alerts yet.
    const later = await runOperator(db(), ["budget"], Date.UTC(2026, 11, 2));
    expect(later.output).toContain("alerts this cycle\n  none");
  });

  it("overrides protection in both directions and clears the override", async () => {
    await measure(60);
    const set = await run(
      "budget-override",
      "protect100",
      "--steps",
      "3",
      "--hours",
      "2",
      "--note",
      "traffic\nspike",
    );
    expect(set.exitCode).toBe(0);
    expect(set.output).toContain(
      "override    protect100 (3 step(s)), until 2026-11-16T02:00:00.000Z, set 2026-11-16T00:00:00.000Z: traffic spike",
    );
    expect(set.output).toContain(
      "effective   protect100: stop_new_artifacts, block_uploads, pause_annotation_writes, tighten_public_traffic (override)",
    );

    const lifted = await run("budget-override", "none", "--note", "false alarm");
    expect(lifted.output).toContain("override    none, until cleared");
    expect(lifted.output).toContain("effective   none: none (override)");

    const cleared = await run("budget-override", "clear");
    expect(cleared.output).toContain("Override cleared.");
    expect(cleared.output).not.toContain("override    ");
    expect(cleared.output).toContain("effective   alert50: none\n");
  });

  it("can protect before the first measurement", async () => {
    const set = await run("budget-override", "slow75", "--note", "launch week");
    expect(set.output).toContain("measured    never (analytics off)");
    expect(set.output).toContain("effective   slow75: stop_new_artifacts (override)");
  });
});
