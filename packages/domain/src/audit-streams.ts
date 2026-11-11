// Audit streams (premium plan E3, decision 0019): which events a stream sends next, how one
// request's body is built and bounded, when a stream reports a gap, how an answer is classified
// and when the next request goes. Pure: the services read, present, seal, sign, send and store.
import {
  AUDIT_STREAM,
  type AuditStreamError,
  type AuditStreamGapRecord,
  type AuditStreamSource,
  type AuditStreamStatusClass,
  type AuditStreamTestRecord,
} from "@portifact/contracts";
import { auditPruneCutoff } from "./audit.ts";

/**
 * Where a stream stands in one database: the time and ID of the last event it delivered, in the
 * log's order oldest first. A null time means "from the oldest event still kept" (a new stream
 * that asked for a backfill); an empty ID means "after every event before `at`".
 */
export interface StreamPosition {
  at: number | null;
  id: string;
}

/**
 * Events recorded before this may already be gone, or go before the stream reads them: the
 * sweep deletes by `at` before `auditPruneCutoff`, and an event's `at` is at most
 * `AUDIT_STREAM.gapMarginMs` older than when it was recorded. Unrounded, from the same function
 * the sweep uses, and taken again for every batch of a run.
 */
export function streamRiskBound(retentionDays: number, now: number): number {
  return auditPruneCutoff(retentionDays, now) + AUDIT_STREAM.gapMarginMs;
}

/**
 * The gap a stream reports in one database before its next events, or null. Everything recorded
 * from the later of the position and the gap already reported (`gapTo`) up to `bound` may have
 * been deleted, or may be before the stream reads it: the stream says so and keeps reading from
 * its position, so whatever is still kept in that range is still sent. A fresh backfill (no
 * position, no gap reported) claims nothing. A range shorter than `gapMinMs` waits, so a stream
 * that lags at the edge reports contiguous ranges, not one per run; the next report starts where
 * the last ended, so nothing is left out.
 */
export function streamGap(
  position: StreamPosition,
  gapTo: number | null,
  bound: number,
): { from: number; to: number } | null {
  const starts = [position.at, gapTo].filter((value): value is number => value !== null);
  if (starts.length === 0) return null;
  const from = Math.max(...starts);
  if (from >= bound) return null;
  if (gapTo !== null && bound - from < AUDIT_STREAM.gapMinMs) return null;
  return { from, to: bound };
}

/** One event already presented as the export's JSON Lines line, with its position. */
export interface StreamLine {
  at: number;
  id: string;
  line: string;
}

export interface StreamBatch {
  source: AuditStreamSource;
  body: string;
  /** Events in the body. */
  events: number;
  gap: { from: number; to: number } | null;
  /** The position after the batch: its last event, or the gap's end when it has none. */
  through: StreamPosition;
  first: StreamPosition;
}

const encoder = new TextEncoder();

/** The gap line, before any event of its database. */
export function gapLine(source: AuditStreamSource, gap: { from: number; to: number }): string {
  const record: AuditStreamGapRecord = {
    record: "gap",
    source,
    from: new Date(gap.from).toISOString(),
    to: new Date(gap.to).toISOString(),
    reason: "retention",
  };
  return `${JSON.stringify(record)}\n`;
}

/** The one line of a test request: marked as a test, with nothing of the owner's. */
export function testLine(id: string, streamId: string, now: number): string {
  const record: AuditStreamTestRecord = {
    record: "test",
    id,
    at: new Date(now).toISOString(),
    stream: streamId,
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * One request's body: the gap line if any, then events in order until `eventsPerBatch` events or
 * `bytesPerBatch` bytes; the first event always goes, whatever its size, so a stream never stalls.
 * Null when there is nothing to say. `lines` must be in the log's order, oldest first.
 */
export function buildStreamBatch(input: {
  source: AuditStreamSource;
  gap: { from: number; to: number } | null;
  lines: readonly StreamLine[];
  bounds?: { events: number; bytes: number } | undefined;
}): StreamBatch | null {
  const bounds = input.bounds ?? {
    events: AUDIT_STREAM.eventsPerBatch,
    bytes: AUDIT_STREAM.bytesPerBatch,
  };
  if (input.gap === null && input.lines.length === 0) return null;
  let body = input.gap === null ? "" : gapLine(input.source, input.gap);
  let bytes = encoder.encode(body).byteLength;
  let events = 0;
  let last: StreamLine | undefined;
  for (const line of input.lines) {
    if (events >= bounds.events) break;
    const size = encoder.encode(line.line).byteLength;
    if (events > 0 && bytes + size > bounds.bytes) break;
    body += line.line;
    bytes += size;
    events += 1;
    last = line;
  }
  const head = input.lines[0];
  const gapEnd = input.gap ? { at: input.gap.to, id: "" } : null;
  const through = last ? { at: last.at, id: last.id } : (gapEnd as StreamPosition);
  const first = input.gap
    ? { at: input.gap.from, id: "" }
    : { at: (head as StreamLine).at, id: (head as StreamLine).id };
  return { source: input.source, body, events, gap: input.gap, through, first };
}

/**
 * The batch's key, the same on every retry of the same batch: a hash of the stream, the database
 * and the first and last positions. It goes in `webhook-id` (signed) and `idempotency-key`.
 */
export async function streamBatchKey(
  streamId: string,
  source: AuditStreamSource,
  first: StreamPosition,
  through: StreamPosition,
): Promise<string> {
  const material = [streamId, source, first.at, first.id, through.at, through.id].join("|");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `asb_${hex.slice(0, 32)}`;
}

/** How one request ended: the endpoint's answer or the error that stopped it. */
export type StreamAttemptResult =
  | { kind: "status"; status: number; retryAfter?: string | null | undefined }
  | { kind: "timeout" }
  | { kind: "network"; message?: string | undefined };

export interface StreamVerdict {
  delivered: boolean;
  statusClass: AuditStreamStatusClass | null;
  error: AuditStreamError | null;
  /** What `Retry-After` asked for, within bounds, when the answer carried one. */
  retryAfterMs: number | null;
}

/** The class of an HTTP status, as the admin sees it. */
export function statusClass(status: number): AuditStreamStatusClass | null {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return null;
}

/**
 * A `Retry-After` value (seconds or an HTTP date) as a delay, clamped to
 * `retryAfterMinMs`..`retryAfterMaxMs`; null when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  let delay: number;
  if (/^\d+$/.test(text)) {
    delay = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    delay = at - now;
  }
  return Math.min(Math.max(delay, AUDIT_STREAM.retryAfterMinMs), AUDIT_STREAM.retryAfterMaxMs);
}

/** A network error whose message names TLS: the endpoint's certificate did not pass. */
const CERTIFICATE = /certificate|ssl|tls|handshake/i;

/** Classifies one request: only a 2xx delivers; any 3xx is a redirect, never followed. */
export function classifyStreamAttempt(result: StreamAttemptResult, now: number): StreamVerdict {
  if (result.kind === "timeout") {
    return { delivered: false, statusClass: null, error: "timeout", retryAfterMs: null };
  }
  if (result.kind === "network") {
    const error = CERTIFICATE.test(result.message ?? "") ? "certificate" : "unreachable";
    return { delivered: false, statusClass: null, error, retryAfterMs: null };
  }
  const cls = statusClass(result.status);
  if (cls === "2xx") return { delivered: true, statusClass: cls, error: null, retryAfterMs: null };
  return {
    delivered: false,
    statusClass: cls,
    error: cls === "3xx" ? "redirect" : "refused",
    retryAfterMs:
      result.status === 429 || result.status === 503
        ? parseRetryAfter(result.retryAfter, now)
        : null,
  };
}

/**
 * When the next request may go after `failures` failed in a row: the endpoint's `Retry-After`
 * when it gave one, otherwise the backoff, whose last delay repeats.
 */
export function nextStreamAttemptAt(
  failures: number,
  now: number,
  retryAfterMs: number | null = null,
): number {
  if (retryAfterMs !== null) return now + retryAfterMs;
  const delays = AUDIT_STREAM.retryDelaysMs;
  const delay = delays[Math.min(Math.max(failures, 1), delays.length) - 1] as number;
  return now + delay;
}

/** Whether a stream failing since `failingSince` has failed long enough to need attention. */
export function needsAttention(failingSince: number | null, now: number): boolean {
  return failingSince !== null && now - failingSince >= AUDIT_STREAM.attentionAfterMs;
}

/**
 * Up to when every event has been delivered or reported: the older of the two positions, or null
 * while either has none yet.
 */
export function deliveredThrough(regional: number | null, global: number | null): number | null {
  if (regional === null || global === null) return null;
  return Math.min(regional, global);
}
