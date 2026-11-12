// One metering path for every terminal outcome of a command (decision 0026, "How it is counted"):
// success, failure after the work began, refusal at any stage, replay and empty answers alike.
// Charged work (a mutation that ran, an export page, protected work) lands in its class's counter
// in the command's own transaction; uncharged work (reads, replays, empty answers and refusals) is
// counted in memory and written with the next counter write, or synchronously when it reaches a
// flush bound. Reads and refusals of an earlier day are always written into that day before
// today's are counted. An alarm's own pruning is deferred to the next counter write, so an idle
// object never writes a row only to record the work of pruning rows (see `PendingReads.deferred`).
import {
  ARTIFACT_DATA,
  type ChargeClass,
  type DayCounters,
} from "@portifact/contracts/artifact-data";
import {
  type Cost,
  charged,
  counted,
  dayOf,
  flushed,
  hasPending,
  measuredCharge,
  mustFlushReads,
  noPendingReads,
  type PendingReads,
  rollPending,
} from "./charging.ts";

export type Terminal =
  /** Work that ran (or failed after it began), an export page, or protected work. */
  | { kind: "charged"; charge: ChargeClass; author?: string | null }
  /** A read, a replay, an empty answer, or a refusal at any stage (`refused`). */
  | { kind: "uncharged"; refused: boolean }
  /** An alarm's pruning: protected work, deferred to the next counter write (`deferred`). */
  | { kind: "housekeeping" };

export interface MeterInput {
  terminal: Terminal;
  cost: Cost;
  pending: PendingReads;
  /** The stored counters of a day (an empty day when none is stored). */
  day: (day: number) => DayCounters;
  /** A visitor's rights row for today, for a rights charge. */
  rightsUsed?: number;
  /** Whether the object has a control record: without one nothing is written. */
  bound: boolean;
  now: number;
}

export interface MeterResult {
  /** Day rows to write in this transaction, an earlier day's first. */
  days: DayCounters[];
  /** The visitor's rights row for today after a rights charge. */
  rights: { author: string; used: number } | null;
  pending: PendingReads;
}

/** The rows a counter write itself costs: the stated fixed overhead of every write of a day row. */
export const COUNTER_WRITE_ROWS = ARTIFACT_DATA.chargeSelf.read + ARTIFACT_DATA.chargeSelf.written;

/**
 * A day row with pending usage written in as a flush: the flush is a counter write of its own, so
 * its overhead is recorded under `protected`, like every other piece of bookkeeping.
 */
export function flushWrite(day: DayCounters, pending: PendingReads): DayCounters {
  const next = flushed(day, pending);
  return { ...next, protected: next.protected + COUNTER_WRITE_ROWS };
}

/** An earlier day's pending reads, written into that day; its deferred usage moves to today. */
function rolled(input: {
  pending: PendingReads;
  day: (day: number) => DayCounters;
  bound: boolean;
  now: number;
}) {
  const { previous, current } = rollPending(input.pending, input.now);
  if (previous === null) return { days: [] as DayCounters[], pending: current };
  if (input.bound)
    return { days: [flushWrite(input.day(previous.day), previous)], pending: current };
  return {
    days: [] as DayCounters[],
    pending: { ...previous, day: dayOf(input.now), deferred: current.deferred },
  };
}

/**
 * Meters one terminal outcome. On an object without a control record nothing can be written (no
 * identity is bound by metering): usage stays pending in memory until the first binding write.
 */
export function meter(input: MeterInput): MeterResult {
  const roll = rolled(input);
  const days = roll.days;
  let pending = roll.pending;
  const today = dayOf(input.now);
  if (input.terminal.kind === "housekeeping") {
    const deferred = pending.deferred + input.cost.rowsRead + input.cost.rowsWritten;
    return { days, rights: null, pending: { ...pending, deferred } };
  }
  if (input.terminal.kind === "charged") {
    if (!input.bound) {
      return { days, rights: null, pending: counted(pending, input.cost, false, input.now) };
    }
    const author = input.terminal.author ?? null;
    days.push(charged(input.day(today), input.terminal.charge, input.cost, pending));
    return {
      days,
      rights:
        input.terminal.charge === "rights" && author !== null
          ? { author, used: (input.rightsUsed ?? 0) + measuredCharge(input.cost) }
          : null,
      pending: noPendingReads(input.now),
    };
  }
  pending = counted(pending, input.cost, input.terminal.refused, input.now);
  if (input.bound && mustFlushReads(pending, input.now)) {
    days.push(flushWrite(input.day(today), pending));
    pending = noPendingReads(input.now);
  }
  return { days, rights: null, pending };
}

/**
 * The alarm's flush: an earlier day's reads go into that day, today's reads and refusals into
 * today's row with any deferred usage. Deferred usage alone writes nothing and stays pending until
 * an eligible counter write, across midnight included, so pruning never creates a day row.
 */
export function flushPending(input: {
  pending: PendingReads;
  day: (day: number) => DayCounters;
  bound: boolean;
  now: number;
}): { days: DayCounters[]; pending: PendingReads } {
  if (!input.bound) return { days: [], pending: input.pending };
  const roll = rolled(input);
  if (!hasPending(roll.pending)) return roll;
  const today = dayOf(input.now);
  return {
    days: [...roll.days, flushWrite(input.day(today), roll.pending)],
    pending: noPendingReads(input.now),
  };
}
