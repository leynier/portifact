// Shapes of webhooks (premium plan P6, decision 0009): the owner's HTTPS destinations for events
// about their artifacts, managed through /api/v1/webhooks, the MCP webhook tools, `portifact
// webhooks` and the dashboard's Webhooks page, and the jobs that deliver them.
import { z } from "zod";
import { AccessMode, ArtifactId } from "./core.ts";

/** Safety caps and timings of webhooks; not plan values (decision 0009). */
export const WEBHOOK_LIMITS = {
  /** Webhooks one owner can have. */
  perOwner: 10,
  urlMaxLength: 2_048,
  /** How long a write's events wait for others before the delivery goes. */
  coalesceMs: 60_000,
  /** Pending rows one delivery carries at most; the rest go in the next. */
  eventsPerDelivery: 50,
  timeoutMs: 10_000,
  /** Bytes of a response read before it is cancelled; nothing of it is kept. */
  responseReadBytes: 4_096,
  /** Delays before the 2nd to 6th attempts of a delivery. */
  retryDelaysMs: [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000],
  /** Failed attempts in a row that disable a webhook. */
  disableAfterFailures: 15,
  /** Delivery attempts per owner and UTC day. */
  attemptsPerOwnerPerDay: 1_000,
  /** How long a deferred delivery waits while deliveries are paused. */
  pausedRetryMs: 15 * 60_000,
  /** An attempt that started this long ago without a result is taken over. */
  attemptStaleMs: 5 * 60_000,
  logDays: 7,
  logPageSize: 100,
} as const;

/** Event types a webhook can subscribe to, with their bit in `webhooks.events`. */
export const WEBHOOK_EVENTS = [
  "comment.created",
  "thread.resolved",
  "artifact.published",
  "artifact.expiring",
  "artifact.access_changed",
] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENTS);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

/** The test event: sent on request, never subscribed to. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export const WEBHOOK_FORMAT_NAMES = ["generic", "slack", "discord"] as const;
export const WebhookFormat = z.enum(WEBHOOK_FORMAT_NAMES);
export type WebhookFormat = z.infer<typeof WebhookFormat>;

export const WebhookState = z.enum(["active", "disabled", "paused"]);
export type WebhookState = z.infer<typeof WebhookState>;

export const WebhookDisabledReason = z.enum(["manual", "failures", "gone", "invalid_url"]);
export type WebhookDisabledReason = z.infer<typeof WebhookDisabledReason>;

export const WebhookId = z.string().regex(/^wh_[0-9a-f]{32}$/, "Invalid webhook id");
export type WebhookId = z.infer<typeof WebhookId>;

export const WebhookDeliveryId = z.string().regex(/^whd_[0-9a-f]{32}$/);

const events = z
  .array(WebhookEventType)
  .min(1, "Choose at least one event.")
  .max(WEBHOOK_EVENTS.length)
  .refine((list) => new Set(list).size === list.length, "List each event once.");

/** Body of POST /api/v1/webhooks and input of create_webhook. */
export const WebhookCreate = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(WEBHOOK_LIMITS.urlMaxLength)
    .describe("The HTTPS URL that receives the events."),
  format: WebhookFormat.default("generic").describe(
    "generic (signed JSON), slack (a Slack incoming webhook URL) or discord (a Discord webhook URL).",
  ),
  events: events.describe("The event types to send."),
});
export type WebhookCreate = z.infer<typeof WebhookCreate>;

/** Body of PATCH /api/v1/webhooks/:id: enable or disable it, or change its events. */
export const WebhookUpdate = z
  .strictObject({
    enabled: z.boolean().optional(),
    events: events.optional(),
  })
  .refine((body) => body.enabled !== undefined || body.events !== undefined, {
    message: "Send enabled, events or both.",
  });
export type WebhookUpdate = z.infer<typeof WebhookUpdate>;

export const WebhookAttempt = z.object({
  deliveryId: z.string(),
  attempt: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  outcome: z.enum(["delivered", "failed", "skipped"]),
  /** The receiver's HTTP status, when it answered. */
  status: z.number().int().nullable(),
  /** Why it failed or was skipped without a status: timeout, network, redirect, invalid_url or daily_cap. */
  error: z.string().nullable(),
});
export type WebhookAttempt = z.infer<typeof WebhookAttempt>;

export const WebhookView = z.object({
  id: WebhookId,
  /** Only the host: the full URL is never shown again after creation. */
  host: z.string(),
  format: WebhookFormat,
  events: z.array(WebhookEventType),
  /** `paused` while the owner's plan does not include webhooks. */
  state: WebhookState,
  disabledReason: WebhookDisabledReason.nullable(),
  disabledAt: z.iso.datetime().nullable(),
  /** Failed attempts in a row. */
  failures: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  lastAttempt: WebhookAttempt.nullable(),
});
export type WebhookView = z.infer<typeof WebhookView>;

export const WebhookList = z.object({
  webhooks: z.array(WebhookView),
  /** Whether the owner's plan includes webhooks. */
  available: z.boolean(),
  limit: z.number().int().positive(),
});
export type WebhookList = z.infer<typeof WebhookList>;

/** Answer of the create: the webhook, and its signing secret once (null for Slack and Discord). */
export const WebhookCreated = z.object({
  webhook: WebhookView,
  secret: z.string().nullable(),
});
export type WebhookCreated = z.infer<typeof WebhookCreated>;

export const WebhookDeliveries = z.object({
  webhookId: WebhookId,
  /** Newest first, at most the last 7 days. */
  attempts: z.array(WebhookAttempt),
  retentionDays: z.number().int().positive(),
});
export type WebhookDeliveries = z.infer<typeof WebhookDeliveries>;

export const WebhookTestQueued = z.object({
  webhookId: WebhookId,
  queued: z.literal(true),
});
export type WebhookTestQueued = z.infer<typeof WebhookTestQueued>;

export const WebhookRemoved = z.object({
  webhookId: WebhookId,
  removed: z.literal(true),
});
export type WebhookRemoved = z.infer<typeof WebhookRemoved>;

/** Inputs of the MCP webhook tools; the owner comes from the token. */
export const ListWebhooksInput = z.object({});
export const WebhookRef = z.object({
  webhookId: WebhookId.describe("The webhook ID, as list_webhooks returns it."),
});
export type WebhookRef = z.infer<typeof WebhookRef>;
export const UpdateWebhookInput = z.object({
  webhookId: WebhookId.describe("The webhook ID, as list_webhooks returns it."),
  enabled: z.boolean().optional().describe("true to enable it again, false to stop it."),
  events: events.optional().describe("The event types to send from now on."),
});
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>;

/** The artifact an event is about, in the generic body. */
export const WebhookArtifactRef = z.strictObject({
  id: ArtifactId,
  name: z.string(),
  url: z.url(),
  viewUrl: z.url(),
});

/** One event of a generic delivery: counts, times and IDs, never comment text or emails. */
export const WebhookEventBody = z.strictObject({
  type: z.union([WebhookEventType, z.literal(WEBHOOK_TEST_EVENT)]),
  artifact: WebhookArtifactRef.nullable(),
  count: z.number().int().positive(),
  firstAt: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  /** The member who acted, only while one person on the owner side did everything counted. */
  actor: z.strictObject({ name: z.string() }).nullable(),
  version: z.number().int().positive().optional(),
  access: AccessMode.optional(),
  expiresAt: z.iso.datetime().optional(),
});
export type WebhookEventBody = z.infer<typeof WebhookEventBody>;

/** The body of a generic delivery, as receivers get it. */
export const WebhookDeliveryBody = z.strictObject({
  id: WebhookDeliveryId,
  webhookId: WebhookId,
  createdAt: z.iso.datetime(),
  test: z.boolean(),
  events: z.array(WebhookEventBody).min(1).max(WEBHOOK_LIMITS.eventsPerDelivery),
});
export type WebhookDeliveryBody = z.infer<typeof WebhookDeliveryBody>;

/**
 * Payload of a `webhook_delivery` job (its subject is the webhook): `{}` until the job claims
 * its events, then the delivery, the attempt it is on and when that attempt started.
 */
export const WebhookJobPayload = z.union([
  z.strictObject({}),
  z.strictObject({
    delivery: WebhookDeliveryBody,
    attempt: z.number().int().min(1),
    startedAt: z.number().int().nonnegative().nullable(),
  }),
]);
export type WebhookJobPayload = z.infer<typeof WebhookJobPayload>;
