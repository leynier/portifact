// Webhooks (premium plan P6, decision 0009): the admins of an owner manage HTTPS destinations that
// receive events about the owner's artifacts, and the jobs Worker delivers them. The rules are in
// packages/domain/src/webhooks.ts; writes record events through webhook-activity.ts.
import {
  type AccessMode,
  ApprovalSummary,
  type AuditDetail,
  isServiceTokenId,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_EVENT,
  type WebhookCreate,
  type WebhookDeliveryBody,
  type WebhookDisabledReason,
  type WebhookEventBody,
  type WebhookEventType,
  type WebhookFormat,
  WebhookJobPayload,
  type WebhookState,
  type WebhookUpdate,
} from "@portifact/contracts";
import { bothSides, type Db, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  bitsToEvents,
  checkReenable,
  checkWebhookUrl,
  classifyAttempt,
  dailyCapReached,
  disableThreshold,
  type Entitlements,
  entitlements,
  eventsToBits,
  fail,
  hasFeature,
  nextAttemptAt,
  ok,
  type Result,
  renderDelivery,
  requireFeature,
  utcDayStart,
} from "@portifact/domain";
import { and, desc, eq, gte, inArray, lt, lte, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ownerSide } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { platformProtection } from "./budget.ts";
import { closeJobs, type JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";
import { deliveryJobs, markWebhookTest, noFreshJob, WEBHOOK_FEATURE } from "./webhook-activity.ts";
import {
  newWebhookSecret,
  open,
  seal,
  signWebhook,
  WebhookKeyUnavailableError,
  type webhookKeys,
} from "./webhook-keys.ts";

type Keys = Awaited<ReturnType<typeof webhookKeys>>;
type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

const w = schema.webhooks;
const we = schema.webhookEvents;
const wd = schema.webhookDeliveries;
const o = schema.outbox;

const missing = () => fail<never>("not_found", "Webhook not found.");

export interface WebhookAttemptRecord {
  deliveryId: string;
  attempt: number;
  at: number;
  outcome: "delivered" | "failed" | "skipped";
  status: number | null;
  error: string | null;
}

export interface WebhookRecord {
  id: string;
  host: string;
  format: WebhookFormat;
  events: WebhookEventType[];
  state: WebhookState;
  disabledReason: WebhookDisabledReason | null;
  disabledAt: number | null;
  failures: number;
  createdAt: number;
  createdVia: string;
  createdBy: string | null;
  probation: boolean;
  lastAttempt: WebhookAttemptRecord | null;
}

type WebhookRow = typeof w.$inferSelect;

function hexId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function attemptRecord(row: typeof wd.$inferSelect): WebhookAttemptRecord {
  return {
    deliveryId: row.deliveryId,
    attempt: row.attempt,
    at: row.at,
    outcome: row.outcome,
    status: row.status,
    error: row.error,
  };
}

function record(
  row: WebhookRow,
  available: boolean,
  last: WebhookAttemptRecord | null,
  names: ReadonlyMap<string, string> = new Map(),
): WebhookRecord {
  return {
    id: row.id,
    host: row.host,
    format: row.format,
    events: bitsToEvents(row.events),
    state: row.disabledAt !== null ? "disabled" : available ? "active" : "paused",
    disabledReason: row.disabledReason,
    disabledAt: row.disabledAt,
    failures: row.failures,
    createdAt: row.createdAt,
    createdVia: row.createdVia,
    createdBy: row.createdBy === null ? null : (names.get(row.createdBy) ?? null),
    probation: row.probation,
    lastAttempt: last,
  };
}

/** Display names of the accounts that created webhooks, from the global users table. */
async function creatorNames(db: RegionalDb, rows: readonly WebhookRow[]) {
  const ids = [...new Set(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])))];
  if (ids.length === 0) return new Map<string, string>();
  const users = await db.global
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(users.map((user) => [user.id, user.name]));
}

/** Whether Portifact delivers webhooks at all (`WEBHOOKS_ENABLED`, decision 0009). */
export interface WebhookService {
  enabled: boolean;
}

export const WEBHOOKS_UNAVAILABLE = "Webhooks are not available yet.";

const unavailable = () => fail<never>("capacity_unavailable", WEBHOOKS_UNAVAILABLE);

/**
 * Counts one action in a fixed window of the `rate_limits` counters (one upsert, so concurrent
 * requests cannot both take the last slot) and returns the count, this one included. The counter
 * is keyed by owner, so removing and creating webhooks never resets it.
 */
async function countAction(db: RegionalDb, key: string, windowMs: number, now: number) {
  const [row] = await db.global.all<{ count: number }>(
    sql`insert into rate_limits (key, window_start, count) values (${key}, ${now}, 1) on conflict (key) do update set count = case when window_start <= ${now} - ${windowMs} then 1 else count + 1 end, window_start = case when window_start <= ${now} - ${windowMs} then ${now} else window_start end returning count`,
  );
  return Number(row?.count ?? 0);
}

const HOUR_MS = 3_600_000;

async function ownerLimit(
  db: RegionalDb,
  action: "create" | "test" | "enable",
  ownerId: string,
  now: number,
): Promise<Result<true>> {
  const [windowMs, max, what] =
    action === "create"
      ? [86_400_000, WEBHOOK_LIMITS.createsPerOwnerPerDay, "webhooks can be created a day"]
      : action === "test"
        ? [HOUR_MS, WEBHOOK_LIMITS.testsPerOwnerPerHour, "test events can be sent an hour"]
        : [86_400_000, WEBHOOK_LIMITS.enablesPerOwnerPerDay, "webhooks can be enabled a day"];
  const count = await countAction(db, `webhook:${action}:${ownerId}`, windowMs, now);
  return count > max ? fail("rate_limited", `At most ${max} ${what}. Try again later.`) : ok(true);
}

async function lastAttempts(db: RegionalDb, ids: string[]) {
  if (ids.length === 0) return new Map<string, WebhookAttemptRecord>();
  const rows = await db
    .select()
    .from(wd)
    .where(
      inArray(
        wd.id,
        db
          .select({ id: sql<number>`max(${wd.id})` })
          .from(wd)
          .where(inArray(wd.webhookId, ids))
          .groupBy(wd.webhookId),
      ),
    );
  return new Map(rows.map((row) => [row.webhookId, attemptRecord(row)]));
}

/** The actor's webhook, or `not_found` for anyone else's. */
async function owned(db: RegionalDb, actor: Actor, webhookId: string) {
  const [row] = await db
    .select()
    .from(w)
    .where(and(eq(w.id, webhookId), eq(w.ownerId, actor.ownerId)))
    .limit(1);
  return row;
}

async function present(db: RegionalDb, row: WebhookRow, owner: Entitlements) {
  const last = await lastAttempts(db, [row.id]);
  const names = await creatorNames(db, [row]);
  return record(row, hasFeature(owner, WEBHOOK_FEATURE), last.get(row.id) ?? null, names);
}

export interface WebhookListing {
  webhooks: WebhookRecord[];
  available: boolean;
  serviceAvailable: boolean;
  limit: number;
}

/** The owner's webhooks, oldest first. Never gated: reading what exists is never behind a plan. */
export async function listWebhooks(
  db: RegionalDb,
  input: { actor: Actor; service: WebhookService; now: number },
): Promise<Result<WebhookListing>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const owner = await ownerEntitlements(db.global, input.actor.ownerId, input.now);
  const available = hasFeature(owner, WEBHOOK_FEATURE);
  const rows = await db
    .select()
    .from(w)
    .where(eq(w.ownerId, input.actor.ownerId))
    .orderBy(w.createdAt, w.id);
  const last = await lastAttempts(
    db,
    rows.map((row) => row.id),
  );
  const names = await creatorNames(db, rows);
  return ok({
    webhooks: rows.map((row) => record(row, available, last.get(row.id) ?? null, names)),
    available,
    serviceAvailable: input.service.enabled,
    limit: WEBHOOK_LIMITS.perOwner,
  });
}

/** The audit event of a webhook change, in its batch on `condition`. */
function webhookEvent<K extends "webhook.created" | "webhook.changed" | "webhook.removed">(
  db: Db,
  actor: Actor,
  webhookId: string,
  kind: K,
  input: { detail: AuditDetail<K>; now: number; condition: SQL },
) {
  return auditEvent(
    db,
    {
      ownerId: actor.ownerId,
      kind,
      actor: { type: "user", id: actor.userId },
      targetId: webhookId,
      detail: input.detail,
      now: input.now,
    },
    input.condition,
  );
}

/** Creates a webhook; the secret (generic only) is returned here and never again. */
export async function createWebhook(
  db: RegionalDb,
  input: {
    actor: Actor;
    webhook: WebhookCreate;
    keys: Keys;
    service: WebhookService;
    /** `dashboard`, or the OAuth client making the request. */
    via: string;
    now: number;
  },
): Promise<Result<{ webhook: WebhookRecord; secret: string | null }>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  if (!input.service.enabled) return unavailable();
  const ownerId = input.actor.ownerId;
  const owner = requireFeature(
    await ownerEntitlements(db.global, ownerId, input.now),
    WEBHOOK_FEATURE,
  );
  if (!owner.ok) return owner;
  const checked = checkWebhookUrl(input.webhook.url, input.webhook.format);
  if (!checked.ok) return checked;
  const [key] = input.keys;
  if (!key) return unavailable();
  const limited = await ownerLimit(db, "create", ownerId, input.now);
  if (!limited.ok) return limited;
  const id = hexId("wh_");
  const secret = input.webhook.format === "generic" ? newWebhookSecret() : null;
  const urlBox = await seal(key, id, "url", checked.value.url);
  const secretBox = secret === null ? null : await seal(key, id, "secret", secret);
  // Columns in schema order: id, owner, host, format, events, key, url, secret, created,
  // disabled, reason, failures, probation, re-enables, re-enable day, created by, created via.
  // The count keeps concurrent creates under the cap.
  const [inserted] = await db.batch([
    db
      .insert(w)
      .select(
        sql`select ${id}, ${ownerId}, ${checked.value.host}, ${input.webhook.format}, ${eventsToBits(input.webhook.events)}, ${key.id}, ${urlBox}, ${secretBox}, ${input.now}, null, null, 0, 0, 0, null, ${input.actor.userId}, ${input.via} where (select count(*) from ${w} where ${w.ownerId} = ${ownerId}) < ${WEBHOOK_LIMITS.perOwner}`,
      )
      .returning(),
    // After the insert, on the webhook it created: only the host, never the URL or the secret.
    webhookEvent(db, input.actor, id, "webhook.created", {
      detail: {
        host: checked.value.host,
        format: input.webhook.format,
        events: [...input.webhook.events],
      },
      now: input.now,
      condition: sql`exists (select 1 from ${w} where ${w.id} = ${id})`,
    }),
  ]);
  const [row] = inserted;
  if (!row) {
    return fail(
      "quota_exceeded",
      `An owner can have at most ${WEBHOOK_LIMITS.perOwner} webhooks. Remove one to add another.`,
    );
  }
  const names = await creatorNames(db, [row]);
  return ok({ webhook: record(row, true, null, names), secret });
}

/**
 * Enables or disables a webhook, or changes its events. Enabling resets the failures and needs
 * the feature, as does any change that leaves it enabled; disabling never does.
 */
export async function updateWebhook(
  db: RegionalDb,
  input: {
    actor: Actor;
    webhookId: string;
    update: WebhookUpdate;
    service: WebhookService;
    now: number;
  },
): Promise<Result<WebhookRecord>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.webhookId);
  if (!row) return missing();
  const enabled = input.update.enabled ?? row.disabledAt === null;
  const owner = await ownerEntitlements(db.global, input.actor.ownerId, input.now);
  if (enabled) {
    if (!input.service.enabled) return unavailable();
    const gate = requireFeature(owner, WEBHOOK_FEATURE);
    if (!gate.ok) return gate;
  }
  const change: Partial<typeof w.$inferInsert> = {};
  // Only what differs is a change: the same events again write nothing and record nothing.
  const events = input.update.events ? eventsToBits(input.update.events) : row.events;
  if (events !== row.events) change.events = events;
  const reenabling = input.update.enabled === true && row.disabledAt !== null;
  if (reenabling) {
    const day = utcDayStart(input.now);
    const allowedAgain = checkReenable({
      disabledReason: row.disabledReason,
      disabledAt: row.disabledAt,
      reenablesToday: row.reenableDay === day ? row.reenables : 0,
      now: input.now,
    });
    if (!allowedAgain.ok) return allowedAgain;
    const limited = await ownerLimit(db, "enable", input.actor.ownerId, input.now);
    if (!limited.ok) return limited;
    // On probation until its next success: a few failures disable it again.
    Object.assign(change, {
      disabledAt: null,
      disabledReason: null,
      failures: 0,
      probation: true,
      reenables: row.reenableDay === day ? row.reenables + 1 : 1,
      reenableDay: day,
    });
  }
  const disabling = input.update.enabled === false && row.disabledAt === null;
  if (disabling) Object.assign(change, { disabledAt: input.now, disabledReason: "manual" });
  if (Object.keys(change).length === 0) return ok(await present(db, row, owner));
  // Conditioned on the state read, so two enables at once count once.
  const where = and(
    eq(w.id, row.id),
    eq(w.ownerId, input.actor.ownerId),
    reenabling ? sql`${w.disabledAt} is not null` : undefined,
    // Two disables at once are one change and one event.
    disabling ? sql`${w.disabledAt} is null` : undefined,
  ) as SQL;
  const changedEvents = change.events !== undefined ? input.update.events : null;
  const [, [updated]] = await db.batch([
    webhookEvent(db, input.actor, row.id, "webhook.changed", {
      detail: {
        ...("disabledAt" in change ? { enabled: change.disabledAt === null } : {}),
        ...(changedEvents ? { events: [...changedEvents] } : {}),
      },
      now: input.now,
      condition: sql`exists (select 1 from ${w} where ${where})`,
    }),
    db.update(w).set(change).where(where).returning(),
  ]);
  if (updated) return ok(await present(db, updated, owner));
  // A concurrent request made the same change first: answer the webhook as it is now.
  const current = await owned(db, input.actor, input.webhookId);
  return current ? ok(await present(db, current, owner)) : missing();
}

/**
 * Removes a webhook with its pending events and log, and writes its tombstone in the same batch so
 * a restored backup cannot bring the destination back. Never gated.
 */
export async function removeWebhook(
  db: RegionalDb,
  input: { actor: Actor; webhookId: string; now: number },
): Promise<Result<{ webhookId: string }>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const mine = sql`exists (select 1 from ${w} where ${w.id} = ${input.webhookId} and ${w.ownerId} = ${input.actor.ownerId})`;
  // With one database the tombstone rides the batch on the same condition, as it always has.
  // With a separate one it is written globally first, once the webhook is known to be the
  // owner's, so a restore never brings back a webhook whose removal it lost (decision 0005).
  const both = bothSides(db);
  const tombstone = (target: Db, condition: SQL) =>
    target
      .insert(schema.tombstones)
      .select(sql`select 'webhook', ${input.webhookId}, ${input.now} where ${condition}`)
      .onConflictDoNothing();
  if (!both) {
    if (!(await owned(db, input.actor, input.webhookId))) return missing();
    await tombstone(db.global, sql`1`);
  }
  const target = both ?? db;
  const removal = target
    .delete(w)
    .where(and(eq(w.id, input.webhookId), eq(w.ownerId, input.actor.ownerId)))
    .returning({ id: w.id });
  const results = await target.batch([
    webhookEvent(target, input.actor, input.webhookId, "webhook.removed", {
      detail: {},
      now: input.now,
      condition: mine,
    }),
    ...(both ? [tombstone(both, mine)] : []),
    closeJobs(target, "webhook_delivery", input.webhookId, mine),
    removal,
  ]);
  const deleted = results.at(-1) as { id: string }[];
  return deleted.length === 1 ? ok({ webhookId: input.webhookId }) : missing();
}

/** Queues a test event for an enabled webhook; it goes with the next delivery, without waiting. */
export async function sendTestEvent(
  db: RegionalDb,
  input: { actor: Actor; webhookId: string; service: WebhookService; now: number },
): Promise<Result<{ webhookId: string }>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.webhookId);
  if (!row) return missing();
  if (!input.service.enabled) return unavailable();
  const gate = requireFeature(
    await ownerEntitlements(db.global, input.actor.ownerId, input.now),
    WEBHOOK_FEATURE,
  );
  if (!gate.ok) return gate;
  if (row.disabledAt !== null) {
    return fail("invalid_input", "This webhook is disabled. Enable it before sending a test.");
  }
  const limited = await ownerLimit(db, "test", input.actor.ownerId, input.now);
  if (!limited.ok) return limited;
  const [first, ...rest] = markWebhookTest(db, {
    webhookId: row.id,
    ownerId: input.actor.ownerId,
    actorId: input.actor.userId,
    now: input.now,
  });
  if (first) await db.batch([first, ...rest]);
  return ok({ webhookId: row.id });
}

/** The webhook's attempts of the last 7 days, newest first. Never gated. */
export async function listWebhookDeliveries(
  db: RegionalDb,
  input: { actor: Actor; webhookId: string; now: number },
): Promise<Result<WebhookAttemptRecord[]>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.webhookId);
  if (!row) return missing();
  const rows = await db
    .select()
    .from(wd)
    .where(
      and(eq(wd.webhookId, row.id), gte(wd.at, input.now - WEBHOOK_LIMITS.logDays * 86_400_000)),
    )
    .orderBy(desc(wd.id))
    .limit(WEBHOOK_LIMITS.logPageSize);
  return ok(rows.map(attemptRecord));
}

/** The owner's webhooks for the account export: no URL and no secret. */
export async function exportWebhooks(db: RegionalDb, ownerId: string) {
  const rows = await db.select().from(w).where(eq(w.ownerId, ownerId)).orderBy(w.createdAt);
  return rows.map((row) => ({
    id: row.id,
    host: row.host,
    format: row.format,
    events: bitsToEvents(row.events),
    disabled: row.disabledAt !== null,
    disabledReason: row.disabledReason,
    createdAt: new Date(row.createdAt).toISOString(),
    createdVia: row.createdVia,
  }));
}

// Delivery

/** What delivering needs besides D1: the keys, the network and the origins links use. */
export interface WebhookDeps {
  keys: Keys;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  appOrigin: string;
  contentDomain: string;
  /** `WEBHOOKS_ENABLED`: without it nothing is delivered (decision 0009, "Switched off"). */
  enabled: boolean;
  /** The emergency stop (`WEBHOOKS_PAUSED` on the jobs Worker). */
  paused?: boolean | undefined;
  /** Defaults to `WEBHOOK_LIMITS.timeoutMs`. */
  timeoutMs?: number | undefined;
}

type OutboxRow = typeof o.$inferSelect;
type Delivery = Extract<WebhookJobPayload, { delivery: unknown }>;

const DAY_MS = 86_400_000;

/** Moves the job to `at`, keeping its payload, for the relay to send again then. */
function reschedule(db: RegionalDb, row: OutboxRow, at: number) {
  return db.update(o).set({ availableAt: at, dispatchedAt: null }).where(eq(o.id, row.id));
}

/**
 * A webhook with its owner's plan row: one joined read with one database (as always), the
 * webhook regionally then the plan globally with a separate one.
 */
async function webhookWithPlan(db: RegionalDb, webhookId: string) {
  const planColumns = {
    plan: schema.ownerPlans.plan,
    seats: schema.ownerPlans.seats,
    validUntil: schema.ownerPlans.validUntil,
    overrides: schema.ownerPlans.overrides,
  };
  const both = bothSides(db);
  if (both) {
    const [hook] = await both
      .select({ webhook: w, plan: planColumns })
      .from(w)
      .leftJoin(schema.ownerPlans, eq(schema.ownerPlans.ownerId, w.ownerId))
      .where(eq(w.id, webhookId))
      .limit(1);
    return hook;
  }
  const [webhook] = await db.select().from(w).where(eq(w.id, webhookId)).limit(1);
  if (!webhook) return undefined;
  const [plan] = await db.global
    .select(planColumns)
    .from(schema.ownerPlans)
    .where(eq(schema.ownerPlans.ownerId, webhook.ownerId))
    .limit(1);
  return { webhook, plan: plan ?? null };
}

/**
 * Runs one `webhook_delivery` job (decision 0009, "Delivering"). Returns `done` when the job's
 * row may go, `stale` when the webhook no longer delivers, and `kept` when the job moved itself
 * to later or another run owns the attempt.
 */
export async function deliverWebhook(
  db: RegionalDb,
  row: OutboxRow,
  now: number,
  deps: WebhookDeps,
): Promise<JobOutcome> {
  const webhookId = row.subject ?? "";
  const hook = await webhookWithPlan(db, webhookId);
  if (!hook) return "done";
  // A duplicate message before the job's time (a retry not due yet) does nothing.
  if (row.availableAt > now) return "kept";
  const webhook = hook.webhook;
  const parsed = WebhookJobPayload.safeParse(row.payload);
  const job: Delivery | null =
    parsed.success && "delivery" in parsed.data ? (parsed.data as Delivery) : null;
  // Switched off, a stopped webhook or a plan without the feature: nothing is sent or kept.
  if (
    !deps.enabled ||
    webhook.disabledAt !== null ||
    !hasFeature(entitlements(hook.plan, now), WEBHOOK_FEATURE)
  ) {
    if (!job) await db.delete(we).where(eq(we.webhookId, webhook.id));
    return "stale";
  }
  const protection = await platformProtection(db.global, now);
  if (deps.paused || protection.actions.includes("block_uploads")) {
    await reschedule(db, row, now + WEBHOOK_LIMITS.pausedRetryMs);
    return "kept";
  }
  const claimed = job
    ? await claimAttempt(db, row, job, now)
    : await claimEvents(db, row, webhook, now, deps);
  if (claimed === "done" || claimed === "kept") return claimed;
  // The daily cap: one atomic count per owner and UTC day, taken before the send and kept when a
  // webhook is removed, so concurrent consumers and recreated webhooks cannot pass it.
  const day = utcDayStart(now);
  const attempts = await countAction(
    db,
    `webhook:attempts:${webhook.ownerId}:${day}`,
    2 * DAY_MS,
    now,
  );
  if (dailyCapReached(attempts - 1)) {
    const noted = sql`exists (select 1 from ${wd} where ${wd.webhookId} = ${webhook.id} and ${wd.at} >= ${day} and ${wd.error} = 'daily_cap')`;
    await db.batch([
      db
        .insert(wd)
        .select(
          sql`select null, ${webhook.id}, ${webhook.ownerId}, ${claimed.delivery.id}, ${claimed.attempt}, ${now}, 'skipped', null, 'daily_cap' where not ${noted}`,
        ),
      db
        .update(o)
        .set({
          payload: { ...claimed, startedAt: null },
          availableAt: day + DAY_MS,
          dispatchedAt: null,
        })
        .where(eq(o.id, row.id)),
    ]);
    return "kept";
  }
  return attempt(db, row, webhook, claimed, now, deps);
}

/** Takes the attempt of a delivery that is already claimed, unless another run holds it. */
async function claimAttempt(
  db: RegionalDb,
  row: OutboxRow,
  job: Delivery,
  now: number,
): Promise<Delivery | "kept"> {
  const taken = await db
    .update(o)
    .set({ payload: sql`json_set(${o.payload}, '$.startedAt', ${now})` })
    .where(
      and(
        eq(o.id, row.id),
        sql`json_extract(${o.payload}, '$.attempt') = ${job.attempt}`,
        // Only once the attempt is due: a retry waits for its backoff whatever delivers it.
        lte(o.availableAt, now),
        sql`coalesce(json_extract(${o.payload}, '$.startedAt'), 0) < ${now - WEBHOOK_LIMITS.attemptStaleMs}`,
      ),
    )
    .returning({ id: o.id });
  return taken.length === 1 ? { ...job, startedAt: now } : "kept";
}

/**
 * Turns up to `eventsPerDelivery` pending rows into the job's delivery, subtracting the claimed
 * counts in the same batch, conditioned on this run's claim. Activity that arrives meanwhile keeps
 * its own counts; if any is left, it gets a job of its own.
 */
async function claimEvents(
  db: RegionalDb,
  row: OutboxRow,
  webhook: WebhookRow,
  now: number,
  deps: WebhookDeps,
): Promise<Delivery | "done" | "kept"> {
  const pending = await db
    .select()
    .from(we)
    .where(eq(we.webhookId, webhook.id))
    .orderBy(we.firstAt, we.artifactId, we.type)
    .limit(WEBHOOK_LIMITS.eventsPerDelivery);
  if (pending.length === 0) return "done";
  const events = await eventBodies(db, webhook.ownerId, pending, deps);
  const deliveryId = hexId("whd_");
  const job: Delivery = {
    delivery: {
      id: deliveryId,
      webhookId: webhook.id,
      createdAt: new Date(now).toISOString(),
      test: events.some((event) => event.type === WEBHOOK_TEST_EVENT),
      events,
    },
    attempt: 1,
    startedAt: now,
  };
  // The claim: this run's delivery ID in the job's payload, or the marker of a job whose events
  // all concerned artifacts that are gone (nothing to send, the counts still go).
  const mine = sql`exists (select 1 from ${o} where ${o.id} = ${row.id} and coalesce(json_extract(${o.payload}, '$.delivery.id'), json_extract(${o.payload}, '$.discarded')) = ${deliveryId})`;
  const statements: Batch = [
    db
      .update(o)
      .set({ payload: events.length > 0 ? job : { discarded: deliveryId } })
      .where(and(eq(o.id, row.id), sql`${o.payload} = '{}'`, lte(o.availableAt, now)))
      .returning({ id: o.id }),
    ...pending.map((event) =>
      db
        .update(we)
        .set({ count: sql`${we.count} - ${event.count}` })
        .where(
          and(
            eq(we.webhookId, webhook.id),
            eq(we.artifactId, event.artifactId),
            eq(we.type, event.type),
            mine,
          ),
        ),
    ),
    db.delete(we).where(and(eq(we.webhookId, webhook.id), sql`${we.count} <= 0`, mine)),
    // What arrived after the read has no job of its own yet: this one is no longer waiting.
    deliveryJobs(
      db,
      sql`${w.id} = ${webhook.id} and exists (select 1 from ${we} where ${we.webhookId} = ${webhook.id}) and ${mine}`,
      now + WEBHOOK_LIMITS.coalesceMs,
      now,
    ),
  ];
  const [won] = (await db.batch(statements)) as [{ id: number }[]];
  if (won.length !== 1) return "kept";
  return events.length > 0 ? job : "done";
}

/** The generic events for pending rows: artifacts that are gone are left out. */
async function eventBodies(
  db: RegionalDb,
  ownerId: string,
  pending: (typeof we.$inferSelect)[],
  deps: WebhookDeps,
): Promise<WebhookEventBody[]> {
  const a = schema.artifacts;
  const artifactIds = [...new Set(pending.map((event) => event.artifactId).filter(Boolean))];
  const artifacts = new Map(
    artifactIds.length === 0
      ? []
      : (
          await db
            .select({ id: a.id, name: a.name, state: a.state })
            .from(a)
            .where(and(inArray(a.id, artifactIds), eq(a.ownerId, ownerId)))
        )
          .filter((artifact) => artifact.state !== "purging" && artifact.state !== "deleted")
          .map((artifact) => [artifact.id, artifact]),
  );
  // Names only of people who act for the owner, checked again now.
  const side = new Set(await ownerSide(db.global, ownerId));
  const actorIds = [
    ...new Set(
      pending.flatMap((event) => (event.actorId && side.has(event.actorId) ? [event.actorId] : [])),
    ),
  ];
  const names = new Map(
    actorIds.length === 0
      ? []
      : (
          await db.global
            .select({ id: schema.users.id, name: schema.users.name })
            .from(schema.users)
            .where(inArray(schema.users.id, actorIds))
        ).map((user) => [user.id, user.name]),
  );
  // A service token of the owner that acted alone is named by its label (decision 0011).
  const tokenIds = [
    ...new Set(
      pending.flatMap((event) =>
        event.actorId && isServiceTokenId(event.actorId) ? [event.actorId] : [],
      ),
    ),
  ];
  if (tokenIds.length > 0) {
    const t = schema.serviceTokens;
    for (const token of await db.global
      .select({ id: t.id, label: t.label })
      .from(t)
      .where(and(inArray(t.id, tokenIds), eq(t.workspaceId, ownerId)))) {
      names.set(token.id, `${token.label} (service token)`);
    }
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  return pending.flatMap((event): WebhookEventBody[] => {
    const isTest = event.type === WEBHOOK_TEST_EVENT;
    const artifact = artifacts.get(event.artifactId);
    if (!isTest && !artifact) return [];
    if (event.count <= 0) return [];
    const name = event.actorId ? names.get(event.actorId) : undefined;
    const body: WebhookEventBody = {
      type: event.type as WebhookEventBody["type"],
      artifact: artifact
        ? {
            id: artifact.id,
            name: artifact.name,
            url: `https://${artifact.id}.${deps.contentDomain}/`,
            viewUrl: `${deps.appOrigin}/view/${artifact.id}`,
          }
        : null,
      count: event.count,
      firstAt: iso(event.firstAt),
      lastAt: iso(event.lastAt),
      actor: name ? { name } : null,
    };
    if (event.type === "artifact.published" && event.version !== null) body.version = event.version;
    if (event.type === "artifact.access_changed" && event.access !== null) {
      body.access = event.access as AccessMode;
    }
    if (event.type === "artifact.expiring" && event.expiresAt !== null) {
      body.expiresAt = iso(event.expiresAt);
    }
    if (event.type.startsWith("review.")) {
      if (event.version !== null) body.version = event.version;
      const review = reviewOf(event.review);
      if (review) body.review = review;
    }
    return [body];
  });
}

/** The review block a pending row stored, when it still reads as one; nothing otherwise. */
function reviewOf(stored: string | null): ApprovalSummary | undefined {
  if (stored === null) return undefined;
  try {
    const parsed = ApprovalSummary.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Reads at most `limit` bytes of a body and cancels the rest; gives up when `signal` aborts. */
export async function drain(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    let read = 0;
    while (read < limit) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) return;
      read += chunk.value.byteLength;
    }
  } catch {
    // The status already decided the outcome; a body that fails to arrive changes nothing.
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Sends one attempt and records it, moving the job to its next attempt or closing it. */
async function attempt(
  db: RegionalDb,
  row: OutboxRow,
  webhook: WebhookRow,
  job: Delivery,
  now: number,
  deps: WebhookDeps,
): Promise<JobOutcome> {
  const log = (outcome: "delivered" | "failed", status: number | null, error: string | null) =>
    db.insert(wd).values({
      webhookId: webhook.id,
      ownerId: webhook.ownerId,
      deliveryId: job.delivery.id,
      attempt: job.attempt,
      at: now,
      outcome,
      status,
      error,
    });
  const stop = async (reason: "invalid_url" | "key_unavailable") => {
    await db.batch([
      log("failed", null, reason),
      db
        .update(w)
        .set({ disabledAt: now, disabledReason: reason })
        .where(and(eq(w.id, webhook.id), sql`${w.disabledAt} is null`)),
    ]);
    return "done" as const;
  };
  let url: string;
  let secret: string | null = null;
  try {
    url = await open(deps.keys, webhook.keyId, webhook.id, "url", webhook.urlBox);
    if (webhook.format === "generic" && webhook.secretBox !== null) {
      secret = await open(deps.keys, webhook.keyId, webhook.id, "secret", webhook.secretBox);
    }
  } catch (error) {
    // Sealed with a key this Worker no longer holds (a restore after a rotation): it can never
    // send, so it stops with a reason the owner sees instead of failing forever.
    if (error instanceof WebhookKeyUnavailableError) return stop("key_unavailable");
    throw error;
  }
  const checked = checkWebhookUrl(url, webhook.format);
  if (!checked.ok) return stop("invalid_url");
  const body = renderDelivery(webhook.format, job.delivery);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Portifact-Webhooks/1 (+https://portifact.com)",
  };
  if (secret !== null) {
    const timestamp = Math.floor(now / 1000);
    headers["webhook-id"] = job.delivery.id;
    headers["webhook-timestamp"] = String(timestamp);
    headers["webhook-signature"] = await signWebhook(secret, job.delivery.id, timestamp, body);
  }
  const signal = AbortSignal.timeout(deps.timeoutMs ?? WEBHOOK_LIMITS.timeoutMs);
  let result: Parameters<typeof classifyAttempt>[0];
  try {
    const response = await deps.fetch(checked.value.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal,
    });
    result = { kind: "status", status: response.status };
    await drain(response, WEBHOOK_LIMITS.responseReadBytes, signal);
  } catch {
    result = signal.aborted ? { kind: "timeout" } : { kind: "network" };
  }
  const verdict = classifyAttempt(result);
  if (verdict.outcome === "delivered") {
    await db.batch([
      log("delivered", verdict.status, null),
      db.update(w).set({ failures: 0, probation: false }).where(eq(w.id, webhook.id)),
      db.delete(o).where(eq(o.id, row.id)),
    ]);
    return "done";
  }
  // Disabled or not is decided by the failure's own update, from the count it writes, so
  // concurrent failures cannot step past the threshold.
  const [counted] = (await db.batch([
    db
      .update(w)
      .set({
        failures: sql`${w.failures} + 1`,
        disabledAt: sql`case when ${w.disabledAt} is not null then ${w.disabledAt} when ${verdict.gone} or ${w.failures} + 1 >= (case when ${w.probation} then ${disableThreshold(true)} else ${disableThreshold(false)} end) then ${now} else null end`,
        disabledReason: sql`case when ${w.disabledAt} is not null then ${w.disabledReason} when ${verdict.gone} then 'gone' when ${w.failures} + 1 >= (case when ${w.probation} then ${disableThreshold(true)} else ${disableThreshold(false)} end) then 'failures' else null end`,
      })
      .where(eq(w.id, webhook.id))
      .returning({ disabledAt: w.disabledAt }),
    log("failed", verdict.status, verdict.error),
  ])) as unknown as [{ disabledAt: number | null }[]];
  const stopped = counted[0]?.disabledAt != null;
  const next = verdict.retryable && !stopped ? nextAttemptAt(job.attempt, now) : null;
  await (next === null
    ? db.delete(o).where(eq(o.id, row.id))
    : db
        .update(o)
        .set({
          payload: { ...job, attempt: job.attempt + 1, startedAt: null },
          availableAt: next,
          dispatchedAt: null,
        })
        .where(eq(o.id, row.id)));
  return next === null ? "done" : "kept";
}

// Maintenance

export interface WebhookMaintenance {
  prunedDeliveries: number;
  requeued: number;
}

/**
 * Prunes the delivery log past 7 days in a bounded batch, and gives a job to any enabled webhook
 * with pending events and no job at all (the safety net for a lost one).
 */
export async function maintainWebhooks(
  db: RegionalDb,
  now: number,
  limit = 500,
): Promise<WebhookMaintenance> {
  const cutoff = now - WEBHOOK_LIMITS.logDays * DAY_MS;
  const pruned = await db
    .delete(wd)
    .where(
      inArray(
        wd.id,
        db.select({ id: wd.id }).from(wd).where(lt(wd.at, cutoff)).orderBy(wd.id).limit(limit),
      ),
    )
    .returning({ id: wd.id });
  const requeued = await deliveryJobs(
    db,
    sql`${w.disabledAt} is null and exists (select 1 from ${we} where ${we.webhookId} = ${w.id}) and not exists (select 1 from ${o} where ${o.topic} = 'webhook_delivery' and ${o.subject} = ${w.id}) and ${noFreshJob(sql`${w.id}`)}`,
    now,
    now,
  ).returning({ id: o.id });
  return { prunedDeliveries: pruned.length, requeued: requeued.length };
}

/**
 * While deliveries are switched off (`WEBHOOKS_ENABLED` unset), stops every enabled webhook with
 * the reason `unavailable`, up to `limit` a run, so writes record no events for them. Admins
 * enable them again once the service is on. Returns how many it stopped.
 */
export async function stopWebhooksWhileOff(db: RegionalDb, now: number, limit = 500) {
  const stopped = await db
    .update(w)
    .set({ disabledAt: now, disabledReason: "unavailable" })
    .where(
      inArray(
        w.id,
        db.select({ id: w.id }).from(w).where(sql`${w.disabledAt} is null`).limit(limit),
      ),
    )
    .returning({ id: w.id });
  return stopped.length;
}

/**
 * Re-seals webhooks sealed with an older key (`WEBHOOK_KEY_PREVIOUS`) with the current one, up
 * to `limit` a run. Returns how many it re-sealed and how many still use another key.
 */
export async function rewrapWebhookKeys(
  db: RegionalDb,
  keys: Keys,
  limit = 200,
): Promise<{ rewrapped: number; left: number }> {
  const [current] = keys;
  if (!current) return { rewrapped: 0, left: 0 };
  const known = keys.map((key) => key.id);
  const rows = await db
    .select()
    .from(w)
    .where(and(ne(w.keyId, current.id), inArray(w.keyId, known)))
    .limit(limit);
  let rewrapped = 0;
  for (const row of rows) {
    const url = await open(keys, row.keyId, row.id, "url", row.urlBox);
    const secret =
      row.secretBox === null ? null : await open(keys, row.keyId, row.id, "secret", row.secretBox);
    const updated = await db
      .update(w)
      .set({
        keyId: current.id,
        urlBox: await seal(current, row.id, "url", url),
        secretBox: secret === null ? null : await seal(current, row.id, "secret", secret),
      })
      .where(and(eq(w.id, row.id), eq(w.keyId, row.keyId)))
      .returning({ id: w.id });
    rewrapped += updated.length;
  }
  const [left] = await db
    .select({ count: sql<number>`count(*)` })
    .from(w)
    .where(ne(w.keyId, current.id));
  return { rewrapped, left: Number(left?.count ?? 0) };
}
