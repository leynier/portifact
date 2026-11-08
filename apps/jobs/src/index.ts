// Runs the maintenance jobs and the budget run on a schedule. The jobs are idempotent and guard
// every transition, so overlapping or retried runs are safe; the budget run upserts one state row
// and records each alert once per cycle.
import { createDb } from "@portifact/db";
import { runMaintenance } from "@portifact/services";
import { type AnalyticsEnv, analyticsFromEnv, type Fetcher } from "./analytics.ts";
import { type NotifierEnv, notifierFromEnv, runBudget } from "./budget.ts";

export interface Env extends AnalyticsEnv, NotifierEnv {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
}

export async function runScheduled(env: Env, now: number) {
  const result = await runMaintenance(createDb(env.DB), env.ARTIFACTS, now);
  console.log(JSON.stringify({ event: "maintenance", ...result }));
  return result;
}

/** The budget run with the collector and notifier the environment configures (none by default). */
export async function runScheduledBudget(
  env: Env,
  now: number,
  fetcher: Fetcher = (input, init) => fetch(input, init),
) {
  const result = await runBudget(createDb(env.DB), now, {
    analytics: analyticsFromEnv(env, fetcher),
    notifier: notifierFromEnv(env),
  });
  console.log(JSON.stringify({ event: "budget", ...result }));
  return result;
}

export default {
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
    ctx.waitUntil(runScheduledBudget(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
