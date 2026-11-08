// Runs the maintenance jobs on a schedule. The jobs are idempotent and guard every transition,
// so overlapping or retried runs are safe.
import { createDb } from "@portifact/db";
import { runMaintenance } from "@portifact/services";

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
}

export async function runScheduled(env: Env, now: number) {
  const result = await runMaintenance(createDb(env.DB), env.ARTIFACTS, now);
  console.log(JSON.stringify({ event: "maintenance", ...result }));
  return result;
}

export default {
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
