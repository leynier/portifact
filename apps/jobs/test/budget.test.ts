import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { emailsSentInCycle, getBudgetState, listBudgetAlerts } from "@portifact/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsCollector } from "../src/analytics.ts";
import { alertEmail, type BudgetEmail, notifierFromEnv, runBudget } from "../src/budget.ts";
import { runScheduledBudget } from "../src/index.ts";

const db = () => createDb(env.DB);
// November has 30 days: the 16th at 00:00 is half the cycle, so counters project to double.
const MID = Date.UTC(2026, 10, 16);

/** A collector reporting counters that project `usd` dollars (US$9 fixed plus D1 writes). */
function spending(usd: number): AnalyticsCollector {
  return { collect: async () => ({ d1RowsWritten: (50_000_000 + (usd - 9) * 1e6) / 2 }) };
}

function recordingNotifier(fail = false) {
  const sent: BudgetEmail[] = [];
  return {
    sent,
    notifier: {
      async send(email: BudgetEmail) {
        if (fail) throw new Error("provider down");
        sent.push(email);
      },
    },
  };
}

let logs: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await db().delete(schema.platformBudget);
  await db().delete(schema.budgetAlerts);
  await db().delete(schema.emailCounters);
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("budget run", () => {
  it("uses D1 alone when analytics are not configured, and sends nothing", async () => {
    const result = await runBudget(db(), MID, { analytics: null, notifier: null });
    expect(result).toEqual({
      level: "none",
      projectedUsd: 9,
      actions: [],
      analytics: "off",
      newAlerts: [],
      notified: 0,
    });
  });

  it("alerts once per threshold per cycle and emails each alert once", async () => {
    const { sent, notifier } = recordingNotifier();
    const first = await runBudget(db(), MID, { analytics: spending(60), notifier });
    expect(first).toMatchObject({
      level: "alert50",
      analytics: "ok",
      newAlerts: ["spend_25", "spend_50"],
      notified: 2,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("Portifact budget: projected US$60.00 this cycle (alert50)");
    // The alert email counts toward the cycle's emails like any other.
    expect(await emailsSentInCycle(db(), MID)).toBe(1);

    const again = await runBudget(db(), MID + 900_000, { analytics: spending(62), notifier });
    expect(again).toMatchObject({ newAlerts: [], notified: 0 });
    expect(sent).toHaveLength(1);

    const protect = await runBudget(db(), MID + 1_800_000, { analytics: spending(112), notifier });
    expect(protect).toMatchObject({
      level: "protect100",
      actions: ["stop_new_artifacts", "block_uploads", "pause_annotation_writes"],
      newAlerts: ["spend_75", "spend_100"],
      notified: 2,
    });
    expect(sent[1]?.text).toMatch(/- spend_75 at US\$111\.\d\d \(2026-11-16T00:30:00\.000Z\)/);
    expect(sent[1]?.text).toContain(
      "Protection in effect: stop_new_artifacts, block_uploads, pause_annotation_writes.",
    );
  });

  it("keeps alerts pending when the email fails and retries on the next run", async () => {
    const failing = recordingNotifier(true);
    const result = await runBudget(db(), MID, {
      analytics: spending(30),
      notifier: failing.notifier,
    });
    expect(result).toMatchObject({ newAlerts: ["spend_25"], notified: 0 });
    const working = recordingNotifier();
    const retry = await runBudget(db(), MID + 900_000, {
      analytics: spending(30),
      notifier: working.notifier,
    });
    expect(retry).toMatchObject({ newAlerts: [], notified: 1 });
    expect((await listBudgetAlerts(db(), { limit: 5 }))[0]?.notifiedAt).toBe(MID + 900_000);
  });

  it("falls back to D1 and carried-forward counters when analytics fail", async () => {
    await runBudget(db(), MID, { analytics: spending(130), notifier: null });
    const failing: AnalyticsCollector = {
      collect: async () => {
        throw new Error("analytics: HTTP 500");
      },
    };
    const result = await runBudget(db(), MID + 900_000, { analytics: failing, notifier: null });
    expect(result).toMatchObject({ analytics: "failed", level: "protect100" });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("ignores values that are not finite numbers", async () => {
    const odd: AnalyticsCollector = {
      collect: async () => ({ storedBytes: Number.NaN, workerRequests: 5 }),
    };
    await runBudget(db(), MID, { analytics: odd, notifier: null });
    expect((await getBudgetState(db(), MID))?.metrics).toMatchObject({
      storedBytes: 0,
      workerRequests: 5,
    });
  });

  it("formats an email without protection", () => {
    const email = alertEmail([], { projectedUsd: 25, level: "alert25", actions: [] });
    expect(email.text).toContain("Protection in effect: none.");
    expect(email.html).toContain("Protection in effect");
    expect(email.html).toContain("US$25.00");
  });
});

describe("budget notifier", () => {
  it("is a no-op unless the binding, recipient and sender are all configured", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    const binding = { send } as unknown as SendEmail;
    expect(notifierFromEnv({})).toBeNull();
    expect(
      notifierFromEnv({ BUDGET_EMAIL: binding, BUDGET_ALERT_TO: "ops@example.test" }),
    ).toBeNull();
    const notifier = notifierFromEnv({
      BUDGET_EMAIL: binding,
      BUDGET_ALERT_TO: "ops@example.test",
      BUDGET_ALERT_FROM: "budget@example.test",
    });
    await notifier?.send({ subject: "S", text: "T", html: "<p>H</p>" });
    expect(send).toHaveBeenCalledWith({
      from: { email: "budget@example.test", name: "Portifact budget" },
      to: "ops@example.test",
      subject: "S",
      text: "T",
      html: "<p>H</p>",
    });
  });
});

describe("scheduled budget run", () => {
  it("builds the collector from the environment and logs the result", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { viewer: { accounts: [{}] } } }));
    const configured = { ...env, CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "a" };
    expect(await runScheduledBudget(configured, MID, fetcher)).toMatchObject({ analytics: "ok" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await runScheduledBudget(env, MID)).toMatchObject({ analytics: "off" });
    expect(logs).toHaveBeenCalledWith(expect.stringContaining('"event":"budget"'));
  });
});
