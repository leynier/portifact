// The jobs Worker. Its schedule runs the maintenance scans (the safety net), relays pending
// outbox rows to the `portifact-jobs` queue, reconciles a slice of storage with D1 and runs the
// budget run (alerts and automatic protection, plan section 12). Its queue consumer runs the
// relayed jobs (including the erasure of access logs in the separate access log database), and the
// schedule prunes access log entries past retention. The consumer of the `portifact-email-events`
// queue records the bounces and
// complaints Cloudflare Email Service reports. Every job is idempotent and guards every
// transition, so overlapping runs, retries and duplicate deliveries are safe.
import { EmailSendingEvent, JobMessage } from "@portifact/contracts";
import { createAccessDb, createDb, type Db } from "@portifact/db";
import {
  pruneAccessEvents,
  reconcileStorage,
  recordEmailEvent,
  relayOutbox,
  runJob,
  runMaintenance,
} from "@portifact/services";
import { type AnalyticsEnv, analyticsFromEnv, type Fetcher } from "./analytics.ts";
import { type NotifierEnv, notifierFromEnv, runBudget } from "./budget.ts";

export interface Env extends AnalyticsEnv, NotifierEnv {
  DB: D1Database;
  /** The access log database (`portifact-access`): pruned here and erased by outbox jobs. */
  ACCESS_DB: D1Database;
  ARTIFACTS: R2Bucket;
  JOBS: Queue<JobMessage>;
}

/** Delay before a job that is not finished yet (an account with artifacts left) runs again. */
export const PENDING_RETRY_SECONDS = 120;
/** Delay before a job that failed runs again. */
export const FAILED_RETRY_SECONDS = 60;

/** The queue Cloudflare Email Service publishes `message.bounced` and `message.complained` to. */
export const EMAIL_EVENTS_QUEUE = "portifact-email-events";

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
  // A separate database: its failure must not hide the rest of the run's result.
  let prunedAccessEvents: number | "failed";
  try {
    prunedAccessEvents = await pruneAccessEvents(createAccessDb(env.ACCESS_DB), now);
  } catch (error) {
    prunedAccessEvents = "failed";
    console.error(JSON.stringify({ event: "access_log_prune_failed", error: errorName(error) }));
  }
  const result = { ...maintenance, relayed, storage, prunedAccessEvents };
  console.log(JSON.stringify({ event: "maintenance", ...result }));
  return result;
}

/** The budget run with the collector and notifier the environment configures. */
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

/**
 * Records bounces and complaints. The event carries the recipient's address, so only the event
 * ID and the outcome are logged.
 */
export async function runEmailEvents(db: Db, batch: MessageBatch<unknown>, now: number) {
  for (const message of batch.messages) {
    const body = typeof message.body === "string" ? safeJson(message.body) : message.body;
    const parsed = EmailSendingEvent.safeParse(body);
    if (!parsed.success) {
      console.error(JSON.stringify({ event: "email_event_malformed", messageId: message.id }));
      message.ack();
      continue;
    }
    try {
      const outcome = await recordEmailEvent(db, parsed.data, now);
      message.ack();
      console.log(
        JSON.stringify({
          event: "email_event",
          type: parsed.data.type,
          eventId: parsed.data.payload.eventId ?? null,
          outcome,
        }),
      );
    } catch (error) {
      console.error(JSON.stringify({ event: "email_event_failed", error: errorName(error) }));
      message.retry({ delaySeconds: FAILED_RETRY_SECONDS });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function runQueue(batch: MessageBatch<unknown>, env: Env, now: number) {
  const db = createDb(env.DB);
  const access = createAccessDb(env.ACCESS_DB);
  if (batch.queue === EMAIL_EVENTS_QUEUE) return runEmailEvents(db, batch, now);
  for (const message of batch.messages) {
    const parsed = JobMessage.safeParse(message.body);
    if (!parsed.success) {
      // Never retried: no delivery can make a malformed message valid.
      console.error(JSON.stringify({ event: "job_malformed", messageId: message.id }));
      message.ack();
      continue;
    }
    try {
      const outcome = await runJob(db, env.ARTIFACTS, parsed.data, now, access);
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
    // Independent of maintenance: a failing scan must not stop the budget's protection.
    ctx.waitUntil(runScheduledBudget(env, controller.scheduledTime));
  },
  queue: (batch, env) => runQueue(batch, env, Date.now()),
} satisfies ExportedHandler<Env>;
