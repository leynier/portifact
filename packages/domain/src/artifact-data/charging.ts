// Per-artifact daily counters, charged by measured work (decision 0026, "Limits and counting").
// Work of a class is refused before it starts when the class's counter is already spent, and the
// refusal writes nothing; otherwise, after the work, what the cursors measured plus the charge
// statement's own rows is added to the class's counter in the same transaction. One operation's
// overshoot is therefore at most its own charge, which its per-operation caps bound
// (`OPERATION_ROW_BOUNDS`). Reads, replays and refusals are counted in memory and persisted in
// batches; every terminal outcome of a command is metered by `meter` (metering.ts).
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type ChargeClass,
  type DayCounters,
  MAX_COLLECTIONS,
  MAX_INDEXED_FIELDS,
} from "@portifact/contracts/artifact-data";
import { type Refusal, refuse } from "./decision.ts";

export interface Cost {
  rowsRead: number;
  rowsWritten: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The UTC day a time falls in. */
export function dayOf(now: number): number {
  return Math.floor(now / DAY_MS);
}

/** The minute a time falls in: the window of per-author rates. */
export function minuteOf(now: number): number {
  return Math.floor(now / MINUTE_MS);
}

export function emptyDay(day: number): DayCounters {
  return {
    day,
    growth: 0,
    read: 0,
    cleanup: 0,
    export: 0,
    rights: 0,
    protected: 0,
    live: 0,
    refused: 0,
    intents: 0,
  };
}

/**
 * The plan's daily limit of a class. `rights` is each visitor's own allowance; `protected` has
 * none: it is never refused.
 */
export function classLimit(charge: ChargeClass, limits: ArtifactDataLimits): number {
  switch (charge) {
    case "growth":
      return limits.rowsWrittenPerDay;
    case "read":
      return limits.rowsReadPerDay;
    case "cleanup":
      return limits.cleanupRowsPerDay;
    case "export":
      return limits.exportRowsPerDay;
    case "rights":
      return limits.rightsRowsPerDay;
    case "protected":
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * The refusal of work whose class's counter is already spent, or null. `used` includes reads
 * counted in memory for the read class, and is the visitor's own row for rights. Growth and reads
 * answer `quota_exceeded`; cleanup, export and rights answer `rate_limited`, since they come back
 * the next day; protected work is never refused.
 */
export function spentRefusal(
  charge: ChargeClass,
  used: number,
  limits: ArtifactDataLimits,
): Refusal | null {
  if (used < classLimit(charge, limits)) return null;
  if (charge === "growth" || charge === "read") {
    return refuse("quota_exceeded", "this artifact's data budget for today is spent");
  }
  return refuse("rate_limited", `this artifact's ${charge} allowance for today is spent`);
}

/** What one operation adds to its class: every row it read and wrote, plus the charge's own. */
export function measuredCharge(cost: Cost): number {
  return (
    cost.rowsRead +
    cost.rowsWritten +
    ARTIFACT_DATA.chargeSelf.read +
    ARTIFACT_DATA.chargeSelf.written
  );
}

/**
 * The day's counters after charging one operation's measured work to its class, with the reads
 * and refusals counted in memory since the last write folded in. Counters only grow.
 */
export function charged(
  day: DayCounters,
  charge: ChargeClass,
  cost: Cost,
  pending: PendingReads,
): DayCounters {
  const next = flushed(day, pending);
  next[charge] += measuredCharge(cost);
  return next;
}

/**
 * The day's counters with what was counted in memory written in (a flush): reads and refusals,
 * and deferred housekeeping as protected work.
 */
export function flushed(day: DayCounters, pending: PendingReads): DayCounters {
  return {
    ...day,
    read: day.read + pending.rows,
    refused: day.refused + pending.refused,
    protected: day.protected + pending.deferred,
  };
}

/** A per-subject, per-minute rate: refused at the limit, writing nothing; otherwise counted. */
export function rateRefusal(used: number, limit: number): Refusal | null {
  if (used < limit) return null;
  return refuse("rate_limited", "too many requests, try again in a minute");
}

/** Reads, replays and refusals counted in memory since the last write of their day's counters. */
export interface PendingReads {
  day: number;
  rows: number;
  refused: number;
  /**
   * Housekeeping rows (alarm pruning) waiting for the next counter write: an alarm never writes a
   * day row for its own work, or an idle object would create the very rows it must later prune,
   * and wake for them again, forever. They never schedule an alarm or force a flush.
   */
  deferred: number;
  /** When the first of them was counted. */
  since: number;
}

export function noPendingReads(now: number): PendingReads {
  return { day: dayOf(now), rows: 0, refused: 0, deferred: 0, since: now };
}

export function hasPending(pending: PendingReads): boolean {
  return pending.rows > 0 || pending.refused > 0;
}

/**
 * Before anything is counted at `now`: pending reads and refusals of an earlier day must first be
 * written into that day's counters (`previous`), and counting starts again for today. Nothing is
 * dropped.
 */
export function rollPending(
  pending: PendingReads,
  now: number,
): { previous: PendingReads | null; current: PendingReads } {
  const today = dayOf(now);
  if (pending.day === today) return { previous: null, current: pending };
  // Deferred housekeeping moves on to today, and so does usage of a day older than the day rows
  // are kept: writing either into an earlier day could recreate a row the alarm already pruned.
  if (pending.day < today - ARTIFACT_DATA.dayKeepDays) {
    return { previous: null, current: { ...pending, day: today } };
  }
  const current = { ...noPendingReads(now), deferred: pending.deferred };
  return { previous: hasPending(pending) ? { ...pending, deferred: 0 } : null, current };
}

/**
 * Pending usage after one uncharged outcome (a read, a replay, an empty answer or a refusal at any
 * stage): its measured rows, and one more refusal when it was refused. `pending` must be today's.
 */
export function counted(
  pending: PendingReads,
  cost: Cost,
  refused: boolean,
  now: number,
): PendingReads {
  const first = !hasPending(pending);
  return {
    ...pending,
    rows: pending.rows + cost.rowsRead + cost.rowsWritten,
    refused: pending.refused + (refused ? 1 : 0),
    since: first ? now : pending.since,
  };
}

/**
 * Whether pending usage must be written now. The command that reaches `readFlush.rows` or
 * `readFlush.refusals` writes it synchronously, which bounds what an eviction loses; at
 * `readFlush.ms` the alarm (`pendingDeadline`) or the next command writes it.
 */
export function mustFlushReads(pending: PendingReads, now: number): boolean {
  if (!hasPending(pending)) return false;
  return (
    pending.rows >= ARTIFACT_DATA.readFlush.rows ||
    pending.refused >= ARTIFACT_DATA.readFlush.refusals ||
    now - pending.since >= ARTIFACT_DATA.readFlush.ms
  );
}

/** When pending usage is due for an alarm, or null with nothing pending. */
export function pendingDeadline(pending: PendingReads): number | null {
  return hasPending(pending) ? pending.since + ARTIFACT_DATA.readFlush.ms : null;
}

/**
 * The live messages a connection may reserve now against the artifact's day: a chunk, or what is
 * left of the day's limit when less; zero refuses. The day's counter therefore never passes the
 * plan's limit at the time of the reservation.
 */
export function liveReservation(used: number, limit: number): number {
  return Math.max(0, Math.min(ARTIFACT_DATA.live.reserveChunk, limit - used));
}

/** The retained control classes one pruning pass walks, each at most `caps.pruneRows`. */
export const RETAINED_CLASSES = [
  "operations",
  "ended",
  "delivered",
  "rates",
  "days",
  "rights",
] as const;
export type RetainedClass = (typeof RETAINED_CLASSES)[number];

/**
 * A command's fixed rows: the control record, the operation record and its audit obligation, the
 * barrier, the collection and its fields, the counters and rates it reads, the storage it touches.
 */
export const COMMAND_ROWS = 100;
/** Rows one indexed value costs at most: the value written, its count read and written, twice
 * over for a replacement (the old value's count and the new). */
export const VALUE_ROWS = 5;
/**
 * The most rows one document's write or delete touches besides its values: the document read,
 * copied and written, its sequence, author count and collection read and written, its unique-key
 * probe and its operation's target.
 */
export const DOCUMENT_BASE_ROWS = 16;
export const DOCUMENT_ROWS = DOCUMENT_BASE_ROWS + VALUE_ROWS * MAX_INDEXED_FIELDS;
/** One document an index step covers: its seek, its copy written, one value and its count. */
export const INDEX_STEP_ROWS = 6;
/** One edit an erasure chunk re-attributes: its seek, the copy written, the collection, the sequence. */
export const EDIT_ROWS = 6;
/**
 * One control row a statement deletes by age or author (an erasure chunk's operation, rate and
 * rights rows, a pruning pass's retained rows): its seek through the index, its lookup by key and
 * its delete. Measured on real SQLite (decision 0026, delivery 4): selecting the keys and deleting
 * each by key costs three rows a row; a `DELETE ... WHERE key IN (SELECT ...)` costs six.
 */
export const DELETED_ROW_ROWS = 3;
/** One operation, rate or rights row an erasure chunk deletes. */
export const ERASED_ROW_ROWS = DELETED_ROW_ROWS;

/**
 * Upper bounds of the rows one operation measures, derived from the per-operation caps, the
 * absolute index and collection caps and the per-row constants above, which name what the work
 * does. Every operation the documents object runs is checked against its bound and a bound passed
 * fails (the in-memory object throws), at the densest legal shapes and in the property sequences;
 * delivery 4's cost tests assert that its SQL stays within them. The overshoot of a spent counter
 * is at most one charge, so at most the operation's bound plus the charge's own rows. Committing a
 * whole erase is not listed: it is protected work, never refused, bounded by the artifact's data
 * limits instead.
 */
export const OPERATION_ROW_BOUNDS = {
  declare:
    COMMAND_ROWS + 2 * MAX_INDEXED_FIELDS + INDEX_STEP_ROWS * ARTIFACT_DATA.caps.indexStepDocuments,
  index_step: COMMAND_ROWS + INDEX_STEP_ROWS * ARTIFACT_DATA.caps.indexStepDocuments,
  create: COMMAND_ROWS + DOCUMENT_ROWS,
  replace: COMMAND_ROWS + 2 * DOCUMENT_ROWS,
  remove: COMMAND_ROWS + DOCUMENT_ROWS,
  bulk_create: COMMAND_ROWS + ARTIFACT_DATA.caps.bulkDocuments * DOCUMENT_ROWS,
  bulk_replace: COMMAND_ROWS + ARTIFACT_DATA.caps.bulkDocuments * 2 * DOCUMENT_ROWS,
  bulk_remove: COMMAND_ROWS + ARTIFACT_DATA.caps.bulkDocuments * DOCUMENT_ROWS,
  erase_author_chunk:
    COMMAND_ROWS +
    ARTIFACT_DATA.caps.eraseChunkDocuments * (DOCUMENT_ROWS + EDIT_ROWS + 3 * ERASED_ROW_ROWS),
  get: COMMAND_ROWS,
  query: COMMAND_ROWS + 2 * (ARTIFACT_DATA.caps.pageDocuments + 1),
  count: COMMAND_ROWS,
  describe: COMMAND_ROWS + MAX_COLLECTIONS * (2 + MAX_INDEXED_FIELDS),
  export_page: COMMAND_ROWS + ARTIFACT_DATA.caps.exportRows + 1,
  prune:
    COMMAND_ROWS + RETAINED_CLASSES.length * (DELETED_ROW_ROWS * ARTIFACT_DATA.caps.pruneRows + 1),
} as const;
export type OperationKind = keyof typeof OPERATION_ROW_BOUNDS;

export function withinBound(kind: OperationKind, cost: Cost): boolean {
  return cost.rowsRead + cost.rowsWritten <= OPERATION_ROW_BOUNDS[kind];
}
