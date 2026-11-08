// The budget run of the scheduled Worker (plan section 12): measure the cycle's usage, record the
// automatic protection and the alerts it earns, and email the operator when that is configured.
// Collector and notifier are injected so every path is tested with fakes.
import type { Db } from "@portifact/db";
import { budgetCycle, type PlatformMetrics } from "@portifact/domain";
import {
  type AnalyticsStatus,
  type BudgetAlert,
  markBudgetAlertsNotified,
  measurePlatformUsage,
  pendingBudgetAlerts,
  recordBudgetMeasurement,
} from "@portifact/services";
import type { AnalyticsCollector } from "./analytics.ts";

export interface BudgetEmail {
  subject: string;
  text: string;
}

export interface BudgetNotifier {
  send(email: BudgetEmail): Promise<void>;
}

export interface NotifierEnv {
  /** A `send_email` binding; with BUDGET_ALERT_TO and BUDGET_ALERT_FROM it turns on alert emails. */
  BUDGET_EMAIL?: SendEmail | undefined;
  BUDGET_ALERT_TO?: string | undefined;
  BUDGET_ALERT_FROM?: string | undefined;
}

/** Emails through Cloudflare Email Service when fully configured, otherwise null (a no-op). */
export function notifierFromEnv(env: NotifierEnv): BudgetNotifier | null {
  const binding = env.BUDGET_EMAIL;
  const to = env.BUDGET_ALERT_TO?.trim();
  const from = env.BUDGET_ALERT_FROM?.trim();
  if (!binding || !to || !from) return null;
  return {
    async send(email) {
      await binding.send({ from: { email: from, name: "Portifact budget" }, to, ...email });
    },
  };
}

export interface BudgetDeps {
  analytics: AnalyticsCollector | null;
  notifier: BudgetNotifier | null;
}

export interface BudgetRunResult {
  level: string;
  projectedUsd: number;
  actions: string[];
  analytics: AnalyticsStatus;
  newAlerts: string[];
  notified: number;
}

const usd = (value: number) => `US$${value.toFixed(2)}`;

/** The alert email: what was crossed, what protection applies and how to look closer. */
export function alertEmail(
  alerts: BudgetAlert[],
  result: { projectedUsd: number; level: string; actions: string[] },
): BudgetEmail {
  return {
    subject: `Portifact budget: projected ${usd(result.projectedUsd)} this cycle (${result.level})`,
    text: [
      `Projected spend this cycle: ${usd(result.projectedUsd)}.`,
      `Level: ${result.level}.`,
      `Protection in effect: ${result.actions.length > 0 ? result.actions.join(", ") : "none"}.`,
      "",
      "New alerts:",
      ...alerts.map(
        (a) => `- ${a.kind} at ${usd(a.projectedUsd)} (${new Date(a.createdAt).toISOString()})`,
      ),
      "",
      "Details and override: bun run --cwd apps/jobs operator budget",
    ].join("\n"),
  };
}

function merge(d1: PlatformMetrics, measured: Partial<PlatformMetrics>): PlatformMetrics {
  const merged = { ...d1 };
  for (const [key, value] of Object.entries(measured) as [keyof PlatformMetrics, number][]) {
    if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
  }
  return merged;
}

/** One budget run. Analytics failures fall back to D1 and carried-forward counters. */
export async function runBudget(db: Db, now: number, deps: BudgetDeps): Promise<BudgetRunResult> {
  const cycle = budgetCycle(now);
  let metrics = await measurePlatformUsage(db, now);
  let analytics: AnalyticsStatus = "off";
  if (deps.analytics) {
    try {
      metrics = merge(metrics, await deps.analytics.collect({ start: cycle.start, end: now }));
      analytics = "ok";
    } catch (error) {
      analytics = "failed";
      // The collector's errors hold only a status or a count, never the token.
      console.error(JSON.stringify({ event: "budget_analytics_failed", error: String(error) }));
    }
  }
  const recorded = await recordBudgetMeasurement(db, { metrics, analytics, now });
  const result: BudgetRunResult = {
    level: recorded.effective.level,
    projectedUsd: recorded.assessment.projectedUsd,
    actions: recorded.effective.actions,
    analytics,
    newAlerts: recorded.newAlerts.map((alert) => alert.kind),
    notified: 0,
  };
  if (recorded.newAlerts.length > 0 || recorded.changed) {
    console.warn(JSON.stringify({ event: "budget_alert", ...result }));
  }
  if (deps.notifier) {
    const pending = await pendingBudgetAlerts(db, cycle.start);
    if (pending.length > 0) {
      try {
        await deps.notifier.send(alertEmail(pending, result));
        await markBudgetAlertsNotified(
          db,
          pending.map((alert) => alert.id),
          now,
        );
        result.notified = pending.length;
      } catch {
        // Left pending: the next run tries again. The provider error may echo the message.
        console.error(JSON.stringify({ event: "budget_email_failed", alerts: pending.length }));
      }
    }
  }
  return result;
}
