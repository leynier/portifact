// The jobs Worker. Its schedule runs the maintenance scans (the safety net), relays pending
// outbox rows to the `portifact-jobs` queue and reconciles a slice of storage with D1. Its queue
// consumer runs the relayed jobs. Every job is idempotent and guards every transition, so
// overlapping runs, retries and duplicate deliveries are safe.
import { JobMessage } from "@portifact/contracts";
import { createDb } from "@portifact/db";
import { reconcileStorage, relayOutbox, runJob, runMaintenance } from "@portifact/services";

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  JOBS: Queue<JobMessage>;
}

/** Delay before a job that is not finished yet (an account with artifacts left) runs again. */
export const PENDING_RETRY_SECONDS = 120;
/** Delay before a job that failed runs again. */
export const FAILED_RETRY_SECONDS = 60;

const errorName = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runScheduled(env: Env, now: number) {
  const db = createDb(env.DB);
  const maintenance = await runMaintenance(db, env.ARTIFACTS, now);
  // A queue outage must not stop the reconciliation; unsent rows stay pending for the next run.
  let relayed: number | "failed";
  try {
    relayed = (await relayOutbox(db, env.JOBS, now)).relayed;
  } catch (error) {
    relayed = "failed";
    console.error(JSON.stringify({ event: "outbox_relay_failed", error: errorName(error) }));
  }
  const storage = await reconcileStorage(db, env.ARTIFACTS, now);
  const result = { ...maintenance, relayed, storage };
  console.log(JSON.stringify({ event: "maintenance", ...result }));
  return result;
}

export async function runQueue(batch: MessageBatch<unknown>, env: Env, now: number) {
  const db = createDb(env.DB);
  for (const message of batch.messages) {
    const parsed = JobMessage.safeParse(message.body);
    if (!parsed.success) {
      // Never retried: no delivery can make a malformed message valid.
      console.error(JSON.stringify({ event: "job_malformed", messageId: message.id }));
      message.ack();
      continue;
    }
    try {
      const outcome = await runJob(db, env.ARTIFACTS, parsed.data, now);
      if (outcome === "pending") {
        message.retry({ delaySeconds: PENDING_RETRY_SECONDS });
      } else {
        message.ack();
      }
      console.log(JSON.stringify({ event: "job", ...parsed.data, outcome }));
    } catch (error) {
      console.error(
        JSON.stringify({ event: "job_failed", ...parsed.data, error: errorName(error) }),
      );
      message.retry({ delaySeconds: FAILED_RETRY_SECONDS });
    }
  }
}

export default {
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
  queue: (batch, env) => runQueue(batch, env, Date.now()),
} satisfies ExportedHandler<Env>;
