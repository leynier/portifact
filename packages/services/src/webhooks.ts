// Webhooks (premium plan P6, decision 0009): the admins of an owner manage HTTPS destinations that
// receive events about the owner's artifacts, and the jobs Worker delivers them. The rules are in
// packages/domain/src/webhooks.ts; writes record events through webhook-activity.ts.
import {
  type AccessMode,
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
import { type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  authorize,
  bitsToEvents,
  checkWebhookUrl,
  classifyAttempt,
  dailyCapReached,
  disablesAfter,
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
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ownerSide } from "./actors.ts";
import { platformProtection } from "./budget.ts";
import { closeJobs, type JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";
import { deliveryJobs, markWebhookTest, noFreshJob, WEBHOOK_FEATURE } from "./webhook-activity.ts";
import { newWebhookSecret, open, seal, signWebhook, type webhookKeys } from "./webhook-keys.ts";

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
    lastAttempt: last,
  };
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
  return record(row, hasFeature(owner, WEBHOOK_FEATURE), last.get(row.id) ?? null);
}

export interface WebhookListing {
  webhooks: WebhookRecord[];
  available: boolean;
  limit: number;
}

/** The owner's webhooks, oldest first. Never gated: reading what exists is never behind a plan. */
export async function listWebhooks(
  db: RegionalDb,
  input: { actor: Actor; now: number },
): Promise<Result<WebhookListing>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const owner = await ownerEntitlements(db, input.actor.ownerId, input.now);
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
  return ok({
    webhooks: rows.map((row) => record(row, available, last.get(row.id) ?? null)),
    available,
    limit: WEBHOOK_LIMITS.perOwner,
  });
}

/** Creates a webhook; the secret (generic only) is returned here and never again. */
export async function createWebhook(
  db: RegionalDb,
  input: { actor: Actor; webhook: WebhookCreate; keys: Keys; now: number },
): Promise<Result<{ webhook: WebhookRecord; secret: string | null }>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const ownerId = input.actor.ownerId;
  const owner = requireFeature(await ownerEntitlements(db, ownerId, input.now), WEBHOOK_FEATURE);
  if (!owner.ok) return owner;
  const checked = checkWebhookUrl(input.webhook.url, input.webhook.format);
  if (!checked.ok) return checked;
  const [key] = input.keys;
  if (!key) return fail("capacity_unavailable", "Webhooks are not available right now.");
  const id = hexId("wh_");
  const secret = input.webhook.format === "generic" ? newWebhookSecret() : null;
  const urlBox = await seal(key, id, "url", checked.value.url);
  const secretBox = secret === null ? null : await seal(key, id, "secret", secret);
  // Columns in schema order: id, owner, host, format, events, key, url, secret, created,
  // disabled, reason, failures. The count keeps concurrent creates under the cap.
  const inserted = await db
    .insert(w)
    .select(
      sql`select ${id}, ${ownerId}, ${checked.value.host}, ${input.webhook.format}, ${eventsToBits(input.webhook.events)}, ${key.id}, ${urlBox}, ${secretBox}, ${input.now}, null, null, 0 where (select count(*) from ${w} where ${w.ownerId} = ${ownerId}) < ${WEBHOOK_LIMITS.perOwner}`,
    )
    .returning();
  const [row] = inserted;
  if (!row) {
    return fail(
      "quota_exceeded",
      `An owner can have at most ${WEBHOOK_LIMITS.perOwner} webhooks. Remove one to add another.`,
    );
  }
  return ok({ webhook: record(row, true, null), secret });
}

/**
 * Enables or disables a webhook, or changes its events. Enabling resets the failures and needs
 * the feature, as does any change that leaves it enabled; disabling never does.
 */
export async function updateWebhook(
  db: RegionalDb,
  input: { actor: Actor; webhookId: string; update: WebhookUpdate; now: number },
): Promise<Result<WebhookRecord>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.webhookId);
  if (!row) return missing();
  const enabled = input.update.enabled ?? row.disabledAt === null;
  const owner = await ownerEntitlements(db, input.actor.ownerId, input.now);
  if (enabled) {
    const gate = requireFeature(owner, WEBHOOK_FEATURE);
    if (!gate.ok) return gate;
  }
  const change: Partial<typeof w.$inferInsert> = {};
  if (input.update.events) change.events = eventsToBits(input.update.events);
  if (input.update.enabled === true && row.disabledAt !== null) {
    Object.assign(change, { disabledAt: null, disabledReason: null, failures: 0 });
  }
  if (input.update.enabled === false && row.disabledAt === null) {
    Object.assign(change, { disabledAt: input.now, disabledReason: "manual" });
  }
  if (Object.keys(change).length === 0) return ok(await present(db, row, owner));
  const [updated] = await db
    .update(w)
    .set(change)
    .where(and(eq(w.id, row.id), eq(w.ownerId, input.actor.ownerId)))
    .returning();
  if (!updated) return missing();
  return ok(await present(db, updated, owner));
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
  const results = await db.batch([
    db
      .insert(schema.tombstones)
      .select(sql`select 'webhook', ${input.webhookId}, ${input.now} where ${mine}`)
      .onConflictDoNothing(),
    closeJobs(db, "webhook_delivery", input.webhookId, mine),
    db
      .delete(w)
      .where(and(eq(w.id, input.webhookId), eq(w.ownerId, input.actor.ownerId)))
      .returning({ id: w.id }),
  ]);
  const deleted = results[2] as { id: string }[];
  return deleted.length === 1 ? ok({ webhookId: input.webhookId }) : missing();
}

/** Queues a test event for an enabled webhook; it goes with the next delivery, without waiting. */
export async function sendTestEvent(
  db: RegionalDb,
  input: { actor: Actor; webhookId: string; now: number },
): Promise<Result<{ webhookId: string }>> {
  const allowed = authorize(input.actor, "webhooks");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.webhookId);
  if (!row) return missing();
  const gate = requireFeature(
    await ownerEntitlements(db, input.actor.ownerId, input.now),
    WEBHOOK_FEATURE,
  );
  if (!gate.ok) return gate;
  if (row.disabledAt !== null) {
    return fail("invalid_input", "This webhook is disabled. Enable it before sending a test.");
  }
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
  }));
}

// Delivery

/** What delivering needs besides D1: the keys, the network and the origins links use. */
export interface WebhookDeps {
  keys: Keys;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  appOrigin: string;
  contentDomain: string;
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
  const [hook] = await db
    .select({
      webhook: w,
      plan: {
        plan: schema.ownerPlans.plan,
        seats: schema.ownerPlans.seats,
        validUntil: schema.ownerPlans.validUntil,
        overrides: schema.ownerPlans.overrides,
      },
    })
    .from(w)
    .leftJoin(schema.ownerPlans, eq(schema.ownerPlans.ownerId, w.ownerId))
    .where(eq(w.id, webhookId))
    .limit(1);
  if (!hook) return "done";
  const webhook = hook.webhook;
  const parsed = WebhookJobPayload.safeParse(row.payload);
  const job: Delivery | null =
    parsed.success && "delivery" in parsed.data ? (parsed.data as Delivery) : null;
  // A stopped webhook, or a plan without the feature, sends nothing and keeps nothing pending.
  if (webhook.disabledAt !== null || !hasFeature(entitlements(hook.plan, now), WEBHOOK_FEATURE)) {
    if (!job) await db.delete(we).where(eq(we.webhookId, webhook.id));
    return "stale";
  }
  const protection = await platformProtection(db, now);
  if (deps.paused || protection.actions.includes("block_uploads")) {
    await reschedule(db, row, now + WEBHOOK_LIMITS.pausedRetryMs);
    return "kept";
  }
  const day = utcDayStart(now);
  const [today] = await db
    .select({ count: sql<number>`count(*)` })
    .from(wd)
    .where(and(eq(wd.ownerId, webhook.ownerId), gte(wd.at, day), ne(wd.outcome, "skipped")));
  if (dailyCapReached(Number(today?.count ?? 0))) {
    const noted = sql`exists (select 1 from ${wd} where ${wd.webhookId} = ${webhook.id} and ${wd.at} >= ${day} and ${wd.error} = 'daily_cap')`;
    await db.batch([
      db
        .insert(wd)
        .select(
          sql`select null, ${webhook.id}, ${webhook.ownerId}, ${job?.delivery.id ?? ""}, ${job?.attempt ?? 0}, ${now}, 'skipped', null, 'daily_cap' where not ${noted}`,
        ),
      reschedule(db, row, day + DAY_MS),
    ]);
    return "kept";
  }
  const claimed = job
    ? await claimAttempt(db, row, job, now)
    : await claimEvents(db, row, webhook, now, deps);
  if (claimed === "done" || claimed === "kept") return claimed;
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
      .where(and(eq(o.id, row.id), sql`${o.payload} = '{}'`))
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
    return [body];
  });
}

/** Reads at most `limit` bytes of a body and cancels the rest; gives up when `signal` aborts. */
async function drain(response: Response, limit: number, signal: AbortSignal) {
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
  const url = await open(deps.keys, webhook.keyId, webhook.id, "url", webhook.urlBox);
  const checked = checkWebhookUrl(url, webhook.format);
  if (!checked.ok) {
    await db.batch([
      log("failed", null, "invalid_url"),
      db
        .update(w)
        .set({ disabledAt: now, disabledReason: "invalid_url" })
        .where(and(eq(w.id, webhook.id), sql`${w.disabledAt} is null`)),
    ]);
    return "done";
  }
  const body = renderDelivery(webhook.format, job.delivery);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Portifact-Webhooks/1 (+https://portifact.com)",
  };
  if (webhook.format === "generic" && webhook.secretBox !== null) {
    const secret = await open(deps.keys, webhook.keyId, webhook.id, "secret", webhook.secretBox);
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
      db.update(w).set({ failures: 0 }).where(eq(w.id, webhook.id)),
      db.delete(o).where(eq(o.id, row.id)),
    ]);
    return "done";
  }
  const failures = webhook.failures + 1;
  const disable: WebhookDisabledReason | null = verdict.gone
    ? "gone"
    : disablesAfter(failures)
      ? "failures"
      : null;
  const next = verdict.retryable && disable === null ? nextAttemptAt(job.attempt, now) : null;
  await db.batch([
    log("failed", verdict.status, verdict.error),
    db
      .update(w)
      .set({
        failures: sql`${w.failures} + 1`,
        ...(disable === null ? {} : { disabledAt: now, disabledReason: disable }),
      })
      .where(and(eq(w.id, webhook.id), sql`${w.disabledAt} is null`)),
    next === null
      ? db.delete(o).where(eq(o.id, row.id))
      : db
          .update(o)
          .set({
            payload: { ...job, attempt: job.attempt + 1, startedAt: null },
            availableAt: next,
            dispatchedAt: null,
          })
          .where(eq(o.id, row.id)),
  ]);
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
