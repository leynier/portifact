// The jobs Worker. Its schedule runs the maintenance scans (the safety net, and the scan that
// schedules expiry and comment notices, which the consumer emails), relays pending
// outbox rows to the `portifact-jobs` queue, reconciles a slice of storage with D1 and runs the
// budget run (alerts and automatic protection, plan section 12). Its queue consumer runs the
// relayed jobs (including the erasure of access logs in the separate access log database), and the
// schedule prunes access log entries past retention. The consumer of the `portifact-email-events`
// queue records the bounces and
// complaints Cloudflare Email Service reports. Every job is idempotent and guards every
// transition, so overlapping runs, retries and duplicate deliveries are safe.

import { BACKGROUND, DEFAULT_REGION, EmailSendingEvent, JobMessage } from "@portifact/contracts";
import {
  createAccessDb,
  type GlobalDb,
  type Region,
  type RegionHandles,
  regionsFromEnv,
  withRequestContext,
} from "@portifact/db";
import type { SuggestionsEnv } from "@portifact/domain";
import {
  CodedError,
  errorLabel,
  logEvent,
  logSummary,
  suggestionsEnabled,
} from "@portifact/domain";
import {
  checkCustomDomains,
  type DomainDeps,
  type DomainEnv,
  dohTxt,
  domainDbs,
  domainDepsFromEnv,
  type EmailDomainDeps,
  heldArtifactIds,
  maintainAuditStreams,
  PREVIEW_PRUNE,
  personalHandles,
  pruneAccessEvents,
  prunePreviewCodes,
  recheckEmailDomains,
  reconcileStorage,
  recordEmailEvent,
  relayOutbox,
  rewrapAuditStreamKeys,
  rewrapIntegrationKeys,
  rewrapWebhookKeys,
  runJob,
  runMaintenance,
  runRegionalMaintenance,
  stopWebhooksWhileOff,
  webhookKeys,
} from "@portifact/services";
import { type AnalyticsEnv, analyticsFromEnv, type Fetcher } from "./analytics.ts";
import { type NotifierEnv, notifierFromEnv, runBudget } from "./budget.ts";
import { type IntegrationEnv, integrationKeysFromEnv, issueDepsFromEnv } from "./integrations.ts";
import {
  commentNotifierFromEnv,
  commentRetentionNotifierFromEnv,
  directoryNotifierFromEnv,
  domainNotifierFromEnv,
  expiryNotifierFromEnv,
  graceNotifierFromEnv,
  moderationNotifierFromEnv,
  type NoticeEnv,
  reportOutcomeNotifierFromEnv,
  retentionNotifierFromEnv,
  reviewNotifierFromEnv,
} from "./notices.ts";
import {
  auditStreamDepsFromWebhooks,
  type Fetch,
  type WebhookEnv,
  webhookDepsFromEnv,
  webhooksEnabled,
} from "./webhooks.ts";

export interface Env
  extends AnalyticsEnv,
    NotifierEnv,
    NoticeEnv,
    DomainEnv,
    WebhookEnv,
    IntegrationEnv,
    SuggestionsEnv {
  DB: D1Database;
  /** The access log database (`portifact-access`): pruned here and erased by outbox jobs. */
  ACCESS_DB: D1Database;
  ARTIFACTS: R2Bucket;
  JOBS: Queue<JobMessage>;
  /** Required here: notices name `.dev` addresses and the DNS check needs the CNAME target. */
  CONTENT_DOMAIN: string;
}

/** Delay before a job that is not finished yet (an account with artifacts left) runs again. */
export const PENDING_RETRY_SECONDS = 120;
/** Delay before a job that failed runs again. */
export const FAILED_RETRY_SECONDS = 60;

/** The queue Cloudflare Email Service publishes `message.bounced` and `message.complained` to. */
export const EMAIL_EVENTS_QUEUE = "portifact-email-events";

/** Cloudflare's custom hostnames and DNS, or null while custom domains are switched off. */
export function domainsFromEnv(env: Env, fetcher: typeof fetch = fetch): DomainDeps | null {
  return domainDepsFromEnv(env, (input, init) => fetcher(input, init));
}

/** DNS over HTTPS for the daily re-check of workspace email domains (decision 0010). */
export function emailDomainsFromEnv(fetcher: typeof fetch = fetch): EmailDomainDeps {
  return { txt: dohTxt((input, init) => fetcher(input, init)) };
}

/** The schedule that only relays the outbox, every minute, so webhook deliveries go within minutes. */
export const RELAY_CRON = "* * * * *";

/** Relays pending outbox rows to the queue; a failure is logged and the rows wait for the next run. */
export async function runRelay(env: Env, now: number): Promise<number | "failed"> {
  // One outbox per database, never per region twice (decision 0005): the default region's is
  // also the global database's, and each other region's messages name their region.
  let relayed = 0;
  let failed = false;
  for (const handles of regionsFromEnv(env).all()) {
    try {
      relayed += (await relayOutbox(handles.db, env.JOBS, now, 5, handles.region)).relayed;
    } catch (error) {
      failed = true;
      logEvent("error", "outbox_relay_failed", {
        region: handles.region,
        error: errorLabel(error),
      });
    }
  }
  return failed ? "failed" : relayed;
}

/**
 * The every-minute prune of preview codes and their cached documents (decision 0027), in every
 * region, only while suggestions are switched on. It runs on the relay's schedule but in its own
 * `waitUntil`, so a failure of one never stops the other; a region that fails is logged and the
 * others go on.
 */
export async function runPreviewPrune(env: Env, now: number): Promise<number | "off" | "failed"> {
  if (!suggestionsEnabled(env)) return "off";
  let pruned = 0;
  let failed = false;
  for (const handles of regionsFromEnv(env).all()) {
    try {
      const done = await prunePreviewCodes(
        handles.db,
        bucketOf(handles),
        now,
        PREVIEW_PRUNE,
        handles.region,
      );
      pruned += done.documents + done.rows;
    } catch (error) {
      failed = true;
      logEvent("error", "preview_prune_failed", {
        region: handles.region,
        error: errorLabel(error),
      });
    }
  }
  return failed ? "failed" : pruned;
}

/** The bucket of a region, which every Worker that runs its jobs is bound to. */
function bucketOf(handles: RegionHandles): R2Bucket {
  if (!handles.bucket) throw new CodedError("BUCKET_NOT_BOUND");
  return handles.bucket;
}

/**
 * The maintenance run. The relay runs on its own one-minute schedule in production
 * (`relay: false` here); tests and a run by hand keep it.
 */
export async function runScheduled(
  env: Env,
  now: number,
  domains = domainsFromEnv(env),
  options: {
    relay?: boolean;
    /** DNS for the email domain re-check; without it (tests that do not need it) it is skipped. */
    emailDomains?: EmailDomainDeps | null;
  } = {},
) {
  // The scans run once per region, each on its own database and bucket; the global ones once,
  // with the default region, whose database is also the global one (decision 0005).
  const regions = regionsFromEnv(env);
  const db = personalHandles(regions).db;
  const maintenance = await runMaintenance(db, env.ARTIFACTS, now);
  const otherRegions: Record<string, Awaited<ReturnType<typeof runRegionalMaintenance>>> = {};
  for (const handles of regions.all()) {
    if (handles.region === DEFAULT_REGION) continue;
    otherRegions[handles.region] = await runRegionalMaintenance(
      handles.db,
      bucketOf(handles),
      now,
      handles.region,
    );
  }
  // Custom domains call Cloudflare and DNS: a failure must not hide the rest of the run.
  let customDomains: Awaited<ReturnType<typeof checkCustomDomains>> | "failed";
  try {
    customDomains = await checkCustomDomains(domainDbs(regions), domains, now);
  } catch (error) {
    customDomains = "failed";
    logEvent("error", "custom_domains_failed", { error: errorLabel(error) });
  }
  // Workspace email domains: a DNS failure is never a miss, and never hides the rest of the run.
  let emailDomains: Awaited<ReturnType<typeof recheckEmailDomains>> | "skipped" | "failed" =
    "skipped";
  if (options.emailDomains) {
    try {
      emailDomains = await recheckEmailDomains(regions.global, options.emailDomains, now);
    } catch (error) {
      emailDomains = "failed";
      logEvent("error", "email_domains_failed", { error: errorLabel(error) });
    }
  }
  // A queue outage must not stop the reconciliation; unsent rows stay pending for the next run.
  const relayed = options.relay === false ? "scheduled" : await runRelay(env, now);
  // Webhooks sealed with `WEBHOOK_KEY_PREVIOUS` move to the current key (docs/releasing.md).
  // Switched off: no webhook stays enabled, so writes record no events (decision 0009).
  const webhooksStopped = webhooksEnabled(env) ? 0 : await stopWebhooksWhileOff(db, now);
  const keys = await webhookKeys({ current: env.WEBHOOK_KEY, previous: env.WEBHOOK_KEY_PREVIOUS });
  const webhookKeyRotation = await rewrapWebhookKeys(db, keys);
  // Audit streams (decision 0019), in every region: re-sealed with the current key like webhooks,
  // and, only while streams are switched on, the log pruned and lost jobs given back (two D1
  // calls per region, whatever the number of owners).
  const auditStreams = { prunedDeliveries: 0, armed: 0, keysRewrapped: 0, keysLeft: 0 };
  for (const handles of regions.all()) {
    const rotated = await rewrapAuditStreamKeys(handles.db, keys);
    auditStreams.keysRewrapped += rotated.rewrapped;
    auditStreams.keysLeft += rotated.left;
    if (!webhooksEnabled(env)) continue;
    const done = await maintainAuditStreams(handles.db, now);
    auditStreams.prunedDeliveries += done.prunedDeliveries;
    auditStreams.armed += done.armed;
  }
  // Connection credentials sealed with `INTEGRATIONS_KEY_PREVIOUS` move to the current key, in
  // every region (decision 0018).
  const integrationKeys = await integrationKeysFromEnv(env);
  const integrationKeyRotation = { rewrapped: 0, left: 0 };
  for (const handles of regions.all()) {
    const rotated = await rewrapIntegrationKeys(handles.db, integrationKeys);
    integrationKeyRotation.rewrapped += rotated.rewrapped;
    integrationKeyRotation.left += rotated.left;
  }
  // Each bucket against its own database, findings in that region's table.
  const storage = await reconcileStorage(db, env.ARTIFACTS, now);
  for (const handles of regions.all()) {
    if (handles.region === DEFAULT_REGION) continue;
    const found = await reconcileStorage(handles.db, bucketOf(handles), now);
    for (const key of Object.keys(storage) as (keyof typeof storage)[]) {
      storage[key] += found[key];
    }
  }
  // Separate databases: a failure must not hide the rest of the run's result.
  let prunedAccessEvents: number | "failed" = 0;
  for (const handles of regions.all()) {
    try {
      const access = handles.accessDb ?? createAccessDb(env.ACCESS_DB);
      // A legal hold keeps its artifact's rows past their expiry (legal-holds.ts).
      const pruned = await pruneAccessEvents(access, now, 10, await heldArtifactIds(handles.db));
      if (prunedAccessEvents !== "failed") prunedAccessEvents += pruned;
    } catch (error) {
      prunedAccessEvents = "failed";
      logEvent("error", "access_log_prune_failed", {
        region: handles.region,
        error: errorLabel(error),
      });
    }
  }
  const result = {
    ...maintenance,
    ...(Object.keys(otherRegions).length > 0 ? { regions: otherRegions } : {}),
    relayed,
    storage,
    prunedAccessEvents,
    webhookKeysRewrapped: webhookKeyRotation.rewrapped,
    webhookKeysLeft: webhookKeyRotation.left,
    webhooksStopped,
    auditStreams,
    integrationKeysRewrapped: integrationKeyRotation.rewrapped,
    integrationKeysLeft: integrationKeyRotation.left,
    customDomains,
    emailDomains,
  };
  logSummary("log", "maintenance", result);
  return result;
}

/** The budget run with the collector and notifier the environment configures. */
export async function runScheduledBudget(
  env: Env,
  now: number,
  fetcher: Fetcher = (input, init) => fetch(input, init),
) {
  const result = await runBudget(regionsFromEnv(env), now, {
    analytics: analyticsFromEnv(env, fetcher),
    notifier: notifierFromEnv(env),
  });
  logSummary("log", "budget", result);
  return result;
}

/**
 * Records bounces and complaints. The event carries the recipient's address, so only the event
 * ID and the outcome are logged.
 */
export async function runEmailEvents(db: GlobalDb, batch: MessageBatch<unknown>, now: number) {
  for (const message of batch.messages) {
    const body = typeof message.body === "string" ? safeJson(message.body) : message.body;
    const parsed = EmailSendingEvent.safeParse(body);
    if (!parsed.success) {
      logEvent("error", "email_event_malformed", { messageId: message.id });
      message.ack();
      continue;
    }
    try {
      const outcome = await recordEmailEvent(db, parsed.data, now);
      message.ack();
      logEvent("log", "email_event", {
        type: emailEventKind(parsed.data.type),
        eventId: parsed.data.payload.eventId ?? null,
        outcome,
      });
    } catch (error) {
      logEvent("error", "email_event_failed", { error: errorLabel(error) });
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

/** An Email Service event's type as a log line may say it: Cloudflare's text is not logged. */
export function emailEventKind(type: string): "bounced" | "complained" | "other" {
  if (type.endsWith("message.bounced")) return "bounced";
  if (type.endsWith("message.complained")) return "complained";
  return "other";
}

export async function runQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  now: number,
  domains = domainsFromEnv(env),
  fetcher?: Fetch,
) {
  const regions = regionsFromEnv(env);
  if (batch.queue === EMAIL_EVENTS_QUEUE) return runEmailEvents(regions.global, batch, now);
  // Notices name artifacts only in the default region (decision 0005), so each job gets the
  // notifiers of its own region.
  const notifiers = (region: Region) => ({
    notifier: expiryNotifierFromEnv(env, region),
    commentNotifier: commentNotifierFromEnv(env, region),
    reviewNotifier: reviewNotifierFromEnv(env, region),
    graceNotifier: graceNotifierFromEnv(env, region),
    moderationNotifier: moderationNotifierFromEnv(env, region),
  });
  const domainNotifier = domainNotifierFromEnv(env);
  const directoryNotifier = directoryNotifierFromEnv(env);
  const retentionNotifier = retentionNotifierFromEnv(env);
  const commentRetentionNotifier = commentRetentionNotifierFromEnv(env);
  const reportOutcomeNotifier = reportOutcomeNotifierFromEnv(env);
  const webhooks = await webhookDepsFromEnv(env, fetcher);
  const auditStreams = auditStreamDepsFromWebhooks(webhooks);
  const issues = await issueDepsFromEnv(env, fetcher);
  const run = async (message: Message<unknown>) => {
    const parsed = JobMessage.safeParse(message.body);
    if (!parsed.success) {
      // Never retried: no delivery can make a malformed message valid.
      logEvent("error", "job_malformed", { messageId: message.id });
      message.ack();
      return;
    }
    try {
      // The job runs on the database its row is in, with that region's bucket and access log.
      const handles = regions.get(parsed.data.region ?? DEFAULT_REGION);
      const outcome = await runJob(handles.db, bucketOf(handles), parsed.data, now, {
        access: handles.accessDb ?? createAccessDb(env.ACCESS_DB),
        ...notifiers(handles.region),
        webhooks,
        auditStreams,
        issues,
        domains,
        domainNotifier,
        directoryNotifier,
        retentionNotifier,
        commentRetentionNotifier,
        reportOutcomeNotifier,
        regions,
        // Edit suggestions (decision 0027): their jobs wait while the switch is off.
        suggestions: { enabled: suggestionsEnabled(env), contentDomain: env.CONTENT_DOMAIN },
      });
      if (outcome === "pending") {
        message.retry({ delaySeconds: PENDING_RETRY_SECONDS });
      } else {
        message.ack();
      }
      logEvent("log", "job", {
        id: parsed.data.id,
        topic: parsed.data.topic,
        region: parsed.data.region,
        outcome,
      });
    } catch (error) {
      logEvent("error", "job_failed", {
        id: parsed.data.id,
        topic: parsed.data.topic,
        region: parsed.data.region,
        error: errorLabel(error),
      });
      message.retry({ delaySeconds: FAILED_RETRY_SECONDS });
    }
  };
  // Webhook deliveries, audit streams and issues wait on services outside Portifact: they run
  // concurrently with each other and alongside the rest of the batch, so a slow receiver never
  // delays a purge, a deletion or a notice in the same batch. The other jobs keep running one after another.
  const isDelivery = (message: Message<unknown>) => {
    const topic = JobMessage.safeParse(message.body).data?.topic;
    return topic === "webhook_delivery" || topic === "audit_stream" || topic === "thread_issue";
  };
  const deliveries = Promise.all(batch.messages.filter(isDelivery).map(run));
  for (const message of batch.messages.filter((m) => !isDelivery(m))) await run(message);
  await deliveries;
}

/**
 * Jobs and scans answer no client: request policies, applied to the request that asked for the
 * work, never bind them (decision 0020).
 */
const background = (env: Env): Env => withRequestContext(env, BACKGROUND);

export default {
  scheduled: (controller, workerEnv, ctx) => {
    const env = background(workerEnv);
    if (controller.cron === RELAY_CRON) {
      ctx.waitUntil(runRelay(env, controller.scheduledTime));
      ctx.waitUntil(runPreviewPrune(env, controller.scheduledTime));
      return;
    }
    ctx.waitUntil(
      runScheduled(env, controller.scheduledTime, domainsFromEnv(env), {
        relay: false,
        emailDomains: emailDomainsFromEnv(),
      }),
    );
    // Independent of maintenance: a failing scan must not stop the budget's protection.
    ctx.waitUntil(runScheduledBudget(env, controller.scheduledTime));
  },
  queue: (batch, env) => runQueue(batch, background(env), Date.now()),
} satisfies ExportedHandler<Env>;
