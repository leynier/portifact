// One metering path for every terminal outcome of a command (decision 0026, "How it is counted"):
// success, failure after the work began, refusal at any stage, replay and empty answers alike.
// Charged work (a mutation that ran, an export page, protected work) lands in its class's counter
// in the command's own transaction; uncharged work (reads, replays, empty answers and refusals) is
// counted in memory and written with the next counter write, or synchronously when it reaches a
// flush bound. Reads and refusals of an earlier day are always written into that day before
// today's are counted. An alarm's own pruning is deferred to the next counter write, so an idle
// object never writes a row only to record the work of pruning rows (see `PendingReads.deferred`).
import type { ChargeClass, DayCounters } from "@portifact/contracts/artifact-data";
import {
  type Cost,
  charged,
  counted,
  dayOf,
  flushed,
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

/**
 * Meters one terminal outcome. On an object without a control record nothing can be written (no
 * identity is bound by metering): usage stays pending in memory until the first binding write.
 */
export function meter(input: MeterInput): MeterResult {
  const { previous, current } = rollPending(input.pending, input.now);
  const days: DayCounters[] = [];
  let pending = current;
  if (previous !== null && input.bound) days.push(flushed(input.day(previous.day), previous));
  else if (previous !== null) pending = { ...previous, day: dayOf(input.now) };
  const today = dayOf(input.now);
  if (input.terminal.kind === "housekeeping") {
    const deferred = pending.deferred + measuredCharge(input.cost);
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
    days.push(flushed(input.day(today), pending));
    pending = noPendingReads(input.now);
  }
  return { days, rights: null, pending };
}
