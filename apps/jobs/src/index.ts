// The jobs Worker. Its schedule runs the maintenance scans (the safety net, and the scan that
// schedules expiry and comment notices, which the consumer emails), relays pending
// outbox rows to the `portifact-jobs` queue, reconciles a slice of storage with D1 and runs the
// budget run (alerts and automatic protection, plan section 12). Its queue consumer runs the
// relayed jobs (including the erasure of access logs in the separate access log database), and the
// schedule prunes access log entries past retention. The consumer of the `portifact-email-events`
// queue records the bounces and
// complaints Cloudflare Email Service reports. Every job is idempotent and guards every
// transition, so overlapping runs, retries and duplicate deliveries are safe.
import { EmailSendingEvent, JobMessage } from "@portifact/contracts";
import { createAccessDb, type Db, regionsFromEnv } from "@portifact/db";
import {
  personalHandles,
  pruneAccessEvents,
  reconcileStorage,
  recordEmailEvent,
  relayOutbox,
  rewrapWebhookKeys,
  runJob,
  runMaintenance,
  webhookKeys,
} from "@portifact/services";
import { type AnalyticsEnv, analyticsFromEnv, type Fetcher } from "./analytics.ts";
import { type NotifierEnv, notifierFromEnv, runBudget } from "./budget.ts";
import { commentNotifierFromEnv, expiryNotifierFromEnv, type NoticeEnv } from "./notices.ts";
import { type Fetch, type WebhookEnv, webhookDepsFromEnv } from "./webhooks.ts";

export interface Env extends AnalyticsEnv, NotifierEnv, NoticeEnv, WebhookEnv {
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

/** The schedule that only relays the outbox, every minute, so webhook deliveries go within minutes. */
export const RELAY_CRON = "* * * * *";

/** Relays pending outbox rows to the queue; a failure is logged and the rows wait for the next run. */
export async function runRelay(env: Env, now: number): Promise<number | "failed"> {
  const db = personalHandles(regionsFromEnv(env)).db;
  try {
    return (await relayOutbox(db, env.JOBS, now)).relayed;
  } catch (error) {
    console.error(JSON.stringify({ event: "outbox_relay_failed", error: errorName(error) }));
    return "failed";
  }
}

/**
 * The maintenance run. The relay runs on its own one-minute schedule in production
 * (`relay: false` here); tests and a run by hand keep it.
 */
export async function runScheduled(env: Env, now: number, options: { relay?: boolean } = {}) {
  // One region for now; with a second (E5) the scans run once per region (decision 0005).
  const db = personalHandles(regionsFromEnv(env)).db;
  const maintenance = await runMaintenance(db, env.ARTIFACTS, now);
  // A queue outage must not stop the reconciliation; unsent rows stay pending for the next run.
  const relayed = options.relay === false ? "scheduled" : await runRelay(env, now);
  // Webhooks sealed with `WEBHOOK_KEY_PREVIOUS` move to the current key (docs/releasing.md).
  const webhookKeyRotation = await rewrapWebhookKeys(
    db,
    await webhookKeys({ current: env.WEBHOOK_KEY, previous: env.WEBHOOK_KEY_PREVIOUS }),
  );
  const storage = await reconcileStorage(db, env.ARTIFACTS, now);
  // A separate database: its failure must not hide the rest of the run's result.
  let prunedAccessEvents: number | "failed";
  try {
    prunedAccessEvents = await pruneAccessEvents(createAccessDb(env.ACCESS_DB), now);
  } catch (error) {
    prunedAccessEvents = "failed";
    console.error(JSON.stringify({ event: "access_log_prune_failed", error: errorName(error) }));
  }
  const result = {
    ...maintenance,
    relayed,
    storage,
    prunedAccessEvents,
    webhookKeysRewrapped: webhookKeyRotation.rewrapped,
    webhookKeysLeft: webhookKeyRotation.left,
  };
  console.log(JSON.stringify({ event: "maintenance", ...result }));
  return result;
}

/** The budget run with the collector and notifier the environment configures. */
export async function runScheduledBudget(
  env: Env,
  now: number,
  fetcher: Fetcher = (input, init) => fetch(input, init),
) {
  const result = await runBudget(regionsFromEnv(env).global, now, {
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

export async function runQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  now: number,
  fetcher?: Fetch,
) {
  const db = personalHandles(regionsFromEnv(env)).db;
  const access = createAccessDb(env.ACCESS_DB);
  if (batch.queue === EMAIL_EVENTS_QUEUE) return runEmailEvents(db, batch, now);
  const notifier = expiryNotifierFromEnv(env);
  const commentNotifier = commentNotifierFromEnv(env);
  const webhooks = await webhookDepsFromEnv(env, fetcher);
  for (const message of batch.messages) {
    const parsed = JobMessage.safeParse(message.body);
    if (!parsed.success) {
      // Never retried: no delivery can make a malformed message valid.
      console.error(JSON.stringify({ event: "job_malformed", messageId: message.id }));
      message.ack();
      continue;
    }
    try {
      const outcome = await runJob(db, env.ARTIFACTS, parsed.data, now, {
        access,
        notifier,
        commentNotifier,
        webhooks,
      });
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
    if (controller.cron === RELAY_CRON) {
      ctx.waitUntil(runRelay(env, controller.scheduledTime));
      return;
    }
    ctx.waitUntil(runScheduled(env, controller.scheduledTime, { relay: false }));
    // Independent of maintenance: a failing scan must not stop the budget's protection.
    ctx.waitUntil(runScheduledBudget(env, controller.scheduledTime));
  },
  queue: (batch, env) => runQueue(batch, env, Date.now()),
} satisfies ExportedHandler<Env>;
