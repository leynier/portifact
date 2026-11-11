// Audit streams (premium plan E3, feature `auditExport`, decision 0019): the admins of an owner
// point the owner's audit log at an HTTPS endpoint they run (a SIEM collector), and the jobs Worker
// posts the events there in batches. The stream keeps a position in each database the owner's
// events live in, in the order the database recorded them (`audit_events.recorded_at`, its own
// clock), and moves it only after a 2xx answer: at least once, in order per database, never
// skipping. The audit write path only sets `recorded_at` inside the insert it already runs.
//
// It reuses the webhook machinery (decision 0009): `checkWebhookUrl` before every request, the
// URL and secret sealed with `WEBHOOK_KEY`, the Standard Webhooks signature, the bounded response
// read, the `WEBHOOKS_ENABLED` switch, the emergency stop and budget protection.
import {
  AUDIT_STREAM,
  AUDIT_STREAM_CONTENT_TYPE,
  AUDIT_STREAM_HEADER,
  AUDIT_STREAM_SOURCE_HEADER,
  AUDIT_STREAM_SOURCES,
  type AuditDetail,
  type AuditStreamAttempt,
  type AuditStreamAutoPause,
  type AuditStreamCreate,
  type AuditStreamError,
  type AuditStreamSource,
  type AuditStreamUpdate,
  type AuditStreamView,
  isWorkspaceId,
} from "@portifact/contracts";
import { bothSides, type Db, hitRateLimit, type RegionalDb, schema } from "@portifact/db";
import {
  type Actor,
  auditJsonLine,
  authorize,
  buildStreamBatch,
  checkWebhookUrl,
  classifyStreamAttempt,
  deliveredThrough,
  type Entitlements,
  entitlements,
  fail,
  hasFeature,
  needsAttention,
  nextStreamAttemptAt,
  ok,
  type Result,
  requireFeature,
  type StreamAttemptResult,
  type StreamBatch,
  type StreamPosition,
  streamBatchKey,
  streamGap,
  streamRiskBound,
  testLine,
  utcDayStart,
} from "@portifact/domain";
import { and, desc, eq, gte, inArray, lt, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { actorOn } from "./actors.ts";
import { auditEvent, presentAuditEvents, streamEventsAfter } from "./audit.ts";
import { platformProtection } from "./budget.ts";
import { closeJobs, type JobOutcome } from "./outbox.ts";
import { ownerEntitlements } from "./plans.ts";
import {
  newWebhookSecret,
  open,
  seal,
  signWebhook,
  WebhookKeyUnavailableError,
  type webhookKeys,
} from "./webhook-keys.ts";
import { drain } from "./webhooks.ts";

type Keys = Awaited<ReturnType<typeof webhookKeys>>;
type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
type StreamRow = typeof s.$inferSelect;
type OutboxRow = typeof o.$inferSelect;

const s = schema.auditStreams;
const sd = schema.auditStreamDeliveries;
const o = schema.outbox;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const AUDIT_STREAMS_UNAVAILABLE = "Audit streams are not available yet.";

const unavailable = () => fail<never>("capacity_unavailable", AUDIT_STREAMS_UNAVAILABLE);
const missing = () => fail<never>("not_found", "Audit stream not found.");
const changedMeanwhile = () =>
  fail<never>("version_conflict", "The stream changed at the same time. Reload it and try again.");

/** Whether Portifact delivers audit streams at all: the webhook switch (`WEBHOOKS_ENABLED`). */
export interface AuditStreamService {
  enabled: boolean;
}

/**
 * Streaming needs both the export (`auditExport`) and the log itself (`audit`) in the owner's
 * plan; the export's own feature is checked first, as for a file export.
 */
function streamGate(owner: Entitlements): Result<Entitlements> {
  const gate = requireFeature(owner, "auditExport");
  if (!gate.ok) return gate;
  return requireFeature(owner, "audit");
}

function canStream(owner: Entitlements): boolean {
  return hasFeature(owner, "auditExport") && hasFeature(owner, "audit");
}

function hexId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function attemptView(row: typeof sd.$inferSelect): AuditStreamAttempt {
  return {
    at: new Date(row.at).toISOString(),
    outcome: row.outcome,
    source: row.source,
    events: row.events,
    statusClass: row.statusClass as AuditStreamAttempt["statusClass"],
    error: row.error as AuditStreamError | null,
  };
}

function view(
  row: StreamRow,
  last: AuditStreamAttempt | null,
  names: ReadonlyMap<string, string>,
  now: number,
): AuditStreamView {
  const through = row.deliveredThrough ?? deliveredThrough(row.regionalAt, row.globalAt);
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    state: row.state,
    pausedReason: row.pausedReason,
    pausedAt: iso(row.pausedAt),
    deliveredThrough: iso(through),
    lagMs: through === null ? null : Math.max(0, now - through),
    failures: row.failures,
    failingSince: iso(row.failingSince),
    lastAttempt: last,
    lastGap:
      row.gapSource !== null && row.gapFrom !== null && row.gapTo !== null
        ? {
            source: row.gapSource,
            from: new Date(row.gapFrom).toISOString(),
            to: new Date(row.gapTo).toISOString(),
          }
        : null,
    testPending: row.testRequestedAt !== null,
    createdAt: new Date(row.createdAt).toISOString(),
    createdBy: row.createdBy === null ? null : (names.get(row.createdBy) ?? null),
  };
}

async function lastAttempts(db: RegionalDb, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, AuditStreamAttempt>();
  const rows = await db
    .select()
    .from(sd)
    .where(
      inArray(
        sd.id,
        db
          .select({ id: sql<number>`max(${sd.id})` })
          .from(sd)
          .where(inArray(sd.streamId, [...ids]))
          .groupBy(sd.streamId),
      ),
    );
  return new Map(rows.map((row) => [row.streamId, attemptView(row)]));
}

async function creatorNames(db: RegionalDb, rows: readonly StreamRow[]) {
  const ids = [...new Set(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])))];
  if (ids.length === 0) return new Map<string, string>();
  const users = await db.global
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(users.map((user) => [user.id, user.name]));
}

async function present(db: RegionalDb, row: StreamRow, now: number) {
  const last = await lastAttempts(db, [row.id]);
  return view(row, last.get(row.id) ?? null, await creatorNames(db, [row]), now);
}

/** The actor's stream, or nothing for anyone else's. */
async function owned(db: RegionalDb, actor: Actor, streamId: string) {
  const [row] = await db
    .select()
    .from(s)
    .where(and(eq(s.id, streamId), eq(s.ownerId, actor.ownerId)))
    .limit(1);
  return row;
}

/**
 * The handle a stream write runs on and the condition it adds, as issue integrations do
 * (decision 0018): with one database the write holds only while the caller is still the
 * workspace's admin (inside the batch); with a separate regional database the caller is
 * resolved again right before the batch (`stillManages`), and a demotion landing between that
 * read and the batch is not seen (decision 0019, "Who and where"). A personal space's owner is
 * always its admin.
 */
function writeScope(db: RegionalDb, actor: Actor): { w: Db; holds: SQL } {
  const both = bothSides(db);
  if (both && isWorkspaceId(actor.ownerId)) {
    const m = schema.workspaceMembers;
    // As `stillAdmin` in ./workspaces.ts (not imported: that module imports this one).
    const holds = sql`exists (select 1 from ${m} as "caller" where "caller"."workspace_id" = ${actor.ownerId} and "caller"."user_id" = ${actor.userId} and "caller"."role" = 'admin')`;
    return { w: both, holds };
  }
  return { w: both ?? db, holds: sql`1` };
}

/** The caller resolved again just before a write: still allowed to manage streams? */
async function stillManages(db: RegionalDb, actor: Actor): Promise<Result<true>> {
  const resolved = await actorOn(db.global, actor.userId, actor.ownerId);
  if (!resolved.ok) return resolved;
  const again = authorize(resolved.value, "audit");
  return again.ok ? ok(true) : again;
}

/**
 * Counts one action of an owner in the `rate_limits` counters (one upsert, so concurrent requests
 * cannot both take the last slot). Keyed by owner, never by stream: removing and creating streams
 * never resets it.
 */
async function ownerLimit(
  db: RegionalDb,
  action: "create" | "test" | "change",
  ownerId: string,
  now: number,
): Promise<Result<true>> {
  const [windowMs, max, what] =
    action === "create"
      ? [DAY_MS, AUDIT_STREAM.createsPerOwnerPerDay, "audit streams can be created a day"]
      : action === "test"
        ? [HOUR_MS, AUDIT_STREAM.testsPerOwnerPerHour, "test records can be sent an hour"]
        : [DAY_MS, AUDIT_STREAM.changesPerOwnerPerDay, "stream changes can be made a day"];
  const hit = await hitRateLimit(
    db.global.$client,
    `audit-stream:${action}:${ownerId}`,
    windowMs,
    now,
  );
  return hit.count > max
    ? fail("rate_limited", `At most ${max} ${what}. Try again later.`)
    : ok(true);
}

/** The audit event of a stream change, in its batch on `condition`. */
function streamEvent<
  K extends "audit_stream.created" | "audit_stream.changed" | "audit_stream.removed",
>(
  db: Db,
  actor: Actor,
  streamId: string,
  kind: K,
  input: { detail: AuditDetail<K>; now: number; condition: SQL },
) {
  return auditEvent(
    db,
    {
      ownerId: actor.ownerId,
      kind,
      actor: { type: "user", id: actor.userId },
      targetId: streamId,
      detail: input.detail,
      now: input.now,
    },
    input.condition,
  );
}

/** Gives the stream a job when it has none, on `condition`: the job is what delivers. */
function ensureJob(db: Db, streamId: string, condition: SQL, now: number) {
  return db
    .insert(o)
    .select(
      sql`select null, 'audit_stream', '{}', ${now}, null, 0, ${now}, ${streamId}, null where not exists (select 1 from ${o} where ${o.topic} = 'audit_stream' and ${o.subject} = ${streamId}) and ${condition}`,
    );
}

export interface AuditStreamListing {
  streams: AuditStreamView[];
  available: boolean;
  serviceAvailable: boolean;
  euOwner: boolean;
  limit: number;
  settleMinutes: number;
}

/** The owner's streams, oldest first. Never gated: reading what exists is never behind a plan. */
export async function listAuditStreams(
  db: RegionalDb,
  input: { actor: Actor; service: AuditStreamService; now: number },
): Promise<Result<AuditStreamListing>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const owner = await ownerEntitlements(db.global, input.actor.ownerId, input.now);
  const rows = await db
    .select()
    .from(s)
    .where(eq(s.ownerId, input.actor.ownerId))
    .orderBy(s.createdAt, s.id);
  const last = await lastAttempts(
    db,
    rows.map((row) => row.id),
  );
  const names = await creatorNames(db, rows);
  return ok({
    streams: rows.map((row) => view(row, last.get(row.id) ?? null, names, input.now)),
    available: canStream(owner),
    serviceAvailable: input.service.enabled,
    euOwner: input.actor.region === "eu",
    limit: AUDIT_STREAM.perOwner,
    settleMinutes: Math.max(1, Math.round(AUDIT_STREAM.settleMs / 60_000)),
  });
}

/**
 * Creates a stream that starts from now (or from the oldest event still kept) and gives it its
 * first job, only while the caller is still an admin. The signing secret is returned here and
 * never again. No idempotency key: a stored replay would keep the secret (as for webhooks); a
 * retried create makes a second stream, which the admin removes.
 */
export async function createAuditStream(
  db: RegionalDb,
  input: {
    actor: Actor;
    stream: AuditStreamCreate;
    keys: Keys;
    service: AuditStreamService;
    now: number;
  },
): Promise<Result<{ stream: AuditStreamView; secret: string }>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  if (!input.service.enabled) return unavailable();
  const ownerId = input.actor.ownerId;
  const gate = streamGate(await ownerEntitlements(db.global, ownerId, input.now));
  if (!gate.ok) return gate;
  const checked = checkWebhookUrl(input.stream.url, "generic");
  if (!checked.ok) return checked;
  const [key] = input.keys;
  if (!key) return unavailable();
  const limited = await ownerLimit(db, "create", ownerId, input.now);
  if (!limited.ok) return limited;
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  const id = hexId("as_");
  const secret = newWebhookSecret();
  const urlBox = await seal(key, id, "url", checked.value.url);
  const secretBox = await seal(key, id, "secret", secret);
  // "Now" is the database's clock, the order streams read in; the oldest event is no position.
  const start = input.stream.start === "oldest" ? sql`null` : schema.recordedNow;
  const exists = sql`exists (select 1 from ${s} where ${s.id} = ${id})`;
  // Columns in schema order: id, owner, label, host, key, url, secret, previous secret, previous
  // until, state, reason, paused at, regional at, regional id, global at, global id, failures,
  // failing since, next attempt, gap source, gap from, gap to, test requested, revision,
  // regional gap to, global gap to, delivered through, created, created by. The count keeps
  // concurrent creates under the cap.
  const [inserted] = await w.batch([
    w
      .insert(s)
      .select(
        sql`select ${id}, ${ownerId}, ${input.stream.label}, ${checked.value.host}, ${key.id}, ${urlBox}, ${secretBox}, null, null, 'active', null, null, ${start}, '', ${start}, '', 0, null, null, null, null, null, null, 0, null, null, null, ${input.now}, ${input.actor.userId} where (select count(*) from ${s} where ${s.ownerId} = ${ownerId}) < ${AUDIT_STREAM.perOwner} and ${holds}`,
      )
      .returning(),
    streamEvent(w, input.actor, id, "audit_stream.created", {
      detail: { host: checked.value.host, start: input.stream.start },
      now: input.now,
      condition: exists,
    }),
    ensureJob(w, id, exists, input.now),
  ]);
  const [row] = inserted;
  if (!row) {
    const again = await stillManages(db, input.actor);
    if (!again.ok) return again;
    return fail(
      "quota_exceeded",
      `An owner can have at most ${AUDIT_STREAM.perOwner} audit streams. Remove one to add another.`,
    );
  }
  return ok({ stream: view(row, null, await creatorNames(db, [row]), input.now), secret });
}

/**
 * Changes a stream: its label, its URL, pausing or resuming it, or a new signing secret (the old
 * one keeps signing for `rotationOverlapMs`, unless the admin revokes it at once). A new URL and
 * resuming need the owner's plan; the label, pausing and rotating never do. Every change is
 * conditioned on the revision read and on the caller still being an admin, and bumps the
 * revision: two changes at once never mix, and a run in flight never moves the stream on behalf
 * of what the admin just changed. Resuming continues from the stored position.
 */
export async function updateAuditStream(
  db: RegionalDb,
  input: {
    actor: Actor;
    streamId: string;
    update: AuditStreamUpdate;
    keys: Keys;
    service: AuditStreamService;
    now: number;
  },
): Promise<Result<{ stream: AuditStreamView; secret: string | null }>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.streamId);
  if (!row) return missing();
  const { update } = input;
  const resuming = update.state === "active" && row.state !== "active";
  const pausing = update.state === "paused" && row.state === "active";
  const newUrl = update.url !== undefined;
  const rotating = update.rotateSecret === true;
  const sealing = newUrl || rotating;
  if ((resuming || sealing) && !input.service.enabled) return unavailable();
  if (resuming || newUrl) {
    const gate = streamGate(await ownerEntitlements(db.global, input.actor.ownerId, input.now));
    if (!gate.ok) return gate;
  }
  const change: Partial<typeof s.$inferInsert> = {};
  const detail: AuditDetail<"audit_stream.changed"> = { host: row.host };
  if (update.label !== undefined && update.label !== row.label) {
    change.label = update.label;
    detail.label = true;
  }
  let secret: string | null = null;
  if (sealing) {
    const [key] = input.keys;
    if (!key) return unavailable();
    let url: string | null = null;
    if (newUrl) {
      const checked = checkWebhookUrl(update.url as string, "generic");
      if (!checked.ok) return checked;
      url = checked.value.url;
      change.host = checked.value.host;
      detail.host = checked.value.host;
      detail.url = true;
    }
    const limited = await ownerLimit(db, "change", input.actor.ownerId, input.now);
    if (!limited.ok) return limited;
    // A change of key re-seals both values with the current key, so the row names one key.
    const opened = await openedValues(input.keys, row);
    if (!opened.ok) return opened;
    secret = rotating ? newWebhookSecret() : null;
    change.keyId = key.id;
    change.urlBox = await seal(key, row.id, "url", url ?? opened.value.url);
    change.secretBox = await seal(key, row.id, "secret", secret ?? opened.value.secret);
    if (rotating && update.revokeOldSecret === true) {
      // An emergency: the old secret stops signing now; requests the endpoint still checks with
      // it fail until the endpoint has the new one.
      Object.assign(change, { previousSecretBox: null, previousUntil: null });
      detail.secret = true;
      detail.revoked = true;
    } else if (rotating) {
      change.previousSecretBox = await seal(key, row.id, "secret", opened.value.secret);
      change.previousUntil = input.now + AUDIT_STREAM.rotationOverlapMs;
      detail.secret = true;
    } else if (row.previousSecretBox !== null) {
      // Re-sealed with the current key, so every value names the row's one key.
      const previous = await openedPrevious(input.keys, row);
      change.previousSecretBox =
        previous === null ? null : await seal(key, row.id, "secret", previous);
    }
    if (newUrl) {
      // A new endpoint starts with a clean slate of failures.
      Object.assign(change, { failures: 0, failingSince: null, nextAttemptAt: null });
    }
  }
  if (resuming) {
    if (!sealing) {
      const limited = await ownerLimit(db, "change", input.actor.ownerId, input.now);
      if (!limited.ok) return limited;
    }
    Object.assign(change, {
      state: "active",
      pausedReason: null,
      pausedAt: null,
      failures: 0,
      failingSince: null,
      nextAttemptAt: null,
    });
    detail.state = "active";
  }
  if (pausing) {
    Object.assign(change, { state: "paused", pausedReason: "manual", pausedAt: input.now });
    detail.state = "paused";
  }
  if (Object.keys(change).length === 0) {
    return ok({ stream: await present(db, row, input.now), secret: null });
  }
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  // The old state is the revision read: anything that changed the stream since refuses this.
  const where = sql`${s.id} = ${row.id} and ${s.ownerId} = ${input.actor.ownerId} and ${s.revision} = ${row.revision} and ${holds}`;
  const results = await w.batch([
    streamEvent(w, input.actor, row.id, "audit_stream.changed", {
      detail,
      now: input.now,
      condition: sql`exists (select 1 from ${s} where ${where})`,
    }),
    w
      .update(s)
      .set({ ...change, revision: sql`${s.revision} + 1` })
      .where(where)
      .returning(),
    ...(resuming
      ? [
          ensureJob(
            w,
            row.id,
            sql`exists (select 1 from ${s} where ${s.id} = ${row.id} and ${s.state} = 'active' and ${s.revision} = ${row.revision + 1})`,
            input.now,
          ),
        ]
      : []),
  ] as unknown as Batch);
  const [updated] = results[1] as StreamRow[];
  if (updated) return ok({ stream: await present(db, updated, input.now), secret });
  const again = await stillManages(db, input.actor);
  if (!again.ok) return again;
  return (await owned(db, input.actor, input.streamId)) ? changedMeanwhile() : missing();
}

/** The URL and current secret of a stream, opened with the key that sealed them. */
async function openedValues(
  keys: Keys,
  row: StreamRow,
): Promise<Result<{ url: string; secret: string }>> {
  try {
    return ok({
      url: await open(keys, row.keyId, row.id, "url", row.urlBox),
      secret: await open(keys, row.keyId, row.id, "secret", row.secretBox),
    });
  } catch (error) {
    if (error instanceof WebhookKeyUnavailableError) {
      return fail(
        "invalid_input",
        "This stream was sealed with a key Portifact no longer holds. Remove it and add it again.",
      );
    }
    throw error;
  }
}

/** The previous secret while it still signs, or null. */
async function openedPrevious(keys: Keys, row: StreamRow): Promise<string | null> {
  if (row.previousSecretBox === null || row.previousUntil === null) return null;
  return open(keys, row.keyId, row.id, "secret", row.previousSecretBox);
}

/** The statement that deletes an owner's streams (their log goes by its foreign key). */
export function deleteOwnerAuditStreams(db: Db, ownerId: string, condition?: SQL) {
  return db
    .delete(s)
    .where(condition ? and(eq(s.ownerId, ownerId), condition) : eq(s.ownerId, ownerId));
}

/**
 * Removes a stream with its log and its job, and writes its tombstone so a restored backup cannot
 * bring the destination back. Never gated, but only while the caller is still an admin.
 */
export async function removeAuditStream(
  db: RegionalDb,
  input: { actor: Actor; streamId: string; now: number },
): Promise<Result<{ streamId: string }>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.streamId);
  if (!row) return missing();
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  const mine = sql`exists (select 1 from ${s} where ${s.id} = ${row.id} and ${s.ownerId} = ${input.actor.ownerId}) and ${holds}`;
  // With one database the tombstone rides the batch on the same condition; with a separate one it
  // is written globally first, once the stream is known to be the owner's (decision 0005).
  const both = bothSides(db);
  const tombstone = (target: Db, condition: SQL) =>
    target
      .insert(schema.tombstones)
      .select(sql`select 'audit_stream', ${row.id}, ${input.now} where ${condition}`)
      .onConflictDoNothing();
  if (!both) await tombstone(db.global, sql`1`);
  const results = await w.batch([
    streamEvent(w, input.actor, row.id, "audit_stream.removed", {
      detail: { host: row.host },
      now: input.now,
      condition: mine,
    }),
    ...(both ? [tombstone(w, mine)] : []),
    closeJobs(w, "audit_stream", row.id, mine),
    w
      .delete(s)
      .where(and(eq(s.id, row.id), eq(s.ownerId, input.actor.ownerId), holds))
      .returning({ id: s.id }),
  ] as unknown as Batch);
  const deleted = results.at(-1) as { id: string }[];
  if (deleted.length === 1) return ok({ streamId: row.id });
  const again = await stillManages(db, input.actor);
  return again.ok ? missing() : again;
}

/**
 * Asks for one synthetic test record, sent by the stream's next run whatever its state (so an
 * admin can check an endpoint before resuming), without moving any position.
 */
export async function sendAuditStreamTest(
  db: RegionalDb,
  input: { actor: Actor; streamId: string; service: AuditStreamService; now: number },
): Promise<Result<{ streamId: string }>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.streamId);
  if (!row) return missing();
  if (!input.service.enabled) return unavailable();
  const gate = streamGate(await ownerEntitlements(db.global, input.actor.ownerId, input.now));
  if (!gate.ok) return gate;
  const limited = await ownerLimit(db, "test", input.actor.ownerId, input.now);
  if (!limited.ok) return limited;
  const still = await stillManages(db, input.actor);
  if (!still.ok) return still;
  const { w, holds } = writeScope(db, input.actor);
  const mine = sql`exists (select 1 from ${s} where ${s.id} = ${row.id}) and ${holds}`;
  const [asked] = await w.batch([
    w
      .update(s)
      .set({ testRequestedAt: input.now })
      .where(and(eq(s.id, row.id), holds))
      .returning({ id: s.id }),
    // A job waiting for its backoff runs now: it sends the test and goes back to waiting.
    w
      .update(o)
      .set({ availableAt: input.now, dispatchedAt: null })
      .where(
        and(
          eq(o.topic, "audit_stream"),
          eq(o.subject, row.id),
          sql`${o.availableAt} > ${input.now}`,
          mine,
        ),
      ),
    ensureJob(w, row.id, mine, input.now),
  ]);
  if (asked.length === 1) return ok({ streamId: row.id });
  const again = await stillManages(db, input.actor);
  return again.ok ? missing() : again;
}

/** The stream's requests of the last `logDays` days, newest first. Never gated. */
export async function listAuditStreamDeliveries(
  db: RegionalDb,
  input: { actor: Actor; streamId: string; now: number },
): Promise<Result<AuditStreamAttempt[]>> {
  const allowed = authorize(input.actor, "audit");
  if (!allowed.ok) return allowed;
  const row = await owned(db, input.actor, input.streamId);
  if (!row) return missing();
  const rows = await db
    .select()
    .from(sd)
    .where(and(eq(sd.streamId, row.id), gte(sd.at, input.now - AUDIT_STREAM.logDays * DAY_MS)))
    .orderBy(desc(sd.id))
    .limit(AUDIT_STREAM.logPageSize);
  return ok(rows.map(attemptView));
}

/** The owner's streams for the account export: no URL, no secret, no position. */
export async function exportAuditStreams(db: RegionalDb, ownerId: string) {
  const rows = await db.select().from(s).where(eq(s.ownerId, ownerId)).orderBy(s.createdAt);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    host: row.host,
    state: row.state,
    pausedReason: row.pausedReason,
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

// Delivery

/** What delivering needs besides D1: the webhook keys and network, and the switches. */
export interface AuditStreamDeps {
  keys: Keys;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** `WEBHOOKS_ENABLED` with `WEBHOOK_KEY`: without it nothing is delivered. */
  enabled: boolean;
  /** The emergency stop (`WEBHOOKS_PAUSED` on the jobs Worker) stops streams too. */
  paused?: boolean | undefined;
  /** Defaults to `AUDIT_STREAM.timeoutMs`. */
  timeoutMs?: number | undefined;
  /**
   * How long after the database recorded an event it is sent; `AUDIT_STREAM.settleMs` by
   * default. Tests cannot move the database's clock, so they set it to 0.
   */
  settleMs?: number | undefined;
  /** Tests make batches small; the Worker uses `AUDIT_STREAM`. */
  bounds?: { events: number; bytes: number; batchesPerRun: number } | undefined;
}

/** A stream with its owner's plan row: one joined read with one database, two with separate ones. */
async function streamWithPlan(db: RegionalDb, streamId: string) {
  const p = schema.ownerPlans;
  const planColumns = {
    plan: p.plan,
    seats: p.seats,
    validUntil: p.validUntil,
    overrides: p.overrides,
    grace: p.grace,
  };
  const both = bothSides(db);
  if (both) {
    const [found] = await both
      .select({ stream: s, plan: planColumns })
      .from(s)
      .leftJoin(p, eq(p.ownerId, s.ownerId))
      .where(eq(s.id, streamId))
      .limit(1);
    return found;
  }
  const [stream] = await db.select().from(s).where(eq(s.id, streamId)).limit(1);
  if (!stream) return undefined;
  const [plan] = await db.global
    .select(planColumns)
    .from(p)
    .where(eq(p.ownerId, stream.ownerId))
    .limit(1);
  return { stream, plan: plan ?? null };
}

/** Moves the job's row to `at` and clears its run, for the relay to send it again then. */
function reschedule(db: Db, rowId: number, at: number) {
  return db
    .update(o)
    .set({ availableAt: at, dispatchedAt: null, payload: {} })
    .where(eq(o.id, rowId));
}

/**
 * The system's pause of a stream, with its audit event, only while the stream is active (and on
 * `extra`); it bumps the revision, so a run in flight stops moving the stream.
 */
function autoPause(
  db: RegionalDb,
  stream: StreamRow,
  reason: AuditStreamAutoPause,
  now: number,
  extra: SQL = sql`1`,
) {
  const active = sql`${s.id} = ${stream.id} and ${s.state} = 'active' and ${extra}`;
  return [
    auditEvent(
      db,
      {
        ownerId: stream.ownerId,
        kind: "audit_stream.paused",
        actor: { type: "system" },
        targetId: stream.id,
        detail: { host: stream.host, reason },
        now,
      },
      sql`exists (select 1 from ${s} where ${active})`,
    ),
    db
      .update(s)
      .set({
        state: reason === "plan" ? "paused" : "attention",
        pausedReason: reason,
        pausedAt: now,
        revision: sql`${s.revision} + 1`,
      })
      .where(active)
      .returning({ id: s.id }),
  ] as const;
}

/** The position of a stream in one database. */
function positionOf(stream: StreamRow, source: AuditStreamSource): StreamPosition {
  return source === "regional"
    ? { at: stream.regionalAt, id: stream.regionalId }
    : { at: stream.globalAt, id: stream.globalId };
}

function gapToOf(stream: StreamRow, source: AuditStreamSource): number | null {
  return source === "regional" ? stream.regionalGapTo : stream.globalGapTo;
}

/** Where the stream still stands at `position` in `source`: the guard of every position write. */
function standsAt(source: AuditStreamSource, position: StreamPosition): SQL {
  const [at, id] = source === "regional" ? [s.regionalAt, s.regionalId] : [s.globalAt, s.globalId];
  return position.at === null
    ? sql`${at} is null and ${id} = ${position.id}`
    : sql`${at} = ${position.at} and ${id} = ${position.id}`;
}

function setPosition(source: AuditStreamSource, position: StreamPosition) {
  return source === "regional"
    ? { regionalAt: position.at, regionalId: position.id }
    : { globalAt: position.at, globalId: position.id };
}

function setGapTo(source: AuditStreamSource, to: number) {
  return source === "regional" ? { regionalGapTo: to } : { globalGapTo: to };
}

/**
 * Runs one `audit_stream` job (decision 0019, "Delivering"). The job row is the stream's chain:
 * after a run it moves itself to its next time (now while more is waiting, `idleMs` when caught
 * up, the backoff after a failure) and stays (`kept`); it ends (`stale`) only when the stream no
 * longer delivers, and the maintenance scan gives an active stream a job again if one is lost.
 */
export async function deliverAuditStream(
  db: RegionalDb,
  row: OutboxRow,
  now: number,
  deps: AuditStreamDeps,
): Promise<JobOutcome> {
  const found = await streamWithPlan(db, row.subject ?? "");
  if (!found) return "done";
  // A duplicate message before the job's time does nothing.
  if (row.availableAt > now) return "kept";
  const stream = found.stream;
  const testing = stream.testRequestedAt !== null;
  // Switched off, or no key to open anything with: the job ends; the scan gives the stream a job
  // again once the switch and the key are back.
  if (!deps.enabled || deps.keys.length === 0) return "stale";
  if (stream.state !== "active" && !testing) return "stale";
  if (!canStream(entitlements(found.plan, now))) {
    // A lapsed plan pauses the stream and keeps everything; resuming continues from the position.
    await db.batch([
      ...autoPause(db, stream, "plan", now),
      db.update(s).set({ testRequestedAt: null }).where(eq(s.id, stream.id)),
    ]);
    return "stale";
  }
  const protection = await platformProtection(db.global, now);
  if (deps.paused || protection.actions.includes("block_uploads")) {
    await reschedule(db, row.id, now + AUDIT_STREAM.pausedRetryMs);
    return "kept";
  }
  // The run's claim: one run at a time, taken over only after `runStaleMs`.
  const taken = await db
    .update(o)
    .set({ payload: { startedAt: now } })
    .where(
      and(
        eq(o.id, row.id),
        sql`${o.availableAt} <= ${now}`,
        sql`coalesce(json_extract(${o.payload}, '$.startedAt'), 0) < ${now - AUDIT_STREAM.runStaleMs}`,
      ),
    )
    .returning({ id: o.id });
  if (taken.length !== 1) return "kept";
  let url: string;
  const secrets: string[] = [];
  try {
    url = await open(deps.keys, stream.keyId, stream.id, "url", stream.urlBox);
    secrets.push(await open(deps.keys, stream.keyId, stream.id, "secret", stream.secretBox));
    if ((stream.previousUntil ?? 0) > now) {
      const previous = await openedPrevious(deps.keys, stream);
      if (previous !== null) secrets.push(previous);
    }
  } catch (error) {
    if (!(error instanceof WebhookKeyUnavailableError)) throw error;
    await stop(db, stream, "key_unavailable", now);
    return "stale";
  }
  const checked = checkWebhookUrl(url, "generic");
  if (!checked.ok) {
    await stop(db, stream, "invalid_url", now);
    return "stale";
  }
  const send = (body: string, key: string, source: AuditStreamSource | null) =>
    post(deps, checked.value.url, { body, key, source, streamId: stream.id, secrets, now });
  if (testing) {
    const capped = await dailyCapReached(db, stream, now);
    const testId = hexId("ast_");
    const verdict = capped ? null : await send(testLine(testId, stream.id, now), testId, null);
    await db.batch([
      logAttempt(db, stream, now, {
        outcome: verdict === null ? "skipped" : "test",
        source: null,
        events: 0,
        statusClass: verdict?.statusClass ?? null,
        error: verdict === null ? "daily_cap" : verdict.error,
      }),
      db
        .update(s)
        .set({ testRequestedAt: null })
        .where(and(eq(s.id, stream.id), eq(s.testRequestedAt, stream.testRequestedAt as number))),
    ]);
  }
  if (stream.state !== "active") return "stale";
  if (stream.nextAttemptAt !== null && stream.nextAttemptAt > now) {
    await reschedule(db, row.id, stream.nextAttemptAt);
    return "kept";
  }
  return deliverBatches(db, row, stream, found.plan, now, deps, send);
}

type StreamVerdictLike = ReturnType<typeof classifyStreamAttempt>;
type Send = (
  body: string,
  key: string,
  source: AuditStreamSource | null,
) => Promise<StreamVerdictLike>;

/** The platform stops a stream that can never send as it is: attention, with its audit event. */
async function stop(
  db: RegionalDb,
  stream: StreamRow,
  reason: "invalid_url" | "key_unavailable",
  now: number,
) {
  await db.batch([
    logAttempt(db, stream, now, {
      outcome: "failed",
      source: null,
      events: 0,
      statusClass: null,
      error: reason,
    }),
    ...autoPause(db, stream, reason, now),
    db.update(s).set({ testRequestedAt: null }).where(eq(s.id, stream.id)),
  ]);
}

/**
 * One row of the stream's log, only while the stream exists: a stream removed during a run takes
 * its log with it, and its run's last write must not fail on the foreign key.
 */
function logAttempt(
  db: Db,
  stream: StreamRow,
  now: number,
  entry: {
    outcome: "delivered" | "failed" | "skipped" | "test";
    source: AuditStreamSource | null;
    events: number;
    statusClass: string | null;
    error: string | null;
  },
) {
  // Columns in schema order: id, stream, owner, at, outcome, source, events, class, error.
  return db
    .insert(sd)
    .select(
      sql`select null, ${stream.id}, ${stream.ownerId}, ${now}, ${entry.outcome}, ${entry.source}, ${entry.events}, ${entry.statusClass}, ${entry.error} where exists (select 1 from ${s} where ${s.id} = ${stream.id})`,
    );
}

/**
 * Counts one request in the owner's daily counter (`rate_limits`, one upsert before the send, so
 * concurrent runs cannot pass it and removing streams never resets it). True when it is spent.
 */
async function dailyCapReached(db: RegionalDb, stream: StreamRow, now: number) {
  const day = utcDayStart(now);
  const hit = await hitRateLimit(
    db.global.$client,
    `audit-stream:attempts:${stream.ownerId}:${day}`,
    2 * DAY_MS,
    now,
  );
  return hit.count > AUDIT_STREAM.attemptsPerOwnerPerDay;
}

/** Sends one signed request and classifies the answer; nothing of the response is kept. */
async function post(
  deps: AuditStreamDeps,
  url: string,
  input: {
    body: string;
    key: string;
    source: AuditStreamSource | null;
    streamId: string;
    secrets: readonly string[];
    now: number;
  },
): Promise<StreamVerdictLike> {
  const timestamp = Math.floor(input.now / 1000);
  const signatures = await Promise.all(
    input.secrets.map((secret) => signWebhook(secret, input.key, timestamp, input.body)),
  );
  const headers: Record<string, string> = {
    "content-type": AUDIT_STREAM_CONTENT_TYPE,
    "user-agent": "Portifact-Audit-Stream/1 (+https://portifact.com)",
    "webhook-id": input.key,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "idempotency-key": input.key,
    [AUDIT_STREAM_HEADER]: input.streamId,
  };
  if (input.source !== null) headers[AUDIT_STREAM_SOURCE_HEADER] = input.source;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? AUDIT_STREAM.timeoutMs);
  // The timeout holds even against a network that ignores the signal.
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  let result: StreamAttemptResult;
  try {
    const response = await Promise.race([
      deps.fetch(url, {
        method: "POST",
        headers,
        body: input.body,
        redirect: "manual",
        signal,
      }),
      aborted,
    ]);
    result = {
      kind: "status",
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
    };
    await drain(response, AUDIT_STREAM.responseReadBytes, signal);
  } catch (error) {
    result = signal.aborted
      ? { kind: "timeout" }
      : { kind: "network", message: error instanceof Error ? error.message : "" };
  }
  return classifyStreamAttempt(result, input.now);
}

/**
 * The next batch of one database: its gap line if events recorded since the position may have
 * been swept, then the settled events after the position in recorded order, presented as the
 * export presents them.
 */
async function nextBatch(
  db: RegionalDb,
  stream: StreamRow,
  source: AuditStreamSource,
  position: StreamPosition,
  gapTo: number | null,
  bound: number,
  settleMs: number,
  bounds: { events: number; bytes: number },
): Promise<{ batch: StreamBatch | null; complete: boolean }> {
  const rows = await streamEventsAfter(source === "global" ? db.global : db, {
    ownerId: stream.ownerId,
    source,
    after: position,
    settleMs,
    limit: bounds.events,
  });
  const events = rows.length === 0 ? [] : await presentAuditEvents(db, stream.ownerId, rows);
  const lines = events.map((event, index) => ({
    at: (rows[index] as (typeof rows)[number]).recordedAt,
    id: event.id,
    line: auditJsonLine(event),
  }));
  const gap = streamGap(position, gapTo, bound);
  const batch = buildStreamBatch({ source, gap, lines, bounds });
  // Everything there was fits in this batch: nothing is left behind it in this database.
  return { batch, complete: rows.length < bounds.events && (batch?.events ?? 0) === rows.length };
}

async function deliverBatches(
  db: RegionalDb,
  row: OutboxRow,
  stream: StreamRow,
  plan: Parameters<typeof entitlements>[0],
  now: number,
  deps: AuditStreamDeps,
  send: Send,
): Promise<JobOutcome> {
  const bounds = deps.bounds ?? {
    events: AUDIT_STREAM.eventsPerBatch,
    bytes: AUDIT_STREAM.bytesPerBatch,
    batchesPerRun: AUDIT_STREAM.batchesPerRun,
  };
  const settleMs = deps.settleMs ?? AUDIT_STREAM.settleMs;
  const retentionDays = entitlements(plan, now).limits.auditRetentionDays;
  const started = Date.now();
  const revision = stream.revision;
  const current = { ...stream };
  const caughtUp = { regional: false, global: false };
  let sent = 0;
  while (sent < bounds.batchesPerRun && !(caughtUp.regional && caughtUp.global)) {
    for (const source of AUDIT_STREAM_SOURCES) {
      if (caughtUp[source] || sent >= bounds.batchesPerRun) continue;
      // The stream as it is now: an admin's change or the platform's pause since the run began
      // ends the run, and its next run starts from what the stream has become.
      const [now_] = await db
        .select({ revision: s.revision, state: s.state })
        .from(s)
        .where(eq(s.id, stream.id))
        .limit(1);
      if (!now_ || now_.revision !== revision || now_.state !== "active") {
        await reschedule(db, row.id, now);
        return "kept";
      }
      const from = positionOf(current, source);
      const gapTo = gapToOf(current, source);
      // The sweep's own cutoff, taken again for each batch, plus the margin.
      const bound = streamRiskBound(retentionDays, now + (Date.now() - started));
      const { batch, complete } = await nextBatch(
        db,
        stream,
        source,
        from,
        gapTo,
        bound,
        settleMs,
        bounds,
      );
      if (!batch) {
        caughtUp[source] = true;
        continue;
      }
      if (await dailyCapReached(db, stream, now)) {
        const day = utcDayStart(now);
        const noted = sql`exists (select 1 from ${sd} where ${sd.streamId} = ${stream.id} and ${sd.at} >= ${day} and ${sd.error} = 'daily_cap')`;
        await db.batch([
          db
            .insert(sd)
            .select(
              sql`select null, ${stream.id}, ${stream.ownerId}, ${now}, 'skipped', ${source}, 0, null, 'daily_cap' where not ${noted}`,
            ),
          reschedule(db, row.id, day + DAY_MS),
        ]);
        return "kept";
      }
      const key = await streamBatchKey(stream.id, source, batch.first, batch.through);
      const verdict = await send(batch.body, key, source);
      sent += 1;
      if (!verdict.delivered) return failed(db, row, stream, source, batch, verdict, now);
      // The position moves only now, only from where this run read it and only while the stream
      // is still the one the batch went to: a batch sent to a destination the admin just left
      // never advances the stream, and goes again to the new one.
      const results = await db.batch([
        db
          .update(s)
          .set({
            ...(batch.events > 0 ? setPosition(source, batch.through) : {}),
            failures: 0,
            failingSince: null,
            nextAttemptAt: null,
            ...(batch.gap
              ? {
                  ...setGapTo(source, batch.gap.to),
                  gapSource: source,
                  gapFrom: batch.gap.from,
                  gapTo: batch.gap.to,
                }
              : {}),
          })
          .where(and(eq(s.id, stream.id), eq(s.revision, revision), standsAt(source, from)))
          .returning(),
        logAttempt(db, stream, now, {
          outcome: "delivered",
          source,
          events: batch.events,
          statusClass: verdict.statusClass,
          error: null,
        }),
      ]);
      const [moved] = results[0] as StreamRow[];
      if (!moved) {
        await reschedule(db, row.id, now);
        return "kept";
      }
      Object.assign(current, moved);
      if (complete) caughtUp[source] = true;
    }
  }
  if (!(caughtUp.regional && caughtUp.global)) {
    await reschedule(db, row.id, now);
    return "kept";
  }
  // Caught up in both: every event the database recorded before the settle window is delivered.
  // Positions stay on the last event (the database's clock moves on its own); the time is kept
  // for the dashboard's lag.
  await db.batch([
    db
      .update(s)
      .set({ deliveredThrough: sql`${schema.recordedNow} - ${settleMs}` })
      .where(and(eq(s.id, stream.id), eq(s.revision, revision))),
    reschedule(db, row.id, now + AUDIT_STREAM.idleMs),
  ]);
  return "kept";
}

/**
 * Records a failed request: the failure count and since when (kept in SQL, so a run never writes
 * back a time the admin's change just cleared), the next time a request may go (the endpoint's
 * `Retry-After` or the backoff) and, once it has failed for `attentionAfterMs`, the pause with the
 * state `attention` and its audit event. Every write holds only while the revision is the run's.
 * Nothing moves the position.
 */
async function failed(
  db: RegionalDb,
  row: OutboxRow,
  stream: StreamRow,
  source: AuditStreamSource,
  batch: StreamBatch,
  verdict: StreamVerdictLike,
  now: number,
): Promise<JobOutcome> {
  const next = nextStreamAttemptAt(stream.failures + 1, now, verdict.retryAfterMs);
  const same = sql`${s.revision} = ${stream.revision}`;
  const attention = needsAttention(stream.failingSince ?? now, now);
  const failingLong = sql`coalesce(${s.failingSince}, ${now}) <= ${now - AUDIT_STREAM.attentionAfterMs}`;
  const pause = attention
    ? autoPause(db, stream, "failures", now, sql`${same} and ${failingLong}`)
    : null;
  const results = await db.batch([
    logAttempt(db, stream, now, {
      outcome: "failed",
      source,
      events: batch.events,
      statusClass: verdict.statusClass,
      error: verdict.error,
    }),
    db
      .update(s)
      .set({
        failures: sql`${s.failures} + 1`,
        failingSince: sql`coalesce(${s.failingSince}, ${now})`,
        nextAttemptAt: next,
      })
      .where(and(eq(s.id, stream.id), same)),
    ...(pause ?? []),
  ] as unknown as Batch);
  const paused = pause !== null && (results.at(-1) as { id: string }[]).length === 1;
  if (paused) return "stale";
  await reschedule(db, row.id, next);
  return "kept";
}

// Maintenance

export interface AuditStreamMaintenance {
  prunedDeliveries: number;
  armed: number;
}

/**
 * The scan of one region (run by the jobs Worker only while streams are switched on): prunes the
 * delivery log past `logDays` (one statement of at most `logPruneBatch` rows) and gives a job to
 * at most `armPerRun` active streams (or streams with a test waiting) that have none, in one
 * statement. One D1 call per region and run, whatever the number of owners or streams.
 */
export async function maintainAuditStreams(
  db: RegionalDb,
  now: number,
): Promise<AuditStreamMaintenance> {
  const cutoff = now - AUDIT_STREAM.logDays * DAY_MS;
  const [pruned, armed] = await db.batch([
    db
      .delete(sd)
      .where(
        inArray(
          sd.id,
          db
            .select({ id: sd.id })
            .from(sd)
            .where(lt(sd.at, cutoff))
            .orderBy(sd.id)
            .limit(AUDIT_STREAM.logPruneBatch),
        ),
      )
      .returning({ id: sd.id }),
    db
      .insert(o)
      .select(
        sql`select null, 'audit_stream', '{}', ${now}, null, 0, ${now}, ${s.id}, null from ${s} where (${s.state} = 'active' or ${s.testRequestedAt} is not null) and not exists (select 1 from ${o} where ${o.topic} = 'audit_stream' and ${o.subject} = ${s.id}) order by ${s.id} limit ${AUDIT_STREAM.armPerRun}`,
      )
      .returning({ id: o.id }),
  ]);
  return { prunedDeliveries: pruned.length, armed: armed.length };
}

/**
 * Re-seals streams sealed with an older key (`WEBHOOK_KEY_PREVIOUS`) with the current one, up to
 * `limit` a run, as `rewrapWebhookKeys` does for webhooks, bumping each stream's revision. Without
 * a previous key there is nothing to re-seal and it reads nothing.
 */
export async function rewrapAuditStreamKeys(
  db: RegionalDb,
  keys: Keys,
  limit = 100,
): Promise<{ rewrapped: number; left: number }> {
  const [current] = keys;
  if (!current || keys.length < 2) return { rewrapped: 0, left: 0 };
  const known = keys.map((key) => key.id);
  const rows = await db
    .select()
    .from(s)
    .where(and(ne(s.keyId, current.id), inArray(s.keyId, known)))
    .limit(limit);
  let rewrapped = 0;
  for (const row of rows) {
    const reseal = (box: string, purpose: "url" | "secret") =>
      open(keys, row.keyId, row.id, purpose, box).then((plain) =>
        seal(current, row.id, purpose, plain),
      );
    const updated = await db
      .update(s)
      .set({
        keyId: current.id,
        urlBox: await reseal(row.urlBox, "url"),
        secretBox: await reseal(row.secretBox, "secret"),
        previousSecretBox:
          row.previousSecretBox === null ? null : await reseal(row.previousSecretBox, "secret"),
        revision: sql`${s.revision} + 1`,
      })
      .where(and(eq(s.id, row.id), eq(s.keyId, row.keyId), eq(s.revision, row.revision)))
      .returning({ id: s.id });
    rewrapped += updated.length;
  }
  const [left] = await db
    .select({ count: sql<number>`count(*)` })
    .from(s)
    .where(ne(s.keyId, current.id));
  return { rewrapped, left: Number(left?.count ?? 0) };
}
