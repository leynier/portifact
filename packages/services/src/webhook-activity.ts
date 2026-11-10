// The write side of webhooks (decision 0009, "Recording an event"): the statements a write adds to
// its own batch so its event exists exactly when the write does, with no extra round trip. They
// upsert the pending row of every enabled webhook of the owner subscribed to the type, and give
// each of those webhooks a delivery job that waits `coalesceMs` for the rest of the burst. Nothing
// is added when the owner's entitlements, which the caller already loaded, lack `webhooks`;
// without a subscribed webhook the statements match no row and write nothing.
import { type AccessMode, WEBHOOK_LIMITS, type WebhookEventType } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import { type Entitlements, eventBit, hasFeature } from "@portifact/domain";
import { type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

export const WEBHOOK_FEATURE = "webhooks";

/** The type of the test event in `webhook_events` (never subscribed, so it has no bit). */
const TEST_TYPE = "webhook.test";

export interface WebhookMark {
  /** The owner's entitlements, loaded with the artifact or the actor. */
  entitlements: Entitlements;
  ownerId: string;
  artifactId: string;
  type: WebhookEventType;
  /** The user who acted, only when they are on the owner side; null otherwise. */
  actorId: string | null;
  /** The version number, or a statement that reads it in the same batch. */
  version?: number | SQL | undefined;
  access?: AccessMode | undefined;
  expiresAt?: number | undefined;
  /**
   * Review events: a statement that computes the review's status and counts as JSON in the same
   * batch (`approvalWebhookSummary`). Never names, addresses or notes.
   */
  review?: SQL | undefined;
  now: number;
  /** The write's own claim or old-state condition. */
  condition: SQL;
}

const w = schema.webhooks;
const we = schema.webhookEvents;
const o = schema.outbox;

/** The webhooks of an owner that take an event of this type. */
function subscribed(ownerId: string, bit: number | null): SQL {
  return sql`${w.ownerId} = ${ownerId} and ${w.disabledAt} is null${bit === null ? sql`` : sql` and (${w.events} & ${bit}) <> 0`}`;
}

/** No delivery job of the webhook is waiting to claim its events. */
export function noFreshJob(webhookId: SQL): SQL {
  return sql`not exists (select 1 from ${o} where ${o.topic} = 'webhook_delivery' and ${o.subject} = ${webhookId} and ${o.payload} = '{}')`;
}

/** Adds this write's counts to the pending row, keeping the actor only while it stays one person. */
function upsert(db: Db, source: SQL) {
  return db
    .insert(we)
    .select(source)
    .onConflictDoUpdate({
      target: [we.webhookId, we.artifactId, we.type],
      set: {
        count: sql`min(1000000, ${we.count} + excluded."count")`,
        lastAt: sql`excluded."last_at"`,
        actorId: sql`case when ${we.actorId} is excluded."actor_id" then ${we.actorId} else null end`,
        version: sql`coalesce(excluded."version", ${we.version})`,
        access: sql`coalesce(excluded."access", ${we.access})`,
        expiresAt: sql`coalesce(excluded."expires_at", ${we.expiresAt})`,
        review: sql`coalesce(excluded."review", ${we.review})`,
      },
    });
}

/** A delivery job for every webhook `where` matches that has none waiting. */
export function deliveryJobs(db: Db, where: SQL, availableAt: number, now: number) {
  // Columns in schema order: id, topic, payload, available, dispatched, attempts, created, subject, generation.
  return db
    .insert(o)
    .select(
      sql`select null, 'webhook_delivery', '{}', ${availableAt}, null, 0, ${now}, ${w.id}, null from ${w} where ${where} and ${noFreshJob(sql`${w.id}`)}`,
    );
}

/** The statements that record one event in the write's batch; none without the feature. */
export function markWebhookEvent(db: Db, mark: WebhookMark): BatchItem<"sqlite">[] {
  if (!hasFeature(mark.entitlements, WEBHOOK_FEATURE)) return [];
  const where = sql`${subscribed(mark.ownerId, eventBit(mark.type))} and ${mark.condition}`;
  // Columns in schema order: webhook, artifact, type, count, first, last, actor, version, access,
  // expires, review.
  return [
    upsert(
      db,
      sql`select ${w.id}, ${mark.artifactId}, ${mark.type}, 1, ${mark.now}, ${mark.now}, ${mark.actorId}, ${mark.version ?? null}, ${mark.access ?? null}, ${mark.expiresAt ?? null}, ${mark.review ?? null} from ${w} where ${where}`,
    ),
    deliveryJobs(db, where, mark.now + WEBHOOK_LIMITS.coalesceMs, mark.now),
  ];
}

/**
 * The expiry scan's statements for one owner: an `artifact.expiring` event per artifact `due`
 * still matches, in the batch that marks the expiry notice, on the same condition.
 */
export function markWebhookExpiring(
  db: Db,
  input: { ownerId: string; artifacts: SQL; now: number },
): BatchItem<"sqlite">[] {
  const a = schema.artifacts;
  const where = subscribed(input.ownerId, eventBit("artifact.expiring"));
  return [
    upsert(
      db,
      sql`select ${w.id}, ${a.id}, 'artifact.expiring', 1, ${input.now}, ${input.now}, null, null, null, ${a.expiresAt}, null from ${w} join ${a} on ${a.ownerId} = ${w.ownerId} where ${where} and ${input.artifacts}`,
    ),
    deliveryJobs(
      db,
      sql`${where} and exists (select 1 from ${a} where ${a.ownerId} = ${w.ownerId} and ${input.artifacts})`,
      input.now + WEBHOOK_LIMITS.coalesceMs,
      input.now,
    ),
  ];
}

/** The test event of one webhook, sent without waiting for a burst. */
export function markWebhookTest(
  db: Db,
  input: { webhookId: string; ownerId: string; actorId: string; now: number },
): BatchItem<"sqlite">[] {
  const where = sql`${w.id} = ${input.webhookId} and ${subscribed(input.ownerId, null)}`;
  return [
    upsert(
      db,
      sql`select ${w.id}, '', ${TEST_TYPE}, 1, ${input.now}, ${input.now}, ${input.actorId}, null, null, null, null from ${w} where ${where}`,
    ),
    deliveryJobs(db, where, input.now, input.now),
  ];
}
