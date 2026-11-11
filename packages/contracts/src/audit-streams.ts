// Audit streams (premium plan E3, feature `auditExport`, decision 0019): continuous delivery of an
// owner's audit log to an HTTPS endpoint the customer runs. Portifact reads the owner's events after
// a stored position in each database and posts them in batches of JSON Lines, advancing the
// position only after a 2xx answer: at least once, ordered per database, never skipping.
import { z } from "zod";

/** Safety caps and timings of audit streams; not plan values (decision 0019). */
export const AUDIT_STREAM = {
  /** Streams one owner can have. */
  perOwner: 2,
  labelMaxLength: 80,
  urlMaxLength: 2_048,
  /**
   * How long after the database recorded an event (`audit_events.recorded_at`, its own clock)
   * the stream sends it: the time a D1 batch that read the clock takes to commit, with room to
   * spare. Ordering by the database's clock instead of the writer's `now` is what makes "never
   * skipping" independent of how old a writer's time is (decision 0019, "Recorded time").
   */
  settleMs: 2 * 60_000,
  /**
   * How much older than its recorded time an event's `at` may be for the gap rule: no writer
   * holds its `now` for a day before writing. Events recorded within this of the retention
   * cutoff may be swept before delivery, so they are reported in a gap.
   */
  gapMarginMs: 24 * 60 * 60_000,
  /** The shortest gap reported after the first; shorter ranges wait and join the next. */
  gapMinMs: 60 * 60_000,
  /** Events one request carries at most. */
  eventsPerBatch: 500,
  /** Bytes of one request's body at most (one event is always sent, whatever its size). */
  bytesPerBatch: 512 * 1_024,
  /** Requests one run of the job sends at most before it hands the rest to its next run. */
  batchesPerRun: 4,
  /** When the job looks again after finding nothing to send. */
  idleMs: 5 * 60_000,
  timeoutMs: 10_000,
  /** Bytes of a response read before it is cancelled; nothing of it is kept. */
  responseReadBytes: 4_096,
  /** Delays after the 1st, 2nd, ... failed request in a row; the last one repeats. */
  retryDelaysMs: [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000],
  /** A `Retry-After` answer is honored within these bounds. */
  retryAfterMinMs: 60_000,
  retryAfterMaxMs: 21_600_000,
  /** Failing for this long without one success pauses the stream with the state `attention`. */
  attentionAfterMs: 72 * 60 * 60_000,
  /** Requests per owner and UTC day, across its streams; removing a stream never resets it. */
  attemptsPerOwnerPerDay: 2_000,
  createsPerOwnerPerDay: 10,
  testsPerOwnerPerHour: 10,
  /** Resumes, URL changes and secret rotations per owner and day. */
  changesPerOwnerPerDay: 20,
  /** How long the previous secret also signs after a rotation. */
  rotationOverlapMs: 24 * 60 * 60_000,
  /** A run that started this long ago without finishing is taken over. */
  runStaleMs: 5 * 60_000,
  /** How long a run waits while deliveries are paused for the whole platform. */
  pausedRetryMs: 15 * 60_000,
  /** Streams the maintenance scan gives a job to per region and run. */
  armPerRun: 100,
  /** Delivery log rows the maintenance scan deletes per region and run. */
  logPruneBatch: 500,
  logDays: 7,
  logPageSize: 50,
} as const;

/** The content type of a stream's requests (a webhook's is `application/json`). */
export const AUDIT_STREAM_CONTENT_TYPE = "application/jsonl; charset=utf-8";
/** The header naming the stream; webhooks never send it. */
export const AUDIT_STREAM_HEADER = "portifact-audit-stream";
/** The header naming the database a batch's events come from. */
export const AUDIT_STREAM_SOURCE_HEADER = "portifact-audit-source";

/** The two databases an owner's events live in (decision 0005): each has its own position. */
export const AUDIT_STREAM_SOURCES = ["regional", "global"] as const;
export const AuditStreamSource = z.enum(AUDIT_STREAM_SOURCES);
export type AuditStreamSource = z.infer<typeof AuditStreamSource>;

export const AuditStreamState = z.enum(["active", "paused", "attention"]);
export type AuditStreamState = z.infer<typeof AuditStreamState>;

/**
 * Why a stream is not sending: `manual` (an admin paused it), `plan` (the owner's plan no longer
 * includes streaming), `failures` (the endpoint failed for `attentionAfterMs`), `invalid_url`
 * (its URL no longer passes the checks) or `key_unavailable` (sealed with a key the Worker no
 * longer holds).
 */
export const AUDIT_STREAM_PAUSE_REASONS = [
  "manual",
  "plan",
  "failures",
  "invalid_url",
  "key_unavailable",
] as const;
export const AuditStreamPauseReason = z.enum(AUDIT_STREAM_PAUSE_REASONS);
export type AuditStreamPauseReason = z.infer<typeof AuditStreamPauseReason>;

/** The reasons the platform pauses a stream on its own (recorded as `audit_stream.paused`). */
export const AuditStreamAutoPause = z.enum(["plan", "failures", "invalid_url", "key_unavailable"]);
export type AuditStreamAutoPause = z.infer<typeof AuditStreamAutoPause>;

/**
 * Why a request failed, in plain words for the admin: never the response body. `unreachable`
 * (no connection), `certificate` (the TLS handshake failed), `timeout`, `redirect` (any 3xx, never
 * followed), `refused` (a 4xx or 5xx: see the status class), `daily_cap` (skipped, the owner's
 * daily requests are spent).
 */
export const AUDIT_STREAM_ERRORS = [
  "unreachable",
  "certificate",
  "timeout",
  "redirect",
  "refused",
  "invalid_url",
  "key_unavailable",
  "daily_cap",
] as const;
export const AuditStreamError = z.enum(AUDIT_STREAM_ERRORS);
export type AuditStreamError = z.infer<typeof AuditStreamError>;

export const AuditStreamStatusClass = z.enum(["2xx", "3xx", "4xx", "5xx"]);
export type AuditStreamStatusClass = z.infer<typeof AuditStreamStatusClass>;

/** Where a new stream starts: events from now on, or the oldest event the owner still keeps. */
export const AuditStreamStart = z.enum(["now", "oldest"]);
export type AuditStreamStart = z.infer<typeof AuditStreamStart>;

export const AuditStreamId = z.string().regex(/^as_[0-9a-f]{32}$/, "Invalid stream id");
export type AuditStreamId = z.infer<typeof AuditStreamId>;

const label = z.string().trim().min(1).max(AUDIT_STREAM.labelMaxLength);
const url = z.string().min(1).max(AUDIT_STREAM.urlMaxLength);

/** Body of POST /api/v1/audit/streams. */
export const AuditStreamCreate = z.strictObject({
  label,
  url,
  start: AuditStreamStart.default("now"),
});
export type AuditStreamCreate = z.infer<typeof AuditStreamCreate>;

/**
 * Body of PATCH /api/v1/audit/streams/:id: a new label or URL, pausing or resuming, or a new
 * signing secret (returned once in the answer).
 */
export const AuditStreamUpdate = z
  .strictObject({
    label: label.optional(),
    url: url.optional(),
    state: z.enum(["active", "paused"]).optional(),
    rotateSecret: z.literal(true).optional(),
    /** With `rotateSecret`: the old secret stops signing at once instead of after a day. */
    revokeOldSecret: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Send label, url, state or rotateSecret.",
  })
  .refine((body) => body.revokeOldSecret === undefined || body.rotateSecret === true, {
    message: "revokeOldSecret goes with rotateSecret.",
  });
export type AuditStreamUpdate = z.infer<typeof AuditStreamUpdate>;

export const AuditStreamAttempt = z.object({
  at: z.iso.datetime(),
  outcome: z.enum(["delivered", "failed", "skipped", "test"]),
  source: AuditStreamSource.nullable(),
  /** Events the request carried (0 for a test or a gap alone). */
  events: z.number().int().nonnegative(),
  statusClass: AuditStreamStatusClass.nullable(),
  error: AuditStreamError.nullable(),
});
export type AuditStreamAttempt = z.infer<typeof AuditStreamAttempt>;

/** The range of events a stream could not deliver because the retention sweep had passed them. */
export const AuditStreamGap = z.object({
  source: AuditStreamSource,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});
export type AuditStreamGap = z.infer<typeof AuditStreamGap>;

export const AuditStreamView = z.object({
  id: AuditStreamId,
  label: z.string(),
  /** Only the host: the full URL is never shown again after it is set. */
  host: z.string(),
  state: AuditStreamState,
  pausedReason: AuditStreamPauseReason.nullable(),
  pausedAt: z.iso.datetime().nullable(),
  /** Every event up to this time has been delivered (or reported in a gap); null before any. */
  deliveredThrough: z.iso.datetime().nullable(),
  /** Milliseconds between now and `deliveredThrough`, null before any. Includes `settleMs`. */
  lagMs: z.number().int().nonnegative().nullable(),
  /** Requests failed in a row, and since when. */
  failures: z.number().int().nonnegative(),
  failingSince: z.iso.datetime().nullable(),
  lastAttempt: AuditStreamAttempt.nullable(),
  /** The last gap the stream reported, if any. */
  lastGap: AuditStreamGap.nullable(),
  /** Whether a test is waiting to be sent. */
  testPending: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Display name of who created it, while that account exists. */
  createdBy: z.string().nullable(),
});
export type AuditStreamView = z.infer<typeof AuditStreamView>;

export const AuditStreamList = z.object({
  streams: z.array(AuditStreamView),
  /** Whether the owner's plan includes streaming (`auditExport` and `audit`). */
  available: z.boolean(),
  /** Whether Portifact delivers streams at all yet (`WEBHOOKS_ENABLED` and `WEBHOOK_KEY`). */
  serviceAvailable: z.boolean(),
  /** Whether the owner's data is kept in the EU while the endpoint may not be. */
  euOwner: z.boolean(),
  limit: z.number().int().positive(),
  settleMinutes: z.number().int().positive(),
});
export type AuditStreamList = z.infer<typeof AuditStreamList>;

/** Answer of a create or a rotation: the stream, and its signing secret once. */
export const AuditStreamWithSecret = z.object({
  stream: AuditStreamView,
  secret: z.string(),
});
export type AuditStreamWithSecret = z.infer<typeof AuditStreamWithSecret>;

export const AuditStreamDeliveries = z.object({
  streamId: AuditStreamId,
  /** Newest first, at most the last `logDays` days. */
  attempts: z.array(AuditStreamAttempt),
  retentionDays: z.number().int().positive(),
});
export type AuditStreamDeliveries = z.infer<typeof AuditStreamDeliveries>;

export const AuditStreamTestQueued = z.object({ streamId: AuditStreamId, queued: z.literal(true) });
export type AuditStreamTestQueued = z.infer<typeof AuditStreamTestQueued>;
export const AuditStreamRemoved = z.object({ streamId: AuditStreamId, removed: z.literal(true) });
export type AuditStreamRemoved = z.infer<typeof AuditStreamRemoved>;

/** A gap line: events in `[from, to)` of `source` were past retention and are not delivered. */
export interface AuditStreamGapRecord {
  record: "gap";
  source: AuditStreamSource;
  from: string;
  to: string;
  reason: "retention";
}

/** The synthetic line of a test request: no event, nothing of the owner's. */
export interface AuditStreamTestRecord {
  record: "test";
  id: string;
  at: string;
  stream: string;
}
